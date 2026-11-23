// send-via-contract.mjs — call the Sender contract on Para A, which sends an XCM
// (through the XCM precompile) that calls Receiver.receiveMessage(text) on Para B.
//
// The precompile sends the message with the Sender contract as its origin, so on
// Para B the message runs as an account derived from (Para A, Sender contract).
// That account pays the fee on Para B, and the Sender contract itself pays the
// delivery fee on Para A. This script funds both (with sudo) if needed.
//
// Needs deployments.json with Sender on Para A and Receiver on Para B:
//   WS=ws://127.0.0.1:9988 node deploy.mjs Sender
//   node deploy.mjs Receiver
//
// Usage:
//   node send-via-contract.mjs ["some text"]   # send and wait for the Receiver's event
//   node send-via-contract.mjs --dry-run       # check setup and simulate, send nothing
//
// Environment overrides (all optional):
//   PARA_A_WS=ws://127.0.0.1:9988  PARA_B_WS=ws://127.0.0.1:9989  SURI=//Alice
//   NETWORK=Polkadot  (relay network id used in the origin; Asset Hub Paseo uses Polkadot)
//   FEE=10000000000  FUND=1000000000000  TIMEOUT_SEC=120

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { existsSync, readFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionData } from 'viem';

const env = process.env;
const PARA_A_WS = env.PARA_A_WS ?? 'ws://127.0.0.1:9988';
const PARA_B_WS = env.PARA_B_WS ?? 'ws://127.0.0.1:9989';
const SURI = env.SURI ?? '//Alice';
const NETWORK = env.NETWORK ?? 'Polkadot';
const FEE = BigInt(env.FEE ?? '10000000000');      // max execution fee on Para B (1 PAS); rest refunded
const FUND = BigInt(env.FUND ?? '1000000000000');  // balance given to each paying account (100 PAS)
const TIMEOUT_SEC = Number(env.TIMEOUT_SEC ?? 120);
const DRY_RUN = process.argv.includes('--dry-run');
const TEXT = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? `hello from the Sender contract at ${new Date().toISOString()}`;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const here = (p) => new URL(p, import.meta.url).pathname;
const abiOf = (name) => JSON.parse(readFileSync(here(`./build/src_${name}_sol_${name}.abi`), 'utf8'));

function moduleError(api, err) {
  if (!err.isModule) return err.toString();
  const { section, name } = api.registry.findMetaError(err.asModule);
  return `${section}.${name}`;
}

function send(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) return reject(new Error(moduleError(api, dispatchError)));
      if (!status.isInBlock) return;
      const sudoErr = events.find(({ event }) => api.events.sudo?.Sudid.is(event) && event.data[0].isErr);
      if (sudoErr) return reject(new Error(`sudo call failed: ${moduleError(api, sudoErr.event.data[0].asErr)}`));
      resolve({ events, block: status.asInBlock.toHex() });
    }).catch(reject);
  });
}

// Give `account` a free balance of FUND on `api`'s chain, unless it already has enough.
async function ensureFunded(api, account, label, alice) {
  const free = (await api.query.system.account(account)).data.free.toBigInt();
  if (free >= FUND / 2n) return log(`${label} ${account} has ${free}`);
  if (DRY_RUN) return log(`[dry-run] ${label} ${account} has ${free}; would set it to ${FUND}`);
  await send(api, api.tx.sudo.sudo(api.tx.balances.forceSetBalance(account, FUND)), alice);
  log(`${label} ${account} funded with ${FUND}`);
}

async function main() {
  await cryptoWaitReady();
  const A = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS), noInitWarn: true });
  const B = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS), noInitWarn: true });
  const alice = new Keyring({ type: 'sr25519' }).addFromUri(SURI);
  const paraAId = (await A.query.parachainInfo.parachainId()).toNumber();
  const paraBId = (await B.query.parachainInfo.parachainId()).toNumber();

  const deployments = existsSync(here('./deployments.json')) ? JSON.parse(readFileSync(here('./deployments.json'), 'utf8')) : {};
  const sender = deployments[paraAId]?.Sender;
  const receiver = deployments[paraBId]?.Receiver;
  if (!sender) fail(`no Sender for para ${paraAId}; run: WS=${PARA_A_WS} node deploy.mjs Sender`);
  if (!receiver) fail(`no Receiver for para ${paraBId}; run: node deploy.mjs Receiver`);
  const senderAbi = abiOf('Sender');
  const receiverAbi = abiOf('Receiver');

  // Who pays what:
  //  - on Para A, the Sender contract's own account pays the XCM delivery fee;
  //  - on Para B, the message's origin is (Para A, Sender contract), which maps to a derived account.
  const senderAccount = (await A.call.reviveApi.accountId(sender)).toString();
  const origin = {
    parents: 1,
    interior: { X2: [{ Parachain: paraAId }, { AccountId32: { network: NETWORK, id: A.createType('AccountId32', senderAccount).toHex() } }] },
  };
  const conv = await B.call.locationToAccountApi.convertLocation({ V5: origin });
  if (conv.isErr) fail(`para ${paraBId} cannot map the Sender's origin to an account: ${conv.asErr.toString()}`);
  const derived = conv.asOk.toString();
  const derivedH160 = (await B.call.reviveApi.address(derived)).toHex();
  log(`Sender ${sender} on para ${paraAId} (account ${senderAccount})`);
  log(`Receiver ${receiver} on para ${paraBId}`);
  log(`On para ${paraBId} the message will run as ${derived} (${derivedH160})`);

  await ensureFunded(A, senderAccount, `[para ${paraAId}] Sender contract account`, alice);
  await ensureFunded(B, derived, `[para ${paraBId}] Sender's derived account`, alice);

  // The call to run on Para B: Receiver.receiveMessage(TEXT), made by the derived account.
  const data = encodeFunctionData({ abi: receiverAbi, functionName: 'receiveMessage', args: [TEXT] });
  // Estimate as the derived account; in a dry run it may not be funded yet, so estimate as Alice.
  const derivedFunded = (await B.query.system.account(derived)).data.free.toBigInt() >= FUND / 2n;
  const est = await B.call.reviveApi.call(derivedFunded ? derived : alice.address, receiver, 0, null, null, data);
  if (est.result.isErr) fail(`simulated Receiver call failed: ${moduleError(B, est.result.asErr)}`);
  const deposit = est.storageDeposit.isCharge ? est.storageDeposit.asCharge.toBigInt() : 0n;
  const reviveCall = B.tx.revive.call(receiver, 0, est.weightRequired, deposit * 2n + 1_000_000_000n, data);
  const mapped = (await B.query.revive.originalAccount(derivedH160)).isSome;
  const callOnB = mapped ? reviveCall : B.tx.utility.batchAll([B.tx.revive.mapAccount(), reviveCall]);

  // XCM program for Para B (the precompile adds DescendOrigin(Sender) in front of it).
  const fee = { id: { parents: 1, interior: 'Here' }, fun: { Fungible: FEE } };
  const xcm = A.createType('XcmVersionedXcm', {
    V5: [
      { WithdrawAsset: [fee] },
      { BuyExecution: { fees: fee, weightLimit: 'Unlimited' } },
      { Transact: { originKind: 'SovereignAccount', fallbackMaxWeight: null, call: { encoded: callOnB.method.toHex() } } },
      'RefundSurplus',
      { DepositAsset: { assets: { Wild: { AllCounted: 1 } }, beneficiary: origin } }, // refund to the derived account
    ],
  }).toHex();
  const dest = A.createType('XcmVersionedLocation', { V5: { parents: 1, interior: { X1: [{ Parachain: paraBId }] } } }).toHex();

  // Call Sender.sendMessage(dest, xcm) on Para A.
  const sendData = encodeFunctionData({ abi: senderAbi, functionName: 'sendMessage', args: [dest, xcm] });
  const simA = await A.call.reviveApi.call(alice.address, sender, 0, null, null, sendData);
  if (simA.result.isErr) fail(`simulated Sender.sendMessage failed: ${moduleError(A, simA.result.asErr)}`);
  if (simA.result.asOk.flags.bits.toNumber() & 1) fail('simulated Sender.sendMessage reverted (is the Sender contract funded?)');
  const depositA = simA.storageDeposit.isCharge ? simA.storageDeposit.asCharge.toBigInt() : 0n;
  // The estimate undercounts the XCM precompile's work: with exactly weightRequired the
  // call runs out of gas, so give it twice as much (unused weight is refunded).
  const weightA = { refTime: simA.weightRequired.refTime.toBigInt() * 2n, proofSize: simA.weightRequired.proofSize.toBigInt() * 2n };
  const tx = A.tx.revive.call(sender, 0, weightA, depositA * 2n + 1_000_000_000n, sendData);

  if (DRY_RUN) {
    const ra = await A.call.dryRunApi.dryRunCall({ system: { Signed: alice.address } }, tx.method, 5);
    log(`[dry-run] Para A: ${ra.asOk.executionResult.isOk ? 'OK' : JSON.stringify(ra.asOk.executionResult.toHuman())}, events: ${ra.asOk.emittedEvents.toHuman().map((e) => `${e.section}.${e.method}`).join(', ')}`);
    const fwd = ra.asOk.forwardedXcms;
    if (fwd.length === 0) fail('simulation on Para A produced no outgoing XCM');
    const rb = await B.call.dryRunApi.dryRunXcm({ V5: { parents: 1, interior: { X1: [{ Parachain: paraAId }] } } }, fwd[0][1][0]);
    log(`[dry-run] Para B outcome: ${JSON.stringify(rb.asOk.executionResult.toHuman())}`);
    log(`[dry-run] Para B events: ${rb.asOk.emittedEvents.toHuman().map((e) => `${e.section}.${e.method}`).join(', ')}`);
    await A.disconnect(); await B.disconnect();
    return;
  }

  // Watch Para B before sending.
  let sentAt;
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no event from the Receiver within ${TIMEOUT_SEC}s`)), TIMEOUT_SEC * 1000);
    B.query.system.events((events) => {
      for (const { event } of events) {
        if (B.events.polkadotXcm.ProcessXcmError?.is(event)) { clearTimeout(timer); reject(new Error(`Para B: XCM error ${event.data.toString()}`)); }
        if (B.events.messageQueue.Processed.is(event) && !event.data.success.isTrue && event.data.origin.toString().includes(String(paraAId))) {
          clearTimeout(timer); reject(new Error(`Para B processed the message but it failed: ${event.data.toString()}`));
        }
        if (B.events.revive.ContractEmitted.is(event) && event.data.contract.toHex() === receiver.toLowerCase()) { clearTimeout(timer); resolve(); }
      }
    });
  });

  log(`Calling Sender.sendMessage on para ${paraAId}: receiveMessage("${TEXT}") on para ${paraBId}`);
  const { events, block } = await send(A, tx, alice);
  sentAt = Date.now();
  for (const { event } of events) {
    if (A.events.polkadotXcm.Sent.is(event)) log(`Para A: polkadotXcm.Sent (message id ${event.data.messageId.toHex()})`);
  }
  log(`Para A: included in block ${block}`);

  await received;
  log(`Para B: Receiver emitted its event ${((Date.now() - sentAt) / 1000).toFixed(1)}s after inclusion on Para A`);
  for (const name of ['messageCount', 'lastMessage', 'lastCaller']) {
    const r = await B.call.reviveApi.call(alice.address, receiver, 0, null, null, encodeFunctionData({ abi: receiverAbi, functionName: name }));
    if (r.result.isOk) log(`  ${name}() = ${decodeFunctionResult({ abi: receiverAbi, functionName: name, data: r.result.asOk.data.toHex() })}`);
  }
  log(`  (lastCaller should be ${derivedH160}, the Sender contract's derived account)`);
  await A.disconnect(); await B.disconnect();
}

main().catch((e) => fail(e.message ?? e));
