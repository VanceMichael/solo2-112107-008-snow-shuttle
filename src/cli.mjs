#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from './source-client.mjs';
import { NightDeskEngine, DeskError } from './engine.mjs';
import { EventStore } from './store.mjs';
import { toMinutes } from './time.mjs';

const args = process.argv.slice(2);
const command = args.shift();

function parseFlags(list) {
  const flags = {};
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

const flags = parseFlags(args);
const asJson = Boolean(flags.json);
const base = process.env.SOURCE_URL ?? 'http://127.0.0.1:4173';
const dataDir = flags.dir ?? join(process.cwd(), '.desk-data');

function out(value) {
  process.stdout.write(asJson ? JSON.stringify(value, null, 2) + '\n' : value);
}

function line(text = '') {
  if (!asJson) process.stdout.write(text + '\n');
}

async function buildEngine({ ephemeral = false } = {}) {
  const store = ephemeral ? null : new EventStore(dataDir);
  const client = new SourceClient({ base });
  // CLI 演示需要按“业务时刻”判断撤座窗口，时钟可注入；默认按当日 08:05。
  const clock = flags.now ? () => toMinutes(flags.now) : () => 8 * 60 + 5;
  const engine = new NightDeskEngine({ client, clock, store });
  return { engine, store };
}

function printPassenger(view) {
  if (!view) {
    line('未找到该乘客代号');
    return;
  }
  line(`乘客 ${view.traveller}（家庭/团 ${view.family}，issue ${view.issue}）`);
  const h = view.handover
    ? `交接子单 ${view.handover.newBooking}：${view.handover.fromStation} → ${view.handover.toStation}`
    : '无交接范围（跨团重号票不合并）';
  line(`  交接范围：${h}`);
  const f = view.firstLeg;
  line(`  第一段 ${f.ticket}：${statusText(f.arrival)}`);
  line(`    实乘 ${f.scans.length} 条` + (f.scans.length ? `，核销点 ${f.scans.map((s) => `${s.station}@${s.time}(${s.id})`).join('，')}` : '（尚无）'));
  if (f.divertedTo) line(`    改道指向：${f.divertedTo}`);
  if (f.expectedStation) line(`    客服应告知等候点：${f.expectedStation}`);
  if (!f.evidenceComplete) line(`    ⚠ 缺卷：${f.missingVolumes.join('、')}，到站结论暂不确定`);
  if (f.note) line(`    说明：${f.note}`);
  const s = view.secondLeg;
  line(`  第二段 ${s.ticket}：${rideText(s.ride)}${s.missedConnection ? '（确认错过转乘）' : ''}`);
  line(`    实乘 ${s.scans.length} 条` + (s.scans.length ? `，核销点 ${s.scans.map((x) => `${x.station}@${x.time}(${x.trip})`).join('，')}` : '（无核销）'));
  if (!s.evidenceComplete) line(`    ⚠ 缺卷：${s.missingVolumes.join('、')}，不能据此判定已坐/未坐`);
  const r = view.replacement;
  line(`  补位资格：${r.eligible ? '具备' : '不具备'}`);
  if (!r.eligible) for (const reason of r.blockedReasons) line(`    - ${reason}`);
  for (const rec of r.deskRecords) {
    line(`    台账 ${rec.key}：${rec.state}${rec.receipt ? `（回执 ${rec.receipt}）` : ''}${rec.seatKey ? `，座位 ${rec.seatKey}` : ''}`);
  }
  line('');
}

function statusText(value) {
  return ({
    arrived: '已到换乘点（有车载核销证据）',
    unknown: '是否到换乘点不确定',
    'scan-at-closed-station': '核销点处于封闭状态，需人工核对',
  })[value] ?? value;
}

function rideText(value) {
  return ({
    rode: '原二段已乘',
    missed: '确认未乘（卷齐且无核销）',
    unknown: '不确定（流水未齐）',
    'late-scan': '宽限外核销，按错过转乘处理',
  })[value] ?? value;
}

async function main() {
  switch (command) {
    case 'ingest': {
      const { engine } = await buildEngine();
      const phase = flags.phase ?? 'confirmed';
      const report = await engine.ingestPhase(phase);
      out(report);
      break;
    }
    case 'passenger': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      const view = engine.reconcilePassenger(flags.code);
      if (asJson) out(view);
      else printPassenger(view);
      break;
    }
    case 'board': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      const board = engine.handoverBoard();
      if (asJson) {
        out(board);
        break;
      }
      line('交班视图（同一乘客代号贯穿答复）');
      for (const row of board) {
        line(`${row.traveller}｜等候点 ${row.waitAt ?? '未定'}｜一段 ${row.firstLegStatus}｜二段 ${row.secondLegStatus}｜补位 ${row.replacementState}${row.seatPromised ? `｜留座 ${row.seatPromised.trip}/${row.seatPromised.seat}/回执${row.seatPromised.receipt}` : ''}${row.uncertainty.length ? `｜不确定：${row.uncertainty.join('、')}` : ''}`);
      }
      break;
    }
    case 'book': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      const atMin = toMinutes(flags.at ?? '08:05');
      const result = await engine.requestReplacement({
        traveller: flags.code, trip: flags.trip, atMin, phase: flags.phase ?? 'confirmed',
      });
      out(result);
      break;
    }
    case 'release': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      const atMin = toMinutes(flags.at ?? '08:10');
      const result = await engine.releaseReplacement({
        traveller: flags.code, atMin, phase: flags.phase ?? 'confirmed',
        basis: flags.basis ?? '客服撤下补位',
      });
      out(result);
      break;
    }
    case 'follow': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      const result = await engine.followRelease({
        traveller: flags.code, portalKey: flags.key,
        atMin: toMinutes(flags.at ?? '08:11'), phase: flags.phase ?? 'confirmed',
      });
      out(result);
      break;
    }
    case 'conflict': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      const result = await engine.resolveRideConflict({
        traveller: flags.code, atMin: toMinutes(flags.at ?? '08:10'), phase: flags.phase ?? 'confirmed',
      });
      out(result);
      break;
    }
    case 'audit': {
      const { engine } = await buildEngine();
      await engine.ingestPhase(flags.phase ?? 'confirmed');
      out(engine.auditTrail(flags.code));
      break;
    }
    case 'inspect': {
      const { engine } = await buildEngine();
      out(await engine.inspectPortal(flags.key, flags.phase ?? 'confirmed'));
      break;
    }
    case 'demo':
      await runDemo();
      break;
    default:
      line(`用法: node src/cli.mjs <ingest|passenger|board|book|release|follow|conflict|audit|inspect|demo> [--json] [选项]
  ingest    --phase confirmed
  passenger --code T1 [--phase interim] [--json]
  board     [--phase opening]
  book      --code T2 --trip ALT9 --at 08:05
  release   --code T1 --at 08:10 --basis "原二段查到已乘"
  follow    --code T1 --key desk:release:ALT-R1:490 --at 08:11
  conflict  --code T1 --at 08:10
  audit     --code T1
  inspect   --key desk:release:ALT-R1:490
环境: SOURCE_URL 覆盖来源地址，--dir 覆盖台账目录（默认 ./.desk-data），--now 覆盖业务时钟`);
  }
}

// 端到端演示：用独立临时目录，跑完即弃，不污染正式台账。
async function runDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'snow-desk-'));
  const client = new SourceClient({ base });
  let clockAt = 7 * 60 + 45;
  const engine = new NightDeskEngine({ client, clock: () => clockAt, store: new EventStore(dir) });
  try {
    line('== 开场（opening）：只有常规公告，B 卷为空 ==');
    line(JSON.stringify(await engine.ingestPhase('opening'), null, 0));
    for (const code of ['T1', 'T2', 'T3']) printPassenger(engine.reconcilePassenger(code));

    line('== 中间观察（interim）：封闭公告+改道开放，A 卷更正到 X-ALT ==');
    clockAt = 7 * 60 + 45;
    line(JSON.stringify(await engine.ingestPhase('interim'), null, 0));
    for (const code of ['T1', 'T2', 'T3']) printPassenger(engine.reconcilePassenger(code));

    line('== 后续发布（confirmed）：b-late 离线流到达，门户已有 ALT-R1 占住 ALT9 独座 ==');
    clockAt = 8 * 60 + 2;
    line(JSON.stringify(await engine.ingestPhase('confirmed'), null, 0));
    for (const code of ['T1', 'T2', 'T3']) printPassenger(engine.reconcilePassenger(code));

    line('== T2 确认错过 H-3，先订补位：独座被 T1 的 ALT-R1 占着，应拒绝并保护共享座位 ==');
    try {
      await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: 8 * 60 + 5 });
    } catch (error) {
      if (error instanceof DeskError) line(`预期拒绝：${error.code} ${error.message}`);
      else throw error;
    }

    line('== 查到 T1 的 B-8 已在 07:58 乘 H-3：撤下其补位（08:10 未过 08:25 撤座时限，门户先回 pending 并冻结座位）==');
    const release = await engine.resolveRideConflict({ traveller: 'T1', atMin: 8 * 60 + 10 });
    line(JSON.stringify({ mode: release.mode, state: release.record.state, seatAvailable: engine.desk.availableSeats('ALT9').length }, null, 0));

    line('== 用同一 release 请求 key 查门户：回执转 released，座位才真正放回（何时、凭什么都留痕）==');
    const follow = await engine.followRelease({
      traveller: 'T1', portalKey: release.portalKey, atMin: 8 * 60 + 11,
    });
    line(JSON.stringify({ settled: follow.settled, state: follow.record.state, seatAvailable: engine.desk.availableSeats('ALT9').length }, null, 0));

    line('== 同一座位现在可给 T2，且幂等键保证不重复收费 ==');
    const booked = await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: 8 * 60 + 12 });
    line(JSON.stringify({ key: booked.key, receipt: booked.receipt, record: booked.record.state, seat: booked.record.seatKey }, null, 0));
    const again = await engine.requestReplacement({ traveller: 'T2', trip: 'ALT9', atMin: 8 * 60 + 12 });
    line(`重复请求返回 duplicate=${again.duplicate}，不会产生第二笔收费`);

    line('== 交班视图与释放审计 ==');
    line(JSON.stringify(engine.handoverBoard(), null, 0));
    line('T1 审计痕迹：' + JSON.stringify(engine.auditTrail('T1'), null, 0));
    line(`台账文件：${dir}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.name ?? 'Error'}: ${error.message}\n`);
  if (process.env.DEBUG) process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
