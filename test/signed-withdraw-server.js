const { spawn } = require('child_process')
const assert = require('assert')

const { Contract, providers, Wallet, utils: { formatEther, parseEther } } = require('ethers')
const debug = require('debug')
const StreamrClient = require('streamr-client')
const fetch = require('node-fetch')

const { until, untilStreamMatches } = require('../src/utils')

const Token = require('./TestToken.json')
const DataUnionSidechain = require('./DataUnionSidechain.json')
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

const env = {
    SERVER_PRIVATE_KEY: config.clientOptions.auth.privateKey,
    PORT,
    ETHEREUM_URL: config.clientOptions.mainnet.url,
    // GAS_PRICE_GWEI,
}
const executable = 'bin/start-signed-withdraw-server.js'

let serverProcess
let serverUrl
beforeEach(async () => {
    log(Object.keys(env).map((k) => k + '=' + env[k] + ' ').join('') + executable)
    serverProcess = spawn(process.execPath, [executable], { env })
    serverProcess.stdout.on('data', (data) => { log(`(server stdout) ${data.toString().trim()}`) })
    serverProcess.stderr.on('data', (data) => { log(`(server stderr) ${data.toString().trim()}`) })
    serverProcess.on('close', (code) => { log(`server exited with code ${code}`) })
    serverProcess.on('error', (err) => { log(`server ERROR: ${err}`) })

    // wait until server is started, also get url from output
    ;[, serverUrl] = await untilStreamMatches(serverProcess.stdout, /Server started at (.*)/)
})

afterEach(() => {
    if (serverProcess) {
        serverProcess.kill()
        serverProcess = null
    }
})

// eslint-disable-next-line prefer-arrow-callback, func-names
it.skip('Signed withdraw server successfully withdraws earnings', async function () {
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

    log(`Deploying data union from ${await adminClient.getAddress()}`)
    const dataUnion = await adminClient.deployDataUnion()
    log(`DataUnion ${dataUnion.address} is ready to roll`)
    // dataUnion = await adminClient.getDataUnionContract({dataUnion: "0xd778CfA9BB1d5F36E42526B2BAFD07B74b4066c0"})

    const pkey = `0x10000000000000000000000000000000000000012300000001${Date.now()}`
    const memberWallet = new Wallet(pkey + '1', providerSidechain)
    const member2Wallet = new Wallet(pkey + '2', providerSidechain)
    log(`Test members:\n* ${memberWallet.address} (${pkey}1)\n* ${member2Wallet.address} (${pkey}2)`)

    const sendTx = await adminWalletSidechain.sendTransaction({ to: memberWallet.address, value: parseEther('0.1') })
    await sendTx.wait()
    log(`sent 0.1sETH to ${memberWallet.address}`)

    const memberClient = new StreamrClient({
        ...config.clientOptions,
        auth: {
            privateKey: memberWallet.privateKey
        },
        dataUnion: dataUnion.address,
    })
    await memberClient.ensureConnected()

    await adminClient.addMembers([memberWallet.address], { dataUnion })

    const tokenAddress = await dataUnion.token()
    log(`Token address: ${tokenAddress}`)
    const adminTokenMainnet = new Contract(tokenAddress, Token.abi, adminWalletMainnet)

    const amount = parseEther('1')
    const duSidechainEarningsBefore = await dataUnion.sidechain.totalEarnings()

    const duBalance1 = await adminTokenMainnet.balanceOf(dataUnion.address)
    log(`Token balance of ${dataUnion.address}: ${formatEther(duBalance1)} (${duBalance1.toString()})`)
    const balance1 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
    log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance1)} (${balance1.toString()})`)

    log(`Transferring ${amount} token-wei ${adminWalletMainnet.address}->${dataUnion.address}`)
    const txTokenToDU = await adminTokenMainnet.transfer(dataUnion.address, amount)
    await txTokenToDU.wait()

    const duBalance2 = await adminTokenMainnet.balanceOf(dataUnion.address)
    log(`Token balance of ${dataUnion.address}: ${formatEther(duBalance2)} (${duBalance2.toString()})`)
    const balance2 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
    log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance2)} (${balance2.toString()})`)

    log(`DU member count: ${await dataUnion.sidechain.activeMemberCount()}`)

    log(`Transferred ${formatEther(amount)} tokens, next sending to bridge`)
    const tx2 = await dataUnion.sendTokensToBridge()
    await tx2.wait()

    log(`Sent to bridge, waiting for the tokens to appear at ${dataUnion.sidechain.address} in sidechain`)
    const tokenSidechain = new Contract(config.clientOptions.tokenAddressSidechain, Token.abi, adminWalletSidechain)
    await until(async () => !(await tokenSidechain.balanceOf(dataUnion.sidechain.address)).eq('0'), 300000, 3000)
    log(`Confirmed tokens arrived, DU balance: ${duSidechainEarningsBefore} -> ${await dataUnion.sidechain.totalEarnings()}`)

    // make a "full" sidechain contract object that has all functions, not just those required by StreamrClient
    const sidechainContract = new Contract(dataUnion.sidechain.address, DataUnionSidechain.abi, adminWalletSidechain)
    const tx3 = await sidechainContract.refreshRevenue()
    const tr3 = await tx3.wait()
    log(`addRevenue returned ${JSON.stringify(tr3)}`)
    log(`DU balance: ${await dataUnion.sidechain.totalEarnings()}`)

    const duBalance3 = await adminTokenMainnet.balanceOf(dataUnion.address)
    log(`Token balance of ${dataUnion.address}: ${formatEther(duBalance3)} (${duBalance3.toString()})`)
    const balance3 = await adminTokenMainnet.balanceOf(adminWalletMainnet.address)
    log(`Token balance of ${adminWalletMainnet.address}: ${formatEther(balance3)} (${balance3.toString()})`)

    // note: getMemberStats without explicit address => get stats of the authenticated StreamrClient
    const stats = await memberClient.getMemberStats()
    log(`Stats: ${JSON.stringify(stats)}. Withdrawing tokens...`)

    const signature = await memberClient.signWithdrawTo(member2Wallet.address)
    const isValid = await sidechainContract.signatureIsValid(memberWallet.address, member2Wallet.address, '0', signature) // '0' = all earnings
    log(`Signature for all tokens ${memberWallet.address} -> ${member2Wallet.address}: ${signature}, checked ${isValid ? 'OK' : '!!!BROKEN!!!'}`)

    log(`sidechainDU(${sidechainContract.address}) token balance ${await tokenSidechain.balanceOf(sidechainContract.address)}`)
    const balanceBefore = await adminTokenMainnet.balanceOf(member2Wallet.address)
    log(`balanceBefore ${balanceBefore}. Withdrawing tokens...`)

    const timeBeforeMs = Date.now()
    const body = JSON.stringify({
        dataUnionAddress: dataUnion.address,
        memberAddress: memberWallet.address,
        recipientAddress: member2Wallet.address,
        tokenAddress,
        signature,
    })
    log(`curl -X POST -H "Content-Type: application/json" -d '${body}' ${serverUrl}`)
    const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body,
    }).then((res) => res.json())
    const timeMs = Date.now() - timeBeforeMs

    log(`Tokens withdrawn, response from server (in ${timeMs}ms): ${JSON.stringify(resp)}`)
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
