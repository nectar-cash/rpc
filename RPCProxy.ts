import { ethers } from 'npm:ethers@^5.7.2'
import { config } from './deps.ts'

// const rpcUrl = 'https://eth-mainnet.public.blastapi.io'; // Mainnet
const rpcUrl = `https://goerli.infura.io/v3/${config()['INFURA_GOERLI_KEY']}` // Goerli -- just in case
const rpc = new ethers.providers.JsonRpcProvider(rpcUrl)

export default rpc
