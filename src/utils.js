const fetch = require('node-fetch')
const { utils: { getAddress } } = require('ethers')
const debug = require('debug')('Streamr:DU:admin-tools-utils')

async function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

/**
 * Wait until a condition is true
 * @param {Function<boolean>|Promise<boolean>} condition wait until this callback function returns true
 * @param {number} [timeOutMs=10000] stop waiting after that many milliseconds, -1 for disable
 * @param {number} [pollingIntervalMs=100] check condition between so many milliseconds
 */
async function until(condition, timeOutMs = 10000, pollingIntervalMs = 100) {
    let timeout = false
    if (timeOutMs > 0) {
        setTimeout(() => { timeout = true }, timeOutMs)
    }

    // Promise wrapped condition function works for normal functions just the same as Promises
    while (!await Promise.resolve().then(condition)) {
        if (timeout) {
            throw new Error(`Timeout after ${timeOutMs} milliseconds`)
        }
        await sleep(pollingIntervalMs)
    }
}

/**
 * Resolves the promise once stream contains the target string
 * @param {Readable} stream to subscribe to
 * @param {String} target string to search
 * @returns {String} the line where match was found
 */
async function untilStreamContains(stream, target) {
    return new Promise((resolve) => {
        function check(buffer) {
            if (buffer.includes(target)) {
                if (stream.off) { stream.off('data', check) } // stream.off might be missing, perhaps Node version issue
                resolve(buffer.toString())
            }
        }
        stream.on('data', check)
    })
}

/**
 * Resolves the promise once stream contains a match for target regex
 * @param {Readable} stream to subscribe to
 * @param {RegExp} regex to use for matching
 * @returns {Match} the regex match object
 */
async function untilStreamMatches(stream, regex) {
    return new Promise((resolve) => {
        function check(buffer) {
            const data = buffer.toString()
            const match = data.match(regex)
            if (match) {
                if (stream.off) { stream.off('data', check) }
                resolve(match)
            }
        }
        stream.on('data', check)
    })
}

// TODO: consider adding to streamr-javascript-client as StreamrClient.fetch(endpoint, opts),
//         as similar to node-fetch as possible
async function streamrFetch(client, endpoint, opts = {}) {
    const sessionToken = await client.session.getSessionToken()
    const url = `${client.options.restUrl}${endpoint}`
    debug('Sending HTTP get to', url, 'with session token', sessionToken)
    const postHeader = opts.body ? { 'Content-Type': 'application/json' } : {}
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${sessionToken}`,
            ...postHeader,
        },
        ...opts
    })
    const json = await response.json()
    debug('Response', json)

    // server may return things like { code: "ConnectionPoolTimeoutException", message: "Timeout waiting for connection from pool" }
    //   they must still be handled as errors
    if (json.error || json.code) {
        throw new Error(`Server returned ${JSON.stringify(json)}`)
    } else if (!response.ok && !json.error) {
        throw new Error(`Server returned ${response.status} ${response.statusText}`)
    }

    return json
}

function throwIfBadAddress(address, variableDescription) {
    try {
        return getAddress(address)
    } catch (e) {
        throw new Error(`${variableDescription || 'Error'}: Bad Ethereum address ${address}. Original error: ${e.stack}.`)
    }
}

async function throwIfNotContract(eth, address, variableDescription) {
    const addr = throwIfBadAddress(address, variableDescription)
    if (await eth.getCode(address) === '0x') {
        throw new Error(`${variableDescription || 'Error'}: No contract at ${address}`)
    }
    return addr
}

module.exports = {
    sleep,
    until,
    untilStreamMatches,
    untilStreamContains,
    streamrFetch,
    throwIfBadAddress,
    throwIfNotContract,
}
