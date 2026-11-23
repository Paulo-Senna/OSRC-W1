#!/usr/bin/env bash
# Spawn the zombienet network, wait for both parachains to produce blocks,
# then open the HRMP channels. Press Ctrl+C to stop the network.
set -e
cd "$(dirname "$0")/.."

./bin/zombienet spawn zombienet/network.toml &
ZOMBIE_PID=$!
trap 'kill $ZOMBIE_PID 2>/dev/null' EXIT

# Prints the best block number of the chain whose RPC is on port $1
# (prints nothing while the node is not up yet).
block() {
  curl -s -H 'Content-Type: application/json' \
    -d '{"id":1,"jsonrpc":"2.0","method":"chain_getHeader","params":[]}' \
    "http://127.0.0.1:$1" | grep -o '"number":"0x[0-9a-f]*"' | cut -d'"' -f4 | xargs -r printf '%d\n'
}

echo "Waiting for both parachains to produce blocks..."
until [ "$(block 9988)" -gt 0 ] 2>/dev/null && [ "$(block 9989)" -gt 0 ] 2>/dev/null; do
  sleep 5
done

echo "Parachains are producing blocks. Opening HRMP channels..."
node scripts/open-hrmp.mjs
echo "HRMP channels opened. Funding accounts..."
node scripts/funds.mjs

echo "Network ready. Press Ctrl+C to stop it."
wait $ZOMBIE_PID
