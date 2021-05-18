#!/usr/bin/env node

const fs = require('fs')

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
const exitHook = require('exit-hook')

const DataunionVault = require('../contracts/DataunionVault.json')
const DataUnionMainnet = require('../contracts/DataUnionMainnet.json')
const DataUnionSidechain = require('../contracts/DataUnionSidechain.json')
const Token = require('../contracts/ERC20Detailed.json')
const TokenMediator = require('../contracts/ITokenMediator.json')
const { streamrFetch, until } = require('../src/utils')

require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })

// TODO: include as option
const tokenMigrationThreshold = 1

// For sending the sidechain tx in parallel
class AutoNonceWallet extends Wallet {
    constructor(...args) {
        super(...args)
        this._noncePromise = null
    }

    sendTransaction(transaction) {
        if (transaction.nonce == null) {
            if (this._noncePromise == null) {
                this._noncePromise = this.provider.getTransactionCount(this.address)
            }
            transaction.nonce = this._noncePromise // eslint-disable-line no-param-reassign
            this._noncePromise = this._noncePromise.then((nonce) => (nonce + 1))
        }
        return super.sendTransaction(transaction)
    }
}

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
    .option('temp', {
        type: 'string',
        describe: 'Temporary file location for the migration state (for resuming etc.)',
        default: 'migrate-state.json'
    })
    .option('whitelist-file', {
        type: 'string',
        describe: 'JSON file that contains the list of addresses to migrate'
    })
    .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'If this option is given, the script doesn\'t really transfer tokens, instead just logs to the console.',
    })
    .option('skip-check', {
        type: 'boolean',
        default: false,
        describe: 'Skip the initial check if there are enough tokens to do the migration (whole from scratch). This is useful for later "update" migrations.',
    })
    .option('skip-joins', {
        type: 'boolean',
        default: false,
        describe: 'Skip the initial check if all members have alredy joined the new DU.',
    })
    .option('out', {
        type: 'string',
        describe: 'JSON file to output migration results on exit',
        default: 'migrate-results.json'
    })
    .option('parallel', {
        type: 'number',
        describe: 'Number of transactions to run in parallel',
        default: 1,
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

const whitelist = options.whitelistFile ? new Set(JSON.parse(fs.readFileSync(options.whitelistFile))) : null

const provider = options.ethereumUrl ? new JsonRpcProvider(options.ethereumUrl) : getDefaultProvider()
const sidechainProvider = options.sidechainUrl ? new JsonRpcProvider(options.sidechainUrl) : new StreamrClient().ethereum.getSidechainProvider()
if (!sidechainProvider) {
    throw new Error('Must provide --sidechainUrl')
}
const wallet = new Wallet(options.key, provider)
const sidechainWallet = new AutoNonceWallet(options.key, sidechainProvider)
debug('Wallet address', wallet.address)

// record what was done before e.g. breaking with Ctrl+C
const results = []
exitHook(() => {
    fs.writeFileSync(options.out, JSON.stringify(results))
})

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

    const duObject = client.getDataUnion(options.new)
    const dataUnionMainnet = new Contract(duObject.getAddress(), DataUnionMainnet.abi, wallet)
    const dataUnionSidechain = new Contract(duObject.getSidechainAddress(), DataUnionSidechain.abi, sidechainWallet)

    debug('Sidechain contract address', dataUnionSidechain.address)
    const code = await sidechainProvider.getCode(dataUnionSidechain.address)
    debug('Code: %s', code)
    if (code === '0x') {
        throw new Error(`No contract found at ${dataUnionSidechain.address}, check the value of --new argument`)
    }

    const tokenAddress = await oldDataUnion.token()
    const token = new Contract(tokenAddress, Token.abi, provider)
    const oldDuTokenBalance = await token.balanceOf(oldDuAddress)
    console.log(`Old Data Union has ${formatEther(oldDuTokenBalance)} DATA`)

    const sidechainTokenAddress = await dataUnionSidechain.token()
    const sidechainToken = new Contract(sidechainTokenAddress, Token.abi, sidechainWallet)
    debug('Sidechain token:', await sidechainToken.name(), sidechainToken.address)
    const newDuTokenBalance = await sidechainToken.balanceOf(dataUnionSidechain.address)
    console.log(`New Data Union has ${formatEther(newDuTokenBalance)} DATA`)
    const tokenDifference = oldDuTokenBalance.sub(newDuTokenBalance)
    console.log(`Difference: ${formatEther(tokenDifference)}`)
    // TODO: token difference might not be what should be migrated if the new also has had token flows that didn't go into the old
    //       the only way to know is to run the thing, hence adding --skip-check

    // TODO: public API endpoint, wouldn't need client at all
    // [ { address, earnings, active } ]
    const members = (await streamrFetch(client, `/dataunions/${oldDuAddress}/members`))
        .filter((m) => m.active && (!whitelist || whitelist.has(m.address)))
        .map((m) => ({
            address: m.address,
            earnings: BigNumber.from(m.earnings), // total earnings registered to the operator
        }))
    members.sort((m1, m2) => (m1.earnings.gt(m2.earnings) ? -1 : 1)) // from largest to smallest (1 and -1 inverted from "normal")

    const isJoinPartAgent = await dataUnionSidechain.joinPartAgents(sidechainWallet.address)
    if (options.skipJoins) {
        debug('Skipping joins')
    } else if (!isJoinPartAgent) {
        console.log(`WARNING: ${sidechainWallet.address} is not a joinPartAgent in the DataUnionSidechain!\nThis means earnings are migrated but new members need to be added later.`)
    } else {
        const memberAddressList = members.map(m => m.address)
        const initialMemberCount = memberAddressList.length
        console.log(`Adding ${initialMemberCount} members, ${options.parallel} at a time`)
        const addProgress = new CliProgress.SingleBar({ format: '{bar} Adding member {value} / {total} | ETA: {eta_formatted}' }, CliProgress.Presets.shades_grey)
        addProgress.start(initialMemberCount, 0)

        // filter from memberAddressList those memberToAdd who are not active members; trying to add an already-active member reverts the whole batch, should be avoided
        while (memberAddressList.length > 0) {
            const membersToAdd = []
            while (membersToAdd.length < options.parallel && memberAddressList.length > 0) {
                const membersToCheck = memberAddressList.splice(0, options.parallel)
                addProgress.update(initialMemberCount - memberAddressList.length)
                debug(`Checking membership of ${membersToCheck.join(', ')}`)
                await Promise.all(membersToCheck.map(async address => {
                    const memberData = await dataUnionSidechain.memberData(address).catch(() => [1]) // skip
                    debug(`${address} state is ${['NONE', 'ACTIVE', 'INACTIVE'][memberData[0]]}`)
                    if (memberData[0] !== 1) { // not ACTIVE  <=>  NONE or INACTIVE
                        membersToAdd.push(address)
                    }
                }))
            }

            debug(`Adding ${membersToAdd.length} members`)
            const tx = await dataUnionSidechain.addMembers(membersToAdd)
            const tr = await tx.wait()
            debug('Added members, receipt: %o', tr)
        }
    }

    const totalOldEarnings = members.reduce((sum, m) => sum.add(m.earnings), BigNumber.from(0))
    console.log(`Preparing to migrate ${members.length} (active) members in the old data union ${oldDuAddress}, total earnings ${formatEther(totalOldEarnings)} DATA`)
    const tokensToDistribute = totalOldEarnings.div(testDivider)
    console.log(`Distributing ${formatEther(tokensToDistribute)} DATA into the new Data Union (divider = ${testDivider}), minus rounding errors`)

    // check that the key controls enough sidechain tokens to do the migration
    if (!options.dryRun && !options.skipCheck) {
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

    // calculate tokensToMigrate, or do the migration if previously calculated
    async function migrate(member) {
        if (!member.tokensToMigrate) {
            const withdrawn = await oldDataUnion.withdrawn(member.address)
            const memberData = await dataUnionSidechain.memberData(member.address)
            const isMember = memberData[0] > 0
            const migratedEarnings = isMember ? await dataUnionSidechain.getEarnings(member.address) : 0
            // we know at this point that in one round, the same address shouldn't be processed twice, so there won't be a race for the tokensToMigrate attribute
            // eslint-disable-next-line require-atomic-updates, no-param-reassign
            member.tokensToMigrate = member.earnings.sub(withdrawn).div(testDivider).sub(migratedEarnings)
            return
        }

        if (member.tokensToMigrate.lt(tokenMigrationThreshold)) {
            return
        }

        if (!options.dryRun) {
            const tx = await dataUnionSidechain.transferToMemberInContract(member.address, member.tokensToMigrate)
            const tr = await tx.wait()
            debug('Transaction receipt', tr)
        }
        console.log(`Transferred to ${member.address}: ${formatEther(member.tokensToMigrate)} DATA`)
        results.push(member)

        // eslint-disable-next-line require-atomic-updates, no-param-reassign
        member.tokensToMigrate = BigNumber.from(0)
    }

    console.log(`Migrating ${oldDuAddress} -> ${dataUnionMainnet.address} (mainnet) / ${dataUnionSidechain.address} (sidechain)`)
    const progress = new CliProgress.SingleBar({ format: '{address} {bar} {value} / {total} {tokensToMigrate} DATA | ETA: {eta_formatted}' }, CliProgress.Presets.shades_grey)
    progress.start(members.length, 0)
    while (members.length > 0) {
        // pick the members with most earnings left to withdraw
        //   first round, the tokensToMigrate will be evaluated
        //   second round, the migration will be done for that amount
        const membersToProcess = members.slice(0, options.parallel)
        debug(membersToProcess.map(m => `${m.address} / ${m.earnings}`))
        await Promise.all(membersToProcess.map(m => migrate(m).catch(console.error)))

        // migrate process sets the tokensToMigrate to zero when it finishes
        const doneCount = membersToProcess.filter(m => m.tokensToMigrate && m.tokensToMigrate.eq(0)).length
        progress.update(progress.value + doneCount, members[0])

        // sort between rounds => if (current) biggest earners have withdrawn tokens, they'll be bumped later in the queue
        // sorting also shuffles the "done" members to the end
        members.sort((m1, m2) => ((m1.tokensToMigrate || m1.earnings.div(testDivider)).gt(m2.tokensToMigrate || m2.earnings.div(testDivider)) ? -1 : 1))

        if (members[0].tokensToMigrate && members[0].tokensToMigrate.lt(tokenMigrationThreshold)) {
            console.log(`Remaining members have less than ${tokenMigrationThreshold} DATA-wei to migrate, ending migration`)
            break
        }
    }

    debug('[DONE]')
}
start().catch(console.error)
