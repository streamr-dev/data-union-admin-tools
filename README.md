## data-union-admin-tools

![CI badge](https://github.com/streamr-dev/data-union-admin-tools/actions/workflows/nodejs.yml/badge.svg)

**UTILITIES IN THIS REPOSITORY SHOULD BE CONSIDERED EXPERIMENTAL. USE AT YOUR OWN RISK, PLEASE KNOW WHAT YOU'RE DOING. [Contact us in Discord](https://discord.com/invite/gZAm8P7hK8) if you're unsure.**

This repository contains a selection of command-line tools for administering Data Unions on Streamr:

* [autokick](#binautokickjs)
* [signed withdraw server](#signed-withdraw-server)

### Installation

To use the tools, you should have node.js and `git` installed as prerequisites.

* Clone the repo: `git clone git@github.com:streamr-dev/data-union-admin-tools.git`
* `cd data-union-admin-tools`
* Install dependencies: `npm ci`

### bin/autokick.js

**WARNING: this tool depends on large historical resends, which are currently unreliable. Do NOT run the util without the `--dry-run` flag. You have been warned!**

A utility to automatically remove non-contributing members from your data union.

Ships with a simple inactivity logic, which kicks users who haven't sent any data within the inspected time window. More elaborate logic can be plugged in.

To get help, just run `bin/autokick.js` without any arguments:

```
Usage: autokick.js --stream [streamId] --contract-address [0x...] ...

Options:
  --help                   Show help                                   [boolean]
  --version                Show version number                         [boolean]
  --stream                 ID of your content stream (to which members produce
                           data). Give this option multiple times to cover
                           multiple streams.                  [array] [required]
  --contract-address       The address of the data union smart contract.
                                                             [string] [required]
  --window-hours           The time window during which to observe messages in
                           the content stream(s).         [number] [default: 48]
  --kick-logic             Loads the desired kick logic from src/autokick
                           folder. The default 'inactivity' logic simply kicks
                           members who haven't published any data during the
                           inspected period.    [string] [default: "inactivity"]
  --batch                  Does a resend on the stream, runs the kick logic, and
                           quits. No continuous monitoring.
                                                      [boolean] [default: false]
  --kick-interval-minutes  How often, in minutes, to check for kickable members
                           and send part messages to kick them. Has no effect in
                           --batch mode.                  [number] [default: 10]
  --api-key                API key of a user that has publish permission to the
                           join/part stream. Either --api-key or --private-key
                           must be given.
  --private-key            Ethereum private key of a user that has publish
                           permission to the join/part stream. Either api-key or
                           private-key must be given.
  --streamr-url            The Streamr websocket API URL. By default, uses the
                           default value in the Streamr JS SDK
                           (wss://streamr.network/api/v1/ws)
  --streamr-rest-url       The Streamr REST API URL. By default, uses the
                           default value in the Streamr JS SDK
                           (https://streamr.network/api/v1)
  --order-messages         Set the orderMessages Streamr client option to true,
                           activating message ordering and gapfill.
                                                      [boolean] [default: false]
  --dry-run                If this option is given, the script doesn't really
                           kick members from the data union, but instead logs
                           kicks to the console.      [boolean] [default: false]

Missing required arguments: stream, contract-address
```

To try it out with default settings and in `--dry-run` mode to avoid accidents, try:

```
bin/autokick.js --stream [streamId] --contract-address [address] --private-key [key] --dry-run
```

Where the arguments are:

* `--stream [streamId]`: The id of the stream your users are sending signed messages to. You can give the `--stream` option multiple times if there are multiple streams related to your data union.
* `--contract-address [address]`: The Ethereum address of your data union smart contract.
* `--private-key [key]`: An Ethereum private key for an address that has been granted permissions to:
  * Read data in all the streams given with `--stream`, and
  * Write to the join/part stream of your data union (not required in `--dry-run` mode, as you're not really kicking anybody)

### Signed withdraw server
```
bin/start-signed-withdraw-server.js 
```

Opens a HTTP port and executes the signed withdrawals from given data unions. This way the data union member doesn't need to pay for the gas when the withdrawn tokens are transported to mainnet over the Asyncronous Message-passing Bridge (AMB).

The data union member only signs a permission to withdraw their tokens into a given (maybe 3rd party) address. The signature is created using StreamrClient:
```javascript
const client = new StreamrClient({
    auth: { privateKey },
    dataUnion,
})
const signature = await client.signWithdrawTo(recipientAddress)
```

Pass arguments as environment variables:

```$xslt
Usage: SERVER_PRIVATE_KEY=0x1234... DATA_UNION_ADDRESS=0x1234... bin/start-signed-withdraw-server.js

SERVER_PRIVATE_KEY is the Ethereum key that will be used for paying the transaction fees
                   so the account must have ETH in it

DATA_UNION_ADDRESS is the Ethereum address or comma-separated list of Ethereum addresses,
                   of the data union whose withdraws are handled by this server (default: handle all)

PORT is where the HTTP server listens for incoming connections (default: 3000)

ETHEREUM_URL is the Ethereum (mainnet) node used for sending the transactions (default: ethers.js)
```
