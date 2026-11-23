import { toMinutes, withinWindow } from './time.mjs';

// 站点按“运营方 + 站点编号 + 生效时段”区分；同名站可能一个通车一个封闭。
// 封闭通知按运营方、站点编号、起止时间覆盖同范围的一般开放声明。
export class StationDirectory {
  #bulletinIndex = new Map(); // key: operator|id|route -> 按发布顺序保留的公告
  #sources = [];

  // bulletin 来自 station-index 声明的各个 roads* 页。
  ingest(bulletins, source) {
    if (!Array.isArray(bulletins)) return;
    for (const bulletin of bulletins) {
      const key = this.#key(bulletin.operator, bulletin.id, bulletin.route);
      const list = this.#bulletinIndex.get(key) ?? [];
      list.push({ ...bulletin, _source: source });
      this.#bulletinIndex.set(key, list);
      this.#sources.push(source);
    }
  }

  #key(operator, id, route) {
    return [operator, id, route ?? ''].join('|');
  }

  // 返回某时刻该运营方站点在某线路上的有效状态（closed 覆盖 open）。
  stateAt(operator, id, atMinutes, route = null) {
    const candidates = [];
    for (const [key, list] of this.#bulletinIndex) {
      const [op, stationId] = key.split('|');
      if (op !== operator || stationId !== id) continue;
      candidates.push(...list);
    }
    const bulletins = candidates
      .filter((b) => (route === null || b.route === route))
      .filter((b) => withinWindow(atMinutes, b.from_time, b.until));
    if (bulletins.length === 0) return { state: 'unknown', bulletins: [] };
    // 同一生效范围内只要存在封闭通知，即覆盖一般开放声明。
    const state = bulletins.some((b) => b.state === 'closed') ? 'closed' : 'open';
    return { state, bulletins };
  }

  // 找某运营方某线路在某时刻“当前有效开放”的站点（被封闭公告覆盖的 open 不算）。
  alternateOpenStations(operator, route, atMinutes) {
    const found = new Map();
    for (const list of this.#bulletinIndex.values()) {
      for (const bulletin of list) {
        if (bulletin.operator !== operator || bulletin.route !== route) continue;
        if (!withinWindow(atMinutes, bulletin.from_time, bulletin.until)) continue;
        if (bulletin.state !== 'open') continue;
        if (this.stateAt(operator, bulletin.id, atMinutes, route).state !== 'open') continue;
        found.set(bulletin.id, bulletin);
      }
    }
    return [...found.values()];
  }

  describe(operator, id) {
    for (const list of this.#bulletinIndex.values()) {
      const hit = list.find((b) => b.operator === operator && b.id === id);
      if (hit) return { operator, id, station: hit.station };
    }
    return { operator, id, station: id };
  }

  explain(operator, id, atMinutes, route = null) {
    const { state, bulletins } = this.stateAt(operator, id, atMinutes, route);
    return {
      ...this.describe(operator, id),
      route,
      state,
      windows: bulletins.map((b) => ({
        state: b.state,
        from: b.from_time,
        until: b.until,
        source: b._source,
      })),
    };
  }

  snapshot() {
    return [...this.#bulletinIndex.values()].flat().map(({ _source, ...b }) => ({ ...b, source: _source }));
  }

  get sources() {
    return [...new Set(this.#sources)];
  }

  static windowCovers(bulletin, atMinutes) {
    return withinWindow(atMinutes, bulletin.from_time, bulletin.until);
  }

  static minuteOf(hhmm) {
    return toMinutes(hhmm);
  }
}
