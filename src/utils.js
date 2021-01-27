const fetch = require('node-fetch')
const { getAddress } = require('ethers')
const debug = require('debug')('Streamr:DU:admin-tools-utils')

async function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

/**
 * @callback UntilCondition
 * @returns {boolean} signifying if it should stop waiting and continue execution
 */
/**
 * Wait until a condition is true
 * @param {UntilCondition|Promise<boolean>} condition wait until this callback function returns true
 * @param {number} [timeOutMs=10000] stop waiting after that many milliseconds, -1 for disable
 * @param {number} [pollingIntervalMs=100] check condition between so many milliseconds
 */
async function until(condition, timeOutMs = 10000, pollingIntervalMs = 100) {
    let timeout = false
    if (timeOutMs > 0) {
        setTimeout(() => { timeout = true }, timeOutMs)
    }

    // Promise wrapped condition function works for normal functions just the same as Promises
    while (!await Promise.resolve().then(condition)) { // eslint-disable-line no-await-in-loop
        if (timeout) {
            throw new Error(`Timeout after ${timeOutMs} milliseconds`)
        }
        await sleep(pollingIntervalMs) // eslint-disable-line no-await-in-loop
    }
    return condition()
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

async function httpGet(client, dataUnionContractAddress, endpoint, opts = {}) {
    const url = `${client.options.restUrl}/dataunions/${dataUnionContractAddress}${endpoint}`
    debug('Sending HTTP get to', url)
    const response = await fetch(url, opts)
    const json = await response.json()
    debug('Response', json)

    // server may return things like { code: "ConnectionPoolTimeoutException", message: "Timeout waiting for connection from pool" }
    //   they must still be handled as errors
    if (json.error || json.code) {
        throw new Error(json)
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
    httpGet,
    throwIfBadAddress,
    throwIfNotContract,
}
