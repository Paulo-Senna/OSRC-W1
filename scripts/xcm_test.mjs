// send-remark.mjs — send an XCM from Para A to Para B (over HRMP) that pays its
// own fee on Para B and runs system.remarkWithEvent there, then wait for it.
//
// The XCM runs on Para B as Para A's sovereign account, which must hold funds
// (see the funding script). It is sent with sudo, so its origin is Para A itself.
//
// Usage:
//   node xcm-test.mjs ["some text"]   # send and wait for System.Remarked on Para B
//   node xcm-test.mjs --dry-run       # simulate on both chains, send nothing
//
// Environment overrides (all optional):
//   PARA_A_WS=ws://127.0.0.1:9988  PARA_B_WS=ws://127.0.0.1:9989
//   PARA_A=2000  PARA_B=2001  SUDO_SURI=//Alice  FEE=10000000000  TIMEOUT_SEC=120

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { blake2AsHex, cryptoWaitReady } from '@polkadot/util-crypto';

const env = process.env;
const PARA_A = Number(env.PARA_A ?? 2000);
const PARA_B = Number(env.PARA_B ?? 2001);
const PARA_A_WS = env.PARA_A_WS ?? 'ws://127.0.0.1:9988';
const PARA_B_WS = env.PARA_B_WS ?? 'ws://127.0.0.1:9989';
const SUDO_SURI = env.SUDO_SURI ?? '//Alice';
const FEE = BigInt(env.FEE ?? '10000000000'); // max fee taken on Para B (1 PAS); unused part is refunded
const TIMEOUT_SEC = Number(env.TIMEOUT_SEC ?? 120);
const DRY_RUN = process.argv.includes('--dry-run');
const TEXT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? `hello from para ${PARA_A}`;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

async function main() {
  await cryptoWaitReady();
  const A = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS), noInitWarn: true });
  const B = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS), noInitWarn: true });
  const alice = new Keyring({ type: 'sr25519' }).addFromUri(SUDO_SURI);

  // Locations as seen from the other parachain.
  const paraA = { parents: 1, interior: { X1: [{ Parachain: PARA_A }] } };
  const paraB = { parents: 1, interior: { X1: [{ Parachain: PARA_B }] } };

  // The call to run on Para B, and the XCM program that carries it.
  const remark = B.tx.system.remarkWithEvent(TEXT);
  const fee = { id: { parents: 1, interior: 'Here' }, fun: { Fungible: FEE } }; // relay token (PAS)
  const message = {
    V5: [
      { WithdrawAsset: [fee] },                                         // take FEE from Para A's sovereign account
      { BuyExecution: { fees: fee, weightLimit: 'Unlimited' } },        // pay for executing this program
      { Transact: { originKind: 'SovereignAccount', fallbackMaxWeight: null, call: { encoded: remark.method.toHex() } } },
      'RefundSurplus',                                                  // get back unused fee
      { DepositAsset: { assets: { Wild: { AllCounted: 1 } }, beneficiary: paraA } }, // ...into the sovereign account
    ],
  };
  const tx = A.tx.sudo.sudo(A.tx.polkadotXcm.send({ V5: paraB }, message));

  if (DRY_RUN) {
    const ra = await A.call.dryRunApi.dryRunCall({ system: { Signed: alice.address } }, tx.method, 5);
    if (ra.isErr || ra.asOk.executionResult.isErr) fail(`simulation on Para A failed: ${JSON.stringify(ra.toHuman())}`);
    const forwarded = ra.asOk.forwardedXcms;
    if (forwarded.length === 0) fail('simulation on Para A did not produce any outgoing XCM');
    log(`[dry-run] Para A: message accepted, forwarded to ${JSON.stringify(forwarded[0][0].toHuman())}`);
    const rb = await B.call.dryRunApi.dryRunXcm({ V5: paraA }, forwarded[0][1][0]);
    log(`[dry-run] Para B outcome: ${JSON.stringify(rb.asOk.executionResult.toHuman())}`);
    for (const ev of rb.asOk.emittedEvents.toHuman()) log(`[dry-run] Para B event: ${ev.section}.${ev.method}`);
    await A.disconnect(); await B.disconnect();
    return;
  }

  // Start watching Para B before sending, so the result can't be missed.
  const expectedHash = blake2AsHex(TEXT);
  let sentAt;
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no System.Remarked on Para B within ${TIMEOUT_SEC}s`)), TIMEOUT_SEC * 1000);
    B.query.system.events((events) => {
      for (const { event } of events) {
        if (B.events.messageQueue?.ProcessingFailed?.is(event)) {
          clearTimeout(timer);
          reject(new Error(`Para B failed to process a message: ${event.data.toString()}`));
        }
        if (B.events.system.Remarked.is(event) && event.data.hash_.toHex() === expectedHash) {
          clearTimeout(timer);
          resolve(event.data.sender.toString());
        }
      }
    });
  });

  log(`Sending XCM from ${PARA_A} to ${PARA_B}: remark "${TEXT}"`);
  await new Promise((resolve, reject) => {
    tx.signAndSend(alice, ({ status, events, dispatchError }) => {
      if (dispatchError) return reject(new Error(`transaction failed: ${dispatchError.toString()}`));
      if (!status.isInBlock) return;
      for (const { event } of events) {
        if (A.events.sudo.Sudid.is(event) && event.data[0].isErr) {
          const err = event.data[0].asErr;
          const msg = err.isModule
            ? (({ section, name }) => `${section}.${name}`)(A.registry.findMetaError(err.asModule))
            : err.toString();
          return reject(new Error(`sudo call failed on Para A: ${msg}`));
        }
        if (A.events.polkadotXcm.Sent.is(event)) log(`Para A: polkadotXcm.Sent (message id ${event.data.messageId.toHex()})`);
      }
      sentAt = Date.now();
      log(`Para A: included in block ${status.asInBlock.toHex()}`);
      resolve();
    }).catch(reject);
  });

  const sender = await received;
  log(`Para B: System.Remarked from ${sender} after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`);
  log('XCM delivered and executed.');
  await A.disconnect(); await B.disconnect();
}

main().catch((e) => fail(e.message ?? e));
