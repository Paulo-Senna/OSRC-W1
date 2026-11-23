// open-hrmp.mjs — open bidirectional HRMP channels between two parachains on a
// local zombienet relay chain, using sudo (hrmp.forceOpenHrmpChannel).
//
// Usage:
//   node open-hrmp.mjs              # open 2000<->2001 and wait until they are live
//   node open-hrmp.mjs --dry-run    # only check state and show what would be sent
//
// Environment overrides (all optional):
//   RELAY_WS=ws://127.0.0.1:9944  SUDO_SURI=//Alice  PARA_A=2000  PARA_B=2001
//   MAX_CAPACITY=8  MAX_MESSAGE_SIZE=1048576  TIMEOUT_SEC=80

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const env = process.env;
const RELAY_WS = env.RELAY_WS ?? 'ws://127.0.0.1:9944';
const SUDO_SURI = env.SUDO_SURI ?? '//Alice';
const PARA_A = Number(env.PARA_A ?? 2000);
const PARA_B = Number(env.PARA_B ?? 2001);
const MAX_CAPACITY = Number(env.MAX_CAPACITY ?? 8);
const MAX_MESSAGE_SIZE = Number(env.MAX_MESSAGE_SIZE ?? 1048576);
const TIMEOUT_SEC = Number(env.TIMEOUT_SEC ?? 80);
const DRY_RUN = process.argv.includes('--dry-run');

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

async function channelState(api, sender, recipient) {
  const id = { sender, recipient };
  if ((await api.query.hrmp.hrmpChannels(id)).isSome) return 'open';
  if ((await api.query.hrmp.hrmpOpenChannelRequests(id)).isSome) return 'requested';
  return 'absent';
}

async function main() {
  await cryptoWaitReady();
  log(`Connecting to relay chain at ${RELAY_WS} ...`);
  const api = await ApiPromise.create({ provider: new WsProvider(RELAY_WS), noInitWarn: true });
  log(`Connected: ${(await api.rpc.system.chain()).toString()}`);

  // 1. Sanity checks: both paras registered, values within relay limits.
  const paras = (await api.query.paras.parachains()).map((p) => p.toNumber());
  for (const id of [PARA_A, PARA_B]) {
    if (!paras.includes(id)) fail(`para ${id} is not a registered parachain (registered: ${paras.join(', ')})`);
  }
  const cfg = await api.query.configuration.activeConfig();
  const maxCap = cfg.hrmpChannelMaxCapacity.toNumber();
  const maxSize = cfg.hrmpChannelMaxMessageSize.toNumber();
  if (MAX_CAPACITY > maxCap) fail(`MAX_CAPACITY ${MAX_CAPACITY} > relay limit ${maxCap}`);
  if (MAX_MESSAGE_SIZE > maxSize) fail(`MAX_MESSAGE_SIZE ${MAX_MESSAGE_SIZE} > relay limit ${maxSize}`);
  log(`Relay limits OK (capacity <= ${maxCap}, message size <= ${maxSize})`);

  // 2. Work out which directions still need opening.
  const directions = [[PARA_A, PARA_B], [PARA_B, PARA_A]];
  const todo = [];
  for (const [s, r] of directions) {
    const st = await channelState(api, s, r);
    log(`Channel ${s} -> ${r}: ${st}`);
    if (st === 'absent') todo.push([s, r]);
  }

  // 3. Build and send the sudo batch.
  const keyring = new Keyring({ type: 'sr25519' });
  const sudoer = keyring.addFromUri(SUDO_SURI);
  const sudoKey = (await api.query.sudo.key()).unwrapOr(null)?.toString();
  if (sudoKey !== sudoer.address) fail(`${SUDO_SURI} (${sudoer.address}) is not the relay sudo key (${sudoKey})`);

  if (todo.length > 0) {
    const calls = todo.map(([s, r]) => api.tx.hrmp.forceOpenHrmpChannel(s, r, MAX_CAPACITY, MAX_MESSAGE_SIZE));
    const tx = api.tx.sudo.sudo(api.tx.utility.batchAll(calls));
    if (DRY_RUN) {
      log(`[dry-run] Would send sudo(utility.batchAll) opening: ${todo.map(([s, r]) => `${s}->${r}`).join(', ')}`);
      log(`[dry-run] Call data: ${tx.method.toHex()}`);
      const info = await tx.paymentInfo(sudoer);
      log(`[dry-run] Estimated fee: ${info.partialFee.toHuman()}`);
      await api.disconnect();
      return;
    }
    log(`Submitting sudo batch to open: ${todo.map(([s, r]) => `${s}->${r}`).join(', ')}`);
    await new Promise((resolve, reject) => {
      tx.signAndSend(sudoer, ({ status, events, dispatchError }) => {
        if (dispatchError) return reject(new Error(`transaction failed: ${dispatchError.toString()}`));
        if (!status.isInBlock) return;
        log(`Included in block ${status.asInBlock.toHex()}`);
        for (const { event } of events) {
          if (api.events.sudo.Sudid.is(event)) {
            const res = event.data[0];
            if (res.isErr) {
              const err = res.asErr;
              const msg = err.isModule
                ? (({ section, name, docs }) => `${section}.${name}: ${docs.join(' ')}`)(api.registry.findMetaError(err.asModule))
                : err.toString();
              return reject(new Error(`sudo call failed: ${msg}`));
            }
          }
          if (api.events.hrmp.HrmpChannelForceOpened.is(event)) {
            log(`Event hrmp.HrmpChannelForceOpened ${event.data.toString()}`);
          }
        }
        resolve();
      }).catch(reject);
    });
  } else {
    log(DRY_RUN ? '[dry-run] Nothing to send: both channels already exist or are requested.' : 'Nothing to send: both channels already exist or are requested.');
    if (DRY_RUN) { await api.disconnect(); return; }
  }

  // 4. Requests become real channels at the next session change; wait for that.
  log(`Waiting for channels to open (happens at the next session change, timeout ${TIMEOUT_SEC}s) ...`);
  const deadline = Date.now() + TIMEOUT_SEC * 1000;
  while (true) {
    const states = await Promise.all(directions.map(([s, r]) => channelState(api, s, r)));
    if (states.every((s) => s === 'open')) break;
    if (Date.now() > deadline) fail(`timed out; channel states: ${directions.map(([s, r], i) => `${s}->${r}=${states[i]}`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 6000));
  }
  const session = (await api.query.session.currentIndex()).toNumber();
  log(`Both channels open (session ${session}): ${PARA_A} <-> ${PARA_B}`);
  await api.disconnect();
}

main().catch((e) => fail(e.message ?? e));
