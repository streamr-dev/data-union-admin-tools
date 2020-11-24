#!/usr/bin/env node

const usage = `
Usage: privateKey=0x1234... port=3000 start-signed-withdraw-server.js

privateKey is the Ethereum key that will be used for paying the transaction fees
           so the account must have ETH in it

port is where the HTTP server listens for incoming connections
`

const { utils: { isAddress, isHexString }, BigNumber } = require("ethers")
const express = require("express")
const bodyParser = require("body-parser")
const StreamrClient = require("streamr-client")
const consoleStamper = require("console-stamp")

const {
    privateKey,
    port = 3000,
} = process.env

if (!privateKey) {
    console.log(usage)
    process.exit(1)
}

const client = new StreamrClient({
    auth: {
        privateKey
    }
})

consoleStamper(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })
const app = express()

// parse application/json
app.use(bodyParser.json())

app.post("/", (req, res) => {
    const {
        memberAddress,
        recipientAddress,
        signature,
    } = req.body

    console.log(`Received request ${memberAddress} -> ${recipientAddress} signature ${signature}`)

    if (!isAddress(memberAddress)) {
        res.send({ error: "memberAddress parameter not found or invalid Ethereum address" })
        return
    }

    if (!isAddress(recipientAddress)) {
        res.send({ error: "recipientAddress parameter not found or invalid Ethereum address" })
        return
    }

    if (!isHexString(signature) || !signature.length !== 132) {
        res.send({ error: "signature parameter not found or invalid signature" })
        return
    }

    const options = {
        // gasPrice
    }

    // signature = await client.signWithdrawTo(recipientAddress, options)
    client.withdrawToSigned(memberAddress, recipientAddress, signature, options).then(tr => {
        res.send({
            txHash: tr.hash,
        })
    }).catch(e => {
        res.send({
            error: e.message,
        })
    })
})

app.listen(port, () => {
    console.log(`Signed Withdraw Server started at http://localhost:${port}`)
})
