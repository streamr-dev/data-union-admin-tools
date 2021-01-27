#!/usr/bin/env node

const DataunionVault = require('../contracts/DataunionVault.json')
const DataUnionFactoryMainnet = require('../contracts/DataUnionFactoryMainnet.json')
const DataUnionFactorySidechain = require('../contracts/DataUnionFactorySidechain.json')
const Token = require('../contracts/IERC20.json')
const debug = require('debug')('Streamr:DU:migrate')

const { httpGet, sleep } = require('../src/utils')
const StreamrClient = require('streamr-client')
const {
    utils: { getAddress, formatEther },
    providers: { JsonRpcProvider },
    getDefaultProvider,
    Contract,
    BigNumber,
    Wallet,
} = require('ethers')
const CliProgress = require('cli-progress')
require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })

/**
 * @typedef {Object} Options
 * @property {String} old
 * @property {String} new
 * @property {String} key
 * @property {String} factoryAddress
 * @property {String} streamrWs
 * @property {String} streamrUrl
 * @property {String} ethereumUrl
 * @property {String} sidechainUrl
 * @property {Boolean} dryRun
 */
const options = require('yargs')
    .usage('Usage: $0 --old 0x... --key 0x... [-new 0x...] ...')
    .option('old', {
        type: 'string',
        describe: 'The address of the old data union smart contract to migrate from',
        demand: 'Must give old data union (Ethereum address) to migrate'
    })
    .option('new', {
        type: 'string',
        describe: 'The address of the new data union smart contract to migrate to. If omitted, deploy a new DataUnionMainnet contract, see --factoryAddress option.',
    })
    .option('key', {
        type: 'string',
        describe: 'Ethereum private key of a user that has publish permission to the join/part stream. Either api-key or private-key must be given.',
        demand: 'Must give Ethereum private key to use for deploying new data union and/or updating balances',
    })
    .option('factory-address', {
        type: 'string',
        default: '0xcfd7de20974194b640cbc028cdf3f2be6e43901c', // TODO: remove when this is default in StreamrClient
        describe: "Ethereum (mainnet) address of DataUnionFactoryMainnet contract. Used only if --new option wasn't given.",
    })
    .option('streamr-ws', {
        type: 'string',
        describe: 'The Streamr websocket API URL. By default, uses the default value in the Streamr JS SDK (wss://streamr.network/api/v1/ws)',
    })
    .option('streamr-url', {
        type: 'string',
        describe: 'The Streamr REST API URL. By default, uses the default value in the Streamr JS SDK (https://streamr.network/api/v1)',
    })
    .option('ethereum-url', {
        type: 'string',
        describe: 'The Ethereum client RPC URL to use for Ethereum (mainnet) provider',
    })
    .option('sidechain-url', {
        type: 'string',
        describe: 'The Ethereum client RPC URL to use for Streamr sidechain provider',
    })
    .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'If this option is given, the script doesn\'t really kick members from the data union, but instead logs kicks to the console.',
    })
    .argv

const streamrOpts = { auth: { privateKey: options.key } }
if (options.url) { streamrOpts.url = options.streamrWs }
if (options.streamrUrl) { streamrOpts.restUrl = options.streamrUrl }
if (options.ethereumUrl) { streamrOpts.mainnet = { url: options.ethereumUrl } }
if (options.sidechainUrl) { streamrOpts.sidechain = { url: options.sidechainUrl } }
if (options.factoryAddress) { streamrOpts.factoryMainnetAddress = options.factoryAddress }
if (options.new) { streamrOpts.dataUnion = options.new }
debug('Command-line options', options)
debug('StreamrClient options', streamrOpts)

const provider = options.ethereumUrl ? new JsonRpcProvider(options.ethereumUrl) : getDefaultProvider()
const sidechainProvider = options.sidechainUrl ? new JsonRpcProvider(options.ethereumUrl) : new StreamrClient().getSidechainProvider()
if (!sidechainProvider) {
    throw new Error('Must provide --sidechainUrl')
}
const wallet = new Wallet(options.key, provider)
const sidechainWallet = new Wallet(options.key, sidechainProvider)
debug('Wallet address', wallet.address)

async function start() {
    const network = await provider.getNetwork()
    console.log(`Connected to Ethereum network ${JSON.stringify(network)}`)

    const oldDuAddress = getAddress(options.old)
    const oldDataUnion = new Contract(oldDuAddress, DataunionVault.abi, provider)

    const client = new StreamrClient(streamrOpts)
    client.on('error', (err) => {
        console.error(err)
    })

    // [ { address, earnings, active } ]
    const members = (await httpGet(client, oldDuAddress, '/members'))
        .filter((m) => m.active)
        .map((m) => ({
            address: m.address,
            earnings: BigNumber.from(m.earnings), // total earnings registered to the operator
        }))
    members.sort((m1, m2) => (m1.earnings.gt(m2.earnings) ? -1 : 1)) // from largest to smallest (1 and -1 inverted from "normal")
    console.log(`Found ${members.length} (active) members in the old data union ${oldDuAddress}`)

    const tokenAddress = await oldDataUnion.token()
    const token = new Contract(tokenAddress, Token.abi, provider)
    const oldDuTokenBalance = await token.balanceOf(oldDuAddress)
    console.log(`Old DU has ${formatEther(oldDuTokenBalance)} DATA`)

    if (!options.new) {
        // TODO: double check that tokenAddress that would be used is correct!
        console.log('Deploying a new data union contract...')
        client.options.dataUnion = !options.dryRun ? await client.deployDataUnion() : '0xbeef0beef0beef0beef0beef0beef0beef0beef0'
        console.log('Deployed a new data union contract!')
        console.log(`*** NOTE: please add "--new ${client.options.dataUnion.address}" to the command-line to continue later`)
    }
    const dataUnion = await client.getDataUnionContract()
    const dataUnionSidechain = new Contract(dataUnion.sidechain.address, DataUnionFactorySidechain.abi, sidechainWallet)

    // TODO: check DATA balance in mainnet, transfer over the bridge enough to cover migration
    // check that the key controls enough sidechain tokens to do the migration
    let sidechainToken
    if (!options.dryRun) {
        const sidechainTokenAddress = await dataUnionSidechain.token()
        sidechainToken = new Contract(sidechainTokenAddress, Token.abi, sidechainWallet)
        const startingTokenBalance = await sidechainToken.balanceOf(wallet.address)
        console.log(`${wallet.address} has ${formatEther(startingTokenBalance)} sidechain DATA`)
        if (oldDuTokenBalance.gt(startingTokenBalance)) {
            throw new Error('Not enough tokens in the sidechain to perform migration! Please send DATA to sidechain first, then try again.')
        }

        // sanity check: token addresses must match
        const newTokenAddress = await dataUnion.token()
        debug('Mainnet token address', tokenAddress, '->', newTokenAddress)
        if (tokenAddress !== newTokenAddress) {
            const newToken = new Contract(newTokenAddress, Token.abi, provider)
            const tokenName = await token.name()
            const newTokenName = await newToken.name()
            throw new Error(`Different tokens found! Old uses ${tokenName} (${tokenAddress}), new uses ${newTokenName} (${newTokenAddress})`)
        }

        // add approval because transferToMemberInContract uses transferFrom
        debug(`Adding approval for ${oldDuTokenBalance}`)
        const approveTx = await sidechainToken.approve(dataUnion.sidechain.address, oldDuTokenBalance)
        const approveTr = await approveTx.wait()
        debug('Approve tx receipt', approveTr)
    }

    // handle members starting from the one with most un-withdrawn earnings
    console.log(`Migrating ${oldDuAddress} -> ${dataUnion.address} (mainnet) / ${dataUnion.sidechain.address} (sidechain)`)
    const progress = new CliProgress.SingleBar({ format: '{address} {bar} {value} / {total} {balance} DATA | ETA: {eta_formatted}' }, CliProgress.Presets.shades_grey)
    progress.start(members.length, 0)
    while (members.length > 0) {
        // pick the member with most tokens left to withdraw
        //   if (current) biggest earner has withdrawn tokens, re-do the sort (sorting is cheap compared to RPC calls)
        const member = members[0]
        if (!member.balance) {
            const withdrawn = await oldDataUnion.withdrawn(member.address)
            member.balance = member.earnings.sub(withdrawn)
            if (withdrawn.gt(0)) {
                members.sort((m1, m2) => ((m1.balance || m1.earnings).gt(m2.balance || m2.earnings) ? -1 : 1))
                if (member.address !== members[0].address) { continue }
            }
        }
        progress.update(progress.value + 1, member)

        if (!options.dryRun) {
            const tx = await dataUnionSidechain.transferToMemberInContract(member.address, member.balance)
            const tr = await tx.wait()
            debug('Transaction receipt', tr)
        }
        console.log(`Transferred to ${member.address}: ${formatEther(member.balance)} DATA`)
        members.shift() // remove members[0]
    }

    debug('[DONE]')
}
start().catch(console.error)

