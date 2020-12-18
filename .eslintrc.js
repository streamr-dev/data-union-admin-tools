module.exports = {
    env: {
        node: true,
        es6: true
    },
    extends: [
        'streamr-nodejs'
    ],

    rules: {
        // TODO: add these to eslint-config-streamr
        'max-len': 'off',
        'object-curly-newline': 'off',
        'promise/always-return': 'warn',
        'no-await-in-loop': 'off',
        'semi-style': ['warn', 'first'],

        // CLI tool specific
        'no-console': 'off',

        // this is broken for some reason, try removing it and check autokick.js
        'import/order': 'warn',
    }
}
