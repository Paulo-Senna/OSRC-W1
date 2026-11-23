// deploy.mjs — deploy a compiled Solidity contract (from build/) to a parachain
// through pallet-revive, and record its address in deployments.json.
//
// Compile first:  npx resolc src/<Name>.sol --bin --abi -o build
//
// Usage:
//   node deploy.mjs Receiver                              # on Para B (default)
//   WS=ws://127.0.0.1:9988 node deploy.mjs Sender         # on Para A
//   node deploy.mjs Receiver --dry-run                    # simulate only
//
// Environment overrides (all optional): WS=ws://127.0.0.1:9989, SURI=//Alice

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const NAME = process.argv.slice(2).find((a) => !a.startsWith('--'));
const WS = process.env.WS ?? 'ws://127.0.0.1:9989';
const SURI = process.env.SURI ?? '//Alice';
const DRY_RUN = process.argv.includes('--dry-run');
const DEPLOYMENTS = new URL('./deployments.json', import.meta.url).pathname;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

function moduleError(api, err) {
  if (!err.isModule) return err.toString();
  const { section, name, docs } = api.registry.findMetaError(err.asModule);
  return `${section}.${name}: ${docs.join(' ')}`;
}

function send(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) return reject(new Error(moduleError(api, dispatchError)));
      if (status.isInBlock) resolve(events);
    }).catch(reject);
  });
}

async function main() {
  if (!NAME) fail('usage: node deploy.mjs <ContractName> [--dry-run]');
  const file = new URL(`./build/src_${NAME}_sol_${NAME}.polkavm`, import.meta.url).pathname;
  if (!existsSync(file)) fail(`${file} not found; compile src/${NAME}.sol first`);
  // Must be a hex string: polkadot.js mis-encodes a Node Buffer.
  const code = '0x' + readFileSync(file).toString('hex');

  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
  const signer = new Keyring({ type: 'sr25519' }).addFromUri(SURI);
  const paraId = (await api.query.parachainInfo.parachainId()).toNumber();
  log(`Deploying ${NAME} to para ${paraId} (${WS}) as ${signer.address}`);

  const h160 = (await api.call.reviveApi.address(signer.address)).toHex();
  if ((await api.query.revive.originalAccount(h160)).isNone) {
    if (DRY_RUN) log('[dry-run] account not mapped; would call revive.mapAccount first');
    else { await send(api, api.tx.revive.mapAccount(), signer); log(`Mapped account to ${h160}`); }
  }

  const sim = await api.call.reviveApi.instantiate(signer.address, 0, null, null, { Upload: code }, '0x', null);
  if (sim.result.isErr) fail(`simulated deployment failed: ${moduleError(api, sim.result.asErr)}`);
  const deposit = sim.storageDeposit.isCharge ? sim.storageDeposit.asCharge.toBigInt() : 0n;
  log(`Simulation OK: storage deposit ${deposit}`);
  if (DRY_RUN) { await api.disconnect(); return; }

  const events = await send(api, api.tx.revive.instantiateWithCode(0, sim.weightRequired, deposit * 2n, code, '0x', null), signer);
  const inst = events.find(({ event }) => api.events.revive.Instantiated.is(event));
  if (!inst) fail('no revive.Instantiated event');
  const addr = inst.event.data.contract.toHex();
  log(`Deployed ${NAME} at ${addr}`);

  const deployments = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, 'utf8')) : {};
  deployments[paraId] = { ...deployments[paraId], [NAME]: addr };
  writeFileSync(DEPLOYMENTS, JSON.stringify(deployments, null, 2) + '\n');
  log(`Saved to deployments.json`);
  await api.disconnect();
}

main().catch((e) => fail(e.message ?? e));
