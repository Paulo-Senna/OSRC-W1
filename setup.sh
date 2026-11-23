#!/usr/bin/env bash
# Usage: ./setup.sh [--specs] [--check] [--force]
set -euo pipefail
cd "$(dirname "$0")"

SPECS=false; CHECK=false; FORCE=false
for a in "$@"; do
  case "$a" in
    --specs) SPECS=true ;;
    --check) CHECK=true ;;
    --force) FORCE=true ;;
    *) echo "Unknown option: $a"; exit 1 ;;
  esac
done

ok()  { echo "  [ok]    $*"; }
err() { echo "  [error] $*" >&2; }
die() { err "$*"; exit 1; }

echo "==> Environment"
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || die "only Linux x86_64 is supported"
for cmd in curl sha256sum node npm; do
  command -v "$cmd" >/dev/null || die "'$cmd' not found"
done
ok "node $(node --version), npm $(npm --version)"

mkdir -p bin runtimes specs zombienet contracts scripts results

echo "==> Requirements"
FAILED=0
while read -r dest sha src; do
  [ -z "${dest:-}" ] && continue
  case "$dest" in \#*) continue ;; esac

  if [ "$src" = "repo" ]; then
    [ -f "$dest" ] || { err "$dest missing from repository"; FAILED=1; continue; }
  elif $FORCE || [ ! -f "$dest" ]; then
    if $CHECK; then err "$dest missing"; FAILED=1; continue; fi
    echo "  [get]   $dest"
    curl -fL --retry 3 --progress-bar -o "$dest.part" "$src" \
      || { err "download failed: $src"; rm -f "$dest.part"; FAILED=1; continue; }
    mv "$dest.part" "$dest"
  fi

  got=$(sha256sum "$dest" | cut -d' ' -f1)
  [ "$got" = "$sha" ] || { err "$dest sha256 mismatch (expected $sha, got $got)"; FAILED=1; continue; }
  case "$dest" in bin/*) chmod +x "$dest" ;; esac
  ok "$dest"
done < requirements.txt
[ "$FAILED" -eq 0 ] || die "requirements check failed"
$CHECK && { echo "==> OK"; exit 0; }

echo "==> Node dependencies"
(cd scripts && npm ci --no-audit --no-fund --silent)
ok "scripts/node_modules"
(cd contracts && npm ci --no-audit --no-fund --silent)
ok "contracts/node_modules"

echo "==> Contracts"
for c in Sender Receiver; do
  (cd contracts && npx resolc "src/$c.sol" --bin --abi -o build >/dev/null)
  ok "contracts/build/src_${c}_sol_${c}.polkavm"
done

if $SPECS; then
  echo "==> Chain specs"
  ./bin/chain-spec-builder -c specs/paseo-local.json create -t local \
    -r runtimes/paseo_runtime.compact.compressed.wasm named-preset local_testnet
  ok "specs/paseo-local.json"
  # parachainInfo.parachainId stays 1000 in genesis; zombienet sets 2000/2001 at spawn.
  for p in "a 2000" "b 2001"; do
    set -- $p
    ./bin/chain-spec-builder -c "specs/para-$1.json" create -t local \
      -r runtimes/asset-hub-paseo_runtime.compressed.wasm \
      --para-id "$2" --relay-chain custom \
      --chain-name "Para ${1^^}" --chain-id "para-$1" named-preset local_testnet
    ok "specs/para-$1.json"
  done
fi

echo "==> Done. Next: ./scripts/network.sh"
