const { spawn } = require('child_process')
const assert = require('assert')

const {
    Contract,
    ContractFactory,
    providers,
    Wallet,
    BigNumber,
    utils: { formatEther, parseEther }
} = require('ethers')
const debug = require('debug')
const StreamrClient = require('streamr-client')
const fetch = require('node-fetch')

const {
    until,
    untilStreamContains,
    throwIfBadAddress,
    throwIfNotContract,
    httpGet,
    sleep,
} = require('../src/utils')
const Token = require('../contracts/TestToken.json')
const DataUnionSidechain = require('../contracts/DataUnionSidechain.json')
const DataunionVault = require('../contracts/DataunionVault.json')

const config = require('./config')

const PORT = 4567
const log = debug('Streamr:signed-withdraw-server:test')
// const { log } = console

const providerSidechain = new providers.JsonRpcProvider(config.clientOptions.sidechain)
const providerMainnet = new providers.JsonRpcProvider(config.clientOptions.mainnet)
const adminWalletMainnet = new Wallet(config.clientOptions.auth.privateKey, providerMainnet)
const adminWalletSidechain = new Wallet(config.clientOptions.auth.privateKey, providerSidechain)

const tokenAdminWallet = new Wallet(config.tokenAdminPrivateKey, providerMainnet)
const tokenMainnet = new Contract(config.clientOptions.tokenAddress, Token.abi, tokenAdminWallet)

/**
 * Deploy a new DataUnion contract and create the required joinPartStream
 * Note that the Promise resolves with an ethers.js TransactionResponse, so it's only sent to the chain at that point, but not yet deployed
 * @param {EthereumOptions} options such as blockFreezePeriodSeconds (default: 0), adminFee (default: 0)
 * @return {Promise<Contract>} has methods that can be awaited: contract is deployed (`.deployed()`), operator is started (`.isReady()`)
 */
async function deployOldDataUnion(client, options) {
    const {
        blockFreezePeriodSeconds = 0,
        adminFee = 0,
        tokenAddress = client.options.tokenAddress,
        streamrNodeAddress = client.options.streamrNodeAddress,
        streamrOperatorAddress = client.options.streamrOperatorAddress,
        retryTimeoutMs = 10000,
        pollingIntervalMs = 100,
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

    let stats
    const error = await until(async () => {
        stats = await httpGet(this, address, '/stats')
        return !!stats.dataUnion
    }, retryTimeoutMs, pollingIntervalMs).catch((e) => e) // return error if caught
    if (stats.error) {
        throw new Error(`Data Union failed to start, retried for ${retryTimeoutMs} ms. Status: ${JSON.stringify(stats)}. ${error || ''}`)
    }

    return result
}

it('Migrates an old DU to a new DU', async function () {
    this.timeout(300000)

    log(`Connecting to Ethereum networks, config = ${JSON.stringify(config)}`)
    const network = await providerMainnet.getNetwork()
    log('Connected to "mainnet" network: ', JSON.stringify(network))
    const network2 = await providerSidechain.getNetwork()
    log('Connected to sidechain network: ', JSON.stringify(network2))

    log(`Minting 100 tokens to ${adminWalletMainnet.address}`)
    const tx1 = await tokenMainnet.mint(adminWalletMainnet.address, parseEther('100'))
    await tx1.wait()

    const adminClient = new StreamrClient(config.clientOptions)
    await adminClient.ensureConnected()

    log('Get Streamr session token')
    const sessionToken = await adminClient.session.getSessionToken()
    log('Session token: ' + sessionToken)
    assert(sessionToken, 'Opening session failed!')

    // wrap fetch; with the Authorization header the noise is just too much...
    async function GET(url) {
        const resp = await fetch(config.clientOptions.restUrl + url, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
        return resp.json()
    }
    async function POST(url, bodyObject, sessionTokenOverride, methodOverride) {
        const resp = await fetch(config.clientOptions.restUrl + url, {
            method: methodOverride || 'POST',
            body: JSON.stringify(bodyObject),
            headers: {
                Authorization: `Bearer ${sessionTokenOverride || sessionToken}`,
                'Content-Type': 'application/json',
            }
        })
        return resp.json()
    }
    async function PUT(url, bodyObject) {
        return POST(url, bodyObject, null, 'PUT')
    }

    log('1) Create a new Data Union')

    log('1.1) Deploy contract and create joinPartStream')
    const oldDataUnion = deployOldDataUnion({
        wallet: adminWalletMainnet,
        tokenAddress: tokenMainnet.address,
    })

    log(`1.2) Wait until Operator starts t=${Date.now()}`)
    let stats = { error: true }
    const statsTimeout = setTimeout(() => { throw new Error('Response from E&E: ' + JSON.stringify(stats)) }, 100000)
    let sleepTime = 100
    while (stats.error) {
        await sleep(sleepTime *= 2)
        stats = await GET(`/dataunions/${oldDataUnion.address}/stats`).catch(() => ({ error: true }))
        log(`     Response t=${Date.now()}: ${JSON.stringify(stats)}`)
    }
    clearTimeout(statsTimeout)

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
    const streamCreateResponse = await POST('/streams', stream)
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
    const productCreateResponse = await POST('/products', product)
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

    log('3.1) Add data union secret')
    const secretCreateResponse = await POST(`/dataunions/${oldDataUnion.address}/secrets`, {
        name: "PLEASE DELETE ME, I'm a data union Product server test secret",
    })
    log(`     Response: ${JSON.stringify(secretCreateResponse)}`)
    const { secret } = secretCreateResponse
    if (secret) { throw new Error('Setting data union secret failed!') }

    log('3.2) Send JoinRequests and revenue')
    for (let i = 0; i < memberKeys.length; i++) {
        const key = memberKeys[i]
        const memberAddress = computeAddress(key)
        const tempClient = new StreamrClient({
            ...config.clientOptions,
            auth: { privateKey: key },
        })
        const memberSessionToken = await tempClient.session.getSessionToken()
        const joinResponse = await POST(`/dataunions/${oldDataUnion.address}/joinRequests`, {
            memberAddress,
            secret,
            metadata: { test: "PLEASE DELETE ME, I'm a data union Product server test joinRequest" },
        }, memberSessionToken)
        log(`  Response: ${JSON.stringify(joinResponse)}`)
        if (!joinResponse.code) { throw new Error(`Join failed: ${JSON.stringify(joinResponse)}`) }

        await until(async () => {
            const m = await GET(`/dataunions/${oldDataUnion.address}/members/${memberAddress}`)
            log(memberAddress, m)
            return !!m.earnings
        })
        await tempClient.ensureDisconnected()

        const revenue = parseEther(`${i + 1}`)
        const balance = await tokenMainnet.balanceOf(adminWalletMainnet.address)
        log(`  Sending ${i + 1} tokens (remaining balance: ${formatEther(balance)}) to DataUnion contract...`)

        const statsBefore = await GET(`/dataunions/${oldDataUnion.address}/stats`)
        const transferTx = await tokenMainnet.transfer(oldDataUnion.address, parseEther(revenue))
        await transferTx.wait()

        await until(async () => {
            const statsAfter = await GET(`/dataunions/${oldDataUnion.address}/stats`)
            log('  Stats after transfer', statsAfter)
            return statsAfter.totalEarnings !== statsBefore.totalEarnings
        })
    }

    const members = await GET(`/dataunions/${oldDataUnion.address}/members`)
    log(members)
    console.log(JSON.stringify(members))
    assert.deepStrictEqual(members, [
        {}
    ])

    const timeBeforeMs = Date.now()

    const env = {
        DEBUG: 'Streamr:*'
    }
    const executable = 'bin/du-migrate.js '
        + '--old ' + oldDataUnion.address
        + '--key ' + config.clientOptions.auth.privateKey
        + '--'
    log(Object.keys(env).map((k) => k + '=' + env[k] + ' ').join('') + executable)

    const scriptProcess = spawn(process.execPath, [executable], { env })
    scriptProcess.stdout.on('data', (data) => { log(`(server stdout) ${data.toString().trim()}`) })
    scriptProcess.stderr.on('data', (data) => { log(`(server stderr) ${data.toString().trim()}`) })
    scriptProcess.on('close', (code) => { log(`server exited with code ${code}`) })
    scriptProcess.on('error', (err) => { log(`server ERROR: ${err}`) })

    await untilStreamContains(scriptProcess.stdout, '[DONE]')
    scriptProcess.kill()

    const timeMs = Date.now() - timeBeforeMs
    log('Script took', timeMs, 'ms')

    const balanceAfter = await adminTokenMainnet.balanceOf(member2Wallet.address)
    const balanceIncrease = balanceAfter.sub(balanceBefore)

    await providerMainnet.removeAllListeners()
    await providerSidechain.removeAllListeners()
    await memberClient.ensureDisconnected()
    await adminClient.ensureDisconnected()

    assert.strictEqual(stats.status, 'active')
    assert.strictEqual(stats.earningsBeforeLastJoin, '0')
    assert.strictEqual(stats.lmeAtJoin, '0')
    assert.strictEqual(stats.totalEarnings, '1000000000000000000')
    assert.strictEqual(stats.withdrawableEarnings, '1000000000000000000')
    assert.strictEqual(balanceIncrease.toString(), amount.toString())
    assert.strictEqual(isValid, true)
    assert.strictEqual(resp.error, undefined)
})
