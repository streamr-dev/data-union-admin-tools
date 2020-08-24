#!/usr/bin/env node
const StreamrClient = require('streamr-client')
const ethers = require('ethers')
const express = require('express')
const app = express()

require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })

const options = require('yargs')
    .usage('Usage: $0 --private-key [privateKeyHex] ...')
    .option('private-key', {
        default: undefined,
        describe: 'Ethereum private key of the Data Union admin or join agent',
    })
    .option('ethereum-rpc', {
        type: 'string',
        describe: 'Ethereum RPC URL to use',
        default: undefined,
    })
    .option('validation-logic', {
        type: 'string',
        describe: 'Loads the desired join request validation logic from src/joinserver folder. The default \'hardcoded\' logic is a dummy logic that accepts requests that supply a hard-coded secret.',
        default: 'hardcoded',
    })
    .option('port', {
        type: 'number',
        describe: 'TCP port to listen on for HTTP requests',
        default: 16823,
    })
    .demandOption(['private-key'])
    .argv;

const privateKeyWithPrefix = (options['private-key'].startsWith('0x') ? '' : '0x') + options['private-key']
const wallet = new ethers.Wallet(privateKeyWithPrefix)
console.log(`Configured with a private key for address: ${wallet.address}`)

// Load the specified validation logic
const ValidationLogic = require('../src/joinserver/' + options['validation-logic'])
const logic = new ValidationLogic(options)
console.log(`Validation logic: ${options['validation-logic']}`)

/**
 * StreamrClient setup
 */
const clientConfig = {
    auth: {
        privateKey: options['private-key']
    }
}

if (options['ethereum-rpc']) {
    clientConfig.ethereumRpc = options['ethereum-rpc'] // TODO: does not exist, need to make this configurable in client!
}

// Create client
const streamr = new StreamrClient(clientConfig)
streamr.on('error', (err) => {
    console.error(err)
})

// Configure HTTP server
app.use(express.json());
app.post('/:mainchainContractAddress/:memberAddress', async (req, res) => {
    // Has this address already joined?
    try {
        const stats = await streamr.getMemberStats(req.params.mainchainContractAddress, req.params.memberAddress)
        if (stats.active) {
            const msg = `Address ${req.params.memberAddress} is already a member of Data Union ${req.params.mainchainContractAddress}`
            console.log(msg)
            res.status(400).send({
                code: 'ALREADY_JOINED',
                message: msg
            })
            return
        }
    } catch (err) {
        // Attempt to join if the status could not be verified in advance
    }

    // Call validation logic. Throws on failure.
    try {
        logic.validate(
            req.params.mainchainContractAddress,
            req.params.memberAddress,
            req.body
        )
    } catch (err) {
        const msg = `Address ${req.params.memberAddress} failed validation while attempting to join Data Union ${req.params.mainchainContractAddress}. Error: ${err.message}`
        console.log(msg)
        res.status(400).send({
            code: 'VALIDATION_FAILED',
            message: msg
        })
        return
    }

    // Join the member! (assumption: promise resolves when added successfully)
    try {
        await streamr.addMembers(req.params.mainchainContractAddress, [req.params.memberAddress])
    } catch (err) {
        console.error(err)
        res.status(500).send({
            code: 'JOIN_FAILED',
            message: `Failed to add member ${req.params.memberAddress} to join Data Union ${req.params.mainchainContractAddress}. The error was: ${err.message}`
        })
        return
    }

    // Verify by querying stats after joining
    try {
        const stats = await streamr.getMemberStats(req.params.mainchainContractAddress, req.params.memberAddress)
        if (!stats.active) {
            const msg = `Failed to add member ${req.params.memberAddress} to join Data Union ${req.params.mainchainContractAddress}. The member never became active.`
            console.error(msg)
            res.status(500).send({
                code: 'JOIN_FAILED',
                message: msg,
            })
        } else {
            res.status(200).send(stats)
        }
    } catch (err) {
        console.error(err)
        res.status(500).send({
            code: 'STATE_UNREACHABLE',
            message: `Could not verify that the member ${req.params.memberAddress} joined Data Union ${req.params.mainchainContractAddress} successfully, because the Data Union state could not be retrieved.`
        })
    }
})

console.log(`Port: ${options.port}`)
app.listen(options.port, () => {
    console.log('Data Union join server started.')
})

// Log unhandled rejection traces
process.on('unhandledRejection', (err, p) => {
    console.error('Unhandled Rejection at: Promise', p, 'err:', err, `stack:`, err.stack)
})
