import { z } from 'zod';
import type { BrowserSession } from '../core/browser-session.js';
import { browserConditionSchema, browserStepsSchema, browserTimeoutSchema } from '../core/action-contracts.js';
import { faultSchema } from '../core/network-faults.js';

const verifySchema = z.object({ condition: browserConditionSchema, timeoutMs: browserTimeoutSchema.optional() }).strict();
const sequenceSchema = z.object({ steps: browserStepsSchema, timeoutMs: browserTimeoutSchema.optional() }).strict();
const faultsClearSchema = z.object({}).strict();
const handoffSchema = z.object({
  reason: z.string().min(1).max(300).describe('What the person must do, for example "Complete the two-factor prompt".'),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe('Default 120000 (2 minutes), maximum 10 minutes.'),
}).strict();

/** Keep the model-facing contract identical in the stdio and Agent SDK transports. */
export function actionTools(session: BrowserSession) {
  return [
    {
      name: 'browser_verify',
      description: 'Wait for an explicit expected URL, element count/state, text or field value. Returns matched, unmet or error with an evidence bookmark; does not perform page actions or decide the test verdict. Use observed targets and expectations from the test request. Default deadline is 10 seconds, maximum 30 seconds. A browser call that hangs past its deadline closes the context to stop pending work.',
      schema: verifySchema,
      run: (args: unknown) => { const { condition, timeoutMs } = verifySchema.parse(args); return session.verify(condition, timeoutMs); },
    },
    {
      name: 'browser_sequence',
      description: 'Run 1 to 10 click, type, press, hover or verify steps in order within one shared deadline (default 10 seconds, maximum 30 seconds). Add expect to an action to verify its result. Stops on the first failure and returns partial progress with evidence. Completed actions without expect are not verified. Never retries actions. Use only controls already inspected; login and navigation use their dedicated tools. A stopped sequence can have changed the page: inspect before recovery.',
      schema: sequenceSchema,
      run: (args: unknown) => { const { steps, timeoutMs } = sequenceSchema.parse(args); return session.sequence(steps, timeoutMs); },
    },
    {
      name: 'browser_fault',
      description: 'Break matching network requests on purpose to test error handling: fail (connection error), status (answer with a status and body, default 500), delay (add latency), or rewrite (change the real response). Faults run inside this browser only, so the site\'s server never sees them. Evidence marks each injected response with its fault ID, separate from real server errors. Faults last until browser_faults_clear or browser_close. Add the fault before the action that sends the request.',
      schema: faultSchema,
      run: (args: unknown) => session.addFault(faultSchema.parse(args)),
    },
    {
      name: 'browser_request_handoff',
      description: 'Pause and let a person act in the visible browser: a CAPTCHA or bot challenge, a two-factor prompt, or a risky confirmation. Shows a banner with the reason and waits until the person clicks Done (or presses Ctrl+Shift+Enter), a detected challenge disappears, or the timeout passes. Other browser actions are refused while waiting. Use it when a receipt has attention.status challenge_detected or handoff_required. Returns unavailable when nobody can see the browser. Never try to solve a challenge yourself.',
      schema: handoffSchema,
      run: (args: unknown) => { const { reason, timeoutMs } = handoffSchema.parse(args); return session.requestHandoff(reason, timeoutMs); },
    },
    {
      name: 'browser_faults_clear',
      description: 'Remove every active network fault.',
      schema: faultsClearSchema,
      run: (args: unknown) => { faultsClearSchema.parse(args); return session.clearFaults(); },
    },
  ];
}

export const ACTION_TOOL_NAMES = ['browser_verify', 'browser_sequence', 'browser_fault', 'browser_faults_clear', 'browser_request_handoff'];
