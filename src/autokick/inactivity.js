module.exports = class InactivityKickLogic {
    constructor(options) {
        this.options = options
        this.lastDataTimestampByMember = {}
    }

    addMessage(payload, streamrMessage) {
        this.lastDataTimestampByMember[streamrMessage.getPublisherId()] = streamrMessage.getTimestamp()
    }

    getMembersToKick(currentlyActiveMembers) {
        const hoursAgo = Date.now() - this.options['window-hours'] * 60 * 60 * 1000
        Object.keys(this.lastDataTimestampByMember).forEach((address) => {
            // Has this member's latest message fallen beyond the window?
            if (this.lastDataTimestampByMember[address] < hoursAgo) {
                console.log(`InactivityKickLogic: Address ${address} hasn't produced data since ${new Date(this.lastDataTimestampByMember)}`)
                delete this.lastDataTimestampByMember[address]
            }
        })

        console.log(`InactivityKickLogic: seen messages from ${Object.keys(this.lastDataTimestampByMember).length} members in the past ${this.options['window-hours']} hours.`)

        // Return active members NOT on the lastDataTimestampByMember set
        const whitelistSet = new Set(Object.keys(this.lastDataTimestampByMember))
        const toBeKicked = currentlyActiveMembers.filter((address) => !whitelistSet.has(address))
        console.log(`InactivityKickLogic: kicking ${toBeKicked.length} members`)
        return toBeKicked
    }
}
