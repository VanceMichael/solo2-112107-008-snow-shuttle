import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// 极简事件存储：客服台账的每次变化都落一条 JSONL，重启后重放即可还原。
// 引擎只在内存里重建派生状态；文件用“临时文件+rename”原子替换，避免半行日志。
export class EventStore {
  #dir;
  #file;

  constructor(dir) {
    this.#dir = dir;
    this.#file = join(dir, 'desk-events.jsonl');
    mkdirSync(dir, { recursive: true });
  }

  append(event) {
    const line = JSON.stringify({ ...event, persistedAt: new Date().toISOString() });
    writeFileSync(this.#file, line + '\n', { flag: 'a' });
  }

  readAll() {
    let text;
    try {
      text = readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  snapshot(name, value) {
    const target = join(this.#dir, name.endsWith('.json') ? name : `${name}.json`);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, target);
  }

  listFiles() {
    return readdirSync(this.#dir);
  }

  get file() {
    return this.#file;
  }
}
