import { FlashbotsBundleProvider } from './deps.ts'
import { ethers } from './deps.ts'
import { config } from './deps.ts'

import { BundleTransactionSigned } from './deps.ts'

import reportAddressEvent from './EventReporter.ts'

import rpc from './RPCProxy.ts'

const env = { ...config(), ...Deno.env.toObject() }
const wallet = new ethers.Wallet(env['RPC_PRIVATE_KEY'], rpc)

const flashbotsProvider = await FlashbotsBundleProvider.create(
  rpc, // a normal ethers.js provider, to perform gas estimiations and nonce lookups
  wallet, // ethers.js signer wallet, only for signing request payloads, not transactions
  'https://relay-goerli.flashbots.net/',
  'goerli'
)

const transactions: {
  [hash: string]: {
    bundle: BundleTransactionSigned[]
    signedTransactions: string[]
    userAddress: string
    bundleIncluded: boolean
    firstBlock: number
    lastPassedBlockWithoutInclusion: number
    lastTargetedBlock: number
  }
} = {}

const deliverPayloadForBlock = async (userTxHash: string): Promise<boolean> => {
  if (transactions[userTxHash].bundleIncluded) {
    return true
  }

  const targetBlockNumber = transactions[userTxHash].lastTargetedBlock + 1
  transactions[userTxHash].lastTargetedBlock = targetBlockNumber
  // if (targetBlockNumber - transactions[userTxHash].lastPassedBlockWithoutInclusion < 5) {
  //   // scheduling at least 5 in advance
  //   return await deliverPayloadForBlock(userTxHash, bundle, signedTransactions)
  // }

  const simulation = await flashbotsProvider.simulate(transactions[userTxHash].signedTransactions, targetBlockNumber)
  if ('error' in simulation) {
    reportAddressEvent(transactions[userTxHash].userAddress, `Publisher: Tx ${userTxHash} bundle simulation failed.`)
    console.log(
      'Simulation failed for tx',
      userTxHash,
      'for block',
      targetBlockNumber,
      'reason:',
      simulation.error.message
    )
    return false
  } else {
    const flashbotsTransactionResponse = await flashbotsProvider.sendBundle(
      transactions[userTxHash].bundle,
      targetBlockNumber
    )
    // console.log('Flashbots Transaction Response', targetBlockNumber, flashbotsTransactionResponse)

    if ('error' in flashbotsTransactionResponse) {
      reportAddressEvent(transactions[userTxHash].userAddress, `Publisher: Flashbots error.`)
      console.error('Response error', targetBlockNumber, flashbotsTransactionResponse.error.message)
      return false
    } else {
      // const receipts = await flashbotsTransactionResponse.receipts()
      // console.log('receipts', targetBlockNumber, receipts)

      const resolution = await flashbotsTransactionResponse.wait()

      const resolutionStrings = ['Bundle Included', 'Block Passed Without Inclusion', 'Account Nonce Too High']
      let logString = ''
      if (resolution === 0) {
        logString = `Publisher: Bundle with tx ${userTxHash} included in a Flashbots-built block ${targetBlockNumber}!`
      } else if (resolution === 1) {
        logString = `Publisher: Block ${targetBlockNumber} not built by Flashbots, does not contain the bundle with tx ${userTxHash}`
      } else if (resolution === 2) {
        logString = `Publisher: Tx with a higher nonce than tx ${userTxHash} found! Bundle will not be included.`
      }
      console.log('Flashbots wait complete: block', targetBlockNumber, 'resolved with:', resolutionStrings[resolution])
      reportAddressEvent(transactions[userTxHash].userAddress, logString)

      if (resolution === 0) {
        console.log('BUNDLE INCLUDED IN THE BLOCK', targetBlockNumber)
        transactions[userTxHash].bundleIncluded = true
        return true
      } else if (resolution === 1) {
        transactions[userTxHash].lastPassedBlockWithoutInclusion = targetBlockNumber
        return await deliverPayloadForBlock(userTxHash)
      } else {
        return false
      }
    }
  }
}

export default async function publishBundle(
  bundle: BundleTransactionSigned[],
  userTxHash: string,
  userAddress: string
) {
  const currentBlockNumber = await rpc.getBlockNumber()
  const signedTransactions = await flashbotsProvider.signBundle(bundle)

  transactions[userTxHash] = {
    bundle,
    signedTransactions,
    userAddress,
    bundleIncluded: false,
    firstBlock: currentBlockNumber + 1,
    lastPassedBlockWithoutInclusion: currentBlockNumber,
    lastTargetedBlock: currentBlockNumber,
  }

  /**
   * Publisher plan
   * 1. schedule a block
   * 2. block scheduling function updates lastTargetedBlock
   * 3. if last targeted block is not 5 away from lastPassedBlockWithoutInclusion, schedule recursively
   * 4. return true if included
   * 5. return true if the recursively scheduled block returns
   * 6. if scheduled block wait ends with status > 0, schedule next block
   */

  return await deliverPayloadForBlock(userTxHash)
}
