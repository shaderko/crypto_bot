const { WebSocket } = require('ws');
var ethers = require('ethers');

const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const UNISWAP_V2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const UNISWAP_V2_ROUTER_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const token =
  'ory_at_bfH3ECvS78s0sKreq1S-9XtyHImocR1pYOsSIyr9vxY.at04Ee5LEIB2KEopCgXMkOsVVMgTeUJYT_3iFu799I4';
//Use use `/eap` instead of `/graphql` if you are using chains on EAP endpoint
const bitqueryConnection = new WebSocket(
  'wss://streaming.bitquery.io/graphql?token=' + token,
  ['graphql-ws']
);

const provider = new ethers.InfuraWebSocketProvider(
  'mainnet',
  '3c409c0cd7d44773b88065fe1c30853f'
);

const factory = new ethers.Contract(
  UNISWAP_V2_FACTORY_ADDRESS,
  UNISWAP_V2_FACTORY_ABI,
  provider
);

const abi = [
  'function swapExactETHForTokens(uint256, address[], address, uint256)'
];
const iface = new ethers.Interface(abi);

function getTokensFromSwapExactETHForTokens(txData) {
  try {
    console.log('Transaction data:', txData);
    // Parse the transaction data
    const parsedTx = iface.parseTransaction({ data: txData });

    if (!parsedTx) {
      console.log('Failed to parse transaction data.');
      return;
    }

    const args = parsedTx.args;

    const token0address = args[1][0];
    const token1address = args[1][1];
    const amountOutMin = args[0];

    // create the contract between addresses
    const address = factory.getPair(token0address, token1address);

    const contract = new ethers.Contract(
      address,
      UNISWAP_V2_ROUTER_ABI,
      provider
    );

    return;
  } catch (error) {
    console.error('Failed to parse transaction data:', error);
    return null;
  }
}

bitqueryConnection.on('open', () => {
  console.log('Connected to Bitquery.');

  // Send initialization message (connection_init)
  const initMessage = JSON.stringify({ type: 'connection_init' });
  bitqueryConnection.send(initMessage);
});

bitqueryConnection.on('message', (data) => {
  const response = JSON.parse(data);

  // Handle connection acknowledgment (connection_ack)
  if (response.type === 'connection_ack') {
    console.log('Connection acknowledged by server.');

    // Send subscription message after receiving connection_ack
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

    bitqueryConnection.send(subscriptionMessage);
    console.log('Subscription message sent.');
  }

  // Handle received data
  if (response.type === 'data') {
    console.log(
      'Received data from Bitquery: ',
      JSON.stringify(response.payload.data)
    );
    getTokensFromSwapExactETHForTokens(
      response.payload.data.EVM.Transactions[0].Transaction.Data
    );
  }

  // Handle keep-alive messages (ka)
  if (response.type === 'ka') {
    console.log('Keep-alive message received.');
    // No action required; just acknowledgment that the connection is alive.
  }

  if (response.type === 'error') {
    console.error('Error message received:', response.payload.errors);
  }
});

bitqueryConnection.on('close', () => {
  console.log('Disconnected from Bitquery.');
});

bitqueryConnection.on('error', (error) => {
  console.error('WebSocket Error:', error);
});

const exitHandler = async (options, exitCode) => {
  if (options.cleanup) {
    console.log('Closing connection...');
    const stopMessage = JSON.stringify({ type: 'stop', id: '1' });
    bitqueryConnection.send(stopMessage);

    await new Promise((r) =>
      setTimeout(() => {
        bitqueryConnection.close();
        console.log('Connection closed.');
        r();
      }, 1000)
    );
  }
  if (exitCode || exitCode === 0) console.log(exitCode);
  if (options.exit) process.exit();
};

process.on('SIGINT', exitHandler.bind(null, { cleanup: true, exit: true }));
