# Nectar RPC Node

Nectar RPC node maintains a private transaction pool, forwards them to auction and publishes winning bundles.

### Usage

```shell
deno run --allow-net --allow-read --allow-env main.ts \
  --auction=ws://localhost:11011 \
  --address=0x03bB3cE1B3020Cac191c9dA927Fc5C228bf5a0af \
  --publisher=http://localhost:11012
```
