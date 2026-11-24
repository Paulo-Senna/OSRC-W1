// Runs N cross-chain calls Sender (Para A) -> Receiver (Para B) and writes one JSON line per run.
// Usage: node run-experiment.mjs [--runs 30] [--gap 6] [--out ../results/<name>.jsonl]
// Env: PARA_A_WS PARA_B_WS SURI NETWORK FEE FUND TIMEOUT_SEC

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeEventLog, decodeFunctionResult, encodeFunctionData } from 'viem';

const env = process.env;
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('runs', 30));
const GAP = Number(arg('gap', 6));
const here = (p) => new URL(p, import.meta.url).pathname;
const OUT = arg('out', here(`../results/run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`));
const PARA_A_WS = env.PARA_A_WS ?? 'ws://127.0.0.1:9988';
const PARA_B_WS = env.PARA_B_WS ?? 'ws://127.0.0.1:9989';
const SURI = env.SURI ?? '//Alice';
const NETWORK = env.NETWORK ?? 'Polkadot';
const FEE = BigInt(env.FEE ?? '10000000000');
const FUND = BigInt(env.FUND ?? '1000000000000');
const TIMEOUT_MS = Number(env.TIMEOUT_SEC ?? 120) * 1000;

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abiOf = (n) => JSON.parse(readFileSync(here(`./build/src_${n}_sol_${n}.abi`), 'utf8'));
const big = (x) => x.toString();

function moduleError(api, err) {
  if (!err.isModule) return err.toString();
  const { section, name } = api.registry.findMetaError(err.asModule);
  return `${section}.${name}`;
}

function submit(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError }) => {
      if (dispatchError) return reject(new Error(moduleError(api, dispatchError)));
      if (status.isInBlock) resolve({ events, hash: status.asInBlock.toHex(), at: Date.now() });
    }).catch(reject);
  });
}

async function blockInfo(api, hash) {
  const at = await api.at(hash);
  const [header, ts, relay] = await Promise.all([
    api.rpc.chain.getHeader(hash), at.query.timestamp.now(), at.query.parachainSystem.lastRelayChainBlockNumber(),
  ]);
  return { block: header.number.toNumber(), hash, timestamp: ts.toNumber(), relay_parent: relay.toNumber() };
}

async function main() {
  await cryptoWaitReady();
  const A = await ApiPromise.create({ provider: new WsProvider(PARA_A_WS), noInitWarn: true });
  const B = await ApiPromise.create({ provider: new WsProvider(PARA_B_WS), noInitWarn: true });
  const alice = new Keyring({ type: 'sr25519' }).addFromUri(SURI);
  const idA = (await A.query.parachainInfo.parachainId()).toNumber();
  const idB = (await B.query.parachainInfo.parachainId()).toNumber();

  const dep = JSON.parse(readFileSync(here('./deployments.json'), 'utf8'));
  const sender = dep[idA]?.Sender, receiver = dep[idB]?.Receiver;
  if (!sender || !receiver) throw new Error('deploy Sender (Para A) and Receiver (Para B) first');
  const senderAbi = abiOf('Sender'), receiverAbi = abiOf('Receiver');

  const senderAccount = (await A.call.reviveApi.accountId(sender)).toString();
  const origin = { parents: 1, interior: { X2: [{ Parachain: idA }, { AccountId32: { network: NETWORK, id: A.createType('AccountId32', senderAccount).toHex() } }] } };
  const conv = await B.call.locationToAccountApi.convertLocation({ V5: origin });
  if (conv.isErr) throw new Error(`cannot convert origin: ${conv.asErr.toString()}`);
  const derived = conv.asOk.toString();
  const derivedH160 = (await B.call.reviveApi.address(derived)).toHex();

  const free = async (api, who) => (await api.query.system.account(who)).data.free.toBigInt();
  for (const [api, who] of [[A, senderAccount], [B, derived]]) {
    if (await free(api, who) < FUND / 2n) await submit(api, api.tx.sudo.sudo(api.tx.balances.forceSetBalance(who, FUND)), alice);
  }

  const readReceiver = async (fn) => {
    const r = await B.call.reviveApi.call(alice.address, receiver, 0, null, null, encodeFunctionData({ abi: receiverAbi, functionName: fn }));
    return decodeFunctionResult({ abi: receiverAbi, functionName: fn, data: r.result.asOk.data.toHex() });
  };

  // Para B block stream: every new best block is inspected once.
  const waiters = [];
  let bestB = 0;
  await B.rpc.chain.subscribeNewHeads(async (h) => {
    const seen = Date.now();
    bestB = h.number.toNumber();
    const hash = h.hash.toHex();
    const events = await (await B.at(hash)).query.system.events();
    for (const w of [...waiters]) {
      const found = { processed: null, receiver: null };
      for (const { event } of events) {
        if (B.events.messageQueue.Processed.is(event) && event.data.id.toHex() === w.id) found.processed = event.data;
        if (B.events.revive.ContractEmitted.is(event) && event.data.contract.toHex() === receiver.toLowerCase()) {
          const d = decodeEventLog({ abi: receiverAbi, data: event.data.data.toHex(), topics: event.data.topics.map((t) => t.toHex()) });
          if (d.args.message === w.text) found.receiver = d.args;
        }
      }
      if (found.processed || found.receiver) { waiters.splice(waiters.indexOf(w), 1); w.resolve({ ...found, hash, seen }); }
    }
  });

  mkdirSync(dirname(OUT), { recursive: true });
  log(`Sender ${sender} (para ${idA}) -> Receiver ${receiver} (para ${idB}); derived ${derivedH160}`);
  log(`${RUNS} runs, gap ${GAP}s -> ${OUT}`);

  for (let run = 1; run <= RUNS; run++) {
    const text = `run-${run}-${Date.now()}`;
    const rec = { run, text, ok: false };
    try {
      const mapped = (await B.query.revive.originalAccount(derivedH160)).isSome;
      rec.warmup = !mapped;
      const data = encodeFunctionData({ abi: receiverAbi, functionName: 'receiveMessage', args: [text] });
      const est = await B.call.reviveApi.call(mapped ? derived : alice.address, receiver, 0, null, null, data);
      const depB = est.storageDeposit.isCharge ? est.storageDeposit.asCharge.toBigInt() : 0n;
      const call = B.tx.revive.call(receiver, 0, est.weightRequired, depB * 2n + 1_000_000_000n, data);
      const callOnB = mapped ? call : B.tx.utility.batchAll([B.tx.revive.mapAccount(), call]);

      const fee = { id: { parents: 1, interior: 'Here' }, fun: { Fungible: FEE } };
      const xcm = A.createType('XcmVersionedXcm', { V5: [
        { WithdrawAsset: [fee] },
        { BuyExecution: { fees: fee, weightLimit: 'Unlimited' } },
        { Transact: { originKind: 'SovereignAccount', fallbackMaxWeight: null, call: { encoded: callOnB.method.toHex() } } },
        'RefundSurplus',
        { DepositAsset: { assets: { Wild: { AllCounted: 1 } }, beneficiary: origin } },
      ] }).toHex();
      const dest = A.createType('XcmVersionedLocation', { V5: { parents: 1, interior: { X1: [{ Parachain: idB }] } } }).toHex();
      const sendData = encodeFunctionData({ abi: senderAbi, functionName: 'sendMessage', args: [dest, xcm] });
      const sim = await A.call.reviveApi.call(alice.address, sender, 0, null, null, sendData);
      if (sim.result.isErr || (sim.result.asOk.flags.bits.toNumber() & 1)) throw new Error('Sender.sendMessage simulation failed');
      const depA = sim.storageDeposit.isCharge ? sim.storageDeposit.asCharge.toBigInt() : 0n;
      const weight = { refTime: sim.weightRequired.refTime.toBigInt() * 2n, proofSize: sim.weightRequired.proofSize.toBigInt() * 2n };
      const tx = A.tx.revive.call(sender, 0, weight, depA * 2n + 1_000_000_000n, sendData);

      const countBefore = await readReceiver('messageCount');
      const costBefore = await free(B, derived);
      const sentFreeBefore = await free(A, senderAccount);
      const bestBAtSend = bestB;
      const tSubmit = Date.now();
      rec.submitted_at = new Date(tSubmit).toISOString();

      const inc = await submit(A, tx, alice);
      const a = { ...(await blockInfo(A, inc.hash)) };
      for (const { event } of inc.events) {
        if (A.events.polkadotXcm.Sent.is(event)) a.message_id = event.data.messageId.toHex();
        if (A.events.transactionPayment.TransactionFeePaid.is(event)) a.tx_fee = big(event.data.actualFee);
      }
      a.delivery_fee = big(sentFreeBefore - (await free(A, senderAccount)));
      if (!a.message_id) throw new Error('no polkadotXcm.Sent on Para A');
      rec.para_a = a;

      const got = await Promise.race([
        new Promise((resolve) => waiters.push({ id: a.message_id, text, resolve })),
        sleep(TIMEOUT_MS).then(() => { throw new Error('timeout waiting for Para B'); }),
      ]);
      const b = await blockInfo(B, got.hash);
      b.processed = got.processed ? got.processed.success.isTrue : null;
      b.weight_ref_time = got.processed ? big(got.processed.weightUsed.refTime) : null;
      b.weight_proof_size = got.processed ? big(got.processed.weightUsed.proofSize) : null;
      b.receiver_event = !!got.receiver;
      b.cost = big(costBefore - (await free(B, derived)));
      rec.para_b = b;

      const countAfter = await readReceiver('messageCount');
      const lastMessage = await readReceiver('lastMessage');
      const lastCaller = await readReceiver('lastCaller');
      rec.state = {
        count_before: Number(countBefore), count_after: Number(countAfter),
        count_ok: countAfter === countBefore + 1n, message_ok: lastMessage === text,
        caller_ok: lastCaller.toLowerCase() === derivedH160.toLowerCase(),
      };
      rec.latency = {
        submit_to_b_ms: got.seen - tSubmit,
        a_to_b_ms: got.seen - inc.at,
        onchain_a_to_b_ms: b.timestamp - a.timestamp,
        para_b_blocks: b.block - bestBAtSend,
        relay_blocks: b.relay_parent - a.relay_parent,
      };
      rec.ok = b.receiver_event && b.processed !== false && rec.state.count_ok && rec.state.message_ok && rec.state.caller_ok;
    } catch (e) {
      rec.error = e.message ?? String(e);
    }
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    log(`run ${run}/${RUNS}: ${rec.ok ? 'ok' : 'FAIL'}${rec.latency ? ` ${(rec.latency.a_to_b_ms / 1000).toFixed(1)}s, ${rec.latency.relay_blocks} relay blocks` : ''}${rec.error ? ` (${rec.error})` : ''}`);
    if (run < RUNS) await sleep(GAP * 1000);
  }
  await A.disconnect(); await B.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(`ERROR: ${e.message ?? e}`); process.exit(1); });
