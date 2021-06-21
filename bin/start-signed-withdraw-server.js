#!/usr/bin/env node

const usage = `
Usage: SERVER_PRIVATE_KEY=0x1234... DATA_UNION_ADDRESS=0x1234... start-signed-withdraw-server.js

SERVER_PRIVATE_KEY is the Ethereum key that will be used for paying the transaction fees
                   so the account must have ETH in it

DATA_UNION_ADDRESS is the Ethereum address or comma-separated list of Ethereum addresses,
                   of the data union whose withdraws are handled by this server (default: handle all)

PORT is where the HTTP server listens for incoming connections (default: 3000)

ETHEREUM_MAINNET is the Ethereum (mainnet) node used for sending the transactions (default: ethers.js)
ETHEREUM_SIDECHAIN is the sidechain url used to talk to the binance adapter
`

const { utils: { getAddress, isAddress, isHexString, parseUnits } } = require('ethers')
const express = require('express')
const bodyParser = require('body-parser')
const StreamrClient = require('streamr-client')
const consoleStamper = require('console-stamp')

const {
    SERVER_PRIVATE_KEY,
    PORT = 3000,
    DATA_UNION_ADDRESS,

    ETHEREUM_MAINNET, // default: mainnet
    ETHEREUM_SIDECHAIN, // default: production (once available)
    GAS_PRICE_GWEI,
    TOKEN_ADDRESS,
    TOKEN_ADDRESS_SIDECHAIN,

    STREAMR_WS_URL, // default: production
    STREAMR_HTTP_URL, // default: production

    FACTORY_MAINNET_ADDRESS,
    FACTORY_SIDECHAIN_ADDRESS,

    PAY_FOR_SIGNATURE_TRANSPORT, // default: yes

    STREAMR_NODE_ADDRESS,
    BINANCE_ADAPTER,
    QUIET,
} = process.env

if (!SERVER_PRIVATE_KEY) {
    console.log(usage)
    process.exit(1)
}

let duWhitelist
if (DATA_UNION_ADDRESS) {
    duWhitelist = DATA_UNION_ADDRESS.split(',').map(getAddress)
}

const serverStreamrOptions = {}
if (FACTORY_MAINNET_ADDRESS) { serverStreamrOptions.factoryMainnetAddress = getAddress(FACTORY_MAINNET_ADDRESS) }
if (FACTORY_SIDECHAIN_ADDRESS) { serverStreamrOptions.factorySidechainAddress = getAddress(FACTORY_SIDECHAIN_ADDRESS) }
if (TOKEN_ADDRESS) { serverStreamrOptions.tokenAddress = getAddress(TOKEN_ADDRESS) }
if (TOKEN_ADDRESS_SIDECHAIN) { serverStreamrOptions.tokenAddressSidechain = getAddress(TOKEN_ADDRESS_SIDECHAIN) }
if (STREAMR_NODE_ADDRESS) { serverStreamrOptions.streamrNodeAddress = getAddress(STREAMR_NODE_ADDRESS) }

if (STREAMR_WS_URL) { serverStreamrOptions.url = STREAMR_WS_URL }
if (STREAMR_HTTP_URL) { serverStreamrOptions.restUrl = STREAMR_HTTP_URL }
if (PAY_FOR_SIGNATURE_TRANSPORT) { serverStreamrOptions.payForSignatureTransport = !!PAY_FOR_SIGNATURE_TRANSPORT }
if (ETHEREUM_MAINNET) { serverStreamrOptions.mainnet = ETHEREUM_MAINNET }
if (ETHEREUM_SIDECHAIN) { serverStreamrOptions.sidechain = ETHEREUM_SIDECHAIN }
if (BINANCE_ADAPTER) { serverStreamrOptions.binanceAdapterAddress = BINANCE_ADAPTER }

consoleStamper(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })

function getStreamrClient(dataUnion) {
    const streamrOptions = {
        ...serverStreamrOptions,
        auth: { privateKey: SERVER_PRIVATE_KEY },
        dataUnion,
    }
    console.log(`Creating StreamrClient with ${JSON.stringify(streamrOptions)}`)
    return new StreamrClient(streamrOptions)
}

const app = express()

// parse application/json
app.use(bodyParser.json())
app.post('/binanceAdapterSetRecipient', (req, res) => {
    const {
        memberAddress,
        binanceRecipientAddress,
        signature
    } = req.body
    console.log(`Received request to set binance recipient for ${memberAddress} as ${binanceRecipientAddress}. signature ${signature}`)
    if (!isAddress(memberAddress)) {
        res.send({ error: 'memberAddress parameter not found or invalid Ethereum address' })
        return
    }

    if (!isAddress(binanceRecipientAddress)) {
        res.send({ error: 'recipientAddress parameter not found or invalid Ethereum address' })
        return
    }

    if (!isHexString(signature) || signature.length !== 132) {
        res.send({ error: 'signature parameter not found or invalid signature' })
        return
    }

    const client = getStreamrClient({})
    console.log(`Calling setBinanceDepositAddressFromSignature("${memberAddress}", "${binanceRecipientAddress}", "${signature}"`)
    client.setBinanceDepositAddressFromSignature(
        memberAddress,
        binanceRecipientAddress,
        signature,
    ).then((tr) => {
        res.send({ transaction: tr.transactionHash })
        return client.ensureDisconnected()
    }).catch((e) => {
        res.send({ error: e.message, stack: e.stack })
    })
})

app.post('/', (req, res) => {
    const {
        dataUnionAddress,
        memberAddress,
        recipientAddress,
        signature,
        tokenAddress,
    } = req.body

    console.log(`Received request ${memberAddress} -> ${recipientAddress} signature ${signature}`)

    // TODO: once tests pass, move code below this to src/signed-withdraw

    if (!isAddress(dataUnionAddress)) {
        res.send({ error: 'dataUnionAddress parameter not found or invalid Ethereum address' })
        return
    }
    const dataUnion = getAddress(dataUnionAddress) // case normalization

    if (duWhitelist && duWhitelist.indexOf(dataUnion) < 0) {
        res.send({ error: `Data Union at ${dataUnionAddress} is not handled by this server` })
        return
    }

    if (!isAddress(memberAddress)) {
        res.send({ error: 'memberAddress parameter not found or invalid Ethereum address' })
        return
    }

    if (!isAddress(recipientAddress)) {
        res.send({ error: 'recipientAddress parameter not found or invalid Ethereum address' })
        return
    }

    if (!isHexString(signature) || signature.length !== 132) {
        res.send({ error: 'signature parameter not found or invalid signature' })
        return
    }
    const withdrawOptions = {}
    if (GAS_PRICE_GWEI) { withdrawOptions.gasPrice = parseUnits(GAS_PRICE_GWEI, 'gwei') }

    const client = getStreamrClient(dataUnion)

    console.log(`Calling withdrawToSigned("${memberAddress}", "${recipientAddress}", "${signature}", ${JSON.stringify(withdrawOptions)})`)
    client.withdrawToSigned(
        memberAddress,
        recipientAddress,
        signature,
        withdrawOptions
    ).then((tr) => {
        res.send({ transaction: tr.transactionHash })
        return client.ensureDisconnected()
    }).catch((e) => {
        res.send({ error: e.message, stack: e.stack })
    })
})

app.listen(PORT, () => {
    console.log(`Signed Withdraw Server started at http://localhost:${PORT}`)
    if (duWhitelist) {
        console.log('Whitelisted data unions:')
        duWhitelist.forEach((address) => console.log(` * ${address}`))
    } else {
        console.log('WARNING: no data union whitelist given, will handle any valid incoming signed withdraw requests')
    }
})
