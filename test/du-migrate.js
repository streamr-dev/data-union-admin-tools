const { spawn } = require('child_process')
const assert = require('assert')

const {
    Contract,
    ContractFactory,
    providers,
    Wallet,
    BigNumber,
    utils: { formatEther, parseEther, computeAddress }
} = require('ethers')
const debug = require('debug')
const StreamrClient = require('streamr-client')

const {
    until,
    untilStreamContains,
    untilStreamMatches,
    throwIfBadAddress,
    throwIfNotContract,
    streamrFetch,
} = require('../src/utils')
const Token = require('../contracts/TestToken.json')
const DataunionVault = require('../contracts/DataunionVault.json')

const config = require('./config')

const log = debug('Streamr:signed-withdraw-server:test')
// const { log } = console

const providerMainnet = new providers.JsonRpcProvider(config.clientOptions.mainnet)
const adminWalletMainnet = new Wallet(config.clientOptions.auth.privateKey, providerMainnet)
const adminTokenMainnet = new Contract(config.clientOptions.tokenAddress, Token.abi, adminWalletMainnet)
const tokenAdminWallet = new Wallet(config.tokenAdminPrivateKey, providerMainnet)

const providerSidechain = new providers.JsonRpcProvider(config.clientOptions.sidechain)

/**
 * Deploy a new DataUnion contract and create the required joinPartStream
 * Note that the Promise resolves with an ethers.js TransactionResponse, so it's only sent to the chain at that point, but not yet deployed
 * @param {EthereumOptions} options such as blockFreezePeriodSeconds (default: 0), adminFee (default: 0)
 * @return {Promise<Contract>} has methods that can be awaited: contract is deployed (`.deployed()`), operator is started (`.isReady()`)
 */
async function deployOldDataUnion(client, options = {}) {
    const {
        blockFreezePeriodSeconds = 0,
        adminFee = 0,
        tokenAddress = client.options.tokenAddress,
        streamrNodeAddress = client.options.streamrNodeAddress,
        streamrOperatorAddress = config.streamrOperatorAddress,
        retryTimeoutMs = 60000,
        pollingIntervalMs = 5000,
    } = options
    const wallet = new Wallet(client.options.auth.privateKey, providerMainnet)

    await throwIfNotContract(wallet.provider, tokenAddress, 'options.tokenAddress')
    await throwIfBadAddress(streamrNodeAddress, 'options.streamrNodeAddress')
    await throwIfBadAddress(streamrOperatorAddress, 'options.streamrOperatorAddress')

    if (adminFee < 0 || adminFee > 1) { throw new Error('options.adminFeeFraction must be a number between 0...1, got: ' + adminFee) }
    const adminFeeBN = BigNumber.from((adminFee * 1e18).toFixed()) // last 2...3 decimals are going to be gibberish

    const stream = await client.createStream({
        name: `Join-Part-${wallet.address.slice(0, 10)}-${Date.now()}`
    })
    log(`Stream created: ${JSON.stringify(stream.toObject())}`)

    let res
    res = await stream.grantPermission('stream_get', null)
    log('Grant stream_get permission response from server', res)
    res = await stream.grantPermission('stream_subscribe', null)
    log('Grant stream_subscribe permission response from server', res)
    res = await stream.grantPermission('stream_get', streamrNodeAddress)
    log(`Grant stream_get permission response to ${streamrNodeAddress} from server`, res)
    res = await stream.grantPermission('stream_publish', streamrNodeAddress)
    log(`Grant stream_publish permission response to ${streamrNodeAddress} from server`, res)

    const deployer = new ContractFactory(DataunionVault.abi, DataunionVault.bytecode, wallet)
    const result = await deployer.deploy(streamrOperatorAddress, stream.id, tokenAddress, blockFreezePeriodSeconds, adminFeeBN)
    const { address } = result // this can be known in advance
    log(`Data Union contract @ ${address} deployment started`)

    let stats = { error: 'http GET not performed for some reason' }
    await until(async () => {
        stats = await streamrFetch(client, `/dataunions/${address}/stats`).catch(error => ({ error }))
        return !!stats.totalEarnings
    }, retryTimeoutMs, pollingIntervalMs)
    if (stats.error) {
        throw new Error(`Data Union failed to start, retried for ${retryTimeoutMs} ms. Status: ${JSON.stringify(stats)}`)
    }

    return result
}

/*
it('Runs a dry-run without error', async () => {
    const timeBeforeMs = Date.now()
    const env = {
        DEBUG: 'Streamr*'
    }
    const cmdLine = ['bin/du-migrate.js',
        '--old', '0x1F9F5Ebe4629b5BEbA6Edd94c83B4aa000C877Ed',
        '--key', config.clientOptions.auth.privateKey,
        '--factory-address', config.clientOptions.factoryMainnetAddress,
        '--streamr-ws', config.clientOptions.url,
        '--streamr-url', config.clientOptions.restUrl,
        '--ethereum-url', config.clientOptions.mainnet.url,
        '--sidechain-url', config.clientOptions.sidechain.url,
        // '--dry-run'
        '--new', '0x336AEEb386B303741AF418806d04b260922bd2EE',
    ]
    log(Object.keys(env).map(k => k + '=' + env[k] + ' ').join('') + cmdLine.join(' '))

    const scriptProcess = spawn(process.execPath, cmdLine, { env })
    scriptProcess.stdout.on('data', data => { log(`(server stdout) ${data.toString().trim()}`) })
    scriptProcess.stderr.on('data', data => { log(`(server stderr) ${data.toString().trim()}`) })
    scriptProcess.on('close', code => { log(`server exited with code ${code}`) })
    scriptProcess.on('error', err => { log(`server ERROR: ${err}`) })

    // debug library logs into stderr
    await untilStreamContains(scriptProcess.stderr, '[DONE]')
    scriptProcess.kill()

    const timeMs = Date.now() - timeBeforeMs
    log('Script took', timeMs, 'ms')
})
*/

it('Migrates an old DU to a new DU', async function test() {
    this.timeout(600000)

    log(`Connecting to Ethereum networks, config = ${JSON.stringify(config)}`)
    const network = await providerMainnet.getNetwork()
    log('Connected to "mainnet" network: ', JSON.stringify(network))
    const network2 = await providerSidechain.getNetwork()
    log('Connected to sidechain network: ', JSON.stringify(network2))
    log('Connecting to Streamr, options:', config.clientOptions)
    const adminClient = new StreamrClient(config.clientOptions)
    await adminClient.ensureConnected()
    log('Connected, session token', await adminClient.session.getSessionToken())

    log(`Minting 100 tokens to ${adminWalletMainnet.address}`)
    const tokenAdminTokenMainnet = new Contract(adminTokenMainnet.address, Token.abi, tokenAdminWallet)
    const tx1 = await tokenAdminTokenMainnet.mint(adminWalletMainnet.address, parseEther('100'))
    await tx1.wait()

    log('1) Deploy contract and create joinPartStream')
    const oldDataUnion = await deployOldDataUnion(adminClient)

    log('2) Set up Data Union in Marketplace and EE')
    log("2.2) create a stream that's going to go into the product")
    const stream = {
        name: 'Data Union HTTP API end-to-end test stream ' + Date.now(),
        description: "PLEASE DELETE ME, I'm a Data Union HTTP API end-to-end test stream",
        config: {
            fields: [{
                name: 'string',
                type: 'number',
            }]
        }
    }
    const streamCreateResponse = await streamrFetch(adminClient, '/streams', {
        method: 'POST',
        body: JSON.stringify(stream),
    }).catch(error => ({ error }))
    log(`     Response: ${JSON.stringify(streamCreateResponse)}`)
    const streamId = streamCreateResponse.id
    assert(streamId, 'Creating stream failed!')

    log('2.3) Create product in the database')
    const product = {
        name: 'Data Union HTTP API end-to-end test product ' + Date.now(),
        description: "PLEASE DELETE ME, I'm a Data Union HTTP API end-to-end test product",
        imageUrl: 'https://www.streamr.com/uploads/to-the-moon.png',
        category: 'other', // TODO: curiously, test-category-id doesn't exist in docker mysql
        streams: [streamId],
        previewStream: streamId,
        previewConfigJson: 'string',
        ownerAddress: adminWalletMainnet.address,
        beneficiaryAddress: oldDataUnion.address,
        pricePerSecond: 5,
        priceCurrency: 'DATA',
        minimumSubscriptionInSeconds: 0,
        type: 'DATAUNION',
    }
    const productCreateResponse = await streamrFetch(adminClient, '/products', {
        method: 'POST',
        body: JSON.stringify(product),
    }).catch(error => ({ error }))
    log(`     Response: ${JSON.stringify(productCreateResponse)}`)
    const productId = productCreateResponse.id
    assert(productId, 'Creating product failed!')

    log('3) Add members and revenue')
    const memberKeys = [config.clientOptions.auth.privateKey,
        '0x1110000000000000000000000000000000000000000000000000000000000001',
        '0x1110000000000000000000000000000000000000000000000000000000000002',
        '0x1110000000000000000000000000000000000000000000000000000000000003',
        '0x1110000000000000000000000000000000000000000000000000000000000004',
        '0x1110000000000000000000000000000000000000000000000000000000000005',
        '0x1110000000000000000000000000000000000000000000000000000000000006',
        '0x1110000000000000000000000000000000000000000000000000000000000007',
        '0x1110000000000000000000000000000000000000000000000000000000000008',
        '0x1110000000000000000000000000000000000000000000000000000000000009',
    ]
    const memberClients = memberKeys.map(privateKey => new StreamrClient({
        ...config.clientOptions,
        auth: { privateKey },
    }))

    log('3.1) Add data union secret')
    const secretCreateResponse = await streamrFetch(adminClient, `/dataunions/${oldDataUnion.address}/secrets`, {
        method: 'POST',
        body: JSON.stringify({
            name: "PLEASE DELETE ME, I'm a data union Product server test secret",
        }),
    }).catch(error => ({ error }))
    log(`     Response: ${JSON.stringify(secretCreateResponse)}`)
    const { secret } = secretCreateResponse
    if (!secret) { throw new Error('Setting data union secret failed!') }

    // for-loop works better here because we want sequential execution, not Promise.all style parallel
    log('3.2) Send JoinRequests and revenue')
    for (let i = 0; i < memberKeys.length; i++) {
        const memberClient = memberClients[i]
        const memberAddress = memberClient.getAddress()
        const joinResponse = await streamrFetch(memberClient, `/dataunions/${oldDataUnion.address}/joinRequests`, {
            method: 'POST',
            body: JSON.stringify({
                memberAddress,
                secret,
                metadata: { test: "PLEASE DELETE ME, I'm a data union Product server test joinRequest" },
            }),
        }).catch(error => ({ error }))
        log(`  Response: ${JSON.stringify(joinResponse)}`)
        if (joinResponse.error) { log(joinResponse.error.stack) }
        if (joinResponse.state !== 'ACCEPTED') { throw new Error(`Join failed: ${JSON.stringify(joinResponse)}`) }

        await until(async () => {
            const m = await streamrFetch(adminClient, `/dataunions/${oldDataUnion.address}/members/${memberAddress}`)
            log('  Member query response', m)
            return !!m.address
        })

        const nonce = await adminWalletMainnet.getTransactionCount()
        log('  Nonce', nonce)
        const statsBefore = await streamrFetch(adminClient, `/dataunions/${oldDataUnion.address}/stats`)
        const balanceBefore = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
        log(`  Sending ${i + 1} token(s) (out of ${formatEther(balanceBefore)}) to DataUnion contract...`)
        const transferTx = await adminTokenMainnet.transfer(oldDataUnion.address, parseEther(`${i + 1}`))
        const transferTr = await transferTx.wait(1)
        log('  Transaction with events:', transferTr.events.map(e => `${e.event}(${e.args})`).join(', '))

        await until(async () => {
            const stats = await streamrFetch(adminClient, `/dataunions/${oldDataUnion.address}/stats`).catch(error => ({ error }))
            return stats.totalEarnings !== statsBefore.totalEarnings
        }, 30000, 3000)
    }

    const oldMemberList = await streamrFetch(adminClient, `/dataunions/${oldDataUnion.address}/members`)
    log(oldMemberList)
    assert.deepStrictEqual(oldMemberList, [
        {
            active: true,
            address: '0x4178baBE9E5148c6D5fd431cD72884B07Ad855a0',
            earnings: '10000000000000000000',
            name: 'admin',
        },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => ({
            active: true,
            address: computeAddress(memberKeys[i]),
            earnings: (10 - i) + '000000000000000000',
        }))
    ])

    log('Old data union successfully set up, migrating to new data union')
    const timeBeforeMs = Date.now()

    const env = {
        DEBUG: 'Streamr:*'
    }
    const cmdLine = ['bin/du-migrate.js',
        '--old', oldDataUnion.address,
        '--key', config.clientOptions.auth.privateKey,
        '--factory-address', config.clientOptions.factoryMainnetAddress,
        '--streamr-ws', config.clientOptions.url,
        '--streamr-url', config.clientOptions.restUrl,
        '--ethereum-url', config.clientOptions.mainnet.url,
        '--sidechain-url', config.clientOptions.sidechain.url,
    ]
    log(Object.keys(env).map(k => k + '=' + env[k] + ' ').join('') + cmdLine.join(' '))

    const scriptProcess = spawn(process.execPath, cmdLine, { env })
    scriptProcess.stdout.on('data', data => { log(`(server stdout) ${data.toString().trim()}`) })
    scriptProcess.stderr.on('data', data => { log(`(server stderr) ${data.toString().trim()}`) })
    scriptProcess.on('close', code => { log(`server exited with code ${code}`) })
    scriptProcess.on('error', err => { log(`server ERROR: ${err}`) })

    const addressMatch = untilStreamMatches(scriptProcess.stdout, /"--new (.*)"/)

    // debug library logs into stderr
    await untilStreamContains(scriptProcess.stderr, '[DONE]')

    const dataUnionAddress = (await addressMatch)[1]
    scriptProcess.kill()
    log('New Data Union address', dataUnionAddress, await addressMatch)

    const timeMs = Date.now() - timeBeforeMs
    log('Script took', timeMs, 'ms')

    log('Checking everyone got their earnings in the new DU')
    const newBalances = await Promise.all(memberClients.map(client => client.getMemberBalance(null, { dataUnionAddress })))

    await providerMainnet.removeAllListeners()
    await providerSidechain.removeAllListeners()
    await adminClient.ensureDisconnected()
    await Promise.all(memberClients.map(client => client.ensureDisconnected()))

    assert.deepStrictEqual(newBalances.map(b => b.toString()), oldMemberList.map(m => m.earnings))

    // assert.strictEqual(oldDUstats.status, 'active')
    // assert.strictEqual(oldDUstats.earningsBeforeLastJoin, '0')
    // assert.strictEqual(oldDUstats.lmeAtJoin, '0')
    // assert.strictEqual(oldDUstats.totalEarnings, '1000000000000000000')
    // assert.strictEqual(oldDUstats.withdrawableEarnings, '1000000000000000000')
})
