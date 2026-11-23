// fund-sovereign.mjs — give each parachain's sovereign account a balance on the
// other parachain, so XCM sent between them can pay for execution.
//
// Para A's sovereign account lives on Para B (and vice versa). The address is
// asked from the destination chain itself (LocationToAccountApi), then set with
// sudo(balances.forceSetBalance).
//
// Usage:
//   node funds.mjs             # fund both directions
//   node funds.mjs --dry-run   # only show addresses and balances
//
// Environment overrides (all optional):
//   PARA_A_WS=ws://127.0.0.1:9988  PARA_B_WS=ws://127.0.0.1:9989
//   PARA_A=2000  PARA_B=2001  SUDO_SURI=//Alice  AMOUNT=1000000000000000

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const env = process.env;
const PARA_A = Number(env.PARA_A ?? 2000);
const PARA_B = Number(env.PARA_B ?? 2001);
const PARA_A_WS = env.PARA_A_WS ?? 'ws://127.0.0.1:9988';
const PARA_B_WS = env.PARA_B_WS ?? 'ws://127.0.0.1:9989';
const SUDO_SURI = env.SUDO_SURI ?? '//Alice';
const AMOUNT = BigInt(env.AMOUNT ?? '1000000000000000');
const DRY_RUN = process.argv.includes('--dry-run');

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

// Fund, on the chain at `ws`, the sovereign account of sibling parachain `siblingId`.
async function fund(ws, siblingId, sudoer) {
  const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
  const selfId = (await api.query.parachainInfo.parachainId()).toNumber();
  const tag = `[on ${selfId}]`;

  const res = await api.call.locationToAccountApi.convertLocation({
    V5: { parents: 1, interior: { X1: [{ Parachain: siblingId }] } },
  });
  if (res.isErr) fail(`${tag} could not derive the sovereign account of ${siblingId}: ${res.asErr.toString()}`);
  const account = res.asOk.toString();

  const free = (await api.query.system.account(account)).data.free.toBigInt();
  log(`${tag} sovereign account of ${siblingId}: ${account} (free: ${free})`);

  if (free >= AMOUNT) {
    log(`${tag} already funded, skipping`);
  } else if (DRY_RUN) {
    log(`${tag} [dry-run] would set free balance to ${AMOUNT}`);
  } else {
    const sudoKey = (await api.query.sudo.key()).unwrapOr(null)?.toString();
    if (sudoKey !== sudoer.address) fail(`${tag} ${SUDO_SURI} is not the sudo key (${sudoKey})`);

    const tx = api.tx.sudo.sudo(api.tx.balances.forceSetBalance(account, AMOUNT));
    await new Promise((resolve, reject) => {
      tx.signAndSend(sudoer, ({ status, events, dispatchError }) => {
        if (dispatchError) return reject(new Error(`${tag} transaction failed: ${dispatchError.toString()}`));
        if (!status.isInBlock) return;
        for (const { event } of events) {
          if (api.events.sudo.Sudid.is(event) && event.data[0].isErr) {
            const err = event.data[0].asErr;
            const msg = err.isModule
              ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(err.asModule))
              : err.toString();
            return reject(new Error(`${tag} sudo call failed: ${msg}`));
          }
        }
        log(`${tag} included in block ${status.asInBlock.toHex()}`);
        resolve();
      }).catch(reject);
    });
    const after = (await api.query.system.account(account)).data.free.toBigInt();
    log(`${tag} new free balance: ${after}`);
  }
  await api.disconnect();
}

async function main() {
  await cryptoWaitReady();
  const sudoer = new Keyring({ type: 'sr25519' }).addFromUri(SUDO_SURI);
  await fund(PARA_B_WS, PARA_A, sudoer); // Para A's account on Para B
  await fund(PARA_A_WS, PARA_B, sudoer); // Para B's account on Para A
  log('Done.');
}

main().catch((e) => fail(e.message ?? e));
