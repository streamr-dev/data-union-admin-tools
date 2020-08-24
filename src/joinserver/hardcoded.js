// This is just a demo logic. In a real implementation you'll want to authenticate the requests better!

const secrets = {
    '0x103efb97b56ac6c5e697e58812a1a0eaa2529b14': {
        'my-very-secret-password': true
    }
}

module.exports = class HardcodedJoinValidationLogic {
    constructor(options) {
        this.options = options
    }

    validate(contractAddress, memberAddress, requestBody) {
        if (!requestBody.secret) {
            throw new Error(`No secret provided! Request body was: ${JSON.stringify(requestBody)}`)
        }

        if (!secrets[contractAddress] || !secrets[contractAddress][requestBody.secret]) {
            throw new Error(`Invalid secret provided!`)
        }
    }
}
