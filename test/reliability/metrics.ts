import { mkdir, writeFile } from 'node:fs/promises';

export function latency(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: !sorted.length ? null : sorted.length % 2 ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95Ms: sorted.length < 20 ? null : sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

export class RequestMetrics {
  readonly samples: { status: number; latencyMs: number }[] = [];

  async record<T extends { statusCode: number }>(request: () => PromiseLike<T>): Promise<T> {
    const start = performance.now();
    const response = await request();
    this.samples.push({ status: response.statusCode, latencyMs: performance.now() - start });
    return response;
  }

  summary() {
    const statusHistogram: Record<number, number> = {};
    for (const { status } of this.samples) statusHistogram[status] = (statusHistogram[status] ?? 0) + 1;
    const success = this.samples.filter(({ status }) => status >= 200 && status < 300).length;
    return { count: this.samples.length, success, failure: this.samples.length - success, statusHistogram,
      ...latency(this.samples.map(({ latencyMs }) => latencyMs)), requests: this.samples };
  }
}

export async function writeEvidence(file: 'reliability.json' | 'eval-chain.json', summary: unknown) {
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/${file}`, JSON.stringify(summary, null, 2) + '\n');
}
