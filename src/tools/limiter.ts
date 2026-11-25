export type LimitResult = { allowed: true } | { allowed: false; retryAfter: number; firstDenial: boolean };

interface Entry { count: number; end: number; denied: boolean }

/**
 * Fixed-window, in-memory budget for tool-endpoint requests: per authenticated actor and per client address.
 * The actor budget is checked first; a request already denied by its actor budget does NOT consume the shared
 * address budget, so one actor cannot exhaust the budget of other actors behind the same address.
 */
export class ToolLimiter {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly perActor = 30,
    private readonly perIp = 120,
    private readonly windowMs = 60000,
    private readonly maxEntries = 10000,
  ) {
    if (perActor < 1 || perIp < 1 || windowMs < 1 || maxEntries < 2) throw new Error('Invalid limiter configuration');
  }

  get size(): number { return this.entries.size; }

  private bump(key: string, limit: number, now: number): LimitResult {
    let entry = this.entries.get(key);
    if (!entry || entry.end <= now) {
      this.entries.delete(key);
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      entry = { count: 0, end: now + this.windowMs, denied: false };
      this.entries.set(key, entry);
    }
    entry.count++;
    if (entry.count <= limit) return { allowed: true };
    const firstDenial = !entry.denied;
    entry.denied = true;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.end - now) / 1000)), firstDenial };
  }

  consume(actorKey: string, ip: string): LimitResult {
    const now = this.now();
    const actor = this.bump(`actor:${actorKey}`, this.perActor, now);
    if (!actor.allowed) return actor;
    return this.bump(`ip:${ip}`, this.perIp, now);
  }
}
