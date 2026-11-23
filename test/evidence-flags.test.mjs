import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSource } from '../source.mjs';
import { SourceClient } from '../src/source-client.mjs';
import { NightDeskEngine } from '../src/engine.mjs';
import { toMinutes } from '../src/time.mjs';

async function startSource() {
  const server = makeSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

test('缺卷场景：声明卷取不到时标记不确定，绝不下未乘结论', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const engine = new NightDeskEngine({
    client: new SourceClient({ base, retryAttempts: 1, backoffMs: 1 }),
    clock: () => toMinutes('07:45'),
  });
  await engine.ingestPhase('interim');

  // interim 的 scans-index 声明了 b-late 但该页未发布：B 侧证据不完整。
  const t2 = engine.reconcilePassenger('T2');
  assert.deepEqual(t2.secondLeg.missingVolumes, ['b-late']);
  assert.equal(t2.secondLeg.evidenceComplete, false);
  assert.equal(t2.secondLeg.ride, 'unknown');
  assert.equal(t2.secondLeg.missedConnection, false);
  assert.equal(t2.replacement.eligible, false, '证据不足时不能给补位承诺');

  const board = engine.handoverBoard();
  const row = board.find((b) => b.traveller === 'T2');
  assert.ok(row.uncertainty.includes('第二段流水缺卷'));
});

test('无法关联团单的流水被显式登记，不挂靠任何乘客代号', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const engine = new NightDeskEngine({
    client: new SourceClient({ base, retryAttempts: 1, backoffMs: 1 }),
    clock: () => toMinutes('08:02'),
  });
  await engine.ingestPhase('confirmed');

  // 注入一条票号不属于任何团单的流水（模拟签收无法关联）。
  engine.evidence.ingestVolume('A', 'A-OP', 'a-stray', [
    { operator: 'A', device: 'Z9', run: '9', seq: 1, time: '07:55', station: 'X-ALT', trip: 'F-1', issue: 'I9', ticket: 'A-99' },
  ], { phase: 'confirmed', at: toMinutes('08:20'), page: 'a-stray' });

  const stray = engine.unlinkedScans;
  assert.equal(stray.length, 1);
  assert.equal(stray[0].ticketRef, 'A/I9/A-99');
  assert.equal(stray[0].device, 'Z9');
  assert.equal(stray[0].run, '9');
  assert.equal(stray[0].seq, 1);
  // 三位乘客的对账视图不受影响。
  for (const code of ['T1', 'T2', 'T3']) {
    const view = engine.reconcilePassenger(code);
    assert.ok(view.firstLeg.scans.every((s) => s.ticket !== 'A-99'));
  }
});

test('乘客视图始终用同一代号回答：等候点、留座回执与证据来源齐全', async (t) => {
  const { server, base } = await startSource();
  t.after(() => server.close());
  const engine = new NightDeskEngine({
    client: new SourceClient({ base, retryAttempts: 1, backoffMs: 1 }),
    clock: () => toMinutes('08:02'),
  });
  await engine.ingestPhase('confirmed');

  const t1 = engine.reconcilePassenger('T1');
  assert.equal(t1.traveller, 'T1');
  assert.equal(t1.firstLeg.expectedStation, 'X-ALT');
  // 证据保留来源页与阶段；confirmed 重新交付的 a-ledger 承载 interim 起的更正内容。
  assert.equal(t1.firstLeg.scans[0].source.page, 'a-ledger');
  assert.equal(t1.firstLeg.scans[0].volume, 'A/A-OP/a-ledger');
  assert.equal(t1.secondLeg.scans[0].source.page, 'b-late');
  const external = t1.replacement.deskRecords.find((r) => r.receipt === 'ALT-R1');
  assert.equal(external.state, 'confirmed');
  assert.equal(external.seatKey, 'ALT9#1');

  // 重号票 B-8 在两个 issue 下各自独立。
  const t3 = engine.reconcilePassenger('T3');
  assert.notEqual(t1.secondLeg.ref, t3.secondLeg.ref);
  assert.equal(t1.secondLeg.ref, 'B/I1/B-8');
  assert.equal(t3.secondLeg.ref, 'B/I2/B-8');
});
