import { z } from 'zod';

const ABORT_CODES = ['failed', 'aborted', 'accessdenied', 'addressunreachable', 'blockedbyclient', 'blockedbyresponse',
  'connectionaborted', 'connectionclosed', 'connectionfailed', 'connectionrefused', 'connectionreset',
  'internetdisconnected', 'namenotresolved', 'timedout'] as const;

export const faultSchema = z.object({
  urlPattern: z.string().min(1).max(500)
    .describe('Substring of the request URL, or a glob with * (for example */products/search*).'),
  method: z.string().min(1).max(10).optional().describe('Only match this HTTP method, such as POST.'),
  action: z.enum(['fail', 'status', 'delay', 'rewrite'])
    .describe('fail: connection error. status: answer with a status and body. delay: add latency. rewrite: merge JSON into the real response.'),
  status: z.number().int().min(100).max(599).optional().describe('For status (default 500) or rewrite (default: keep the real status).'),
  body: z.string().max(64_000).optional().describe('Response body for status, or the replacement body for rewrite.'),
  contentType: z.string().max(100).optional(),
  errorCode: z.enum(ABORT_CODES).optional().describe('Network error for fail (default failed).'),
  delayMs: z.number().int().min(0).max(30_000).optional().describe('Latency for delay (default 3000).'),
  json: z.record(z.string(), z.unknown()).optional().describe('For rewrite: top-level fields merged into a JSON object response. Use body instead to replace the whole response body.'),
  times: z.number().int().min(1).max(1_000).optional().describe('Apply at most this many times, then stop matching.'),
}).strict();

export type FaultRule = z.infer<typeof faultSchema>;
export type ActiveFault = FaultRule & { id: string; applied: number };

function matcher(pattern: string): (url: string) => boolean {
  if (!pattern.includes('*')) return (url) => url.includes(pattern);
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const expression = new RegExp(`^${source}$`);
  return (url) => expression.test(url);
}

/** Session-owned fault rules. The first matching rule wins; exhausted rules stop matching. */
export class FaultBook {
  private rules: { fault: ActiveFault; matches: (url: string) => boolean }[] = [];
  private counter = 0;

  add(rule: FaultRule): ActiveFault {
    if (this.rules.length >= 20) throw new Error('At most 20 fault rules can be active.');
    const fault = { ...rule, id: `fault-${++this.counter}`, applied: 0 };
    this.rules.push({ fault, matches: matcher(rule.urlPattern) });
    return fault;
  }

  match(url: string, method: string): ActiveFault | undefined {
    const entry = this.rules.find(({ fault, matches }) =>
      (!fault.method || fault.method.toUpperCase() === method.toUpperCase()) &&
      (fault.times === undefined || fault.applied < fault.times) && matches(url));
    if (!entry) return undefined;
    entry.fault.applied++;
    return entry.fault;
  }

  list(): ActiveFault[] { return this.rules.map(({ fault }) => ({ ...fault })); }

  clear(): number {
    const count = this.rules.length;
    this.rules = [];
    return count;
  }

  reset(): void { this.clear(); this.counter = 0; }
}

/**
 * Pair captured requests or responses with the fault rule that produced them: same URL and method,
 * nearest in time. Request records are stamped before interception and responses after it, so the
 * window covers the longest allowed delay. Each applied fault marks at most one item.
 */
export function matchInjectedFaults<T extends { url: string; method: string; timestamp: number }>(
  applied: { timestamp: number; params: Record<string, unknown> }[], items: T[], windowMs = 35_000): Map<T, string> {
  const result = new Map<T, string>();
  const unused = [...applied];
  for (const item of [...items].sort((left, right) => left.timestamp - right.timestamp)) {
    let best = -1;
    for (const [index, event] of unused.entries()) {
      if (event.params.url !== item.url || event.params.method !== item.method) continue;
      const distance = Math.abs(event.timestamp - item.timestamp);
      if (distance <= windowMs && (best === -1 || distance < Math.abs(unused[best]!.timestamp - item.timestamp))) best = index;
    }
    if (best === -1) continue;
    result.set(item, String(unused[best]!.params.faultId));
    unused.splice(best, 1);
  }
  return result;
}

/** Merge top-level fields into a JSON body; a non-JSON body is returned unchanged with a reason. */
export function rewriteJson(body: string, fields: Record<string, unknown>): { body: string; rewritten: boolean } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { body, rewritten: false };
    return { body: JSON.stringify({ ...parsed, ...fields }), rewritten: true };
  } catch {
    return { body, rewritten: false };
  }
}
