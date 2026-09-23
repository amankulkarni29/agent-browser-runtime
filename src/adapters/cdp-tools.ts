import { z } from 'zod';
import type { BrowserSession } from '../core/browser-session.js';

const cdpSchema = z.object({
  method: z.string().min(3).max(100).describe('CDP method, such as Performance.getMetrics or Profiler.start.'),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();
const cdpWaitSchema = z.object({
  event: z.string().min(3).max(100).describe('CDP event name, such as Tracing.tracingComplete.'),
  timeoutMs: z.number().int().min(1).max(30_000).optional(),
}).strict();

/** Advanced tools, registered only when the session enables raw CDP (BROWSER_RAW_CDP=1). */
export function cdpTools(session: BrowserSession) {
  if (!session.isRawCdpEnabled) return [];
  return [
    {
      name: 'browser_cdp',
      description: 'Advanced: send one Chrome DevTools Protocol command on the current page, for data the other tools do not expose (performance metrics, coverage, accessibility audits). The result is redacted and bounded, and the call is recorded in evidence. Commands that close or crash the browser are blocked.',
      schema: cdpSchema,
      run: (args: unknown) => { const { method, params } = cdpSchema.parse(args); return session.cdp(method, params); },
    },
    {
      name: 'browser_cdp_wait',
      description: 'Advanced: wait for the next CDP event of one name (default 10 seconds, maximum 30). Enable its domain with browser_cdp first.',
      schema: cdpWaitSchema,
      run: (args: unknown) => { const { event, timeoutMs } = cdpWaitSchema.parse(args); return session.cdpWait(event, timeoutMs); },
    },
  ];
}

export const CDP_TOOL_NAMES = ['browser_cdp', 'browser_cdp_wait'];
