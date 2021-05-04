#!/usr/bin/env node

const StreamrClient = require('streamr-client')
const {
    utils: { getAddress, formatEther },
    providers: { JsonRpcProvider },
    getDefaultProvider,
    Contract,
    BigNumber,
    Wallet,
} = require('ethers')
const yargs = require('yargs')
const debug = require('debug')('Streamr:DU:migrate')
const CliProgress = require('cli-progress')

const DataunionVault = require('../contracts/DataunionVault.json')
const DataUnionMainnet = require('../contracts/DataUnionMainnet.json')
const DataUnionSidechain = require('../contracts/DataUnionSidechain.json')
const Token = require('../contracts/ERC20Detailed.json')
const TokenMediator = require('../contracts/ITokenMediator.json')
const { streamrFetch, until } = require('../src/utils')

require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })

// TODO: include as option
const tokenMigrationThreshold = 1

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
const options = yargs.usage('Usage: $0 --old 0x... --key 0x... [-new 0x...] ...')
    .option('old', {
        type: 'string',
        describe: 'The address of the old data union smart contract to migrate from',
        demand: 'Must give old data union (Ethereum address) to migrate from'
    })
    .option('new', {
        type: 'string',
        describe: 'The address of the new data union smart contract to migrate to', //. If omitted, deploy a new DataUnionMainnet contract, see --factoryAddress option.',
        demand: 'Must give new data union (Ethereum address) to migrate to'
    })
    .option('key', {
        type: 'string',
        describe: 'Ethereum private key of a user that has publish permission to the join/part stream. Either api-key or private-key must be given.',
        demand: 'Must give Ethereum private key to use for deploying new data union and/or updating balances',
    })
    // TODO: to make tests work, lots of other addresses are needed too, now. Maybe take them from env? Maybe ditch yargs entirely?
    // .option('factory-address', {
    //     type: 'string',
    //     default: '0xcfd7de20974194b640cbc028cdf3f2be6e43901c', // TODO: remove when this is default in StreamrClient
    //     describe: "Ethereum (mainnet) address of DataUnionFactoryMainnet contract. Used only if --new option wasn't given.",
    // })
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
    .option('test-divider', {
        type: 'number',
        describe: 'For testing purposes: Instead of sending the full amount, only send `test-divider` part, e.g. 1000 -> send 1/1000th of the real amount'
    })
    .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'If this option is given, the script doesn\'t really transfer tokens, instead just logs to the console.',
    })
    .argv

const streamrOpts = { auth: { privateKey: options.key } }
if (options.streamrWs) { streamrOpts.url = options.streamrWs }
if (options.streamrUrl) { streamrOpts.restUrl = options.streamrUrl }
if (options.ethereumUrl) { streamrOpts.mainnet = { url: options.ethereumUrl } }
if (options.sidechainUrl) { streamrOpts.sidechain = { url: options.sidechainUrl } }
// if (options.factoryAddress) { streamrOpts.dataunion.factoryMainnetAddress = options.factoryAddress }
const testDivider = BigNumber.from(options.testDivider || '1') // throws if truthy but bad number
debug('Command-line options', options)
debug('StreamrClient options', streamrOpts)

const provider = options.ethereumUrl ? new JsonRpcProvider(options.ethereumUrl) : getDefaultProvider()
const sidechainProvider = options.sidechainUrl ? new JsonRpcProvider(options.sidechainUrl) : new StreamrClient().ethereum.getSidechainProvider()
if (!sidechainProvider) {
    throw new Error('Must provide --sidechainUrl')
}
const wallet = new Wallet(options.key, provider)
const sidechainWallet = new Wallet(options.key, sidechainProvider)
debug('Wallet address', wallet.address)

async function start() {
    const network = await provider.getNetwork()
    console.log(`Connected to Ethereum network ${JSON.stringify(network)}`)
    const sidechainNetwork = await sidechainProvider.getNetwork()
    console.log(`Connected to Streamr sidechain ${JSON.stringify(sidechainNetwork)}`)
    // TODO: check network IDs, throw error if not what expected

    const oldDuAddress = getAddress(options.old)
    const oldDataUnion = new Contract(oldDuAddress, DataunionVault.abi, provider)

    const client = new StreamrClient(streamrOpts)
    client.on('error', (err) => {
        console.error(err)
    })

    // [ { address, earnings, active } ]
    const members = (await streamrFetch(client, `/dataunions/${oldDuAddress}/members`))
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
    console.log(`Old Data Union has ${formatEther(oldDuTokenBalance)} DATA`)
    const tokensToDistribute = oldDuTokenBalance.div(testDivider)
    console.log(`Distributing ${formatEther(tokensToDistribute)} DATA into the new Data Union (divider = ${testDivider}), minus rounding errors`)

    const duObject = client.getDataUnion(options.new) // not used after these lines, TODO: maybe make the StreamrClient more useful?
    const dataUnionMainnet = new Contract(duObject.getAddress(), DataUnionMainnet.abi, wallet)
    const dataUnionSidechain = new Contract(duObject.getSidechainAddress(), DataUnionSidechain.abi, sidechainWallet)

    debug('Sidechain contract address', dataUnionSidechain.address)
    const code = await sidechainProvider.getCode(dataUnionSidechain.address)
    debug('Code: %s', code)
    if (code === '0x') {
        throw new Error(`No contract found at ${dataUnionSidechain.address}, check the value of --new argument`)
    }

    // check that the key controls enough sidechain tokens to do the migration
    if (!options.dryRun) {
        const sidechainTokenAddress = await dataUnionSidechain.token()
        const sidechainToken = new Contract(sidechainTokenAddress, Token.abi, sidechainWallet)
        debug('Sidechain token:', await sidechainToken.name(), sidechainToken.address)
        const sidechainTokenBalance = await sidechainToken.balanceOf(wallet.address)
        console.log(`${wallet.address} has ${formatEther(sidechainTokenBalance)} sidechain DATA`)

        // if not enough DATA in sidechain, check DATA balance in mainnet, transfer over the bridge enough to cover migration
        if (tokensToDistribute.gt(sidechainTokenBalance)) {
            const missingSidechainTokens = tokensToDistribute.sub(sidechainTokenBalance)
            const mainnetTokenBalance = await token.balanceOf(wallet.address)
            if (missingSidechainTokens.gt(mainnetTokenBalance)) {
                throw new Error(`${formatEther(missingSidechainTokens)} more tokens required in sidechain! Only ${formatEther(mainnetTokenBalance)} tokens available in mainnet. Please more tokens to sidechain address ${wallet.address} first, then try again.`)
            }
            console.log('Not enough tokens in the sidechain to perform migration! Sending tokens from mainnet.')
            const tokenMediatorAddress = await dataUnionMainnet.token_mediator()
            const tokenMediator = new Contract(tokenMediatorAddress, TokenMediator.abi, wallet)
            const approveTx = await token.connect(wallet).approve(tokenMediator.address, missingSidechainTokens)
            const approveTr = await approveTx.wait()
            debug('Token approve receipt', approveTr)
            const relayTx = await tokenMediator['relayTokens(address,uint256)'](wallet.address, missingSidechainTokens)
            const relayTr = await relayTx.wait()
            debug('Token relay receipt', relayTr)

            debug(`Waiting for sidechain balance ${formatEther(sidechainTokenBalance)} to change`)
            await until(async () => !(await sidechainToken.balanceOf(wallet.address)).eq(sidechainTokenBalance), 60000, 2000)

            const sidechainTokenBalance2 = await sidechainToken.balanceOf(wallet.address)
            console.log(`${wallet.address} now has ${formatEther(sidechainTokenBalance2)} sidechain DATA`)
        }

        // sanity check: token addresses must match
        const newTokenAddress = await dataUnionMainnet.token()
        debug('Mainnet token address', tokenAddress, '->', newTokenAddress)
        if (tokenAddress !== newTokenAddress) {
            const newToken = new Contract(newTokenAddress, Token.abi, provider)
            const tokenName = await token.name()
            const newTokenName = await newToken.name()
            throw new Error(`Different tokens found! Old uses ${tokenName} (${tokenAddress}), new uses ${newTokenName} (${newTokenAddress})`)
        }

        // add approval because transferToMemberInContract uses transferFrom
        debug(`Adding approval for ${tokensToDistribute}`)
        const approveTx = await sidechainToken.approve(dataUnionSidechain.address, tokensToDistribute)
        const approveTr = await approveTx.wait()
        debug('Approve tx receipt', approveTr)
    }

    // handle members starting from the one with most un-withdrawn earnings
    console.log(`Migrating ${oldDuAddress} -> ${dataUnionMainnet.address} (mainnet) / ${dataUnionSidechain.address} (sidechain)`)
    const progress = new CliProgress.SingleBar({ format: '{address} {bar} {value} / {total} {tokensToMigrate} DATA | ETA: {eta_formatted}' }, CliProgress.Presets.shades_grey)
    progress.start(members.length, 0)
    while (members.length > 0) {
        // pick the member with most tokens left to withdraw
        //   if (current) biggest earner has withdrawn tokens, re-do the sort (sorting is cheap compared to RPC calls)
        const member = members[0]
        if (!member.tokensToMigrate) {
            const withdrawn = await oldDataUnion.withdrawn(member.address)
            const migratedEarnings = await dataUnionSidechain.getEarnings(member.address).catch(() => BigNumber.from(0))
            member.tokensToMigrate = member.earnings.sub(withdrawn).div(testDivider).sub(migratedEarnings)
            if (withdrawn.gt(0) || migratedEarnings.gt(0)) {
                members.sort((m1, m2) => ((m1.tokensToMigrate || m1.earnings.div(testDivider)).gt(m2.tokensToMigrate || m2.earnings.div(testDivider)) ? -1 : 1))
                if (member.address !== members[0].address) { continue }
            }
        }
        if (member.tokensToMigrate.lt(tokenMigrationThreshold)) {
            console.log(`Remaining members have less than ${tokenMigrationThreshold} DATA-wei to migrate, ending migration`)
            break
        }
        progress.update(progress.value + 1, member)

        if (!options.dryRun) {
            const tx = await dataUnionSidechain.transferToMemberInContract(member.address, member.tokensToMigrate)
            const tr = await tx.wait()
            debug('Transaction receipt', tr)
        }
        console.log(`Transferred to ${member.address}: ${formatEther(member.tokensToMigrate)} DATA`)
        members.shift() // remove members[0]
    }

    debug('[DONE]')
}
start().catch(console.error)
