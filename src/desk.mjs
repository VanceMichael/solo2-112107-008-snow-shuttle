import { toMinutes, fromMinutes } from './time.mjs';

// 替代线路席位台账。规则要点：
// - 公告本身不等于留座，只有门户回执确认后才算占住座位；
// - 共享座位不得同时承诺给不同家庭（按 seatId 记账）；
// - expires 之前可经门户撤下；过了发车时刻只能人工处理；
// - 旧确认释放后必须留痕“何时、凭什么放回去”。
export class DeskError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeskError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class ReplacementDesk {
  #trips = new Map(); // tripId -> {trip, seatByKey: Map(seatKey, seat)}
  #records = new Map(); // deskKey -> 补位记录（每个乘客-意向唯一）
  #events = [];

  loadTrips(rows) {
    for (const row of rows) {
      const seatByKey = new Map();
      for (let i = 0; i < row.seats; i += 1) {
        const seatKey = `${row.trip}#${i + 1}`;
        seatByKey.set(seatKey, {
          seatKey, trip: row.trip, station: row.station,
          occupant: null, recordKey: null,
        });
      }
      this.#trips.set(row.trip, { ...row, departMin: toMinutes(row.depart), expiresMin: toMinutes(row.expires), seatByKey });
    }
  }

  trip(tripId) {
    return this.#trips.get(tripId) ?? null;
  }

  availableSeats(tripId) {
    const trip = this.#trips.get(tripId);
    if (!trip) return [];
    return [...trip.seatByKey.values()].filter((seat) => seat.occupant === null);
  }

  record(key) {
    return this.#records.get(key) ?? null;
  }

  recordsForTraveller(traveller) {
    return [...this.#records.values()].filter((r) => r.traveller === traveller);
  }

  // 发起意向（尚未向门户承诺）。意向未接受前可改选，改选留痕。
  openIntent({ key, traveller, family, trip, reason, at }) {
    if (this.#records.has(key)) return this.#records.get(key);
    const existing = this.recordsForTraveller(traveller).find((r) =>
      ['intent', 'booking', 'confirmed'].includes(r.state));
    if (existing) {
      throw new DeskError('INTENT_EXISTS', '该乘客已有进行中的补位意向', { existingKey: existing.key });
    }
    if (!this.#trips.has(trip)) throw new DeskError('UNKNOWN_TRIP', '替代线路不存在', { trip });
    const record = {
      key, traveller, family, trip, reason, state: 'intent',
      chosenAt: at, changedFrom: null, receipt: null, sourceRef: null,
      seatKey: null, portalPhase: null, history: [],
    };
    this.#records.set(key, record);
    this.#events.push({ at, type: 'intent-opened', key, traveller, trip, reason });
    return record;
  }

  // 意向未接受前改选：释放旧意向（不产生门户动作），开新意向。
  changeIntent({ key, oldKey, traveller, family, trip, reason, at }) {
    const old = this.#records.get(oldKey);
    if (!old || old.traveller !== traveller) {
      throw new DeskError('NO_SUCH_RECORD', '找不到可改选的旧意向', { oldKey });
    }
    if (old.state !== 'intent') {
      throw new DeskError('INTENT_LOCKED', '已确认的补位不能直接改选，需先走释放', { oldKey, state: old.state });
    }
    old.state = 'superseded';
    old.history.push({ at, type: 'superseded-by', newKey: key });
    this.#events.push({ at, type: 'intent-changed', key: oldKey, newKey: key, traveller });
    return this.openIntent({ key, traveller, family, trip, reason, at });
  }

  // 本地先占座，再由引擎调用门户；门户失败时回滚本地占位。
  holdSeat(recordKey, at) {
    const record = this.#records.get(recordKey);
    if (!record) throw new DeskError('NO_SUCH_RECORD', '补位记录不存在', { recordKey });
    if (record.state === 'confirmed' || record.state === 'booking') return record;
    if (record.state !== 'intent') {
      throw new DeskError('RECORD_NOT_OPEN', '该记录已不可占座', { recordKey, state: record.state });
    }
    const trip = this.#trips.get(record.trip);
    const seat = this.availableSeats(record.trip)[0];
    if (!seat) throw new DeskError('NO_SEAT', '替代线路已无共享座位', { trip: record.trip });
    seat.occupant = record.traveller;
    seat.recordKey = recordKey;
    record.seatKey = seat.seatKey;
    record.state = 'booking';
    record.history.push({ at, type: 'seat-held', seatKey: seat.seatKey });
    this.#events.push({ at, type: 'seat-held', key: recordKey, seatKey: seat.seatKey, traveller: record.traveller });
    return record;
  }

  rollbackHold(recordKey, at, cause) {
    const record = this.#records.get(recordKey);
    if (!record || record.state !== 'booking') return record ?? null;
    const seat = this.#seatOf(record);
    if (seat) {
      seat.occupant = null;
      seat.recordKey = null;
    }
    record.seatKey = null;
    record.state = 'intent';
    record.history.push({ at, type: 'hold-rolled-back', cause });
    this.#events.push({ at, type: 'hold-rolled-back', key: recordKey, cause, traveller: record.traveller });
    return record;
  }

  // 门户回执到达后落确认。
  markConfirmed(recordKey, receipt, sourceRef, portalPhase, at) {
    const record = this.#records.get(recordKey);
    if (!record) throw new DeskError('NO_SUCH_RECORD', '补位记录不存在', { recordKey });
    record.state = 'confirmed';
    record.receipt = receipt;
    record.sourceRef = sourceRef;
    record.portalPhase = portalPhase;
    record.history.push({ at, type: 'portal-confirmed', receipt, sourceRef, portalPhase });
    this.#events.push({ at, type: 'confirmed', key: recordKey, receipt, traveller: record.traveller });
    return record;
  }

  // 记录外部已存在的确认（如 confirmed 阶段门户里的 ALT-R1），直接占用共享座位。
  adoptExternalConfirmation({ key, traveller, family, trip, receipt, seatKey, sourceRef, portalPhase, at }) {
    const tripRow = this.#trips.get(trip);
    if (!tripRow) throw new DeskError('UNKNOWN_TRIP', '替代线路不存在', { trip });
    let seat = tripRow.seatByKey.get(seatKey);
    if (!seat) {
      const free = this.availableSeats(trip)[0];
      if (!free) throw new DeskError('NO_SEAT', '外部确认无座可对应', { trip });
      seat = free;
    }
    if (seat.occupant && seat.occupant !== traveller) {
      throw new DeskError('SEAT_CONFLICT', '共享座位已承诺给另一家庭', { seatKey: seat.seatKey, occupant: seat.occupant });
    }
    seat.occupant = traveller;
    seat.recordKey = key;
    const record = {
      key, traveller, family, trip, reason: 'external-confirmation', state: 'confirmed',
      chosenAt: at, changedFrom: null, receipt, sourceRef: sourceRef ?? null,
      seatKey: seat.seatKey, portalPhase, history: [{ at, type: 'adopted-external', receipt }],
    };
    this.#records.set(key, record);
    this.#events.push({ at, type: 'external-confirmed', key, receipt, traveller, seatKey: seat.seatKey });
    return record;
  }

  // 撤下判断：替代车未过 expires（门户可撤）-> portal-release；
  // 已过发车时刻 -> manual，禁止再向门户承诺。
  releaseDecision(recordKey, atMin) {
    const record = this.#records.get(recordKey);
    if (!record) throw new DeskError('NO_SUCH_RECORD', '补位记录不存在', { recordKey });
    if (record.state !== 'confirmed' && record.state !== 'release-pending') {
      throw new DeskError('NOT_CONFIRMED', '只有已确认补位才能撤下', { recordKey, state: record.state });
    }
    const trip = this.#trips.get(record.trip);
    if (atMin <= trip.expiresMin) {
      return { mode: 'portal-release', trip, at: fromMinutes(atMin) };
    }
    if (atMin >= trip.departMin) {
      return { mode: 'manual', reason: '替代车已发车，门户无法撤下', trip, at: fromMinutes(atMin) };
    }
    // expires 与 depart 之间：门户撤座窗口已过但车未发，按保守口径走人工。
    return { mode: 'manual', reason: '撤座时限已过，等待人工处理', trip, at: fromMinutes(atMin) };
  }

  // 门户 release 回执可能是 pending：座位先挂“释放待确认”，inspect 到 released 再真正放回。
  markReleasePending(recordKey, { receipt, sourceRef, at, basis, portalResult }) {
    const record = this.#records.get(recordKey);
    if (!record) throw new DeskError('NO_SUCH_RECORD', '补位记录不存在', { recordKey });
    const seat = this.#seatOf(record);
    if (seat) {
      // 挂起期间冻结座位：既不继续承诺给原乘客，也不能被别的家庭订走。
      seat.occupant = `release-pending:${record.traveller}`;
      seat.recordKey = recordKey;
    }
    record.state = 'release-pending';
    record.history.push({ at, type: 'release-pending', receipt, sourceRef, basis, portalResult });
    this.#events.push({ at, type: 'release-pending', key: recordKey, traveller: record.traveller,
      previousSeat: record.seatKey, receipt, basis });
    return record;
  }

  // inspect 确认门户侧已释放：把冻结座位真正放回可售池。
  confirmRelease(recordKey, { receipt, sourceRef, at, basis }) {
    const record = this.#records.get(recordKey);
    if (!record) throw new DeskError('NO_SUCH_RECORD', '补位记录不存在', { recordKey });
    const seat = this.#seatOf(record);
    const previousSeat = record.seatKey;
    if (seat) {
      seat.occupant = null;
      seat.recordKey = null;
    }
    record.state = 'released';
    record.seatKey = null;
    record.history.push({ at, type: 'released', receipt, sourceRef, basis: basis ?? 'inspect 确认门户已释放' });
    this.#events.push({ at, type: 'released', key: recordKey, traveller: record.traveller,
      previousSeat, receipt, basis: basis ?? 'inspect 确认门户已释放' });
    return record;
  }

  markReleased(recordKey, { mode, receipt, sourceRef, at, basis, portalResult }) {
    const record = this.#records.get(recordKey);
    if (!record) throw new DeskError('NO_SUCH_RECORD', '补位记录不存在', { recordKey });
    const seat = this.#seatOf(record);
    const previousSeat = record.seatKey;
    if (seat) {
      if (mode === 'manual') {
        // 人工挂起：座位从可售池冻结，等人工裁决，不能被别的家庭订走。
        seat.occupant = `manual-review:${record.traveller}`;
        seat.recordKey = recordKey;
      } else {
        seat.occupant = null;
        seat.recordKey = null;
      }
    }
    record.state = mode === 'manual' ? 'manual-review' : 'released';
    if (mode !== 'manual') record.seatKey = null;
    record.history.push({
      at, type: mode === 'manual' ? 'manual-hold' : 'released',
      receipt: receipt ?? null, sourceRef: sourceRef ?? null, basis, portalResult: portalResult ?? null,
    });
    this.#events.push({
      at, type: record.state, key: recordKey, traveller: record.traveller,
      previousSeat, receipt: receipt ?? null, basis,
    });
    return record;
  }

  // 后来查到原二段其实已乘：按替代线路能否撤下区分释放/人工。
  resolveRideConflict(recordKey, { atMin, basis }) {
    const decision = this.releaseDecision(recordKey, atMin);
    return { ...decision, basis };
  }

  #seatOf(record) {
    if (!record.seatKey) return null;
    const trip = this.#trips.get(record.trip);
    return trip?.seatByKey.get(record.seatKey) ?? null;
  }

  occupancy(tripId) {
    const trip = this.#trips.get(tripId);
    if (!trip) return [];
    return [...trip.seatByKey.values()].map(({ seatKey, occupant, recordKey }) => ({ seatKey, occupant, recordKey }));
  }

  allRecords() {
    return [...this.#records.values()];
  }

  get events() {
    return this.#events;
  }
}
