import { z } from 'zod';
import type { BrowserSession } from '../core/browser-session.js';

export const targetSchema = {
  selector: z.string().min(1).optional(), name: z.string().min(1).optional(), role: z.string().optional(),
  frameId: z.string().optional(), ref: z.string().optional(), index: z.number().int().nonnegative().optional(),
};

const requestsSchema = z.object({ url: z.string().optional(), status: z.number().int().optional(), since: z.number().optional() });
const requestSchema = z.object({ requestId: z.string() });
const responseBodySchema = z.object({ requestId: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16000).optional() });
const framesSchema = z.object({});
const changesSchema = z.object({});
const inspectSchema = z.object({ ...targetSchema, properties: z.array(z.string()).max(60).optional()
  .describe('CSS properties to inspect. Pass [] for compact DOM/control discovery without computed styles or stylesheet rules.') });
const viewportSchema = z.object({ width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(2560) });
const explainActionSchema = z.object({
  actionId: z.number().int().positive().optional().describe('The actionId from an action receipt. Defaults to the most recent action.'),
  filter: z.enum(['relevant', 'all']).optional().describe('relevant (default) omits successful static and third-party requests and non-error console messages.'),
  format: z.enum(['text', 'json']).optional().describe('text (default) returns the rendered chain; json also returns the structured tree.'),
});

/** Both transports share the same schemas and narrow core operations. */
export function inspectionTools(session: BrowserSession) {
  return [
    { name: 'browser_requests', description: 'List captured requests with stable IDs, status, body availability and capture loss. since is a Unix timestamp in milliseconds.',
      schema: requestsSchema,
      run: (args: unknown) => session.requests(requestsSchema.parse(args)) },
    { name: 'browser_request', description: 'Inspect one request ID: safe headers, payload, timing, initiator and failure. Use browser_response_body for its body.',
      schema: requestSchema,
      run: (args: unknown) => session.request(requestSchema.parse(args).requestId) },
    { name: 'browser_response_body', description: 'Read a bounded page of a captured response body by request ID. Reports truncation, missing bodies and the next offset.',
      schema: responseBodySchema,
      run: (args: unknown) => { const value = responseBodySchema.parse(args);
        return session.responseBody(value.requestId, value.offset, value.limit); } },
    { name: 'browser_changes', description: 'Describe what changed in the accessibility tree since the last browser_snapshot or browser_changes call: added, removed, and changed nodes (text, enabled, checked, expanded). Much shorter than a full snapshot. The first call only captures a baseline.',
      schema: changesSchema,
      run: (args: unknown) => { changesSchema.parse(args); return session.changes(); } },
    { name: 'browser_frames', description: 'List current frames and their IDs before inspecting a child frame.', schema: framesSchema,
      run: (args: unknown) => { framesSchema.parse(args); return session.frames(); } },
    { name: 'browser_inspect', description: 'Inspect an element: redacted DOM, attributes, geometry, computed/pseudo styles and CSSOM rule candidates. Returns a stable ref for actions and screenshots. Ambiguous targets require an index. Cross-origin CSS limits are explicit.',
      schema: inspectSchema,
      run: (args: unknown) => { const { properties, ...target } = inspectSchema.parse(args);
        return session.inspect(target, properties); } },
    { name: 'browser_explain_action', description: 'Explain what one action caused, as a tree: the requests it started with the script, line and function that started them (following timers and promises back to the handler), their status and body excerpt, console messages, uncaught exceptions and navigations. Messages are nested under the request whose code they share. Use request IDs with browser_request and browser_response_body.',
      schema: explainActionSchema,
      run: (args: unknown) => { const { actionId, filter, format } = explainActionSchema.parse(args);
        return session.explainAction(actionId, filter).then(({ chain, ...explanation }) =>
          format === 'json' ? { ...explanation, chain } : explanation); } },
    { name: 'browser_viewport', description: 'Set viewport size for responsive layout inspection, then wait for settling.',
      schema: viewportSchema,
      run: (args: unknown) => { const { width, height } = viewportSchema.parse(args); return session.viewport(width, height); } },
  ];
}

export const INSPECTION_TOOL_NAMES = ['browser_requests', 'browser_request', 'browser_response_body', 'browser_changes', 'browser_frames', 'browser_inspect',
  'browser_explain_action', 'browser_viewport'];
