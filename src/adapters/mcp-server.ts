#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserRuntimeError, BrowserSession, getErrorMessage } from '../index.js';
import type { LocatorTarget } from '../index.js';
import { browserSessionOptionsFromEnvironment, challengeChannels } from './environment.js';
import { formatBrowserEvidence } from './tool-results.js';
import { inspectionTools } from './inspection-tools.js';
import { actionTools } from './action-tools.js';
import { reportTools } from './report-tools.js';
import { cdpTools } from './cdp-tools.js';

const namedTarget = {
  name: z.string().min(1).describe('The visible or accessible name, or an element ref returned by browser_inspect.'),
  role: z.string().min(1).optional().describe('Optional ARIA role, such as button or link.'),
};

function locator(name: string, role?: string): LocatorTarget {
  if (/^element-\d+$/.test(name)) return { kind: 'ref', ref: name };
  return role ? { kind: 'role', role, name } : { kind: 'text', text: name };
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function call(operation: () => Promise<unknown> | unknown) {
  try {
    return result(await operation());
  } catch (error) {
    const payload = {
      error: getErrorMessage(error),
      code: error instanceof BrowserRuntimeError ? error.code : 'UNEXPECTED_ERROR',
    };
    console.error('Browser MCP tool call failed', payload);
    return { ...result(payload), isError: true };
  }
}

export function createBrowserMcpServer(
  session = new BrowserSession(browserSessionOptionsFromEnvironment(process.env)),
): {
  server: McpServer;
  session: BrowserSession;
} {
  const server = new McpServer({ name: 'agent-browser-runtime', version: '0.3.0' }, { capabilities: { logging: {} } });
  if (challengeChannels(process.env).includes('mcp')) {
    session.onHumanCheck((notice) => {
      void server.server.sendLoggingMessage({ level: 'warning', logger: 'agent-browser', data: notice }).catch((error: unknown) => {
        console.error('Browser MCP: challenge notice could not be sent', { error: getErrorMessage(error) });
      });
    });
  }

  server.registerTool(
    'browser_navigate',
    {
      description:
        'Open an exact URL, wait for DOM and network activity to settle, and return the resulting URL and title.',
      inputSchema: { url: z.string().url() },
    },
    ({ url }) => call(() => session.navigate(url)),
  );

  server.registerTool(
    'browser_snapshot',
    {
      description:
        'Return the current URL, title, and accessibility tree. Use this to find real element names before acting.',
      inputSchema: {},
    },
    () => call(() => session.snapshot()),
  );

  server.registerTool(
    'browser_click',
    {
      description:
        'Click an element by accessible name and optional ARIA role, then wait for the page to settle.',
      inputSchema: namedTarget,
    },
    ({ name, role }) => call(() => session.click(locator(name, role))),
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Fill a unique visible field by its exact label, accessible name, placeholder, or inspected element ref, then wait for the page to settle. Inspect ambiguous fields and use a ref.',
      inputSchema: { name: z.string().min(1), text: z.string() },
    },
    ({ name, text }) => call(() => session.type(/^element-\d+$/.test(name) ? { kind: 'ref', ref: name } : { kind: 'label', label: name }, text)),
  );

  server.registerTool(
    'browser_press',
    {
      description: 'Press a keyboard key, such as Enter, Escape, Tab, or ArrowDown.',
      inputSchema: { key: z.string().min(1) },
    },
    ({ key }) => call(() => session.press(key)),
  );

  server.registerTool(
    'browser_hover',
    {
      description: 'Hover an element by accessible name and optional ARIA role, then wait for the page to settle.',
      inputSchema: namedTarget,
    },
    ({ name, role }) => call(() => session.hover(locator(name, role))),
  );

  server.registerTool(
    'browser_dismiss_overlay',
    {
      description:
        'Dismiss a cookie banner, promotion, modal, or chat widget. It checks the main page and child frames.',
      inputSchema: {},
    },
    () => call(() => session.dismissOverlay()),
  );

  server.registerTool(
    'browser_wait_for_settled',
    {
      description: 'Wait until the DOM is stable and browser network activity is quiet, up to the configured limit.',
      inputSchema: {},
    },
    () => call(() => session.waitForSettled()),
  );

  server.registerTool(
    'browser_evidence',
    {
      description:
        'Return captured network responses with selected bodies, console messages, uncaught page errors, and important CDP events.',
      inputSchema: {
        filter: z.enum(['errors', 'first-party', 'all']).default('errors'),
        since: z.number().int().nonnegative().optional(),
      },
    },
    ({ filter, since }) =>
      call(async () =>
        formatBrowserEvidence(
          await session.evidence({ filter, ...(since === undefined ? {} : { since }) }),
        ),
      ),
  );

  server.registerTool(
    'browser_screenshot',
    {
      description: 'Capture the current viewport and return both its artifact path and image data.',
      inputSchema: { name: z.string().optional(), fullPage: z.boolean().optional(), ref: z.string().optional() },
    },
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
        return call(() => {
          throw error;
        });
      }
    },
  );

  server.registerTool(
    'browser_login',
    {
      description:
        'Sign in with a trusted account profile against an owner-approved brand and environment. Never pass a credential value here — the runtime resolves them internally. Returns a structured outcome (success, missing_credentials, invalid_credentials, unsupported_host, timeout, or interactive_challenge); never retries automatically.',
      inputSchema: {
        profile: z.string().min(1).describe('Trusted account profile reference, e.g. a shared QA account name.'),
        brand: z.string().min(1).describe('Approved brand to sign in on.'),
        environment: z.string().min(1).describe('Approved environment to sign in on.'),
        controls: z.object({ usernameRef: z.string().min(1), passwordRef: z.string().min(1), submitRef: z.string().min(1) }).optional()
          .describe('Discover the login form using browser_snapshot and browser_inspect, then supply the current field and submit-button refs. The runtime privately fills and submits them. Never pass credentials.'),
      },
    },
    (target) => call(() => session.login(target)),
  );

  server.registerTool(
    'browser_close',
    {
      description:
        'Close Chromium, save the trace when tracing is enabled, and prepare the same MCP connection for another investigation.',
      inputSchema: {},
    },
    () => call(() => session.close()),
  );

  for (const definition of [...inspectionTools(session), ...actionTools(session), ...reportTools(session), ...cdpTools(session)]) {
    server.registerTool(definition.name, { description: definition.description, inputSchema: definition.schema.shape },
      (args: unknown) => call(() => definition.run(args)));
  }
  return { server, session };
}

const { server, session } = createBrowserMcpServer();

let isShuttingDown = false;
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    const result = await session.close();
    process.exit(result.closed ? 0 : 1);
  } catch {
    console.error('Browser MCP: session cleanup failed during shutdown.');
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.stdin.once('end', () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
