import { Application, Router } from './deps.ts'
import { ethers } from './deps.ts'
import { config } from './deps.ts'

import {
  TransactionIntent,
  BundleTransactionSigned,
  NectarOptions,
  PayloadRPCNewAuction,
  PayloadAuctionResult,
} from './deps.ts'
import { METHOD_AUCTION_RESULT, METHOD_RPC_NEW_AUCTION } from './deps.ts'

import rpc from './RPCProxy.ts'
import publishBundle from './Publisher.ts'
import reportAddressEvent, { reportEvent } from './EventReporter.ts'

interface StoredTransactions {
  [hash: string]: {
    rawTx: string
    parsedTx: ethers.Transaction
    options?: NectarOptions
  }
}

const env = { ...config(), ...Deno.env.toObject() }
const wallet = new ethers.Wallet(env['RPC_PRIVATE_KEY'], rpc)

const transactions: StoredTransactions = {}

const app = new Application() // { logErrors: false }
const port = parseInt(env['PORT'] || '8000')

const router = new Router()

const auctionConnection = new WebSocket(`${env['AUCTION_URL']}/rpc?address=${wallet.address}`)

auctionConnection.onopen = () => {
  console.log('Connected to auction', env['AUCTION_URL'])
}

auctionConnection.onerror = function (e) {
  console.log('auction connection error', e)
}

auctionConnection.onmessage = async (m) => {
  try {
    const body = JSON.parse(m.data)
    const { method, data } = body
    console.log('\nAuction message:', method)
    if (method === METHOD_AUCTION_RESULT) {
      const { hash, hasWinner, bundle } = data as PayloadAuctionResult['data']
      const userAddress = transactions[hash].parsedTx.from || '0x0'
      if (hasWinner) {
        console.log('There is a winning bundle with', bundle.length, 'items')

        reportAddressEvent(userAddress, `RPC: Received winning auction bundle for tx ${hash} with ${bundle.length} txs`)
        // validate options
        // console.log(hash, bundle)
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
        // console.log('transaction bundle formed', transactionBundle)

        reportAddressEvent(userAddress, `RPC: Sent bundle with tx ${hash} to be published`)
        const publishOutcome = await publishBundle(transactionBundle, hash, userAddress)
        if (publishOutcome) {
          reportAddressEvent(userAddress, `RPC: Bundle with tx ${hash} included in a block!`)
          console.log('Bundle published!')
        } else {
          console.log('Error during bundle publishing')
          reportAddressEvent(userAddress, `RPC: Publishing bundle with tx ${hash} failed.`)
        }
      } else {
        console.log('No auction bids, delivering transaction normally')
        reportAddressEvent(userAddress, `RPC: No bids received for tx ${hash}, publishing publicly`)
        const out = await rpc.send('eth_sendRawTransaction', [transactions[hash].rawTx])
        console.log('eth_sendRawTransaction response', out)
      }
    }
  } catch (e) {
    console.error(e)
    console.error('cannot parse message', m.data)
  }
}

function isMEVSafe(tx: ethers.Transaction) {
  if (tx.to === '0x328E07B5b09a8c9e01A849C8d8f246d56ed3ec75') {
    return true
  }
  if (tx.data === '0x0') {
    return true
  }
  return false
}

router.post('/', async (ctx) => {
  const body = await ctx.request.body({ type: 'json' }).value
  const { method, params, id, jsonrpc } = body
  // console.log('POST', method, params, id, jsonrpc)

  try {
    if (method === 'eth_sendRawTransaction') {
      const rawTx: string = params[0]
      // console.log('signed:', rawTx)
      const parsed = ethers.utils.parseTransaction(rawTx)
      const { hash } = parsed
      if (!hash) throw new Error('Transaction has no hash')

      if (hash in transactions) {
        // parsed.from && reportAddressEvent(parsed.from, `RPC: Repeated tx ${hash} ignored`)
        console.log('Received a repeated submission of', hash, 'Ignoring')
        ctx.response.body = { id, jsonrpc, result: hash }
        return
      }

      console.log('Received new tx', parsed)
      parsed.from && reportAddressEvent(parsed.from, `RPC: Received tx ${hash}`)

      if (isMEVSafe(parsed)) {
        reportAddressEvent(parsed.from!, `RPC: Tx ${hash} is MEV-safe, publishing publicly`)
        const out = await rpc.send('eth_sendRawTransaction', [rawTx])
        console.log('eth_sendRawTransaction response', out)
      } else {
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
        parsed.from && reportAddressEvent(parsed.from, `RPC: Sent tx ${hash} to auction`)
      }

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

reportEvent('RPC node booted')
console.log(`RPC Server is running at http://localhost:${port}`)

await app.listen({ port: port })
