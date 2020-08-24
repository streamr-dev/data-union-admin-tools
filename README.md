## data-union-admin-tools

This repository contains a selection of command-line tools for administering Data Unions on Streamr:

* [autokick](#binautokickjs)
* [joinserver](#binjoinserverjs)

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

### bin/joinserver.js

A http server to validate join requests to a Data Union. This can be used to implement custom validation for join requests, such as adding a CAPTCHA.

The util ships with a dummy validation logic called `hardcoded` that simply checks that the requests contain a pre-defined secret. In real life, you'll want to implement your own validation logic and pass it to the script with the `--validation-logic` option. 

To get help, just run `bin/joinserver.js` without any arguments:

```
Usage: joinserver.js --private-key [privateKeyHex] ...

Options:
  --help              Show help                                        [boolean]
  --version           Show version number                              [boolean]
  --private-key       Ethereum private key of the Data Union admin or join agent
                                                                      [required]
  --ethereum-rpc      Ethereum RPC URL to use                           [string]
  --validation-logic  Loads the desired join request validation logic from
                      src/joinserver folder. The default 'hardcoded' logic is a
                      dummy logic that accepts requests that supply a hard-coded
                      secret.                    [string] [default: "hardcoded"]
  --port              TCP port to listen on for HTTP requests
                                                       [number] [default: 16823]
```

The script must be run with a private key for a user that has the permission to join members to the Data Union.

Once the join server is running, you can try it out by doing a HTTP request:

```
curl -v -H "Content-Type: application/json" -d "{\"secret\":\"my-very-secret-password\"}" http://localhost:16823/0x103efb97b56ac6c5e697e58812a1a0eaa2529b14/0x9e3d69305Da51f34eE29BfB52721e3A824d59e69
```
