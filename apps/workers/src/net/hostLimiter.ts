const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface HostState {
  active: number;
  nextStart: number;
  waiters: Array<() => void>;
}

/**
 * Politeness limits per host: at most `maxConcurrent` requests in flight and
 * at least `minIntervalMs` between request starts. One host serves ~79% of
 * mainnet agent profiles, so this matters (see vault: registry-data-profile).
 */
export class HostLimiter {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
  ) {}

  /** Delays the next request start to this host (e.g. after HTTP 429). */
  pause(host: string, ms: number): void {
    const s = this.state(host);
    s.nextStart = Math.max(s.nextStart, Date.now() + ms);
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
    }
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { active: 0, nextStart: 0, waiters: [] };
      this.hosts.set(host, s);
    }
    return s;
  }

  private async acquire(host: string): Promise<void> {
    const s = this.state(host);
    for (;;) {
      if (s.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => s.waiters.push(resolve));
        continue;
      }
      const wait = s.nextStart - Date.now();
      if (wait > 0) {
        await sleep(wait);
        continue;
      }
      s.active++;
      s.nextStart = Date.now() + this.minIntervalMs;
      return;
    }
  }

  private release(host: string): void {
    const s = this.state(host);
    s.active--;
    s.waiters.shift()?.();
    if (s.active === 0 && s.waiters.length === 0 && s.nextStart <= Date.now()) this.hosts.delete(host);
  }
}
