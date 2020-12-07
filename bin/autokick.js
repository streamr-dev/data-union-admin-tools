#!/usr/bin/env node
/* eslint-disable no-loop-func,import/order */

const StreamrClient = require('streamr-client')
const CliProgress = require('cli-progress')
require('console-stamp')(console, { pattern: 'yyyy-mm-dd HH:MM:ss' })

const options = require('yargs')
    .usage('Usage: $0 --stream [streamId] --contract-address [0x...] ...')
    .option('stream', {
        type: 'array',
        describe: 'ID of your content stream (to which members produce data). Give this option multiple times to cover multiple streams.',
    })
    .option('contract-address', {
        type: 'string',
        describe: 'The address of the data union smart contract.',
        default: undefined
    })

// TODO: how to set the ethereum network to use?

    .option('window-hours', {
        type: 'number',
        describe: 'The time window during which to observe messages in the content stream(s).',
        default: 48,
    })
    .option('kick-logic', {
        type: 'string',
        describe: 'Loads the desired kick logic from src/autokick folder. The default \'inactivity\' logic simply kicks members who haven\'t published any data during the inspected period.',
        default: 'inactivity',
    })
    .option('batch', {
        type: 'boolean',
        describe: 'Does a resend on the stream, runs the kick logic, and quits. No continuous monitoring.',
        default: false,
    })
    .option('kick-interval-minutes', {
        type: 'number',
        describe: 'How often, in minutes, to check for kickable members and send part messages to kick them. Has no effect in --batch mode.',
        default: 10,
    })
    .option('api-key', {
        default: undefined,
        describe: 'API key of a user that has publish permission to the join/part stream. Either --api-key or --private-key must be given.',
    })
    .option('private-key', {
        default: undefined,
        describe: 'Ethereum private key of a user that has publish permission to the join/part stream. Either api-key or private-key must be given.',
    })
    .option('streamr-url', {
        default: undefined,
        describe: 'The Streamr websocket API URL. By default, uses the default value in the Streamr JS SDK (wss://streamr.network/api/v1/ws)',
    })
    .option('streamr-rest-url', {
        default: undefined,
        describe: 'The Streamr REST API URL. By default, uses the default value in the Streamr JS SDK (https://streamr.network/api/v1)',
    })
    .option('order-messages', {
        type: 'boolean',
        default: false,
        describe: 'Set the orderMessages Streamr client option to true, activating message ordering and gapfill.',
    })
    .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'If this option is given, the script doesn\'t really kick members from the data union, but instead logs kicks to the console.',
    })
    .demandOption(['stream', 'contract-address'])
    .argv

// Load the specified kick logic
// eslint-disable-next-line import/no-dynamic-require
const KickLogic = require('../src/autokick/' + options['kick-logic'])
const logic = new KickLogic(options)

/**
 * Streamr connection setup
 */
const clientConfig = {
    orderMessages: options['order-messages'],
}

if (options['streamr-url']) {
    clientConfig.url = options['streamr-url']
}
if (options['streamr-rest-url']) {
    clientConfig.restUrl = options['streamr-rest-url']
}

// Log the config before setting the secrets
console.log('Streamr client config: ', clientConfig)

if (options['api-key']) {
    clientConfig.auth = {
        apiKey: options['api-key']
    }
} else if (options['private-key']) {
    clientConfig.auth = {
        privateKey: options['private-key']
    }
} else if (!options['dry-run']) {
    console.error('You must give either the --api-key or --private-key option, or use --dry-run!')
    process.exit(1)
}

// Create client
const streamr = new StreamrClient(clientConfig)
streamr.on('error', (err) => {
    console.error(err)
})

// Subscribe to given content streams from given timestamp
const now = Date.now()
const hoursAgo = now - options['window-hours'] * 60 * 60 * 1000
// const subs = [] // TODO: maybe this was meant for cleanup afterwards?
const resendingSubs = []
const multibar = new CliProgress.MultiBar({
    format: ' {bar} | {stream}',
}, CliProgress.Presets.shades_grey)
let latestSeenMessage

async function kickMembers() {
    // Check that no subscription is resending anymore
    if (resendingSubs.length) {
        return
    }

    if (Date.now() - latestSeenMessage.getTimestamp() >= options['kick-interval-minutes'] * 60 * 1000) {
        console.log(`No new data in any of the streams since ${new Date(latestSeenMessage.getTimestamp())}! I'm not confident kicking people. Skipping this time...`)
        return
    }

    // What are the currently active members? Anyone we want to kick must be in this set
    console.log('Fetching currently active members...')
    const currentlyActiveMembers = await streamr.getMembers(options['contract-address'])
    console.log(`Found ${currentlyActiveMembers.length} active members. Checking who to kick. Latest seen message timestamp: ${new Date(latestSeenMessage.getTimestamp())}`)

    // Pass only the array of addresses to the logic
    const membersToKick = logic.getMembersToKick(currentlyActiveMembers)
    const addressesToKick = membersToKick.map((member) => member.address)

    console.log(`Kicking ${membersToKick.length} members: ${JSON.stringify(addressesToKick)}`)

    if (options['dry-run']) {
        console.log('dry-run: Not really kicking!')
    } else {
        // Kick the given members
        await streamr.kick(options['contract-address'], membersToKick.map((member) => member.address))
    }
}

console.log(`Resending messages from ${options.stream.length} streams since ${options['window-hours']} hours ago (${new Date(hoursAgo)})...`)

options.stream.forEach(async (streamId) => {
    // Fetch the stream metadata to learn the stream name and number of partitions
    const stream = await streamr.getStream(streamId)

    // Get messages from all partitions and forward them to the kick logic
    for (let partition = 0; partition < stream.partitions; partition++) {
        let resendInProgress = true

        // Progressbar values run from 0 to (now - hoursAgo)
        let maxSeenTimestamp = hoursAgo
        const subProgressBar = multibar.create(now - hoursAgo, 0)
        const streamDescriptionForProgressBar = `${stream.name} (id: ${stream.id}, partition: ${partition})`
        subProgressBar.update(0, {
            stream: streamDescriptionForProgressBar,
        })

        const methodName = options.batch ? 'resend' : 'subscribe'
        const sub = await streamr[methodName]({
            stream: stream.id,
            partition,
            resend: {
                from: {
                    timestamp: hoursAgo,
                },
            }
        }, (payload, streamrMessage) => {
            logic.addMessage(payload, streamrMessage)
            latestSeenMessage = streamrMessage

            if (resendInProgress && streamrMessage.getTimestamp() > maxSeenTimestamp) {
                maxSeenTimestamp = streamrMessage.getTimestamp()
                subProgressBar.update(maxSeenTimestamp - hoursAgo, {
                    stream: streamDescriptionForProgressBar,
                })
            }
        })
        sub.on('error', (err) => {
            console.log(err)
        })
        sub.on('initial_resend_done', async () => {
            resendInProgress = false

            subProgressBar.update(now - hoursAgo, {
                stream: streamDescriptionForProgressBar,
            })

            // Remove sub from resendingSubs
            resendingSubs.splice(resendingSubs.indexOf(sub), 1)
            if (!resendingSubs.length) {
                multibar.stop()
                console.log('All resends complete.')

                // Sanity check
                if (!latestSeenMessage) {
                    console.error('Sanity check failed: Initial resend contained no messages. Either there\'s no data in the stream, or something went wrong with the resend. Exiting..')
                    process.exit(1)
                }

                // Do the members kick once now
                await kickMembers()

                // Then schedule it to happen at intervals
                if (options.batch) {
                    process.exit(0)
                } else {
                    console.log(`Listening to new messages and repeating the check every ${options['kick-interval-minutes']} minutes.`)
                    setInterval(kickMembers, options['kick-interval-minutes'] * 60 * 1000)
                }
            }
        })
    }
})

// Log unhandled rejection traces
process.on('unhandledRejection', (err, p) => {
    console.error('Unhandled Rejection at: Promise', p, 'err:', err, 'stack:', err.stack)
})
