import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BrowserRuntimeError, BrowserSession, getErrorMessage } from '../index.js';
import type { LocatorTarget } from '../index.js';
import { formatBrowserEvidence } from './tool-results.js';
import { inspectionTools, INSPECTION_TOOL_NAMES } from './inspection-tools.js';
import { actionTools, ACTION_TOOL_NAMES } from './action-tools.js';
import { reportTools, REPORT_TOOL_NAMES } from './report-tools.js';
import { cdpTools } from './cdp-tools.js';

export { CDP_TOOL_NAMES } from './cdp-tools.js';

function locator(name: string, role?: string): LocatorTarget {
  if (/^element-\d+$/.test(name)) return { kind: 'ref', ref: name };
  return role ? { kind: 'role', role, name } : { kind: 'text', text: name };
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function call(operation: () => Promise<unknown> | unknown) {
  try {
    return text(await operation());
  } catch (error) {
    const payload = {
      error: getErrorMessage(error),
      code: error instanceof BrowserRuntimeError ? error.code : 'UNEXPECTED_ERROR',
    };
    console.error('Agent SDK browser tool call failed', payload);
    return { ...text(payload), isError: true };
  }
}

const namedTarget = {
  name: z.string().min(1).describe('The visible or accessible name, or an element ref returned by browser_inspect.'),
  role: z.string().min(1).optional().describe('Optional ARIA role, such as button or link.'),
};

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_hover',
  'browser_dismiss_overlay',
  'browser_wait_for_settled',
  'browser_evidence',
  'browser_screenshot',
  'browser_login',
  'browser_close',
  ...INSPECTION_TOOL_NAMES,
  ...ACTION_TOOL_NAMES,
  ...REPORT_TOOL_NAMES,
].map((name) => `mcp__browser__${name}`);

/**
 * Create an in-process Agent SDK MCP adapter around an orchestrator-owned session.
 * The caller retains the session so it can salvage evidence after an agent abort.
 */
export function createAgentSdkBrowserServer(session: BrowserSession): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'browser',
    version: '0.3.0',
    tools: [
      ...[...inspectionTools(session), ...actionTools(session), ...reportTools(session), ...cdpTools(session)].map((definition) => tool(definition.name, definition.description, definition.schema.shape,
        (args) => call(() => definition.run(args)))),
      tool(
        'browser_navigate',
        'Open an exact URL, wait for DOM and network activity to settle, and return the resulting URL and title.',
        { url: z.string().url() },
        ({ url }) => call(() => session.navigate(url)),
      ),
      tool(
        'browser_snapshot',
        'Return the current URL, title, and accessibility tree. Use this before choosing an element.',
        {},
        () => call(() => session.snapshot()),
      ),
      tool(
        'browser_click',
        'Click an element by accessible name and optional ARIA role.',
        namedTarget,
        ({ name, role }) => call(() => session.click(locator(name, role))),
      ),
      tool(
        'browser_type',
        'Fill a unique visible field by its exact label, accessible name, placeholder, or inspected element ref. Inspect ambiguous fields and use a ref.',
        { name: z.string().min(1), text: z.string() },
        ({ name, text: value }) => call(() => session.type(/^element-\d+$/.test(name) ? { kind: 'ref', ref: name } : { kind: 'label', label: name }, value)),
      ),
      tool(
        'browser_press',
        'Press a keyboard key, such as Enter, Escape, Tab, or ArrowDown.',
        { key: z.string().min(1) },
        ({ key }) => call(() => session.press(key)),
      ),
      tool(
        'browser_hover',
        'Hover an element by accessible name and optional ARIA role.',
        namedTarget,
        ({ name, role }) => call(() => session.hover(locator(name, role))),
      ),
      tool(
        'browser_dismiss_overlay',
        'Dismiss a cookie banner, promotion, modal, or chat widget in the page or a child frame.',
        {},
        () => call(() => session.dismissOverlay()),
      ),
      tool(
        'browser_wait_for_settled',
        'Wait for stable DOM content and quiet network activity.',
        {},
        () => call(() => session.waitForSettled()),
      ),
      tool(
        'browser_evidence',
        'Return network responses with selected bodies, console messages, page errors, and important CDP events.',
        {
          filter: z.enum(['errors', 'first-party', 'all']).default('errors'),
          since: z.number().int().nonnegative().optional(),
        },
        ({ filter, since }) =>
          call(async () =>
            formatBrowserEvidence(
              await session.evidence({ filter, ...(since === undefined ? {} : { since }) }),
            ),
          ),
      ),
      tool(
        'browser_screenshot',
        'Capture the current viewport and return the image for visual inspection.',
        { name: z.string().optional(), fullPage: z.boolean().optional(), ref: z.string().optional() },
        async ({ name, fullPage, ref }) => {
          try {
            const artifact = await session.screenshot(name, { fullPage, ref });
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify({ ...artifact, dataBase64: undefined }) },
                { type: 'image' as const, data: artifact.dataBase64, mimeType: artifact.mimeType },
              ],
            };
          } catch (error) {
            const payload = {
              error: getErrorMessage(error),
              code: error instanceof BrowserRuntimeError ? error.code : 'UNEXPECTED_ERROR',
            };
            console.error('Agent SDK browser screenshot failed', payload);
            return { ...text(payload), isError: true };
          }
        },
      ),
      tool(
        'browser_login',
        'Sign in with a trusted account profile against an owner-approved brand and environment. Never pass a credential value here. Returns a structured outcome (success, missing_credentials, invalid_credentials, unsupported_host, timeout, or interactive_challenge); never retries automatically.',
        {
          profile: z.string().min(1),
          brand: z.string().min(1),
          environment: z.string().min(1),
          controls: z.object({ usernameRef: z.string().min(1), passwordRef: z.string().min(1), submitRef: z.string().min(1) }).optional()
            .describe('Current username, password, and submit-button refs discovered with browser_inspect. Never pass credentials.'),
        },
        (target) => call(() => session.login(target)),
      ),
      tool(
        'browser_close',
        'Close Chromium, save the trace when tracing is enabled, and prepare the session for another investigation.',
        {},
        () => call(() => session.close()),
      ),
    ],
  });
}
