import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StationDirectory } from '../src/stations.mjs';
import { EvidenceLedger, ticketRef, scanId } from '../src/evidence.mjs';
import { ReplacementDesk, DeskError } from '../src/desk.mjs';
import { toMinutes } from '../src/time.mjs';

const src = (phase, page) => ({ phase, page });

test('同名站点按运营方与生效时段区分，封闭公告覆盖一般开放声明', () => {
  const dir = new StationDirectory();
  dir.ingest([
    { operator: 'A', station: '松桥', id: 'X-A', route: 'F', from_time: '06:00', until: '08:10', state: 'open' },
    { operator: 'B', station: '松桥', id: 'X-B', route: 'H', from_time: '06:00', until: '09:00', state: 'open' },
  ], src('opening', 'roads-one'));
  dir.ingest([
    { operator: 'A', station: '松桥', id: 'X-A', route: 'F', from_time: '07:30', until: '08:10', state: 'closed' },
    { operator: 'A', station: '北路口', id: 'X-ALT', route: 'F', from_time: '07:30', until: '09:00', state: 'open' },
  ], src('interim', 'roads-late'));

  assert.equal(dir.stateAt('A', 'X-A', toMinutes('07:00'), 'F').state, 'open');
  assert.equal(dir.stateAt('A', 'X-A', toMinutes('07:41'), 'F').state, 'closed');
  // 同名站 B 侧不受 A 的封闭公告影响。
  assert.equal(dir.stateAt('B', 'X-B', toMinutes('07:41'), 'H').state, 'open');
  // 边界：until 为排他时刻，08:09 仍封闭，08:10 起两窗都已结束（unknown）。
  assert.equal(dir.stateAt('A', 'X-A', toMinutes('08:09'), 'F').state, 'closed');
  assert.equal(dir.stateAt('A', 'X-A', toMinutes('08:10'), 'F').state, 'unknown');

  const alts = dir.alternateOpenStations('A', 'F', toMinutes('07:45'));
  assert.deepEqual(alts.map((b) => b.id), ['X-ALT']);
});

test('票号联合运营方与 issue 定位，重号票互不合并', () => {
  const ledger = new EvidenceLedger();
  const bookings = [
    { group: 'TG1', booking: 'B1', traveller: 'T1', issue: 'I1', first: 'A-11', second: 'B-8' },
    { group: 'TG2', booking: 'B2', traveller: 'T3', issue: 'I2', first: 'A-11', second: 'B-8' },
  ];
  for (const b of bookings) {
    ledger.registerTicket('first', ticketRef('A', b.issue, b.first));
    ledger.registerTicket('second', ticketRef('B', b.issue, b.second));
  }
  ledger.ingestVolume('B', 'B-OP', 'b-late', [
    { operator: 'B', device: 'M2', run: '2', seq: 1, time: '07:58', station: 'X-B', trip: 'H-3', issue: 'I1', ticket: 'B-8' },
    { operator: 'B', device: 'M2', run: '1', seq: 1, time: '07:50', station: 'X-B', trip: 'H-3', issue: 'I2', ticket: 'B-8' },
  ], src('confirmed', 'b-late'));

  // 换班后 seq=1 在 run 1/run 2 各出现一次，联合身份不同，两条都保留。
  const t1 = ledger.scansForTicket('second', ticketRef('B', 'I1', 'B-8'));
  const t3 = ledger.scansForTicket('second', ticketRef('B', 'I2', 'B-8'));
  assert.equal(t1.length, 1);
  assert.equal(t3.length, 1);
  assert.notEqual(scanId(t1[0]), scanId(t3[0]));
  assert.deepEqual(ledger.unlinkedScans(bookings.flatMap((b) => [
    ticketRef('A', b.issue, b.first), ticketRef('B', b.issue, b.second),
  ])), []);
});

test('整卷更正取代旧行并留痕；缺卷显式标记而非当作未乘车', () => {
  const ledger = new EvidenceLedger();
  ledger.registerTicket('first', ticketRef('A', 'I1', 'A-11'));
  ledger.ingestVolume('A', 'A-OP', 'a-ledger', [
    { operator: 'A', device: 'Z1', run: '1', seq: 1, time: '07:40', station: 'X-A', trip: 'F-1', issue: 'I1', ticket: 'A-11' },
  ], src('opening', 'a-ledger'));
  assert.equal(ledger.scansForTicket('first', ticketRef('A', 'I1', 'A-11'))[0].station, 'X-A');

  ledger.ingestVolume('A', 'A-OP', 'a-ledger', [
    { operator: 'A', device: 'Z1', run: '1', seq: 1, time: '07:41', station: 'X-ALT', trip: 'F-1', issue: 'I1', ticket: 'A-11' },
  ], src('interim', 'a-ledger'));
  const current = ledger.scansForTicket('first', ticketRef('A', 'I1', 'A-11'));
  assert.equal(current.length, 1);
  assert.equal(current[0].station, 'X-ALT');
  assert.equal(current[0].time, '07:41');
  assert.equal(ledger.history[0].reason, 'volume-replaced');
  assert.equal(ledger.history[0].scan.station, 'X-A');

  ledger.markVolumeMissing('B', 'B-OP', 'b-ledger', src('interim', 'b-ledger'));
  assert.equal(ledger.hasMissingVolumeFor('B', 'B-OP'), true);
  assert.deepEqual(ledger.missingVolumesForOperator('B'), ['b-ledger']);
  ledger.ingestVolume('B', 'B-OP', 'b-late', [], src('confirmed', 'b-late'));
  assert.deepEqual(ledger.missingVolumesForOperator('B'), ['b-ledger']);
});

test('无法关联团单的流水只登记，不靠人名或团号猜归属', () => {
  const ledger = new EvidenceLedger();
  ledger.registerTicket('first', ticketRef('A', 'I1', 'A-11'));
  ledger.ingestVolume('A', 'A-OP', 'a-ledger', [
    { operator: 'A', device: 'Z1', run: '1', seq: 1, time: '07:40', station: 'X-A', trip: 'F-1', issue: 'I1', ticket: 'A-11' },
    { operator: 'A', device: 'Z1', run: '1', seq: 2, time: '07:41', station: 'X-A', trip: 'F-1', issue: 'I9', ticket: 'A-90' },
  ], src('interim', 'a-ledger'));
  const unlinked = ledger.unlinkedScans([ticketRef('A', 'I1', 'A-11')]);
  assert.equal(unlinked.length, 1);
  assert.equal(unlinked[0].ticketRef, 'A/I9/A-90');
  // 已知票号的查询不受影响。
  assert.equal(ledger.scansForTicket('first', ticketRef('A', 'I1', 'A-11')).length, 1);
});

test('替代席位只在门户确认后占住，共享座位不能承诺给两个家庭', () => {
  const desk = new ReplacementDesk();
  desk.loadTrips([{ trip: 'ALT9', station: 'X-ALT', seats: 1, depart: '08:30', expires: '08:25' }]);
  desk.adoptExternalConfirmation({
    key: 'external:ALT-R1', traveller: 'T1', family: 'TG1', trip: 'ALT9',
    receipt: 'ALT-R1', seatKey: null, portalPhase: 'confirmed', at: 482,
  });
  assert.throws(
    () => desk.openIntent({ key: 'k2', traveller: 'T2', family: 'TG2', trip: 'ALT9', reason: 'x', at: 485 })
      && desk.holdSeat('k2', 485),
    (error) => error instanceof DeskError && error.code === 'NO_SEAT',
  );

  // 未过 expires：门户可撤。
  const decision = desk.releaseDecision('external:ALT-R1', toMinutes('08:10'));
  assert.equal(decision.mode, 'portal-release');
  desk.markReleased('external:ALT-R1', {
    mode: 'portal-release', receipt: 'ALT-R1', at: 490,
    basis: '原二段已乘', portalResult: 'released',
  });
  assert.equal(desk.availableSeats('ALT9').length, 1);
  const released = desk.record('external:ALT-R1');
  assert.equal(released.state, 'released');
  assert.ok(released.history.some((h) => h.type === 'released' && h.basis === '原二段已乘'));

  // 发车后只能人工。
  desk.adoptExternalConfirmation({
    key: 'external:ALT-R2', traveller: 'T2', family: 'TG2', trip: 'ALT9',
    receipt: 'ALT-R2', seatKey: null, portalPhase: 'confirmed', at: 492,
  });
  const late = desk.releaseDecision('external:ALT-R2', toMinutes('08:40'));
  assert.equal(late.mode, 'manual');
});

test('意向未接受前可改选且不产生门户动作，确认后改选被拒绝', () => {
  const desk = new ReplacementDesk();
  desk.loadTrips([
    { trip: 'ALT9', station: 'X-ALT', seats: 2, depart: '08:30', expires: '08:25' },
  ]);
  desk.openIntent({ key: 'i1', traveller: 'T2', family: 'TG1', trip: 'ALT9', reason: 'x', at: 480 });
  desk.changeIntent({ key: 'i2', oldKey: 'i1', traveller: 'T2', family: 'TG1', trip: 'ALT9', reason: 'x', at: 481 });
  assert.equal(desk.record('i1').state, 'superseded');
  assert.equal(desk.record('i2').state, 'intent');
  desk.holdSeat('i2', 482);
  desk.markConfirmed('i2', 'R9', 'ref9', 'confirmed', 483);
  assert.throws(
    () => desk.changeIntent({ key: 'i3', oldKey: 'i2', traveller: 'T2', family: 'TG1', trip: 'ALT9', reason: 'x', at: 484 }),
    (error) => error.code === 'INTENT_LOCKED',
  );
});
