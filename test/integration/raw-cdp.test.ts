import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';
import { cdpTools } from '../../src/adapters/cdp-tools.js';
import { browserSessionOptionsFromEnvironment } from '../../src/adapters/environment.js';

let server: Server;
let url: string;
let artifactsDir: string;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'cdp-test-'));
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=private-value; Path=/' });
    response.end('<!doctype html><title>CDP</title><h1>Raw CDP</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  url = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(artifactsDir, { recursive: true, force: true });
});

it('keeps raw CDP tools off unless BROWSER_RAW_CDP is set', async () => {
  expect(browserSessionOptionsFromEnvironment({ BROWSER_RAW_CDP: '1' }).isRawCdpEnabled).toBe(true);
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  expect(cdpTools(session)).toEqual([]);
  try {
    await session.navigate(url);
    await expect(session.cdp('Performance.getMetrics')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  } finally { await session.close(); }
}, 30_000);

it('sends commands, waits for events, redacts cookies, records calls, and blocks lifecycle methods', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless', isRawCdpEnabled: true });
  const [cdp, wait] = cdpTools(session);
  try {
    await session.navigate(url);
    await cdp!.run({ method: 'Performance.enable' });
    const metrics = await cdp!.run({ method: 'Performance.getMetrics' }) as { result: { metrics: { name: string }[] } };
    expect(metrics.result.metrics.some((metric) => metric.name === 'Nodes')).toBe(true);
    const cookies = await cdp!.run({ method: 'Network.getCookies' }) as { result: unknown };
    expect(JSON.stringify(cookies)).not.toContain('private-value');
    await expect(session.cdp('Browser.close')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    await expect(session.cdp('not a method')).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    const waiting = wait!.run({ event: 'Page.loadEventFired', timeoutMs: 10_000 });
    await session.cdp('Page.reload');
    expect(await waiting).toMatchObject({ status: 'received' });
    expect(await session.cdpWait('Page.javascriptDialogOpening', 200)).toMatchObject({ status: 'timeout' });
    const evidence = await session.evidence({ filter: 'all' });
    expect(evidence.runId).toBeTruthy();
    expect(JSON.stringify(session.getEvidence({ filter: 'all' }))).not.toContain('private-value');
  } finally { await session.close(); }
}, 30_000);
