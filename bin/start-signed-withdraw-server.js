#!/usr/bin/env node

const usage = `
Usage: SERVER_PRIVATE_KEY=0x1234... DATA_UNION_ADDRESS=0x1234... start-signed-withdraw-server.js

SERVER_PRIVATE_KEY is the Ethereum key that will be used for paying the transaction fees
                   so the account must have ETH in it

DATA_UNION_ADDRESS is the Ethereum address or comma-separated list of Ethereum addresses,
                   of the data union whose withdraws are handled by this server (default: handle all)

PORT is where the HTTP server listens for incoming connections (default: 3000)

ETHEREUM_URL is the Ethereum (mainnet) node used for sending the transactions (default: ethers.js)
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

    ETHEREUM_URL, // explicitly specify Ethereum node address
    GAS_PRICE_GWEI,
} = process.env

if (!SERVER_PRIVATE_KEY) {
    console.log(usage)
    process.exit(1)
}

let duWhitelist
if (DATA_UNION_ADDRESS) {
    duWhitelist = DATA_UNION_ADDRESS.split(',').map(getAddress)
}

consoleStamper(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })
const app = express()

// parse application/json
app.use(bodyParser.json())

app.post('/', (req, res) => {
    const {
        dataUnionAddress,
        memberAddress,
        recipientAddress,
        signature,
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

    const ethersOptions = {}
    if (GAS_PRICE_GWEI) { ethersOptions.gasPrice = parseUnits(GAS_PRICE_GWEI, 'gwei') }

    const streamrOptions = {
        auth: { privateKey: SERVER_PRIVATE_KEY },
        dataUnion,
    }
    if (ETHEREUM_URL) { streamrOptions.mainnet = { url: ETHEREUM_URL } }

    const client = new StreamrClient(streamrOptions)

    // signature = await client.signWithdrawTo(recipientAddress, options)
    console.log(`Calling withdrawToSigned("${memberAddress}", "${recipientAddress}", "${signature}", ${JSON.stringify(ethersOptions)})`)
    client.withdrawToSigned(
        memberAddress,
        recipientAddress,
        signature,
        ethersOptions
    ).then((tr) => {
        res.send({ transaction: tr.hash })
        return client.ensureDisconnected()
    }).catch((e) => {
        res.send({ error: e.message })
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
