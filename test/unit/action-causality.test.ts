import { compactInitiator, explainAction, type CausalityInput } from '../../src/core/action-causality.js';
import type { RequestRecord } from '../../src/core/network-recorder.js';
import type { EvidenceEvent } from '../../src/core/types.js';

const PAGE = 'https://shop.test/cart.html';
const SCRIPT = 'https://shop.test/app.js';

function frame(functionName: string, lineNumber: number, url = SCRIPT) {
  return { functionName, url, lineNumber, columnNumber: 4 };
}

function request(id: string, timestamp: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id, timestamp, actionId: 2, url: `https://shop.test/api/${id}`, method: 'GET', frameId: 'main', resourceType: 'Fetch',
    hostClass: 'first-party', status: 200, requestHeaders: {}, responseHeaders: {}, payload: null, initiator: { type: 'other' },
    timing: null, failure: null, payloadTruncated: false, body: null, bodyState: 'unavailable', bodyReason: null, ...overrides,
  };
}

function event(sequence: number, method: string, params: Record<string, unknown>, actionId = 2): EvidenceEvent {
  return { sequence, timestamp: 1_000 + sequence * 10, method, params, actionId };
}

function input(overrides: Partial<CausalityInput>): CausalityInput {
  return { runId: 'run-1', actionId: 2, events: [], requests: [], droppedEvents: 0, droppedRequests: 0, ...overrides };
}

it('nests a console error under the request whose starting frames it shares, not under a later or unrelated request', () => {
  const started = { type: 'script', stack: { callFrames: [frame('saveCart', 10)],
    parent: { description: 'setTimeout', callFrames: [frame('onSave', 3)] } } };
  const explanation = explainAction(input({
    requests: [
      request('save', 1_005, { method: 'POST', initiator: started, body: '{\n  "items": []\n}' }),
      request('late', 1_900, { initiator: started }),
      request('other', 1_006, { initiator: { type: 'script', stack: { callFrames: [frame('track', 40)] } } }),
    ],
    events: [
      event(1, 'Browser.action', { kind: 'click', target: 'button "Save"', url: PAGE, settled: { networkQuiet: true, domStable: true, waitedMs: 420 } }),
      event(2, 'Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Cart is empty' }, { type: 'number', value: 0 }],
        stackTrace: { callFrames: [frame('render', 20)], parent: { description: 'await', callFrames: [frame('saveCart', 11)] } } }),
      event(3, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'debug noise' }] }),
    ],
  }));

  const save = explanation.chain.find((node) => node.kind === 'request' && node.requestId === 'save');
  expect(save).toMatchObject({ bodyExcerpt: '{ "items": [] }', children: [expect.objectContaining({ kind: 'console', text: 'Cart is empty 0' })] });
  expect(explanation.summary).toMatchObject({ requests: 3, consoleErrors: 1 });
  expect(explanation.text).toContain('click button "Save" (action 2) → /cart.html, settled after 420 ms');
  expect(explanation.text).toContain('started by app.js:11:5 (saveCart) ← setTimeout ← app.js:4:5 (onSave)');
  expect(explanation.text).not.toContain('debug noise');
  const all = explainAction(input({ filter: 'all',
    events: [event(3, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'debug noise' }] })] }));
  expect(all.text).toContain('console.log "debug noise"');
});

it('groups parser-loaded resources under their document and omits successful static requests unless all are requested', () => {
  const parser = { type: 'parser', url: PAGE, lineNumber: 4 };
  const records = [
    request('doc', 1_001, { url: PAGE, resourceType: 'Document', initiator: { type: 'other' } }),
    request('logo', 1_002, { url: 'https://shop.test/logo.png', resourceType: 'Image', initiator: parser }),
    request('broken', 1_003, { url: 'https://shop.test/missing.png', resourceType: 'Image', status: 404, initiator: parser }),
    request('font', 1_004, { url: 'https://cdn.test/font.woff2', resourceType: 'Font', hostClass: 'third-party', failure: 'net::ERR_BLOCKED_BY_CLIENT', initiator: parser }),
  ];
  const events = [event(1, 'Browser.action', { kind: 'navigate', url: PAGE }), event(2, 'Page.frameNavigated', { frame: { id: 'main', url: PAGE } }),
    event(3, 'Page.frameNavigated', { frame: { id: 'ad', parentId: 'main', url: 'https://ads.test/' } })];

  const relevant = explainAction(input({ requests: records, events }));
  const document = relevant.chain[0];
  expect(document?.kind === 'request' && document.children.map((node) => node.kind === 'request' && node.requestId)).toEqual(['broken', 'font']);
  expect(relevant.summary).toMatchObject({ failedRequests: 2, omittedRequests: 1, navigations: 1 });
  expect(relevant.text).toContain('GET /missing.png (image) → 404 [broken]');
  expect(relevant.text).toContain('GET cdn.test/font.woff2 (font) → failed: net::ERR_BLOCKED_BY_CLIENT [font]');
  expect(relevant.text).toContain('loaded by cart.html:5');
  expect(relevant.text).toContain('+ 1 successful static or third-party request(s) omitted (use filter "all")');

  const all = explainAction(input({ requests: records, events, filter: 'all' }));
  expect(all.summary.omittedRequests).toBe(0);
  expect(all.text).toContain('GET /logo.png (image) → 200 [logo]');
});

it('falls back to Playwright console and page errors when CDP Runtime capture is unavailable', () => {
  const explanation = explainAction(input({
    hasCdpRuntime: false,
    requests: [request('app', 1_001, { url: SCRIPT, resourceType: 'Script', initiator: { type: 'parser', url: PAGE } })],
    events: [
      event(1, 'Browser.console', { level: 'error', text: 'Boot failed', location: { url: SCRIPT, lineNumber: 8, columnNumber: 2 } }),
      event(2, 'Browser.pageError', { message: 'x is undefined', stack: `TypeError: x is undefined\n    at boot (${SCRIPT}:12:7)` }),
      event(3, 'Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'ignored duplicate' }] }),
    ],
  }));
  const app = explanation.chain[0];
  expect(app?.kind === 'request' && app.children).toEqual([
    expect.objectContaining({ kind: 'console', text: 'Boot failed' }),
    expect.objectContaining({ kind: 'exception', origin: [expect.objectContaining({ location: expect.objectContaining({ line: 12, functionName: 'boot' }) })] }),
  ]);
  expect(explanation.text).toContain('action 2 (no action receipt was captured)');
  expect(explanation.text).not.toContain('ignored duplicate');
});

it('reports a failed action and possible capture loss', () => {
  const explanation = explainAction(input({
    droppedEvents: 5, droppedRequests: 3,
    requests: [request('newer', 2_000, { actionId: 4 })],
    events: [event(9, 'Browser.actionFailed', { kind: 'type', reason: 'target_not_found', message: 'No matching visible field was found.' })],
  }));
  expect(explanation.action).toMatchObject({ kind: 'type', failure: 'No matching visible field was found.' });
  expect(explanation.text).toContain('type (action 2), failed: No matching visible field was found.');
  expect(explanation.captureLoss).toHaveLength(2);
  expect(explanation.text).toContain('(no requests, console messages, exceptions or navigations were captured)');
});

it('bounds initiator stacks while keeping the CDP shape', () => {
  let stack: Record<string, unknown> | undefined;
  for (let level = 0; level < 20; level++) {
    stack = { description: `hop-${level}`, callFrames: Array.from({ length: 30 }, (_, index) => frame(`f${index}`, index)), ...(stack ? { parent: stack } : {}) };
  }
  const compact = compactInitiator({ type: 'script', stack, extra: 'dropped' }) as { type: string; extra?: string; stack: Record<string, unknown> };
  expect(compact.type).toBe('script');
  expect(compact.extra).toBeUndefined();
  let levels = 0;
  for (let level: Record<string, unknown> | undefined = compact.stack; level; level = level.parent as Record<string, unknown> | undefined) {
    expect((level.callFrames as unknown[]).length).toBeLessThanOrEqual(10);
    levels++;
  }
  expect(levels).toBe(8);
});
