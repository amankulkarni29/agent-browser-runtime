import type { BrowserCondition } from './action-contracts.js';
import type { RequestRecord } from './network-recorder.js';
import type { LocatorTarget } from './types.js';

/** A locator the exported test can use without the session's element refs. */
export type PortableTarget = Exclude<LocatorTarget, { kind: 'ref' }> | { kind: 'unportable'; reason: string };

export type PortableCondition =
  | { kind: 'url'; equals: string }
  | { kind: 'count'; target: PortableTarget; equals: number }
  | { kind: 'state'; target: PortableTarget; state: 'visible' | 'hidden' | 'enabled' | 'disabled' }
  | { kind: 'text' | 'value'; target: PortableTarget; equals: string };

export type RecordedStep =
  | { kind: 'navigate'; url: string }
  | { kind: 'click' | 'hover'; target: PortableTarget }
  | { kind: 'type'; target: PortableTarget; value: string; sensitive: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'verify'; condition: PortableCondition; matched: boolean }
  | { kind: 'note'; text: string };

export const MAX_RECORDED_STEPS = 500;

const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;

/** Mirror the session's matching: actions match names loosely, fields and checks match exactly. */
function locatorCode(target: PortableTarget, mode: 'action' | 'field' | 'condition'): string | null {
  const exact = mode === 'action' ? '' : ', exact: true';
  const exactOnly = mode === 'action' ? '' : ', { exact: true }';
  switch (target.kind) {
    case 'role': return `page.getByRole(${quote(target.role)}, { name: ${quote(target.name)}${exact} })`;
    case 'label': return mode === 'field'
      ? `page.getByLabel(${quote(target.label)}, { exact: true }).or(page.getByPlaceholder(${quote(target.label)}, { exact: true })).or(page.getByRole('textbox', { name: ${quote(target.label)}, exact: true }))`
      : `page.getByLabel(${quote(target.label)}${exactOnly})`;
    case 'text': return `page.getByText(${quote(target.text)}${exactOnly})`;
    case 'selector': return `page.locator(${quote(target.selector)})`;
    case 'unportable': return null;
  }
}

function conditionCode(condition: PortableCondition): string | null {
  if (condition.kind === 'url') return `await expect(page).toHaveURL(${quote(condition.equals)});`;
  const locator = locatorCode(condition.target, 'condition');
  if (!locator) return null;
  switch (condition.kind) {
    case 'count': return `await expect(${locator}).toHaveCount(${condition.equals});`;
    case 'state': return `await expect(${locator}.first()).${{ visible: 'toBeVisible', hidden: 'toBeHidden', enabled: 'toBeEnabled', disabled: 'toBeDisabled' }[condition.state]}();`;
    case 'text': return `await expect(${locator}.first()).toHaveText(${quote(condition.equals)});`;
    case 'value': return `await expect(${locator}.first()).toHaveValue(${quote(condition.equals)});`;
  }
}

function stepCode(step: RecordedStep): string[] {
  switch (step.kind) {
    case 'navigate': return [`await page.goto(${quote(step.url)});`];
    case 'press': return [`await page.keyboard.press(${quote(step.key)});`];
    case 'note': return [`// ${step.text.replace(/\n/g, ' ')}`];
    case 'verify': {
      const code = conditionCode(step.condition);
      if (!code) return ['// Verification skipped: its target has no portable locator.'];
      return step.matched ? [code] : [`// Not met during exploration, so left out: ${code}`];
    }
    case 'click':
    case 'hover': {
      const locator = locatorCode(step.target, 'action');
      return locator ? [`await ${locator}.first().${step.kind}();`] : [`// ${step.kind} skipped: ${step.target.kind === 'unportable' ? step.target.reason : ''}`];
    }
    case 'type': {
      const locator = locatorCode(step.target, 'field');
      if (!locator) return [`// type skipped: ${step.target.kind === 'unportable' ? step.target.reason : ''}`];
      const value = step.sensitive ? `process.env.TEST_SECRET_VALUE ?? ''` : quote(step.value);
      return [`await ${locator}.first().fill(${value});`];
    }
  }
}

export function renderSpec(name: string, steps: RecordedStep[], options: { harFile: string | null; startUrl: string | null }): string {
  const verified = steps.filter((step) => step.kind === 'verify' && step.matched).length;
  const lines = [
    `// Exported by agent-browser-runtime from an exploratory session${options.startUrl ? ` on ${options.startUrl}` : ''}.`,
    `// ${steps.length} recorded steps, ${verified} verified as assertions. Review before adding it to CI.`,
    `// Run: npx playwright test ${name}.spec.ts`,
    ...(options.harFile ? [
      `// Replay recorded responses: REPLAY=har npx playwright test ${name}.spec.ts (falls back to the network)`,
      `// Offline: REPLAY=offline npx playwright test ${name}.spec.ts (requests missing from the HAR fail)`,
    ] : []),
    `import { test, expect } from '@playwright/test';`,
    ...(options.harFile ? [`import { dirname, join } from 'node:path';`] : []),
    '',
    `test(${quote(name)}, async ({ page, context }) => {`,
    ...(options.harFile ? [
      `  if (process.env.REPLAY === 'har' || process.env.REPLAY === 'offline') {`,
      `    const har = join(dirname(test.info().file), ${quote(options.harFile)});`,
      `    await context.routeFromHAR(har, { notFound: process.env.REPLAY === 'offline' ? 'abort' : 'fallback' });`,
      '  }',
    ] : ['  void context;']),
    ...steps.flatMap(stepCode).map((line) => `  ${line}`),
    '});',
    '',
  ];
  return lines.join('\n');
}

/** HAR 1.2 from captured responses whose full body was retained. */
export function buildHar(records: RequestRecord[]): { har: object; entries: number } {
  const entries = records
    .filter((record) => record.status > 0 && record.bodyState === 'available' && record.body !== null && !record.failure)
    .map((record) => {
      const url = new URL(record.url);
      const mimeType = record.responseHeaders['content-type'] ?? 'application/octet-stream';
      return {
        startedDateTime: new Date(record.timestamp).toISOString(),
        time: 0,
        request: {
          method: record.method, url: record.url, httpVersion: 'HTTP/1.1', cookies: [],
          headers: Object.entries(record.requestHeaders).map(([name, value]) => ({ name, value })),
          queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
          ...(record.payload !== null ? { postData: { mimeType: record.requestHeaders['content-type'] ?? 'text/plain', text: record.payload } } : {}),
          headersSize: -1, bodySize: record.payload?.length ?? 0,
        },
        response: {
          status: record.status, statusText: '', httpVersion: 'HTTP/1.1', cookies: [],
          headers: Object.entries(record.responseHeaders).filter(([name]) => name !== 'content-length').map(([name, value]) => ({ name, value })),
          content: { size: record.body!.length, mimeType, text: record.body! },
          redirectURL: '', headersSize: -1, bodySize: record.body!.length,
        },
        cache: {}, timings: { send: 0, wait: 0, receive: 0 },
      };
    });
  return { har: { log: { version: '1.2', creator: { name: 'agent-browser-runtime', version: '1' }, entries } }, entries: entries.length };
}

export function portableCondition(condition: BrowserCondition, target: PortableTarget | undefined): PortableCondition {
  if (condition.kind === 'url') return condition;
  const resolved = target ?? { kind: 'unportable', reason: 'no target' };
  if (condition.kind === 'count') return { kind: 'count', target: resolved, equals: condition.equals };
  if (condition.kind === 'state') return { kind: 'state', target: resolved, state: condition.state };
  return { kind: condition.kind, target: resolved, equals: condition.equals };
}
