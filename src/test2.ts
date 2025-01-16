import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

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
        while (
            this.currentConcurrent < this.maxConcurrent &&
            this.queue.length
        ) {
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
            new Pair(
                token0,
                token1,
                factory,
                provider,
                this.registerPair.bind(this),
                this.onSwap.bind(this)
            )
        );
    }

    onSwap() {
        this.emit('swap');
    }

    registerPair(pair: Pair) {
        pair.contract.on(
            'Swap',

            (
                ...args: [
                    sender: string,
                    amount0In: ethers.BigNumberish,
                    amount1In: ethers.BigNumberish,
                    amount0Out: ethers.BigNumberish,
                    amount1Out: ethers.BigNumberish,
                    to: string,
                    event: ethers.ContractEvent
                ]
            ) => {
                pair.processSwap(...args);
            }
        );
    }

    print() {
        this.pairs.forEach((pair) => {
            console.log(`${pair.token0.name}-${pair.token1.name}`);

            console.table(
                pair.swaps.map((swap: Swap) => {
                    return {
                        tokenIn: swap.tokenIn.name,
                        amountIn: ethers.formatUnits(
                            swap.amountIn,
                            swap.tokenIn.decimals
                        ),
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
                        profit: `${swap.profit?.max ?? 0} / ${
                            swap.profit?.min ?? 0
                        }`
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
        onInitialized: (pair: Pair) => void = undefined,
        onSwap: () => void = undefined
    ) {
        super();

        if (onInitialized) this.on('init', onInitialized);
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
                new ethers.Contract(
                    this.address,
                    UNISWAP_V2_ROUTER_ABI,
                    this.provider
                )
        );

        const token0_address = await taskQueue.add(() =>
            this.contract.token0()
        );

        if (token0_address !== this.token0.address) {
            const tempToken = this.token0;
            this.token0 = this.token1;
            this.token1 = tempToken;
        }

        this.emit('init', this);

        clearTimeout(loader);

        console.log(
            `Initialized Pair: ${this.token0.name}-${this.token1.name}`
        );
    }

    // console.log('\x1b[32m BUY ORDER \x1b[0m');
    // console.log('\x1b[31m SELL ORDER \x1b[0m');

    async processSwap(
        sender: string,
        amount0In: ethers.BigNumberish,
        amount1In: ethers.BigNumberish,
        amount0Out: ethers.BigNumberish,
        amount1Out: ethers.BigNumberish,
        to: string,
        event: ethers.ContractEvent
    ) {
        const amount0OutBN = BigInt(amount0Out);
        const amount1OutBN = BigInt(amount1Out);
        const amount0InBN = BigInt(amount0In);
        const amount1InBN = BigInt(amount1In);

        const amountIn = amount0InBN ? amount0InBN : amount1InBN;
        const amountOut = amount0OutBN ? amount0OutBN : amount1OutBN;

        const tokenIn = amount0InBN ? this.token0 : this.token1;
        const tokenOut = amount0OutBN ? this.token0 : this.token1;

        // Create and store the swap
        this.swaps.push(
            new Swap(
                sender,
                this,
                tokenIn,
                amountIn,
                tokenOut,
                amountOut,
                to,
                event,
                this.provider
            )
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
        const tokensDataPath = path.join(__dirname, filename);
        const tokenData = JSON.parse(fs.readFileSync(tokensDataPath, 'utf-8'));

        if (!tokenData) throw new Error('No tokens provided!');

        Object.entries(tokenData).map(([_name, token]: [string, Token]) => {
            this.addToken(new Token(token.address, provider));
        });
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
    sender: string;
    pair: Pair;

    tokenIn: Token;
    amountIn: ethers.BigNumberish;

    tokenOut: Token;
    amountOut: ethers.BigNumberish;

    to: string;
    event: ethers.ContractEvent;

    createdAt: Date;

    constructor(
        sender: string,
        pair: Pair,
        tokenIn: Token,
        amountIn: ethers.BigNumberish,
        tokenOut: Token,
        amountOut: ethers.BigNumberish,
        to: string,
        event: ethers.ContractEvent,
        provider: ethers.ethers.InfuraWebSocketProvider
    ) {
        this.sender = sender;
        this.pair = pair;

        this.tokenIn = tokenIn;
        this.amountIn = amountIn;

        this.tokenOut = tokenOut;
        this.amountOut = amountOut;

        this.to = to;
        this.event = event;

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
        if (this.tokenOut.address === WETH_ADDRESS) {
            this.profit = {
                min: '0',
                max: '0'
            };
            return;
        }

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
        const fees = (await taskQueue.add(() => this.provider.getFeeData()))
            .gasPrice;
        console.log('fees: ', ethers.formatEther(fees));

        // Calculate profit in WETH by comparing the WETH received from our reverse swap
        // against our total input plus fees
        const profit = wethReceived - (assumed_price_fr + fees);
        console.log('profit: ', ethers.formatEther(profit));

        // Provide a profit range (with ±20% for uncertainty, can be adjusted)
        const minProfit = (profit * 80n) / 100n;
        const maxProfit = (profit * 120n) / 100n;

        if (minProfit > 0n) {
            wallet += minProfit;
        }

        // Format profit numbers to human-readable format (assuming 18 decimals for WETH)
        const formattedMinProfit = ethers.formatUnits(
            minProfit,
            this.tokenIn.decimals
        );
        const formattedMaxProfit = ethers.formatUnits(
            maxProfit,
            this.tokenIn.decimals
        );

        console.log(
            `Front-run profit range: min = ${formattedMinProfit} WETH, max = ${formattedMaxProfit} WETH`
        );

        // Optionally store the profit for later use
        this.profit = { min: formattedMinProfit, max: formattedMaxProfit };
    }
}

class Bot {
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

        this.pairManager = new PairManager(this.onSwap.bind(this));
        this.tokenManager = new TokenManager(
            'tokens.json',
            this.provider,
            this.factory,
            this.pairManager.addPair.bind(this.pairManager)
        );
    }

    onSwap() {
        this.print();
    }

    print() {
        // console.clear();

        this.tokenManager.print();

        this.pairManager.print();

        console.log('Wallet status', ethers.formatEther(wallet));
    }
}

const bot = new Bot();
