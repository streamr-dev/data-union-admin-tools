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

module.exports = {
    sleep,
    until,
    untilStreamMatches,
}
