import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

const ERC20_ABI = [
	'function name() view returns (string)',
	'function decimals() view returns (uint8)',
];

const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const UNISWAP_V2_FACTORY_ABI = [
	'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const UNISWAP_V2_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNISWAP_V2_ROUTER_ABI = [
	'function token0() view returns (address)',
	'function token1() view returns (address)',
	'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
];

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

class PairManager extends EventEmitter {
	pairs: Pair[];

	constructor() {
		super();

		this.pairs = [];
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
				this.print.bind(this)
			)
		);
	}

	registerPair(pair: Pair) {
		pair.contract.on(
			'Swap',
			(
				args: [
					sender: string,
					amount0In: ethers.BigNumberish,
					amount1In: ethers.BigNumberish,
					amount0Out: ethers.BigNumberish,
					amount1Out: ethers.BigNumberish,
					to: string,
					event: ethers.ContractEvent
				]
			) => pair.processSwap(...args)
		);
	}

	print() {
		this.pairs.forEach((pair) => {
			console.log(`${pair.token0.name}-${pair.token1.name}`);

			console.table(pair.swaps);
		});
	}
}

class Pair extends EventEmitter {
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

		this.swaps = [];
		this.token0 = token0;
		this.token1 = token1;

		this.Init(factory, provider);
	}

	async Init(
		factory: ethers.ethers.Contract,
		provider: ethers.ethers.InfuraWebSocketProvider
	) {
		this.address = await factory.getPair(
			this.token0.getAddress(),
			this.token1.getAddress()
		);

		this.contract = new ethers.Contract(
			this.address,
			UNISWAP_V2_ROUTER_ABI,
			provider
		);

		this.emit('init', this);

		console.log('Initialized Pair: ', this.address);
	}

	async processSwap(
		sender: string,
		amount0In: ethers.BigNumberish,
		amount1In: ethers.BigNumberish,
		amount0Out: ethers.BigNumberish,
		amount1Out: ethers.BigNumberish,
		to: string,
		event: ethers.ContractEvent
	) {
		const token0 = await this.contract.token0();
		const token1 = await this.contract.token1();

		let token0In: ethers.BigNumberish | undefined,
			token0Out: ethers.BigNumberish | undefined,
			token1In: ethers.BigNumberish | undefined,
			token1Out: ethers.BigNumberish | undefined;

		if (token0 === this.token0.address) {
			if (amount0In) {
				token0In = amount0In;
				token1Out = amount1Out;
			} else {
				token0Out = amount0Out;
				token1In = amount1In;
			}
		} else {
			if (amount1In) {
				token0In = amount1In;
				token1Out = amount0Out;
			} else {
				token0Out = amount1Out;
				token1In = amount0In;
			}
		}

		if (token0In && token1Out) {
			// BUY
			console.log('\x1b[32m BUY ORDER \x1b[0m');
			this.swaps.push(
				new Swap(
					sender,
					this.token0,
					token0In,
					this.token1,
					token1Out,
					to,
					event
				)
			);
		} else if (token0Out && token1In) {
			// SELL
			console.log('\x1b[31m SELL ORDER \x1b[0m');
			this.swaps.push(
				new Swap(
					sender,
					this.token1,
					token1In,
					this.token0,
					token0Out,
					to,
					event
				)
			);
		}

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
	isInitialized: boolean;

	address: string;

	name: string;
	decimals: any;

	contract: ethers.ethers.Contract;

	constructor(
		address: string,
		provider: ethers.ethers.InfuraWebSocketProvider
	) {
		this.address = address;

		this.isInitialized = false;

		this.Init(provider);
	}

	async Init(provider: ethers.ethers.InfuraWebSocketProvider): Promise<void> {
		this.contract = new ethers.Contract(this.address, ERC20_ABI, provider);

		const [name, decimals] = await Promise.all([
			this.contract.name(),
			this.contract.decimals(),
		]);

		this.name = name;
		this.decimals = decimals;

		this.isInitialized = true;
	}

	getAddress() {
		return this.address;
	}
}

class SwapManager {
	swaps: Swap[];

	constructor() {
		this.swaps = [];
	}

	// print() {
	// 	let sellData = {};
	// 	let buyData = {};

	// 	this.swaps.forEach((swap) => {
	// 		if (swap.isBuy()) {
	// 			buyData[swap.tokenOut.name] = [
	// 				Number(ethers.formatUnits(swap.amountOut, swap.tokenOut.decimals)),
	// 			].concat(buyData[swap.tokenOut.name] ?? []);
	// 			return;
	// 		}

	// 		sellData[swap.tokenIn.name] = [
	// 			Number(ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals)),
	// 		].concat(sellData[swap.tokenIn.name] ?? []);
	// 	});

	// 	console.log('Buy Data');
	// 	console.table(buyData);
	// 	console.log('Sell Data');
	// 	console.table(sellData);
	// }

	addSwap(swap: Swap) {
		this.swaps.push(swap);
	}
}

class Swap {
	sender: string;
	amountIn: ethers.BigNumberish;
	amountOut: ethers.BigNumberish;
	to: string;
	event: ethers.ContractEvent;

	createdAt: Date;

	constructor(
		sender: string,
		tokenIn: Token,
		amountIn: ethers.BigNumberish,
		tokenOut: Token,
		amountOut: ethers.BigNumberish,
		to: string,
		event: ethers.ContractEvent
	) {
		this.sender = sender;
		this.to = to;
		this.event = event;

		this.amountIn = amountIn;
		this.amountOut = amountOut;

		this.createdAt = new Date();
	}

	getProfit() {
		// TODO:
		// const [reserve0, reserve1] = await token.pairContract.getReserves();
	}
}

class Bot {
	provider: ethers.ethers.InfuraWebSocketProvider;
	factory: ethers.ethers.Contract;

	pairManager: PairManager;
	tokenManager: TokenManager;
	swapManager: SwapManager;

	constructor() {
		console.clear();

		this.provider = new ethers.InfuraWebSocketProvider(
			'mainnet',
			'3c409c0cd7d44773b88065fe1c30853f'
		);

		this.factory = new ethers.Contract(
			UNISWAP_V2_FACTORY_ADDRESS,
			UNISWAP_V2_FACTORY_ABI,
			this.provider
		);

		this.swapManager = new SwapManager();
		this.pairManager = new PairManager();
		this.tokenManager = new TokenManager(
			'tokens.json',
			this.provider,
			this.factory,
			this.pairManager.addPair.bind(this.pairManager)
		);
	}

	print() {
		console.clear();

		this.tokenManager.print();

		this.pairManager.print();
	}
}

const bot = new Bot();
