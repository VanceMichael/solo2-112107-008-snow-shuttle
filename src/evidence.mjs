// 实乘证据账本：车载核销流水的唯一身份是 operator+device+run+seq；
// 设备换班后 seq 可复用，因此 seq 永远不能单独当主键。
// 票号必须联合运营方与 issue 才能定位，两边重号不可合并。
export function ticketRef(operator, issue, ticket) {
  return `${operator}/${issue}/${ticket}`;
}

export function scanId(scan) {
  return `${scan.operator}/${scan.device}/run-${scan.run}/seq-${scan.seq}`;
}

export class EvidenceLedger {
  #scans = new Map(); // scanId -> 当前生效流水（含来源标记）
  #history = []; // 整卷更正/离线重发留下的覆盖痕迹
  #byRef = new Map(); // 票号联合身份 -> 流水列表（先到流水也不会丢）
  #legByRef = new Map(); // ref -> Set<'first'|'second'>，来自团单登记
  #volumes = new Map(); // operator/issue/volume -> 卷状态

  // volumeName 对应 scans-index 里的 volumes 条目（如 a-ledger、b-late）。
  // 同名卷重新发布视为整卷更正：旧行被新行取代并留痕。
  ingestVolume(operator, issue, volumeName, rows, source) {
    const volumeKey = `${operator}/${issue}/${volumeName}`;
    const previous = this.#volumes.get(volumeKey);
    const removedIds = [];
    if (previous?.observed) {
      for (const id of previous.rowIds) {
        const existing = this.#scans.get(id);
        if (existing && existing._volume === volumeKey) {
          this.#history.push({ reason: 'volume-replaced', scan: existing, source });
          this.#detach(existing);
          this.#scans.delete(id);
          removedIds.push(id);
        }
      }
    }
    const rowIds = [];
    for (const row of rows) {
      const id = scanId(row);
      if (this.#scans.has(id) && this.#scans.get(id)._volume !== volumeKey) {
        // 联合身份在另一个卷里已存在：合成数据不应出现，显式报错而不是静默合并。
        throw new Error(`设备流水联合身份冲突: ${id}`);
      }
      const scan = { ...row, _volume: volumeKey, _source: source };
      this.#scans.set(id, scan);
      rowIds.push(id);
      this.#attach(scan);
    }
    this.#volumes.set(volumeKey, {
      operator, issue, volume: volumeName, observed: true, missing: false,
      rowIds, phase: source.phase, refreshedAt: source.at,
    });
    return { volumeKey, added: rowIds.length, replaced: removedIds };
  }

  // scans-index 声明了某卷但取不到（确认缺失）：标缺，不把缺卷当“没坐车”。
  markVolumeMissing(operator, issue, volumeName, source) {
    const volumeKey = `${operator}/${issue}/${volumeName}`;
    this.#volumes.set(volumeKey, {
      operator, issue, volume: volumeName, observed: false, missing: true,
      rowIds: [], phase: source.phase, refreshedAt: source.at,
    });
  }

  #attach(scan) {
    const ref = ticketRef(scan.operator, scan.issue, scan.ticket);
    if (!this.#byRef.has(ref)) this.#byRef.set(ref, []);
    this.#byRef.get(ref).push(scan);
  }

  #detach(scan) {
    const ref = ticketRef(scan.operator, scan.issue, scan.ticket);
    const list = this.#byRef.get(ref);
    if (!list) return;
    const next = list.filter((item) => scanId(item) !== scanId(scan));
    if (next.length) this.#byRef.set(ref, next);
    else this.#byRef.delete(ref);
  }

  // 团单票号登记到 first/second 两个语义；重号票因 issue 不同，ref 天然分开。
  registerTicket(leg, ref) {
    if (!this.#legByRef.has(ref)) this.#legByRef.set(ref, new Set());
    this.#legByRef.get(ref).add(leg);
  }

  scansForTicket(leg, ref) {
    const legs = this.#legByRef.get(ref);
    if (!legs || !legs.has(leg)) return [];
    return [...(this.#byRef.get(ref) ?? [])].sort((a, b) => a.time.localeCompare(b.time));
  }

  hasMissingVolumeFor(operator, issue) {
    for (const volume of this.#volumes.values()) {
      if (volume.operator === operator && volume.issue === issue && volume.missing) return true;
    }
    return false;
  }

  // 卷按运营方发布、供该运营方全部 issue 共用；缺卷判定只按运营方。
  missingVolumesForOperator(operator) {
    return [...this.#volumes.values()].filter((v) => v.operator === operator && v.missing).map((v) => v.volume);
  }

  // 该运营方是否根本没有任何已交付的卷（区别于“交付了但内容为空”）。
  operatorHasNoVolume(operator) {
    const entries = [...this.#volumes.values()].filter((v) => v.operator === operator);
    return entries.length === 0 || entries.every((v) => v.missing);
  }

  // 该运营方是否已有“带实乘行”的卷交付：离线流水可能晚到，在此之前不下未乘结论。
  operatorHasObservedRows(operator) {
    return [...this.#volumes.values()]
      .some((v) => v.operator === operator && v.observed && v.rowIds.length > 0);
  }

  // 无法关联到任何团单票号的流水：登记出来，绝不靠人名或团号猜归属。
  unlinkedScans(knownRefs) {
    const known = new Set(knownRefs);
    const out = [];
    for (const [ref, scans] of this.#byRef) {
      if (!known.has(ref)) out.push(...scans.map((scan) => ({ ...scan, ticketRef: ref })));
    }
    return out;
  }

  get volumes() {
    return [...this.#volumes.values()];
  }

  get history() {
    return this.#history;
  }

  allScans() {
    return [...this.#scans.values()];
  }
}
