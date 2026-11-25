import { createHash } from 'node:crypto';
export class RateLimitError extends Error {
  constructor(public readonly retryAfter: number) { super('Too many requests'); }
}
export function loginKey(ip: string, slug: string, email: string): string {
  return `${ip}|${createHash('sha256').update(`${slug}|${email}`).digest('hex')}`;
}
interface Bucket { count: number; end: number }

export class LoginLimiter {
  private readonly accounts = new Map<string, Bucket>();
  private readonly ips = new Map<string, Bucket>();
  constructor(private readonly now: () => number = Date.now, private readonly maxEntries = 10000,
    private readonly perKey = 10, private readonly perIp = 30, private readonly windowMs = 60000) {
    if (maxEntries < 2 || perKey < 1 || perIp < 1 || windowMs < 1) throw new Error('Invalid limiter configuration');
  }
  get size(): number { return this.ips.size + this.accounts.size; }

  consume(ip: string, slug: string, email: string): void {
    const now = this.now();
    this.consumeBucket(this.ips, ip, this.perIp, now);
    this.consumeBucket(this.accounts, loginKey(ip, slug, email), this.perKey, now);
  }

  private consumeBucket(buckets: Map<string, Bucket>, key: string, limit: number, now: number): void {
    let bucket = buckets.get(key);
    if (!bucket || bucket.end <= now) {
      buckets.delete(key);
      // Reserve room for an account bucket even when all other slots hold IP buckets.
      if (buckets === this.ips && this.ips.size >= this.maxEntries - 1) {
        this.ips.delete(this.ips.keys().next().value!);
      } else if (this.size >= this.maxEntries) {
        this.accounts.delete(this.accounts.keys().next().value!);
      }
      bucket = { count: 0, end: now + this.windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) throw new RateLimitError(Math.ceil((bucket.end - now) / 1000));
    bucket.count++;
  }
}
