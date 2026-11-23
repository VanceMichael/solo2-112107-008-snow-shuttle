import { SourceClient } from './source-client.mjs';
import { StationDirectory } from './stations.mjs';
import { EvidenceLedger, ticketRef } from './evidence.mjs';
import { ReplacementDesk, DeskError } from './desk.mjs';
import { toMinutes, withinGrace } from './time.mjs';

const LEG_OPERATOR = { first: 'A', second: 'B' };
const STATION_INDEX_PAGES = ['roads-one', 'roads-late'];

export class NightDeskEngine {
  #client;
  #clock;
  #store;
  #replayed = false;
  stations = new StationDirectory();
  evidence = new EvidenceLedger();
  desk = new ReplacementDesk();

  bookings = [];
  handovers = [];
  confirmations = [];
  connections = [];
  replacementTrips = [];
  phasesSeen = [];
  lastIngest = null;
  #portalKeys = new Set();

  constructor({ client, clock = () => Date.now(), store = null } = {}) {
    this.#client = client instanceof SourceClient ? client : new SourceClient(client ?? {});
    this.#clock = clock;
    this.#store = store;
  }

  #ensureReplayed() {
    if (this.#replayed || !this.#store) return;
    this.#replayed = true;
    this.#replay(this.#store.readAll());
  }

  #now() {
    return this.#clock();
  }

  #replay(events) {
    for (const event of events) {
      this.#portalKeys.add(event.key);
      this.#applyDeskEvent(event);
    }
  }

  #applyDeskEvent(event) {
    switch (event.type) {
      case 'external-confirmed':
        this.desk.adoptExternalConfirmation({
          key: event.key, traveller: event.traveller, family: event.family,
          trip: event.trip, receipt: event.receipt, seatKey: event.seatKey,
          sourceRef: event.sourceRef ?? null, portalPhase: event.phase, at: event.at,
        });
        break;
      case 'confirmed': {
        // 正常流程的 confirmed 事件：先补意向/占位再落确认，保证重放后座位占用一致。
        if (!this.desk.record(event.key)) {
          this.desk.openIntent({
            key: event.key, traveller: event.traveller, family: null,
            trip: event.trip, at: event.at, reason: event.basis ?? 'replay',
          });
          this.desk.holdSeat(event.key, event.at);
        }
        this.desk.markConfirmed(event.key, event.receipt, event.sourceRef, null, event.at);
        break;
      }
      case 'released':
      case 'manual-review':
      case 'release-pending': {
        const record = this.desk.record(event.key);
        if (!record) break;
        if (event.type === 'release-pending') {
          this.desk.markReleasePending(event.key, {
            receipt: event.receipt, sourceRef: event.sourceRef, at: event.at,
            basis: event.basis, portalResult: event.portalResult,
          });
          break;
        }
        this.desk.markReleased(event.key, {
          mode: event.type === 'released' ? 'portal-release' : 'manual',
          receipt: event.receipt, at: event.at, basis: event.basis,
          sourceRef: event.sourceRef, portalResult: event.portalResult,
        });
        break;
      }
      default:
        break; // 占位/待查类中间事件由确认或释放事件重建最终态
    }
  }

  #persist(event) {
    if (this.#store) this.#store.append(event);
  }

  // ---------- 来源摄入 ----------

  async ingestPhase(phase) {
    const at = this.#now();
    const report = { phase, at, pages: [], missing: [], failures: [] };

    const bookingPage = await this.#client.get(phase, 'bookings');
    this.bookings = bookingPage.body;
    this.#registerBookings();
    report.pages.push('bookings');

    const indexPage = await this.#client.get(phase, 'station-index');
    const bulletins = indexPage.body.bulletins ?? [];
    for (const page of new Set([...STATION_INDEX_PAGES, ...bulletins])) {
      const got = await this.#client.getMaybe(phase, page);
      if (got.missing) {
        report.missing.push(page);
        continue;
      }
      this.stations.ingest(got.body, { phase, page });
      report.pages.push(page);
    }

    const scansIndex = await this.#client.get(phase, 'scans-index');
    for (const entry of scansIndex.body) {
      for (const volume of entry.volumes ?? []) {
        const got = await this.#client.getMaybe(phase, volume);
        if (got.missing) {
          this.evidence.markVolumeMissing(entry.operator, entry.issue, volume, { phase, at });
          report.missing.push(volume);
          continue;
        }
        const result = this.evidence.ingestVolume(entry.operator, entry.issue, volume, got.body, { phase, at, page: volume });
        report.pages.push(`${volume}(+${result.added})`);
      }
    }
    // 索引未声明的历史卷本阶段不再交付时维持原判定，不擅自补数；声明了却取不到才标缺。
    this.handovers = (await this.#client.get(phase, 'handover')).body;
    this.connections = (await this.#client.get(phase, 'connections')).body;
    this.replacementTrips = (await this.#client.get(phase, 'replacement')).body;
    this.desk.loadTrips(this.replacementTrips);
    this.#ensureReplayed();
    this.confirmations = (await this.#client.get(phase, 'confirmations')).body;
    this.#adoptConfirmations(phase, at);

    const unlinked = this.evidence.unlinkedScans(this.#allTicketRefs());
    this.lastIngest = { ...report, unlinkedCount: unlinked.length };
    if (!this.phasesSeen.includes(phase)) this.phasesSeen.push(phase);
    return this.lastIngest;
  }

  #registerBookings() {
    for (const b of this.bookings) {
      this.evidence.registerTicket('first', ticketRef(LEG_OPERATOR.first, b.issue, b.first));
      this.evidence.registerTicket('second', ticketRef(LEG_OPERATOR.second, b.issue, b.second));
    }
  }

  #allTicketRefs() {
    return this.bookings.flatMap((b) => [
      ticketRef(LEG_OPERATOR.first, b.issue, b.first),
      ticketRef(LEG_OPERATOR.second, b.issue, b.second),
    ]);
  }

  #adoptConfirmations(phase, at) {
    for (const c of this.confirmations) {
      const key = `external:${c.receipt}`;
      if (this.desk.record(key)) continue;
      const booking = this.bookings.find((b) => b.booking === c.booking
        || this.handovers.some((h) => h.new_booking === c.booking && h.travellers.includes(b.traveller)));
      const record = this.desk.adoptExternalConfirmation({
        key,
        traveller: c.traveller,
        family: booking?.group ?? 'unknown-family',
        trip: c.trip,
        receipt: c.receipt,
        seatKey: null,
        sourceRef: null,
        portalPhase: phase,
        at,
      });
      this.#portalKeys.add(key);
      this.#persist({
        type: 'external-confirmed', key, at, phase, traveller: c.traveller,
        family: record.family, trip: c.trip, receipt: c.receipt, seatKey: record.seatKey,
      });
    }
  }

  // ---------- 乘客级判定 ----------

  // 交接范围：以 handover 签发的子单乘客与运营方确认的上下站对应为准，禁止按团号扩张。
  handoverFor(traveller, issue) {
    return this.handovers.find((h) => h.issue === issue && h.travellers.includes(traveller)) ?? null;
  }

  #connectionFor(booking, scans) {
    const byTrip = this.connections.find((c) => scans.some((s) => s.trip === c.second_trip));
    if (byTrip) return byTrip;
    // 没有二段流水时，connections 是按运营方站点给出的接泊计划；合成场景下只有一条山线连接。
    const candidates = this.connections.filter((c) =>
      this.stations.describe('B', c.station).operator === 'B');
    return candidates.length === 1 ? candidates[0] : (candidates[0] ?? null);
  }

  #legView(booking, leg) {
    const operator = LEG_OPERATOR[leg];
    const ticket = booking[leg];
    const ref = ticketRef(operator, booking.issue, ticket);
    const scans = this.evidence.scansForTicket(leg, ref);
    // 该运营方在 scans-index 中声明过的所有卷都已交付（哪怕是空卷）才算证据完整；
    // 只有声明了却取不到的卷才进入 missingVolumes。
    const declared = this.evidence.volumes
      .filter((v) => v.operator === operator)
      .map((v) => v.volume);
    const missingVolumes = this.evidence.missingVolumesForOperator(operator)
      .filter((name) => declared.includes(name));
    const latest = scans.at(-1) ?? null;
    return {
      leg, operator, ticket, ref, scans, latest,
      evidenceComplete: missingVolumes.length === 0,
      missingVolumes,
    };
  }

  reconcilePassenger(travellerCode) {
    const booking = this.bookings.find((b) => b.traveller === travellerCode);
    if (!booking) return null;
    const first = this.#legView(booking, 'first');
    const second = this.#legView(booking, 'second');
    const handover = this.handoverFor(booking.traveller, booking.issue);

    const firstLeg = this.#explainFirstLeg(booking, first, handover);
    const secondLeg = this.#explainSecondLeg(booking, second);
    const replacement = this.#replacementView(booking, firstLeg, secondLeg, handover);

    return {
      traveller: booking.traveller,
      family: booking.group,
      booking: booking.booking,
      issue: booking.issue,
      handover: handover ? {
        newBooking: handover.new_booking,
        fromStation: handover.from_station,
        toStation: handover.to_station,
      } : null,
      firstLeg,
      secondLeg,
      replacement,
    };
  }

  #explainFirstLeg(booking, leg, handover) {
    const latest = leg.latest;
    let arrival = 'unknown';
    let station = null;
    let stateAtScan = null;
    let divertedTo = null;

    if (latest) {
      station = latest.station;
      const at = toMinutes(latest.time);
      const route = this.#routeOf(latest);
      stateAtScan = this.stations.stateAt(latest.operator, latest.station, at, route);
      const planned = handover?.from_station ?? null;
      // 实际核销点与交接的原上车站不同，且该时刻原站封闭、新站开放，即改道接走。
      if (planned && latest.station !== planned) {
        const plannedState = this.stations.stateAt(latest.operator, planned, at, route);
        const actualState = stateAtScan;
        if (plannedState.state === 'closed' && actualState.state === 'open') divertedTo = latest.station;
      }
      // 到站事实只认实际核销地点；封闭站上的旧流水被更正卷取代后自然不会再成为 latest。
      arrival = stateAtScan.state === 'closed' ? 'scan-at-closed-station' : 'arrived';
    } else if (handover) {
      // 还在路上：先按交接范围显示该去哪个换乘点，权益待第一段实乘补齐再判。
      divertedTo = handover.to_station;
    } else {
      const alt = this.stations.alternateOpenStations('A', 'F', this.#clockMinutes());
      if (alt.length === 1) divertedTo = alt[0].id;
    }

    return {
      ticket: leg.ticket,
      ref: leg.ref,
      arrival,
      evidenceComplete: leg.evidenceComplete,
      missingVolumes: leg.missingVolumes,
      scans: leg.scans.map((s) => this.#scanView(s)),
      scannedStation: station,
      stationState: stateAtScan?.state ?? null,
      expectedStation: handover?.to_station ?? divertedTo ?? station,
      divertedTo,
      note: arrival === 'unknown'
        ? '第一段实乘尚未补齐，只能提示前往的换乘点，不能判定转乘权益'
        : null,
    };
  }

  #explainSecondLeg(booking, leg) {
    const latest = leg.latest;
    const connection = this.#connectionFor(booking, leg.scans);
    let ride = 'unknown';
    let missedConnection = false;

    if (latest && connection) {
      const at = toMinutes(latest.time);
      const onTrip = latest.trip === connection.second_trip;
      const inGrace = withinGrace(at, connection.departure, connection.grace_minutes);
      if (onTrip && inGrace) {
        ride = 'rode';
      } else {
        ride = 'late-scan';
        missedConnection = true;
      }
    } else if (!latest) {
      // 没有核销：只有运营方已交付“带实乘行”的卷（说明设备在正常记账），
      // 且无缺卷时，才能下“未乘/错过”结论；空卷或一卷未交都保持 unknown 等离线流水。
      const canConcludeAbsence = leg.evidenceComplete
        && this.evidence.operatorHasObservedRows('B');
      ride = canConcludeAbsence ? 'missed' : 'unknown';
      missedConnection = canConcludeAbsence && Boolean(connection);
    }

    return {
      ticket: leg.ticket,
      ref: leg.ref,
      ride,
      missedConnection,
      evidenceComplete: leg.evidenceComplete,
      missingVolumes: leg.missingVolumes,
      scans: leg.scans.map((s) => this.#scanView(s)),
      connection: connection ? {
        trip: connection.second_trip,
        station: connection.station,
        departure: connection.departure,
        graceMinutes: connection.grace_minutes,
        allowReplace: connection.allow_replace,
      } : null,
    };
  }

  #replacementView(booking, firstLeg, secondLeg, handover) {
    const eligible = secondLeg.missedConnection
      && secondLeg.connection?.allowReplace === true
      && Boolean(handover)
      && firstLeg.arrival === 'arrived';
    const reasons = [];
    if (!handover) reasons.push('不在签发的交接范围内');
    if (handover && firstLeg.arrival !== 'arrived') reasons.push('第一段实乘事实未确认');
    if (!secondLeg.missedConnection) reasons.push(`二段状态为 ${secondLeg.ride}，不构成实际错过转乘`);
    if (secondLeg.connection?.allowReplace !== true) reasons.push('该连接不允许替代补位');

    const records = this.desk.recordsForTraveller(booking.traveller);
    return {
      eligible,
      blockedReasons: reasons,
      handoverStation: handover?.to_station ?? null,
      deskRecords: records.map((r) => this.#recordView(r)),
    };
  }

  #scanView(scan) {
    return {
      id: `${scan.operator}/${scan.device}/run-${scan.run}/seq-${scan.seq}`,
      time: scan.time,
      station: scan.station,
      trip: scan.trip,
      issue: scan.issue,
      ticket: scan.ticket,
      volume: scan._volume,
      source: scan._source,
      // 迟到的离线流水按实际核销时间解释，而不是按到达系统的时间。
      interpretation: '按实际核销时间认定',
    };
  }

  #routeOf(scan) {
    const bulletin = this.stations.snapshot()
      .find((b) => b.operator === scan.operator && b.id === scan.station);
    return bulletin?.route ?? null;
  }

  #clockMinutes() {
    const value = this.#now();
    return typeof value === 'number' && value < 1440 ? value : 12 * 60;
  }

  #recordView(record) {
    const trip = this.desk.trip(record.trip);
    return {
      key: record.key,
      state: record.state,
      trip: record.trip,
      station: trip?.station ?? null,
      depart: trip?.depart ?? null,
      seatKey: record.seatKey,
      receipt: record.receipt,
      sourceRef: record.sourceRef,
      reason: record.reason,
      history: record.history,
    };
  }

  reconcileAll() {
    return this.bookings.map((b) => this.reconcilePassenger(b.traveller));
  }

  // ---------- 补位操作（门户交互，全部幂等） ----------

  async requestReplacement({ traveller, trip, atMin, phase = 'confirmed' }) {
    const view = this.reconcilePassenger(traveller);
    if (!view) throw new DeskError('UNKNOWN_TRAVELLER', '乘客代号不存在', { traveller });
    if (!view.replacement.eligible) {
      throw new DeskError('NOT_ELIGIBLE', '不满足补位条件', { blockedReasons: view.replacement.blockedReasons });
    }
    // 稳定 key 是“不重复收费”的闸门：同乘客、同替代车、同一决策时刻重放只产生一笔门户请求。
    const key = `desk:book:${traveller}:${trip}:${atMin}`;
    if (this.#portalKeys.has(key)) {
      return { duplicate: true, key, record: this.#recordView(this.desk.record(key)) };
    }
    // 同一乘客已有进行中的确认/占位：视为同一补位诉求的重复提交，返回既有记录。
    const inProgress = this.desk.recordsForTraveller(traveller).find((r) =>
      ['intent', 'booking', 'confirmed'].includes(r.state) && r.trip === trip);
    if (inProgress) {
      return { duplicate: true, key: inProgress.key, record: this.#recordView(inProgress) };
    }
    this.desk.openIntent({ key, traveller, family: view.family, trip, at: atMin, reason: 'missed-connection' });
    let record;
    try {
      record = this.desk.holdSeat(key, atMin);
    } catch (error) {
      // 无座可占时把意向也一并作废，避免污染后续补位请求。
      const stale = this.desk.record(key);
      if (stale) stale.state = 'abandoned';
      throw error;
    }
    const payload = {
      action: 'book', key,
      facts: {
        traveller, issue: view.issue, handover: view.handover?.newBooking ?? null,
        trip, station: view.replacement.handoverStation, basis: 'missed-connection',
      },
    };
    let outcome;
    try {
      outcome = await this.#client.post(phase, payload);
    } catch (error) {
      this.desk.rollbackHold(record.key, atMin, `portal-error:${error.name}`);
      throw error;
    }
    if (outcome.status === 503) {
      // 门户可能已受理：本地保留占位，交给 inspect 找回执，绝不换 key 重发。
      record.history.push({ at: atMin, type: 'portal-503-pending', key });
      this.#persist({ type: 'booking-pending', key, at: atMin, traveller, trip });
      return { pending: true, key, record: this.#recordView(record), outcome };
    }
    if (outcome.status >= 400 || outcome.body.result !== 'confirmed') {
      this.desk.rollbackHold(record.key, atMin, `portal-status-${outcome.status}`);
      throw new DeskError('PORTAL_DENIED', '门户未确认补位', { outcome });
    }
    const receipt = outcome.body.receipt;
    this.desk.markConfirmed(key, receipt, outcome.body.sourceRef, phase, atMin);
    this.#portalKeys.add(key);
    this.#persist({
      type: 'confirmed', key, receipt,
      sourceRef: outcome.body.sourceRef, at: atMin, traveller, family: view.family,
      trip, seatKey: record.seatKey, basis: 'missed-connection',
    });
    return { duplicate: false, key, record: this.#recordView(record), receipt };
  }

  async releaseReplacement({ traveller, atMin, phase = 'confirmed', basis }) {
    const record = this.desk.recordsForTraveller(traveller)
      .find((r) => ['confirmed', 'release-pending', 'manual-review'].includes(r.state));
    if (!record) throw new DeskError('NOT_CONFIRMED', '该乘客没有可撤下的确认补位', { traveller });
    if (record.state === 'release-pending') {
      return { pending: true, record: this.#recordView(record), note: '释放仍待门户确认，座位已冻结' };
    }
    const decision = this.desk.releaseDecision(record.key, atMin);
    if (decision.mode === 'manual') {
      this.desk.markReleased(record.key, {
        mode: 'manual', at: atMin, basis, receipt: null,
      });
      this.#persist({ type: 'manual-review', key: record.key, at: atMin, traveller,
        trip: record.trip, previousSeat: record.seatKey, basis });
      return { mode: 'manual', record: this.#recordView(this.desk.record(record.key)), basis };
    }
    const portalKey = `desk:release:${record.receipt}:${atMin}`;
    const payload = { action: 'release', key: portalKey, facts: { receipt: record.receipt, basis } };
    const outcome = await this.#client.post(phase, payload);
    if (outcome.status === 503) {
      record.history.push({ at: atMin, type: 'release-503-pending', portalKey });
      return { pending: true, record: this.#recordView(record), outcome };
    }
    this.#portalKeys.add(portalKey);
    const portalResult = outcome.body.result ?? null;
    if (portalResult === 'released') {
      this.desk.markReleased(record.key, {
        mode: 'portal-release', receipt: outcome.body.receipt ?? record.receipt,
        sourceRef: outcome.body.sourceRef ?? null, at: atMin, basis, portalResult,
      });
      this.#persist({
        type: 'released', key: record.key, at: atMin, traveller, trip: record.trip,
        receipt: outcome.body.receipt ?? record.receipt, sourceRef: outcome.body.sourceRef ?? null,
        previousSeat: record.seatKey, basis, portalResult, portalKey,
      });
      return { mode: 'portal-release', record: this.#recordView(this.desk.record(record.key)), outcome };
    }
    // 门户回执 pending：先冻结座位，等后续 inspect 推进，不提前放回可售池。
    this.desk.markReleasePending(record.key, {
      receipt: outcome.body.receipt ?? record.receipt,
      sourceRef: outcome.body.sourceRef ?? null, at: atMin, basis, portalResult,
    });
    this.#persist({
      type: 'release-pending', key: record.key, at: atMin, traveller, trip: record.trip,
      receipt: outcome.body.receipt ?? record.receipt, sourceRef: outcome.body.sourceRef ?? null,
      previousSeat: record.seatKey, basis, portalResult, portalKey,
    });
    return {
      mode: 'portal-release-pending', portalKey,
      record: this.#recordView(this.desk.record(record.key)), outcome,
    };
  }

  // 用 inspect 回执推进释放：查到 released 才真正放回座位；查无回执保持挂起。
  async followRelease({ traveller, portalKey, atMin, phase = 'confirmed' }) {
    const record = this.desk.recordsForTraveller(traveller)
      .find((r) => r.state === 'release-pending');
    if (!record) throw new DeskError('NO_PENDING_RELEASE', '该乘客没有待确认的释放', { traveller });
    const inspected = await this.#client.inspect(phase, portalKey);
    if (!inspected.found) return { status: inspected.status, settled: false, record: this.#recordView(record) };
    if (inspected.body.result !== 'released') {
      return { status: inspected.status, settled: false, record: this.#recordView(record), portal: inspected.body };
    }
    this.desk.confirmRelease(record.key, {
      receipt: inspected.body.receipt ?? record.receipt,
      sourceRef: inspected.body.sourceRef ?? null, at: atMin,
      basis: 'inspect 确认门户已释放',
    });
    this.#persist({
      type: 'released', key: record.key, at: atMin, traveller, trip: record.trip,
      receipt: inspected.body.receipt ?? record.receipt,
      sourceRef: inspected.body.sourceRef ?? null,
      previousSeat: record.seatKey, basis: 'inspect 确认门户已释放',
      portalResult: 'released', portalKey,
    });
    return { status: inspected.status, settled: true, record: this.#recordView(this.desk.record(record.key)) };
  }

  // 后来查到原二段其实已乘：按替代线路能否撤下分流。
  async resolveRideConflict({ traveller, atMin, phase = 'confirmed' }) {
    const view = this.reconcilePassenger(traveller);
    const record = this.desk.recordsForTraveller(traveller)
      .find((r) => ['confirmed', 'release-pending'].includes(r.state));
    if (!record) throw new DeskError('NOT_CONFIRMED', '该乘客没有已确认补位', { traveller });
    if (view.secondLeg.ride !== 'rode') {
      throw new DeskError('NO_RIDE_CONFLICT', '原二段没有已乘证据，不能按冲突处理', { ride: view.secondLeg.ride });
    }
    const basis = `原二段票 ${view.secondLeg.ticket} 查到车载已乘（${view.secondLeg.scans.at(-1)?.id ?? ''}）`;
    return this.releaseReplacement({ traveller, atMin, phase, basis });
  }

  async inspectPortal(portalKey, phase = 'confirmed') {
    return this.#client.inspect(phase, portalKey);
  }

  // ---------- 交班视图 ----------

  handoverBoard() {
    return this.reconcileAll().map((view) => {
      const active = view.replacement.deskRecords.find((r) =>
        ['intent', 'booking', 'confirmed', 'release-pending'].includes(r.state));
      return {
        traveller: view.traveller,
        family: view.family,
        waitAt: view.firstLeg.expectedStation ?? view.firstLeg.scannedStation,
        firstLegStatus: view.firstLeg.arrival,
        secondLegStatus: view.secondLeg.ride,
        seatPromised: active?.state === 'confirmed'
          ? { trip: active.trip, seat: active.seatKey, receipt: active.receipt }
          : null,
        replacementState: active?.state ?? 'none',
        uncertainty: [
          ...(view.firstLeg.evidenceComplete ? [] : ['第一段流水缺卷']),
          ...(view.secondLeg.evidenceComplete ? [] : ['第二段流水缺卷']),
        ],
      };
    });
  }

  auditTrail(traveller) {
    return this.desk.events.filter((e) => e.traveller === traveller);
  }

  get unlinkedScans() {
    return this.evidence.unlinkedScans(this.#allTicketRefs());
  }
}

export { DeskError } from './desk.mjs';
export { PortalConflict, SourceUnavailable } from './source-client.mjs';
