// get wss pending transaction hash
// parse the transaction
// get token addresses from the transaction
// get token prices
// get token liquidity
// get gas price fees from transaction
// calculate profit

var ethers = require('ethers');
var url = 'wss://mainnet.infura.io/ws/v3/3c409c0cd7d44773b88065fe1c30853f';

const ERC20_ABI = [
	'function name() view returns (string)',
	'function symbol() view returns (string)',
	'function decimals() view returns (uint8)',
	// Add other ERC20 functions if needed
];

/**
 * Checks if the given address is a smart contract.
 * @param {string} address - The Ethereum address to check.
 * @param {ethers.Provider} provider - The ethers provider instance.
 * @returns {Promise<boolean>} - Returns true if it's a contract, else false.
 */
async function isContract(address, provider) {
	const code = await provider.getCode(address);
	return code !== '0x';
}

/**
 * Returns a Contract instance if the address is a contract.
 * @param {string} address - The contract address.
 * @param {Array} abi - The ABI of the contract.
 * @param {ethers.Provider} provider - The ethers provider instance.
 * @returns {ethers.Contract|null} - Returns the Contract instance or null.
 */
function getContractInstance(address, abi, provider) {
	if (!ethers.isAddress(address)) {
		console.error(`Invalid address: ${address}`);
		return null;
	}

	return new ethers.Contract(address, abi, provider);
}

/**
 * Fetches token information like name, symbol, and decimals.
 * @param {ethers.Contract} contract - The contract instance.
 * @returns {Promise<Object>} - Returns an object with token info.
 */
async function getTokenInfo(contract) {
	try {
		const [name, symbol, decimals] = await Promise.all([
			contract.name(),
			contract.symbol(),
			contract.decimals(),
		]);

		return { name, symbol, decimals };
	} catch (error) {
		// console.error('Error fetching token info:', error);
		return null;
	}
}

class Bot {
	constructor(url, maxConcurrency) {
		this.url = url;
		this.maxConcurrency = maxConcurrency;

		this.websocket = new ethers.WebSocketProvider(url);

		// This array will hold the in-flight transaction fetch promises
		this.pendingTxFetches = [];

		this.seenTokens = [];
	}

	start() {
		// WebSocket event: new pending transaction
		this.websocket.on('pending', (txHash) => {
			// console.log('New pending transaction:', txHash);
			this.onPending(txHash);
		});

		// WebSocket error
		this.websocket.on('error', (err) => {
			console.log('WebSocket Error:', err);
		});

		// Periodic log of concurrency
		setInterval(() => {
			// console.log(
			//     `Current concurrency: ${this.pendingTxFetches.length}/${this.maxConcurrency}`
			// );
		}, 2000);

		console.log('Bot started. Listening for pending transactions...');
	}

	async onPending(txHash) {
		// Check concurrency limit
		if (this.pendingTxFetches.length >= this.maxConcurrency) {
			// Too many requests in flight
			return;
		}

		// Create a promise that fetches the transaction & processes it
		const fetchPromise = this.websocket
			.getTransaction(txHash)
			.then((tx) => {
				// If tx is null, it means the node does not have info on it yet
				// or it was dropped from the mempool
				if (tx) {
					this.processTransaction(tx);
				}
			})
			.catch((err) => {
				// console.error('Error fetching transaction:', err);
			})
			.finally(() => {
				// Remove this promise from the array when done
				this.removePromise(fetchPromise);
			});

		// Add promise to the array
		this.pendingTxFetches.push(fetchPromise);
	}

	async getProfitability(tx) {
		try {
			const toAddress = tx.to;

			if (!toAddress) {
				console.log('Transaction does not have a "to" address.');
				return;
			}

			// Check if the `to` address is a contract
			if (!(await isContract(toAddress, ethers.getDefaultProvider()))) {
				return;
			}

			console.log(`Address "to" ${toAddress} is a smart contract.`);

			// Instantiate the contract
			const contract = getContractInstance(
				toAddress,
				ERC20_ABI,
				ethers.getDefaultProvider()
			);

			if (!contract) {
				console.log('Failed to instantiate contract.');
				return;
			}

			// Fetch token information
			const tokenInfo = await getTokenInfo(contract);

			if (!tokenInfo) {
				console.log('Failed to fetch token info.');
				return;
			}

			// console.log(tx);
			// return;
			if (
				this.seenTokens.filter((token) => token.name === tokenInfo.name)
					.length === 0
			) {
				this.seenTokens.push({
					name: tokenInfo.name,
					symbol: tokenInfo.symbol,
					decimals: tokenInfo.decimals,
					seen: 1,
				});
			} else {
				this.seenTokens.forEach((token) => {
					if (token.name === tokenInfo.name) {
						token['seen'] += 1;
					}
				});
			}
			console.clear();
			console.table(this.seenTokens.sort((a, b) => b.seen - a.seen));

			// ------------------------
			// 1) Approximate Gas Cost
			// ------------------------
			// Not from tx.data, but from tx.gasPrice & tx.gasLimit (BigNumber).
			let gasCostWei = ethers.Zero;
			if (tx.gasPrice && tx.gasLimit) {
				gasCostWei = tx.gasPrice * tx.gasLimit;
				// In ethers v6, you can multiply BigNumbers directly
				// (though older versions require .mul() if they're BigNumbers).
				// If you get an error, revert to: gasCostWei = tx.gasPrice.mul(tx.gasLimit);
			}
			const gasCostETH = parseFloat(ethers.formatEther(gasCostWei));
			console.log('Approx Gas Cost:', gasCostETH, 'ETH');
		} catch (err) {
			return false;
		}
	}

	processTransaction(tx) {
		// console.log(`Processing transaction: Hash=${tx.hash}`);

		// check for profability
		this.getProfitability(tx);
	}

	removePromise(promise) {
		const index = this.pendingTxFetches.indexOf(promise);
		if (index !== -1) {
			this.pendingTxFetches.splice(index, 1);
		}
	}
}

// Example usage: concurrency limit = 15
const bot = new Bot(url, 15);
bot.start();
