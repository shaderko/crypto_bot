var ethers = require('ethers');

const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const UNISWAP_V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const UNISWAP_V2_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNISWAP_V2_ROUTER_ABI = [
    'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'
];

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const USDC_ETH_PAIR_ADDRESS = '0xE0554a476A092703abdB3Ef35c80e0D76d32939F';

class Bot {
    constructor() {
        this.provider = new ethers.InfuraWebSocketProvider(
            'mainnet',
            '3c409c0cd7d44773b88065fe1c30853f'
        );

        this.factory = new ethers.Contract(
            UNISWAP_V2_FACTORY_ADDRESS,
            UNISWAP_V2_FACTORY_ABI,
            this.provider
        );
    }

    async start() {
        console.clear();

        const pair_add = await this.factory
            .getPair(WETH_ADDRESS, DAI_ADDRESS)
            .then((pairAddress) => {
                console.log('Pair address:', pairAddress);
                return pairAddress;
            });

        if (pair_add === ethers.ZeroAddress) {
            console.log('No WETH-DAI pair found. Exiting.');
            return;
        }

        const wethDaiPair = new ethers.Contract(
            pair_add,
            UNISWAP_V2_ROUTER_ABI,
            this.provider
        );

        wethDaiPair.on(
            'Swap',
            (
                sender,
                amount0In,
                amount1In,
                amount0Out,
                amount1Out,
                to,
                event
            ) => {
                console.log('=== WETH–DAI Swap ===');
                console.log('  sender       :', sender);
                console.log('  amount0In    :', ethers.formatEther(amount0In));
                console.log('  amount1In    :', ethers.formatEther(amount1In));
                console.log('  amount0Out   :', ethers.formatEther(amount0Out));
                console.log('  amount1Out   :', ethers.formatEther(amount1Out));
                console.log('  to           :', to);
                console.log('  blockNumber  :', event.blockNumber);
                console.log('  transaction  :', event.transactionHash);
                console.log('====================');
            }
        );

        const usdcEthPair = new ethers.Contract(
            USDC_ETH_PAIR_ADDRESS,
            UNISWAP_V2_ROUTER_ABI,
            this.provider
        );

        usdcEthPair.on(
            'Swap',
            (
                sender,
                amount0In,
                amount1In,
                amount0Out,
                amount1Out,
                to,
                event
            ) => {
                console.log('=== USDC-ETH Swap ===');
                console.log('  sender       :', sender);
                console.log('  amount0In    :', ethers.formatEther(amount0In));
                console.log('  amount1In    :', ethers.formatEther(amount1In));
                console.log('  amount0Out   :', ethers.formatEther(amount0Out));
                console.log('  amount1Out   :', ethers.formatEther(amount1Out));
                console.log('  to           :', to);
                console.log('  blockNumber  :', event.blockNumber);
                console.log('  transaction  :', event.transactionHash);
                console.log('====================');
            }
        );

        console.log('Bot started. Listening for pending transactions...');
    }
}

const bot = new Bot();
bot.start();
