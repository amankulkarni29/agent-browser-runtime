import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/core/browser-session.js';
import type { BrowserCondition, BrowserStep } from '../../src/core/action-contracts.js';

let server: Server;
let url: string;
let directory: string;
let session: BrowserSession;
let mutations = 0;
const selector = (value: string) => ({ kind: 'selector' as const, selector: value });

describe.each(['headless', 'virtual-display'] as const)('%s verified actions', (launchMode) => {
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runtime-verified-test-'));
  server = createServer((request, response) => {
    if (request.url === '/mutated') {
      mutations++;
      response.end('mutated');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Verified actions fixture</title>
      <label>Value<input id="value" placeholder="Value"></label>
      <input id="password" type="password" value="private-actual-value">
      <input id="readonly" readonly value="read-only">
      <button id="start" onclick="setTimeout(()=>document.querySelector('#result').textContent='Done',200)">Start</button>
      <p id="result">Pending</p><p id="slow-result">Pending</p><p id="hidden" hidden>Hidden</p>
      <button class="duplicate">Same</button><button class="duplicate">Same</button>
      <button id="later" onclick="fetch('/mutated')">Later</button>
      <button id="danger" onclick="fetch('/mutated')">Place order</button>
      <span id="danger-label">Place order</span><button id="labelled-danger" aria-labelledby="danger-label" onclick="fetch('/mutated')">Continue</button>
      <button id="disabled" disabled onclick="fetch('/mutated')">Disabled</button>
      <form action="/mutated"><input id="danger-input"><button>Place order</button></form>
      <form action="${url?.replace('127.0.0.1', 'localhost')}/mutated"><input id="external-input"><button id="external-submit">Continue</button></form>
      <a id="external-link" href="${url?.replace('127.0.0.1', 'localhost')}/mutated">Leave</a>
      <button id="stale">Old control</button>
      <button id="replace" onclick="document.querySelector('#stale').outerHTML='<button id=stale>Replacement</button>'">Replace</button>
      <button id="hover" onmouseover="document.querySelector('#result').textContent='Hovered'">Hover</button>
      <script>setTimeout(()=>document.querySelector('#disabled').disabled=false,1000);
        Object.defineProperty(document.querySelector('#slow-result'), 'innerText', {
          get() { const end = performance.now() + 600; while (performance.now() < end) {} return 'Pending'; }
        });</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  url = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  mutations = 0;
  session = new BrowserSession({ launchMode, artifactsDir: directory, settleQuietMs: 10, settleTimeoutMs: 100 });
  await session.navigate(url);
});

afterEach(async () => { await session.close(); });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

it('verifies a delayed outcome and reports actions without expectations as unverified completion', async () => {
  const result = await session.sequence([
    { kind: 'type', target: selector('#value'), value: 'fixture-input' },
    { kind: 'click', target: selector('#start'), expect: { kind: 'text', target: selector('#result'), equals: 'Done' } },
    { kind: 'verify', condition: { kind: 'value', target: selector('#value'), equals: 'fixture-input' } },
  ], 2_000);

  expect(result.status).toBe('completed');
  expect(result.steps.map((step) => step.status)).toEqual(['completed', 'verified', 'verified']);
  expect(result.runId).toBeTruthy();
  expect(result.evidence.since).toBe(result.evidenceSince);
  expect(JSON.stringify(result.steps)).not.toContain('fixture-input');
  expect(result.steps[1]?.verification).toMatchObject({ status: 'matched', kind: 'text' });
});

it('stops before a later action when an expectation stays unmet', async () => {
  const started = Date.now();
  const result = await session.sequence([
    // URL checks use cached page state, so an in-flight CDP read cannot turn this into a timeout error.
    { kind: 'hover', target: selector('#hover'), expect: { kind: 'url', equals: `${url}/never-matches` } },
    { kind: 'click', target: selector('#later') },
  ], 1_000);

  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.status).toBe('stopped');
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]).toMatchObject({ status: 'failed', verification: {
    status: 'unmet', diagnostic: { reason: 'condition_unmet' },
  } });
  expect(mutations).toBe(0);
});

it('reports a timeout when a condition read crosses the deadline without running a later action', async () => {
  const started = Date.now();
  const result = await session.sequence([
    { kind: 'verify', condition: { kind: 'text', target: selector('#slow-result'), equals: 'Never happens' } },
    { kind: 'click', target: selector('#later') },
  ], 200);

  expect(Date.now() - started).toBeLessThan(3_000);
  expect(result.status).toBe('stopped');
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]).toMatchObject({ index: 0, kind: 'verify', status: 'failed', verification: {
    status: 'error', diagnostic: { code: 'ACTION_FAILED', reason: 'action_timeout' },
  } });
  expect(mutations).toBe(0);
});

it('validates every step and selector before the first mutation', async () => {
  const steps: BrowserStep[] = [
    { kind: 'type', target: selector('#value'), value: 'must-not-be-entered' },
    { kind: 'hover', target: selector('#hover') },
  ];
  Object.assign(steps[1]!, { unexpected: true });
  await expect(session.sequence(steps)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  const invalidSelector = await session.sequence([
    steps[0]!, { kind: 'click', target: selector('[') },
  ]);
  expect(invalidSelector.status).toBe('stopped');
  expect(invalidSelector.steps).toEqual([expect.objectContaining({
    index: 1, kind: 'click', status: 'failed', evidenceSince: invalidSelector.evidenceSince,
    diagnostic: { code: 'INVALID_CONFIGURATION', reason: 'invalid_selector',
      message: 'The target selector is invalid. Correct its syntax before retrying.' },
  })]);
  const invalidExpectation = await session.sequence([
    steps[0]!,
    { kind: 'click', target: selector('#later') },
    { kind: 'hover', target: selector('#hover'), expect: {
      kind: 'text', target: selector('#private-invalid['), equals: 'private-expected-value',
    } },
  ]);
  expect(invalidExpectation.status).toBe('stopped');
  expect(invalidExpectation.steps).toEqual([expect.objectContaining({
    index: 2, kind: 'hover', status: 'failed', evidenceSince: invalidExpectation.evidenceSince,
    diagnostic: { code: 'INVALID_CONFIGURATION', reason: 'invalid_selector',
      message: 'The target selector is invalid. Correct its syntax before retrying.' },
  })]);
  expect(JSON.stringify(invalidExpectation)).not.toMatch(/private-invalid|private-expected-value|must-not-be-entered/);
  expect(mutations).toBe(0);
  expect(await session.verify({ kind: 'value', target: selector('#value'), equals: '' }, 100)).toMatchObject({ status: 'matched' });
  await expect(session.sequence(Array.from({ length: 11 }, () => steps[0]!))).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  for (const timeout of [0, -1, NaN, Infinity, 30_001, 1.5]) {
    await expect(session.sequence([steps[0]!], timeout)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  }
  await expect(Reflect.apply(session.sequence, session, [[steps[0]!], null])).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
});

it('counts all matches and rejects ambiguous checks and actions', async () => {
  expect(await session.verify({ kind: 'count', target: selector('.duplicate'), equals: 2 })).toMatchObject({ status: 'matched' });
  expect(await session.verify({ kind: 'text', target: selector('.duplicate'), equals: 'Same' })).toMatchObject({
    status: 'error', diagnostic: { reason: 'ambiguous_target' },
  });
  const result = await session.sequence([{ kind: 'click', target: selector('.duplicate') }, { kind: 'click', target: selector('#later') }]);
  expect(result.steps[0]).toMatchObject({ status: 'failed', diagnostic: { reason: 'ambiguous_target' } });
  expect(mutations).toBe(0);
});

it('checks exact URL, hidden absence and enabled states without exposing values', async () => {
  const conditions: BrowserCondition[] = [
    { kind: 'url', equals: `${url}/` },
    { kind: 'state', target: selector('#hidden'), state: 'hidden' },
    { kind: 'state', target: selector('#absent'), state: 'hidden' },
    { kind: 'state', target: selector('#value'), state: 'enabled' },
    { kind: 'state', target: selector('#disabled'), state: 'disabled' },
    { kind: 'count', target: selector('#absent'), equals: 0 },
  ];
  for (const condition of conditions) expect(await session.verify(condition, 100)).toMatchObject({ status: 'matched' });
  const secretCheck = await session.verify({ kind: 'value', target: selector('#password'), equals: 'private-expected-value' });
  expect(secretCheck).toMatchObject({ status: 'error', diagnostic: { reason: 'sensitive_value' } });
  expect(JSON.stringify(secretCheck)).not.toMatch(/private-(actual|expected)-value/);
  const manifest = await readFile(session.getEvidence().manifestPath!, 'utf8');
  expect(manifest).not.toMatch(/private-(actual|expected)-value/);
});

it('does not treat stale references as absent for hidden or zero-count checks', async () => {
  const { ref } = await session.inspect({ selector: '#stale' }, []);
  await session.click(selector('#replace'));
  for (const condition of [
    { kind: 'state', target: { kind: 'ref', ref }, state: 'hidden' },
    { kind: 'count', target: { kind: 'ref', ref }, equals: 0 },
  ] satisfies BrowserCondition[]) {
    expect(await session.verify(condition, 100)).toMatchObject({ status: 'error', diagnostic: { reason: 'target_detached' } });
  }
});

it('enforces the shared action budget and never clicks a control enabled after expiry', async () => {
  const started = Date.now();
  const result = await session.sequence([
    { kind: 'click', target: selector('#disabled') },
    { kind: 'click', target: selector('#later') },
  ], 200);
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(result.status).toBe('stopped');
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]?.diagnostic?.reason).toMatch(/action_timeout|target_disabled/);
  await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
  expect(mutations).toBe(0);
});

it('rejects concurrent mutations and cancels a sequence when the session closes', async () => {
  const running = session.sequence([
    { kind: 'verify', condition: { kind: 'text', target: selector('#result'), equals: 'never' } },
    { kind: 'click', target: selector('#later') },
  ], 2_000);
  await expect(session.type(selector('#value'), 'concurrent-value')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  expect(await session.verify({ kind: 'count', target: selector('#result'), equals: 1 })).toMatchObject({
    status: 'error', diagnostic: { reason: 'session_busy', code: 'INVALID_STATE' },
  });
  await session.close();
  const result = await running;
  expect(result.status).toBe('stopped');
  expect(result.steps).toHaveLength(1);
  expect(mutations).toBe(0);
  await session.navigate(url);
  expect(await session.verify({ kind: 'value', target: selector('#value'), equals: '' })).toMatchObject({ status: 'matched' });
});
});
