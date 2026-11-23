import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSource } from '../source.mjs';
import { SourceClient, PortalConflict } from '../src/source-client.mjs';
import { NightDeskEngine, DeskError } from '../src/engine.mjs';
import { EventStore } from '../src/store.mjs';
import { toMinutes } from '../src/time.mjs';

async function startSource() {
  const server = makeSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

function makeEngine(base, clockMin, store = null) {
  return new NightDeskEngine({
    client: new SourceClient({ base, retryAttempts: 2, backoffMs: 1 }),
    clock: () => clockMin.value,
    store,
  });
}

test('三阶段对账：改道、离线流水、交接范围与不确定标记逐阶段成立', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const clock = { value: toMinutes('07:20') };
  const engine = makeEngine(base, clock);

  // ---- opening：A 卷在 X-A，B 卷为空 ----
  await engine.ingestPhase('opening');
  let t1 = engine.reconcilePassenger('T1');
  assert.equal(t1.firstLeg.arrival, 'arrived');
  assert.equal(t1.firstLeg.scannedStation, 'X-A');
  assert.equal(t1.secondLeg.ride, 'unknown');
  assert.equal(t1.secondLeg.evidenceComplete, true, '空卷也是交付完成的证据，不是缺卷');
  assert.equal(t1.secondLeg.missedConnection, false, '证据未定时不能宣布错过转乘');
  let t3 = engine.reconcilePassenger('T3');
  assert.equal(t3.handover, null, 'T3 属 I2/TG2，不在 I1 的交接范围内');

  // ---- interim：封闭+改道公告，A 卷更正到 X-ALT ----
  clock.value = toMinutes('07:45');
  await engine.ingestPhase('interim');
  t1 = engine.reconcilePassenger('T1');
  assert.equal(t1.firstLeg.scannedStation, 'X-ALT');
  assert.equal(t1.firstLeg.divertedTo, 'X-ALT');
  assert.equal(t1.firstLeg.stationState, 'open');
  assert.equal(t1.firstLeg.arrival, 'arrived');
  assert.equal(t1.firstLeg.scans[0].time, '07:41', '离线流水按实际核销时间解释');
  // 更正痕迹可追溯。
  assert.equal(engine.evidence.history.some((h) => h.scan.station === 'X-A'), true);
  // T3 第一段始终无核销：只能提示去哪个换乘点，权益挂起。
  t3 = engine.reconcilePassenger('T3');
  assert.equal(t3.firstLeg.arrival, 'unknown');
  assert.equal(t3.firstLeg.expectedStation, 'X-ALT');
  assert.ok(t3.firstLeg.note.includes('不能判定转乘权益'));
  assert.equal(t3.replacement.eligible, false);

  // ---- confirmed：b-late 到达，ALT-R1 已占独座 ----
  clock.value = toMinutes('08:02');
  await engine.ingestPhase('confirmed');
  t1 = engine.reconcilePassenger('T1');
  const t2 = engine.reconcilePassenger('T2');
  t3 = engine.reconcilePassenger('T3');

  // 重号 B-8：I1 的 T1 已乘，I2 的 T3 也已乘，两条流水互不串号。
  assert.equal(t1.secondLeg.ride, 'rode');
  assert.equal(t1.secondLeg.scans[0].id, 'B/M2/run-2/seq-1');
  assert.equal(t3.secondLeg.ride, 'rode');
  assert.equal(t3.secondLeg.scans[0].id, 'B/M2/run-1/seq-1');
  // T2 的 B-9 全卷无核销且卷齐：确认错过 H-3（08:00、grace=0）。
  assert.equal(t2.secondLeg.ride, 'missed');
  assert.equal(t2.secondLeg.missedConnection, true);
  assert.equal(t2.replacement.eligible, true);
  // T1 虽有交接，但二段已乘，不具备补位资格。
  assert.equal(t1.replacement.eligible, false);
  // 外部确认 ALT-R1 被台账接纳并占住 ALT9 的唯一座位。
  const ext = t1.replacement.deskRecords.find((r) => r.receipt === 'ALT-R1');
  assert.equal(ext.state, 'confirmed');
  assert.equal(engine.desk.availableSeats('ALT9').length, 0);
  assert.equal(engine.unlinkedScans.length, 0);
});

test('补位全流程：占座保护、冲突撤下、释放审计与不重复收费', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const clock = { value: toMinutes('08:02') };
  const dir = mkdtempSync(join(tmpdir(), 'snow-desk-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const engine = makeEngine(base, clock, new EventStore(dir));
  await engine.ingestPhase('confirmed');

  // 独座在 T1 名下，T2 先订必被拒，共享座位不会被二次承诺。
  await assert.rejects(
    () => engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: toMinutes('08:05') }),
    (error) => error instanceof DeskError && error.code === 'NO_SEAT',
  );

  // T1 原二段查到已乘：08:10 在 08:25 撤座时限内，门户先回 pending，座位冻结。
  const release = await engine.resolveRideConflict({ traveller: 'T1', atMin: toMinutes('08:10') });
  assert.equal(release.mode, 'portal-release-pending');
  assert.equal(release.record.state, 'release-pending');
  assert.ok(release.record.history.some((h) => h.type === 'release-pending' && h.basis.includes('B-8')));
  // 冻结期间座位既不继续承诺给 T1，也不能被 T2 订走。
  assert.equal(engine.desk.availableSeats('ALT9').length, 0);

  // 后续用同一 release 请求 key 查门户：confirmed 阶段回执已变 released，座位才放回。
  const follow = await engine.followRelease({
    traveller: 'T1', portalKey: release.portalKey, atMin: toMinutes('08:11'),
  });
  assert.equal(follow.settled, true);
  assert.equal(follow.record.state, 'released');
  assert.equal(engine.desk.availableSeats('ALT9').length, 1);

  // 座位释放后 T2 可订（门户 book 回执固定为 ALT-R2，幂等性靠请求 key 保证）。
  const booked = await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: toMinutes('08:12') });
  assert.equal(booked.receipt, 'ALT-R2');
  assert.equal(booked.record.seatKey, 'ALT9#1');
  const replay = await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: toMinutes('08:12') });
  assert.equal(replay.duplicate, true);

  // 台账事件已持久化：新引擎重放后座位仍由 T2 占住，T1 的释放时间和依据可查。
  const rebuilt = makeEngine(base, clock, new EventStore(dir));
  await rebuilt.ingestPhase('confirmed');
  assert.equal(rebuilt.desk.availableSeats('ALT9').length, 0);
  const t2View = rebuilt.reconcilePassenger('T2');
  assert.equal(t2View.replacement.deskRecords.at(-1).state, 'confirmed');
  const trail = rebuilt.auditTrail('T1');
  const pendingEvent = trail.find((e) => e.type === 'release-pending');
  const releasedEvent = trail.find((e) => e.type === 'released');
  assert.equal(pendingEvent.at, toMinutes('08:10'), '发起撤下的时刻与依据可查');
  assert.ok(pendingEvent.basis.includes('B-8'));
  assert.equal(releasedEvent.at, toMinutes('08:11'), 'inspect 确认释放的时刻可查');
  assert.ok(releasedEvent.basis.includes('inspect'));
  assert.ok(releasedEvent.receipt);
});

test('过了发车时刻的冲突只能人工处理，且释放后座位可再分配', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const clock = { value: toMinutes('08:02') };
  const engine = makeEngine(base, clock);
  await engine.ingestPhase('confirmed');

  // 先在撤座时限内释放 T1（pending→inspect 确认），再给 T2 订座。
  const r1 = await engine.resolveRideConflict({ traveller: 'T1', atMin: toMinutes('08:10') });
  await engine.followRelease({ traveller: 'T1', portalKey: r1.portalKey, atMin: toMinutes('08:11') });
  await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: toMinutes('08:12') });

  // 模拟后续补到的离线卷：T2 的 B-9 其实已乘 H-3（迟到流水按实际核销时间解释）。
  engine.evidence.ingestVolume('B', 'B-OP', 'b-recovery', [
    { operator: 'B', device: 'M3', run: '3', seq: 1, time: '07:59', station: 'X-B', trip: 'H-3', issue: 'I1', ticket: 'B-9' },
  ], { phase: 'confirmed', at: toMinutes('08:35'), page: 'b-recovery' });
  assert.equal(engine.reconcilePassenger('T2').secondLeg.ride, 'rode');

  // 跨过 08:30 发车后处理冲突：只能人工，座位挂起不得再承诺。
  const manual = await engine.resolveRideConflict({ traveller: 'T2', atMin: toMinutes('08:40') });
  assert.equal(manual.mode, 'manual');
  assert.equal(manual.record.state, 'manual-review');
  assert.equal(engine.desk.availableSeats('ALT9').length, 0);
  assert.ok(manual.record.history.some((h) => h.type === 'manual-hold'));
});

test('门户 409（请求号换报文）向上抛出，绝不静默当成同一笔', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const client = new SourceClient({ base, retryAttempts: 0 });
  const first = await client.post('confirmed', { action: 'book', key: 'k-conflict', facts: { scope: 'a' } });
  assert.equal(first.status, 201);
  await assert.rejects(
    () => client.post('confirmed', { action: 'book', key: 'k-conflict', facts: { scope: 'b' } }),
    (error) => error instanceof PortalConflict,
  );
  // 相同报文重放回原回执。
  const replay = await client.post('confirmed', { action: 'book', key: 'k-conflict', facts: { scope: 'a' } });
  assert.equal(replay.status, 200);
});

test('门户 503 后保留占位并可通过 inspect 找回执，不换 key 重发', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const calls = [];
  // 第一次 book POST 强制 503 的桩：来源本身不产生 503，这里模拟一次回执迟到。
  let attempt = 0;
  const flakyFetch = async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'book' && attempt === 0) {
        attempt += 1;
        return new Response(JSON.stringify({ message: '门户未能及时回传回执' }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
    }
    return fetch(url, options);
  };
  const engine = new NightDeskEngine({
    client: new SourceClient({ base, fetch: flakyFetch, retryAttempts: 0 }),
    clock: () => toMinutes('08:02'),
  });
  await engine.ingestPhase('confirmed');
  const r1 = await engine.resolveRideConflict({ traveller: 'T1', atMin: toMinutes('08:06') });
  await engine.followRelease({ traveller: 'T1', portalKey: r1.portalKey, atMin: toMinutes('08:07') });
  const pending = await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: toMinutes('08:12') });
  assert.equal(pending.pending, true);
  assert.equal(pending.record.state, 'booking');
  // 只用同一个 key 查回执（合成门户未收到该笔时回 404，客服按待查继续跟进，绝不重发新单）。
  const inspected = await engine.inspectPortal(pending.key);
  assert.equal(inspected.status, 404);
  assert.equal(calls.filter((c) => c.action === 'book').length, 1, '503 后没有换 key 重发');
  assert.equal(calls.at(-1).action, 'inspect');
  assert.equal(calls.at(-1).key, pending.key);
});

test('交班视图用同一乘客代号答复等候点与留座真相', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const engine = makeEngine(base, { value: toMinutes('08:02') });
  await engine.ingestPhase('confirmed');
  const board = engine.handoverBoard();
  const byCode = Object.fromEntries(board.map((row) => [row.traveller, row]));
  assert.equal(byCode.T1.waitAt, 'X-ALT');
  assert.equal(byCode.T1.seatPromised.receipt, 'ALT-R1');
  assert.equal(byCode.T2.waitAt, 'X-ALT');
  assert.equal(byCode.T2.seatPromised, null);
  assert.equal(byCode.T3.waitAt, 'X-ALT');
  assert.equal(byCode.T3.secondLegStatus, 'rode');
});
