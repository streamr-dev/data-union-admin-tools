module.exports = {
    env: {
        node: true,
        es6: true
    },
    parserOptions: {
        ecmaVersion: 2017
    },
    extends: [
        'streamr-nodejs'
    ],

    rules: {
        // TODO: add these to eslint-config-streamr
        'max-len': 'off',
        'object-curly-newline': 'off',
        'promise/always-return': 'off',
        'no-await-in-loop': 'off',

        // CLI tool specific
        'no-console': 'off',

        // this is broken for some reason, try removing it and check autokick.js
        'import/order': 'warn',
    }
}
