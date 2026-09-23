import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';

let server: Server;
let url: string;
let artifactsDir: string;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'browser-outcomes-'));
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Evidence fixture</title>
      <button onclick="document.querySelector('#status').textContent='Saved'">Save</button>
      <button onclick="for(let i=0;i<100;i++)console.error('Background error '+i)">Noise</button>
      <p id="status">Waiting</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (artifactsDir) await rm(artifactsDir, { recursive: true, force: true });
});

it('returns important outcomes after noisy traffic and applies the same bookmark to saved and tool evidence', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless',
    maxEvidenceEvents: 32, settleQuietMs: 20 });
  try {
    await session.navigate(url);
    const beforeAction = session.checkpoint();
    await session.click({ kind: 'role', role: 'button', name: 'Save' });
    const verification = await session.verify({ kind: 'text', target: { kind: 'selector', selector: '#status' }, equals: 'Saved' });
    expect(verification.status).toBe('matched');
    const beforeNoise = session.checkpoint();
    await session.click({ kind: 'role', role: 'button', name: 'Noise' });
    const evidence = await session.evidence({ since: beforeAction });
    expect(evidence.droppedEvents).toBeGreaterThan(100);
    expect(evidence.truncated).toBe(true);
    expect(evidence.outcomes?.map((event) => event.method)).toEqual(['Browser.action', 'Browser.verify', 'Browser.action']);
    expect(evidence.outcomes?.every((event) => event.sequence > beforeAction)).toBe(true);
    expect(session.getEvidence({ since: beforeNoise }).outcomes?.map((event) => event.method)).toEqual(['Browser.action']);
    const saved = JSON.parse(await readFile(evidence.manifestPath!, 'utf8'));
    expect(saved.events).toEqual(expect.arrayContaining(evidence.outcomes!));
  } finally {
    await session.close();
  }
}, 30_000);
