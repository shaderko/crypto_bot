import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';

const ERC20_ABI = [
  'function name() view returns (string)',
  'function decimals() view returns (uint8)'
];

const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const UNISWAP_V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const UNISWAP_V2_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNISWAP_V2_ROUTER_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

interface ExitOptions {
  cleanup: boolean;
  exit: boolean;
}

const abi = [
  'function swapExactETHForTokens(uint256, address[], address, uint256)'
];
const iface = new ethers.Interface(abi);

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

let wallet = 0n;

function loadingAnimation(
  text = '',
  chars = ['⠙', '⠘', '⠰', '⠴', '⠤', '⠦', '⠆', '⠃', '⠋', '⠉'],
  delay = 100
) {
  let x = 0;

  return setInterval(function () {
    process.stdout.write('\r' + chars[x++] + ' ' + text);
    x = x % chars.length;
  }, delay);
}

/**
 * Typical Uniswap V2 `getAmountOut` formula using bigint arithmetic
 *
 * amountOut = amountIn * 997 * reserveOut
 *             ---------------------------------
 *             reserveIn * 1000 + amountIn * 997
 */
function getUniV2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): bigint {
  // 0.3% fee => multiplier = 997
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  if (denominator === 0n) {
    return 0n;
  }
  return numerator / denominator;
}

class TaskQueue {
  // Each queued item holds the task function and its promise callbacks.
  private queue: {
    task: () => Promise<any> | any;
    resolve: (value?: any) => void;
    reject: (reason?: any) => void;
  }[] = [];

  private maxConcurrent: number;
  private currentConcurrent: number = 0;

  constructor(maxConcurrent: number = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Adds a new task to the queue. The task may be an async function
   * or a synchronous one. Returns a Promise that resolves with the
   * result of the task when it eventually runs.
   */
  public async add(task: () => Promise<any> | any): Promise<any> {
    return new Promise((resolve, reject) => {
      // Push the task and its promise callbacks into the queue.
      this.queue.push({ task, resolve, reject });
      // Try to run tasks if we have capacity.
      this.runNext();
    });
  }

  /**
   * Checks if we can run more tasks and starts them if possible.
   */
  private runNext(): void {
    while (this.currentConcurrent < this.maxConcurrent && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift()!;
      this.currentConcurrent++;

      // Define a helper that will attempt to execute the task,
      // and in case of failure, wait one second and retry.
      const attemptTask = async (): Promise<any> => {
        try {
          // Ensure that task is handled as a promise.
          return await Promise.resolve().then(() => task());
        } catch (error) {
          // Wait one second and then retry.
          await new Promise((res) => setTimeout(res, 3000));
          console.log(error);
          return attemptTask();
        }
      };

      // Chain the helper promise to the outer promise.
      attemptTask()
        .then((result) => resolve(result))
        .catch((error) => reject(error)) // Note: With infinite retries, this catch may never occur.
        .finally(() => {
          this.currentConcurrent--;
          this.runNext();
        });
    }
  }
}
const taskQueue = new TaskQueue();

class PairManager extends EventEmitter {
  pairs: Pair[];

  constructor(onSwap: () => void = undefined) {
    super();

    this.pairs = [];

    if (onSwap) this.on('swap', onSwap);
  }

  addPair(
    token0: Token,
    token1: Token,
    factory: ethers.ethers.Contract,
    provider: ethers.ethers.InfuraWebSocketProvider
  ) {
    this.pairs.push(
      new Pair(token0, token1, factory, provider, this.onSwap.bind(this))
    );
  }

  onSwap() {
    this.emit('swap');
  }

  getPair(address0: string, address1: string) {
    const pairs = this.pairs.filter(
      (pair) =>
        (pair.token0.address === address0 ||
          pair.token1.address === address0) &&
        (pair.token1.address === address0 || pair.token1.address === address1)
    );

    if (pairs.length <= 0) return null;

    return pairs[0];
  }

  print() {
    this.pairs.forEach((pair) => {
      console.log(`${pair.token0.name}-${pair.token1.name}`);

      console.table(
        pair.swaps.map((swap: Swap) => {
          return {
            tokenIn: swap.tokenIn.name,
            amountIn: ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals),
            amountOut: ethers.formatUnits(
              swap.amountOut,
              swap.tokenOut.decimals
            ),
            out: swap.tokenOut.name,
            createdAt: swap.createdAt,
            action:
              swap.tokenIn.address === WETH_ADDRESS
                ? `\x1b[32m BUY ORDER \x1b[0m`
                : '\x1b[31m SELL ORDER \x1b[0m',
            profit: `${swap.profit?.max ?? 0} / ${swap.profit?.min ?? 0}`
          };
        })
      );
    });
  }
}

class Pair extends EventEmitter {
  provider: ethers.ethers.InfuraWebSocketProvider;
  swaps: Swap[];

  token0: Token;
  token1: Token;

  address: string;
  contract: ethers.ethers.Contract;

  constructor(
    token0: Token,
    token1: Token,
    factory: ethers.ethers.Contract,
    provider: ethers.ethers.InfuraWebSocketProvider,
    onSwap: () => void = undefined
  ) {
    super();

    if (onSwap) this.on('swap', onSwap);

    this.provider = provider;

    this.swaps = [];
    this.token0 = token0;
    this.token1 = token1;

    this.Init(factory);
  }

  async Init(factory: ethers.ethers.Contract) {
    const loader = loadingAnimation('Initializing Pair');

    this.address = await taskQueue.add(() =>
      factory.getPair(this.token0.getAddress(), this.token1.getAddress())
    );

    this.contract = await taskQueue.add(
      () =>
        new ethers.Contract(this.address, UNISWAP_V2_ROUTER_ABI, this.provider)
    );

    const token0_address = await taskQueue.add(() => this.contract.token0());

    if (token0_address !== this.token0.address) {
      const tempToken = this.token0;
      this.token0 = this.token1;
      this.token1 = tempToken;
    }

    this.emit('init', this);

    clearTimeout(loader);

    console.log(`Initialized Pair: ${this.token0.name}-${this.token1.name}`);
  }

  // console.log('\x1b[32m BUY ORDER \x1b[0m');
  // console.log('\x1b[31m SELL ORDER \x1b[0m');

  async process(amountIn: bigint, amountOut: bigint) {
    const aa_in =
      this.token0.address === WETH_ADDRESS ? this.token0 : this.token1;
    const aa_out =
      this.token0.address === WETH_ADDRESS ? this.token1 : this.token0;

    this.swaps.push(
      new Swap(this, aa_in, amountIn, aa_out, amountOut, this.provider)
    );
    this.emit('swap');
  }
}

class TokenManager extends EventEmitter {
  tokens: Token[];
  WETHToken: Token;

  constructor(
    filename: string,
    provider: ethers.ethers.InfuraWebSocketProvider,
    factory: ethers.ethers.Contract,
    onTokenAdded: (
      token0: Token,
      token1: Token,
      factory: ethers.ethers.Contract,
      provider: ethers.ethers.InfuraWebSocketProvider
    ) => void = undefined
  ) {
    super();

    if (onTokenAdded)
      this.on('tokenAdded', (args: [token0: Token, token1: Token]) =>
        onTokenAdded(...args, factory, provider)
      );

    this.tokens = [];

    this.WETHToken = new Token(WETH_ADDRESS, provider);

    // Read which tokens to initialize pairs with WETH - TOKEN
    // const tokensDataPath = path.join(__dirname, filename);
    // const tokenData = JSON.parse(fs.readFileSync(tokensDataPath, 'utf-8'));

    // if (!tokenData) throw new Error('No tokens provided!');

    // Object.entries(tokenData).map(([_name, token]: [string, Token]) => {
    //   this.addToken(new Token(token.address, provider));
    // });
  }

  addToken(token: Token) {
    this.tokens.push(token);
    this.emit('tokenAdded', [this.WETHToken, token]);
  }

  print() {
    console.table(this.tokens);
  }
}

class Token {
  address: string;

  name: string;
  decimals: any;

  contract: ethers.ethers.Contract;

  constructor(
    address: string,
    provider: ethers.ethers.InfuraWebSocketProvider
  ) {
    this.address = address;

    this.Init(provider);
  }

  async Init(provider: ethers.ethers.InfuraWebSocketProvider): Promise<void> {
    this.contract = await taskQueue.add(
      () => new ethers.Contract(this.address, ERC20_ABI, provider)
    );

    const [name, decimals] = await taskQueue.add(() =>
      Promise.all([this.contract.name(), this.contract.decimals()])
    );

    this.name = name;
    this.decimals = decimals;
  }

  getAddress() {
    return this.address;
  }
}

class Swap {
  provider: ethers.ethers.InfuraWebSocketProvider;
  profit: { min: string; max: string };
  pair: Pair;

  tokenIn: Token;
  amountIn: ethers.BigNumberish;

  tokenOut: Token;
  amountOut: ethers.BigNumberish;

  to: string;
  event: ethers.ContractEvent;

  createdAt: Date;

  constructor(
    pair: Pair,
    tokenIn: Token,
    amountIn: ethers.BigNumberish,
    tokenOut: Token,
    amountOut: ethers.BigNumberish,
    provider: ethers.ethers.InfuraWebSocketProvider
  ) {
    this.pair = pair;

    this.tokenIn = tokenIn;
    this.amountIn = amountIn;

    this.tokenOut = tokenOut;
    this.amountOut = amountOut;

    this.createdAt = new Date();

    this.provider = provider;

    this.getProfit();
  }

  async getProfit(this: Swap): Promise<void> {
    /**
     * Overview:
     * 1. Simulate our front-running swap (WETH → Coin) by adding our input
     *    to the WETH reserve and subtracting the output coin.
     * 2. Then simulate the victim’s swap on the updated reserves.
     * 3. Finally, simulate our reverse swap (Coin → WETH).
     *
     * Note: Even though the swap math uses the 997 factor (0.3% fee),
     * the actual reserves update by **adding the full input amount**.
     */

    // No profit calculation if our swap is already a WETH swap.
    console.log('get profit: ', this.amountIn, this.amountOut);

    // Get current reserves from the pair contract
    const reserves: [bigint, bigint] = await taskQueue.add(() =>
      this.pair.contract.getReserves()
    );

    let reserveWeth: bigint, reserveCoin: bigint;
    if (this.pair.token0.address === WETH_ADDRESS) {
      reserveWeth = reserves[0];
      reserveCoin = reserves[1];
    } else {
      reserveWeth = reserves[1];
      reserveCoin = reserves[0];
    }

    // Our front-run swap: we invest a fixed amount (assumed_price_fr) of WETH
    console.log('investment: ', ethers.formatEther(200000000000000000n));
    const assumed_price_fr = BigInt(200000000000000000n);
    // For logging purposes, note that the "fee-adjusted" input is:
    console.log(
      'effective input after fee (for swap math): ',
      ethers.formatEther((assumed_price_fr * 997n) / 1000n)
    );

    // Calculate how many coins we acquire with our swap input.
    const coinAcquired = getUniV2AmountOut(
      assumed_price_fr,
      reserveWeth,
      reserveCoin
    );
    console.log(
      'coinAcquired: ',
      ethers.formatUnits(coinAcquired, this.tokenOut.decimals)
    );

    /**
     * Update reserves after our swap:
     *  - The entire assumed_price_fr (0.2 ETH) is added to the WETH reserve.
     *  - The coin reserve is decreased by the amount of coinAcquired.
     *
     * Note: Although only 99.7% of our input is effective for the swap,
     * the pool receives the full amount.
     */
    const weth_after_our_swap = reserveWeth + assumed_price_fr;
    const coin_after_our_swap = reserveCoin - coinAcquired;

    /**
     * Now simulate the victim’s swap.
     * The victim supplies an input amount (this.amountIn) to the pool.
     * Because the reserves have already been updated with our trade,
     * the victim’s output (victimCoin) is computed on the new reserves.
     */
    const victimCoin = getUniV2AmountOut(
      BigInt(this.amountIn),
      weth_after_our_swap,
      coin_after_our_swap
    );
    console.log(
      'victimCoin: ',
      ethers.formatUnits(victimCoin, this.tokenOut.decimals)
    );

    /**
     * Update reserves after the victim’s swap:
     *  - The victim’s full input amount is added to the WETH reserve.
     *  - The coin reserve is reduced by the victim’s acquired coin.
     */
    const weth_after_swap = weth_after_our_swap + BigInt(this.amountIn);
    const coin_after_swap = coin_after_our_swap - victimCoin;

    // --- Step 3: Our reverse swap (swapping our acquired coin back to WETH) ---
    const wethReceived = getUniV2AmountOut(
      coinAcquired,
      coin_after_swap,
      weth_after_swap
    );
    console.log('recv: ', ethers.formatEther(wethReceived));

    // Get gas fee data for our transaction (if relevant)
    const fees = await taskQueue.add(() => this.provider.getFeeData());
    console.log('fees: ', ethers.formatEther(fees.maxFeePerGas));

    // Calculate profit in WETH by comparing the WETH received from our reverse swap
    // against our total input plus fees
    const profit = wethReceived - (assumed_price_fr + fees.gasPrice);
    console.log('profit: ', ethers.formatEther(profit));

    // Provide a profit range (with ±20% for uncertainty, can be adjusted)
    const minProfit = (profit * 80n) / 100n;
    const maxProfit = (profit * 120n) / 100n;

    if (minProfit > 0n) {
      wallet += minProfit;
      // const desiredMaxFeePerGas = fees.gasPrice;
      // const desiredPriorityFee = fees.maxPriorityFeePerGas;
      // // Get the correct nonce for our wallet.
      // const nonce = await wallet.getTransactionCount();
      // // Build the front-run transaction (swapping ETH for tokens)
      // const frontRunTx = {
      //   to: UNISWAP_V2_ROUTER_ADDRESS,
      //   data: frontRunData,
      //   value: ethers.BigNumber.from(assumedInvestment.toString()),
      //   gasLimit: gasLimitPerTx,
      //   nonce: nonce,
      //   maxFeePerGas: desiredMaxFeePerGas,
      //   maxPriorityFeePerGas: desiredPriorityFee
      // };
      // // Build the reverse (back-run) transaction (swapping tokens back to ETH)
      // const backRunTx = {
      //   to: UNISWAP_ROUTER_ADDRESS,
      //   data: backRunData,
      //   gasLimit: gasLimitPerTx,
      //   nonce: nonce + 1,
      //   maxFeePerGas: desiredMaxFeePerGas,
      //   maxPriorityFeePerGas: desiredPriorityFee
      // };
      // // 5. Set the target block: either the next block or one you expect the victim's tx to be in.
      // const currentBlock = await this.provider.getBlockNumber();
      // // For example, target the next block:
      // const targetBlockNumber = currentBlock + 1;
      // console.log('Target block for inclusion:', targetBlockNumber);
      // // 6. Set up the Flashbots provider.
      // const flashbotsProvider = await setupFlashbotsProvider();
      // // 7. Submit the bundle.
      // const bundleResponse = await flashbotsProvider.sendBundle(
      //   [
      //     { signer: wallet, transaction: frontRunTx },
      //     { signer: wallet, transaction: backRunTx }
      //   ],
      //   targetBlockNumber
      // );
      // // Check if the bundle submission returned an error.
      // if ('error' in bundleResponse) {
      //   console.error(
      //     'Flashbots bundle submission error:',
      //     bundleResponse.error.message
      //   );
      //   return;
      // }
      // console.log('Bundle submitted, targeting block', targetBlockNumber);
      // // 8. Wait for the bundle outcome.
      // const bundleResolution = await bundleResponse.wait();
      // if (bundleResolution === 0) {
      //   console.log('Bundle was included in block', targetBlockNumber);
      // } else {
      //   console.log(
      //     'Bundle was not included as planned. Resolution code:',
      //     bundleResolution
      //   );
      // }
    }

    // Format profit numbers to human-readable format (assuming 18 decimals for WETH)
    const formattedMinProfit = ethers.formatEther(minProfit);
    const formattedMaxProfit = ethers.formatEther(maxProfit);

    console.log(
      `Front-run profit range: min = ${formattedMinProfit} WETH, max = ${formattedMaxProfit} WETH`
    );

    // Optionally store the profit for later use
    this.profit = { min: formattedMinProfit, max: formattedMaxProfit };
  }
}

class Bot {
  bq: WebSocket;

  provider: ethers.ethers.InfuraWebSocketProvider;
  factory: ethers.ethers.Contract;

  pairManager: PairManager;
  tokenManager: TokenManager;

  constructor() {
    console.clear();

    this.Init();
  }

  async Init() {
    this.provider = await taskQueue.add(
      () =>
        new ethers.InfuraWebSocketProvider(
          'mainnet',
          '3c409c0cd7d44773b88065fe1c30853f'
        )
    );

    this.factory = await taskQueue.add(
      () =>
        new ethers.Contract(
          UNISWAP_V2_FACTORY_ADDRESS,
          UNISWAP_V2_FACTORY_ABI,
          this.provider
        )
    );

    this.connectWebSocket();

    this.pairManager = new PairManager(this.onSwap.bind(this));
    this.tokenManager = new TokenManager(
      'tokens.json',
      this.provider,
      this.factory,
      this.pairManager.addPair.bind(this.pairManager)
    );
  }

  connectWebSocket() {
    // Define the WebSocket URL and protocols
    const wsUrl =
      'wss://streaming.bitquery.io/graphql?token=' +
      'ory_at_vdvkjiHMsHigglmh0e3isr7tw157CuCX6GgEzSIkOsk.l0KcDiortwCzay-1HFl5giZ6jaCJiC6kcsOTLQObE2g';
    const protocols = ['graphql-ws'];

    // Create a new WebSocket instance
    this.bq = new WebSocket(wsUrl, protocols);

    // Attach event listeners
    this.bq.addEventListener('open', () => {
      console.log('Connected to Bitquery.');

      // Send initialization message (connection_init)
      const initMessage = JSON.stringify({ type: 'connection_init' });
      this.bq.send(initMessage);
    });

    this.bq.addEventListener('message', (event) => {
      const response = JSON.parse(event.data);

      if (response.type === 'connection_ack') {
        console.log('Connection acknowledged by server.');

        // Subscription message after connection acknowledgement
        const subscriptionMessage = JSON.stringify({
          type: 'start',
          id: '1',
          payload: {
            query: `
              subscription {
                EVM(mempool: true, network: eth, trigger_on: head) {
                  Transactions(
                    limit: {count: 10}
                    orderBy: {descending: Block_Time}
                    where: {Transaction: {To: {is: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"}}}
                  ) {
                    Transaction {
                      Data
                      Hash
                      From
                      To
                      Time
                      ValueInUSD
                      Value
                      Gas
                      GasPrice
                      GasFeeCap
                      GasPriceInUSD
                    }
                    Block {
                      Difficulty
                      GasLimit
                      Hash
                      Number
                    }
                  }
                }
              }
            `
          }
        });
        this.bq.send(subscriptionMessage);
        console.log('Subscription message sent.');
      }

      if (response.type === 'data') {
        try {
          const parsedTx = iface.parseTransaction({
            data: response.payload.data.EVM.Transactions[0].Transaction.Data
          });

          if (!parsedTx) {
            console.log('Failed to parse transaction data.');
            return;
          }

          const args = parsedTx.args;
          const token0address = args[1][0];
          const token1address = args[1][1];
          const amountOutMin = args[0];

          const pair = this.pairManager.getPair(token0address, token1address);

          if (!pair) {
            console.log('We have not seen this pair yet');

            const token0 = new Token(token0address, this.provider);
            const token1 = new Token(token1address, this.provider);

            this.pairManager.addPair(
              token0,
              token1,
              this.factory,
              this.provider
            );
            return;
          }

          pair.process(
            ethers.parseEther(
              response.payload.data.EVM.Transactions[0].Transaction.Value
            ),
            amountOutMin
          );
        } catch (err) {
          console.log('Caught error processing data:', err);
        }
      }

      if (response.type === 'ka') {
        console.log('Keep-alive message received.');
      }

      if (response.type === 'error') {
        console.error('Error message received:', response.payload.errors);
      }
    });

    this.bq.addEventListener('close', (event) => {
      console.warn(
        `WebSocket closed (code: ${event.code}, reason: ${
          event.reason
        }). Reconnecting in ${2000 / 1000} seconds...`
      );

      // Attempt reconnection after delay
      setTimeout(() => {
        this.connectWebSocket();
      }, 2000);
    });

    this.bq.addEventListener('error', (error) => {
      console.error('WebSocket Error:', error);
      // You could optionally close the connection here to trigger the reconnect logic
      // this.bq.close();
    });
  }

  onSwap() {
    this.print();
  }

  async exit(options: ExitOptions, exitCode: number | null) {
    if (options.cleanup) {
      console.log('Closing connection...');
      const stopMessage = JSON.stringify({ type: 'stop', id: '1' });
      this.bq.send(stopMessage);

      await new Promise<void>((r) =>
        setTimeout(() => {
          this.bq.close();
          console.log('Connection closed.');
          r();
        }, 1000)
      );
    }
    if (exitCode || exitCode === 0) console.log(exitCode);
    if (options.exit) process.exit();
  }

  print() {
    console.clear();

    this.tokenManager.print();

    this.pairManager.print();

    console.log('Wallet status', ethers.formatEther(wallet));
  }
}

const bot = new Bot();
process.on('SIGINT', bot.exit.bind(bot, { cleanup: true, exit: true }));
