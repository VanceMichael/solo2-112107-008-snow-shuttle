// 合成来源门户的 HTTP 客户端：只负责取数与幂等提交，业务解释放在引擎里。
export class SourceUnavailable extends Error {
  constructor(message, { status, url, retries } = {}) {
    super(message);
    this.name = 'SourceUnavailable';
    this.status = status;
    this.url = url;
    this.retries = retries;
  }
}

export class SourceMissing extends Error {
  constructor(message, { url } = {}) {
    super(message);
    this.name = 'SourceMissing';
    this.url = url;
  }
}

export class PortalConflict extends Error {
  constructor(message, { key, body } = {}) {
    super(message);
    this.name = 'PortalConflict';
    this.key = key;
    this.body = body;
  }
}

export class PortalRejected extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PortalRejected';
    this.status = status;
    this.body = body;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SourceClient {
  #base;
  #fetch;
  #retryAttempts;
  #backoffMs;

  constructor({ base = 'http://127.0.0.1:4173', fetch: fetchImpl = fetch, retryAttempts = 3, backoffMs = 25 } = {}) {
    this.#base = base.replace(/\/$/, '');
    this.#fetch = fetchImpl;
    this.#retryAttempts = retryAttempts;
    this.#backoffMs = backoffMs;
  }

  async #open(path) {
    const url = `${this.#base}${path}`;
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.#retryAttempts; attempt += 1) {
      const response = await this.#fetch(url, { method: 'GET' });
      if (response.status === 503) {
        lastStatus = 503;
        if (attempt < this.#retryAttempts) {
          await delay(this.#backoffMs * (attempt + 1));
          continue;
        }
        throw new SourceUnavailable('来源暂不可用（503 重试耗尽）', {
          status: 503, url, retries: this.#retryAttempts,
        });
      }
      if (response.status === 404) {
        throw new SourceMissing('该页尚未发布', { url });
      }
      if (response.status !== 200) {
        throw new SourceUnavailable(`来源返回异常状态 ${response.status}`, { status: response.status, url });
      }
      return { body: await response.json(), release: response.headers.get('x-release') ?? null };
    }
    throw new SourceUnavailable('来源暂不可用', { status: lastStatus, url });
  }

  async get(phase, resource) {
    const { body, release } = await this.#open(`/v1/${encodeURIComponent(phase)}/${encodeURIComponent(resource)}`);
    return { body, release };
  }

  // 按索引声明逐页取数；某页 404 时由调用方决定如何解释（未发布 vs 缺卷标记）。
  async getMaybe(phase, resource) {
    try {
      return await this.get(phase, resource);
    } catch (error) {
      if (error instanceof SourceMissing) return { missing: true };
      throw error;
    }
  }

  // inspect 的 404 是业务上正常的“门户暂查无此回执”，返回 found=false 而非抛错。
  async inspect(phase, key) {
    const url = `${this.#base}/v1/${encodeURIComponent(phase)}/portal`;
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.#retryAttempts; attempt += 1) {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'inspect', key, facts: {} }),
      });
      lastStatus = response.status;
      const body = await response.json().catch(() => ({}));
      if (response.status === 503) {
        if (attempt < this.#retryAttempts) {
          await delay(this.#backoffMs * (attempt + 1));
          continue;
        }
        return { status: 503, found: false, body, retries: this.#retryAttempts };
      }
      if (response.status === 404) return { status: 404, found: false, body };
      if (response.status === 200) return { status: 200, found: true, body };
      throw new PortalRejected(`门户拒绝查询（${response.status}）`, { status: response.status, body });
    }
    return { status: lastStatus, found: false, body: {} };
  }

  // 门户提交的幂等语义由合成来源保证：相同 key+报文回原回执；同 key 不同报文 409。
  // 调用方必须为每次业务操作生成稳定 key，这样 503 后重发不会产生第二笔收费。
  async post(phase, payload) {
    const url = `${this.#base}/v1/${encodeURIComponent(phase)}/portal`;
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.#retryAttempts; attempt += 1) {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastStatus = response.status;
      const body = await response.json().catch(() => ({}));
      if (response.status === 503) {
        if (attempt < this.#retryAttempts) {
          await delay(this.#backoffMs * (attempt + 1));
          continue;
        }
        // 重试耗尽不丢业务：异常交回引擎，由 inspect 找回执。
        return { status: 503, body, retries: this.#retryAttempts };
      }
      if (response.status === 409) {
        throw new PortalConflict('请求号已对应其他报文', { key: payload.key, body });
      }
      if (response.status === 200 || response.status === 201) {
        return { status: response.status, body };
      }
      throw new PortalRejected(`门户拒绝请求（${response.status}）`, { status: response.status, body });
    }
    return { status: lastStatus, body: {}, retries: this.#retryAttempts };
  }
}
