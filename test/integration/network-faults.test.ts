import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';
import { actionTools } from '../../src/adapters/action-tools.js';

let server: Server;
let url: string;
let artifactsDir: string;
let searchHits = 0;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'faults-test-'));
  server = createServer((request, response) => {
    if (request.url?.startsWith('/api/search')) {
      searchHits++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: ['hammer'], total: 1 }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Shop</title><button id="go">Search</button><p role="status">Idle</p>
      <script>document.querySelector('#go').addEventListener('click', async () => {
        const status = document.querySelector('[role=status]');
        try { const r = await fetch('/api/search?q=hammer'); status.textContent = r.ok ? JSON.stringify(await r.json()) : 'Error ' + r.status; }
        catch { status.textContent = 'Network error'; }
      });</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(artifactsDir, { recursive: true, force: true });
});

async function statusText(session: BrowserSession): Promise<string> {
  const { aria } = await session.snapshot();
  const value = /status: (.*)/.exec(aria)?.[1] ?? '';
  return value.startsWith('"') ? JSON.parse(value) as string : value;
}

it('injects status, failure, delay, and rewrite faults without reaching the server, and labels them in evidence', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  const [fault, clear] = ['browser_fault', 'browser_faults_clear'].map((name) => actionTools(session).find((tool) => tool.name === name)!);
  try {
    await session.navigate(url);
    expect(() => fault!.run({ urlPattern: '/api', action: 'explode' })).toThrow();

    await fault!.run({ urlPattern: '*/api/search*', action: 'status', status: 500, body: 'boom', times: 1 });
    const hitsBefore = searchHits;
    const click = await session.click({ kind: 'role', role: 'button', name: 'Search' });
    expect(await statusText(session)).toBe('Error 500');
    expect(searchHits).toBe(hitsBefore);
    const evidence = await session.evidence({ filter: 'all', since: click.evidenceSince });
    expect(evidence.network.find((item) => item.url.includes('/api/search'))).toMatchObject({ status: 500, injectedFault: 'fault-1' });
    expect(evidence.summary.injectedFaults).toBe(1);
    expect((await session.explainAction(click.actionId)).text).toMatch(/GET \/api\/search\?q=hammer → 500 \[request-\d+\] \(injected by fault-1\)/);

    await fault!.run({ urlPattern: '/api/search', action: 'fail', errorCode: 'connectionrefused', times: 1 });
    await session.click({ kind: 'role', role: 'button', name: 'Search' });
    expect(await statusText(session)).toBe('Network error');

    await fault!.run({ urlPattern: '/api/search', action: 'rewrite', json: { items: [] }, times: 1 });
    await session.click({ kind: 'role', role: 'button', name: 'Search' });
    expect(await statusText(session)).toBe('{"items":[],"total":1}');

    await fault!.run({ urlPattern: '/api/search', action: 'delay', delayMs: 1_200, times: 1 });
    const startedAt = Date.now();
    await session.click({ kind: 'role', role: 'button', name: 'Search' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_200);
    expect(await statusText(session)).toContain('hammer');

    await fault!.run({ urlPattern: '/api/search', action: 'status', status: 503 });
    expect(await clear!.run({})).toEqual({ cleared: 5 });
    await session.click({ kind: 'role', role: 'button', name: 'Search' });
    expect(await statusText(session)).toContain('hammer');
  } finally { await session.close(); }
}, 45_000);
