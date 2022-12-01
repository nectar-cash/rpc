import { Application, Router } from './deps.ts'
import { parse } from './deps.ts'
import { ethers } from './deps.ts'
import { config } from './deps.ts'
import { FlashbotsBundleProvider } from './deps.ts'

import {
  TransactionIntent,
  BundleTransactionSigned,
  NectarOptions,
  PayloadRPCNewAuction,
  PayloadAuctionResult,
} from './deps.ts'
import { METHOD_AUCTION_RESULT, METHOD_RPC_NEW_AUCTION } from './deps.ts'

import rpc from './RPCProxy.ts'

interface StoredTransactions {
  [hash: string]: {
    rawTx: string
    parsedTx: ethers.Transaction
    options?: NectarOptions
  }
}

const env = config()
const wallet = new ethers.Wallet(env['RPC_PRIVATE_KEY'], rpc)

const flags = parse(Deno.args, { string: ['auction', 'address', 'publisher'] })
console.log('Auction URL:', flags.auction)

const transactions: StoredTransactions = {}

const app = new Application() // { logErrors: false }
const port = parseInt(env['PORT'] || '11010')

const router = new Router()

const auctionConnection = new WebSocket(`${flags.auction}/rpc?address=${flags.address}`)

auctionConnection.onmessage = async (m) => {
  try {
    const body = JSON.parse(m.data)
    const { method, data } = body
    console.log('\nAuction message:', method)
    if (method === METHOD_AUCTION_RESULT) {
      const { hash, hasWinner, bundle } = data as PayloadAuctionResult['data']
      if (hasWinner) {
        console.log('There is a winning bundle with', bundle.length, 'items')
        // TODO validate options
        // TODO create actual flashbots bundle
        console.log(hash, bundle)
        const transactionBundle = bundle.map((item) => {
          if (item.signedTransaction) {
            return item
          } else if (item.hash && transactions[item.hash]) {
            return {
              signedTransaction: transactions[item.hash].rawTx,
            }
          } else {
            console.error('unsupported transaction in bundle!')
          }
        }) as BundleTransactionSigned[]

        console.log(transactionBundle)

        // Flashbots provider requires passing in a standard provider
        const flashbotsProvider = await FlashbotsBundleProvider.create(
          rpc, // a normal ethers.js provider, to perform gas estimiations and nonce lookups
          wallet, // ethers.js signer wallet, only for signing request payloads, not transactions
          'https://relay-goerli.flashbots.net/',
          'goerli'
        )

        const targetBlockNumber = (await rpc.getBlockNumber()) + 1
        console.log(targetBlockNumber)

        const signedTransactions = await flashbotsProvider.signBundle(transactionBundle)
        console.log(JSON.stringify(signedTransactions))

        const simulation = await flashbotsProvider.simulate(signedTransactions, targetBlockNumber)
        console.log(JSON.stringify(simulation, null, 2))

        const flashbotsTransactionResponse = await flashbotsProvider.sendBundle(transactionBundle, targetBlockNumber)
        console.log(flashbotsTransactionResponse)

        // const resp = await fetch(`${flags.publisher}/bundle`, {
        //   method: 'POST',
        //   headers: {
        //     'Content-Type': 'application/json',
        //     'X-API-Key': 'nectar',
        //   },
        //   body: JSON.stringify({ bundle }),
        // })
        // console.log(resp)
      } else {
        // await rpc.send('eth_sendRawTransaction', [transactions[hash].rawTx])
      }
    }
  } catch (e) {
    console.error(e)
    console.error('cannot parse message', m.data)
  }

  // TODO handle winning bundles
  // TODO handle concluded without bids
}

router.post('/', async (ctx) => {
  const body = await ctx.request.body({ type: 'json' }).value
  const { method, params, id, jsonrpc } = body
  console.log('POST', method, params, id, jsonrpc)

  try {
    if (method === 'eth_sendRawTransaction') {
      const rawTx: string = params[0]
      console.log('signed:', rawTx)
      const parsed = ethers.utils.parseTransaction(rawTx)
      console.log('Parsed Tx', parsed)
      const { hash } = parsed

      if (!hash) throw new Error('Transaction has no hash')

      const nectarOptions: NectarOptions = {
        onlyBackrun: false,
        rewardAddress: parsed.from || ethers.constants.AddressZero,
      }

      transactions[hash] = {
        rawTx,
        parsedTx: parsed,
        options: nectarOptions ?? {},
      }

      const txIntent = {
        ...parsed,
        v: undefined,
        r: undefined,
        s: undefined,
      } as TransactionIntent

      const newAuctionPayload: PayloadRPCNewAuction = {
        method: METHOD_RPC_NEW_AUCTION,
        data: {
          hash,
          tx: txIntent,
          options: nectarOptions,
        },
      }
      auctionConnection.send(JSON.stringify(newAuctionPayload))

      ctx.response.body = { id, jsonrpc, result: hash }
    } else {
      const rpcResponse = await rpc.send(method, params)
      ctx.response.body = { id, jsonrpc, result: rpcResponse }
    }
  } catch (error) {
    ctx.response.body = { id, jsonrpc, error: { code: -32603, message: error } }
  }
})

app.use(router.routes())
app.use(router.allowedMethods())

console.log(`RPC Server is running at http://localhost:${port}`)
await app.listen({ port: port })
