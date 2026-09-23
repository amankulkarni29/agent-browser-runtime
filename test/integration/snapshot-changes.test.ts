import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';

let server: Server;
let url: string;
let artifactsDir: string;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'changes-test-'));
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Controls</title><main><h1>Dynamic controls</h1>
      ${Array.from({ length: 40 }, (_, index) => `<p>Paragraph ${index} with enough text to make a full snapshot long.</p>`).join('')}
      <div id="box"><input type="checkbox" aria-label="A checkbox"></div>
      <button id="toggle" onclick="document.querySelector('#box').innerHTML=''; this.textContent='Add'">Remove</button>
      <input aria-label="Note" disabled><button onclick="document.querySelector('[aria-label=Note]').disabled=false">Enable</button>
      <p role="status">Idle</p></main>`);
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

it('reports what each action changed at a fraction of a full snapshot', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  try {
    await session.navigate(url);
    expect(await session.changes()).toMatchObject({ baseline: true });
    await session.click({ kind: 'role', role: 'button', name: 'Remove' });
    const removed = await session.changes();
    expect(removed.text).toContain('removed checkbox "A checkbox"');
    expect(removed.text).toMatch(/button "Remove"/);
    await session.click({ kind: 'role', role: 'button', name: 'Enable' });
    const enabled = await session.changes();
    expect(enabled.text).toBe('changed textbox "Note": now enabled');
    expect(enabled.diffChars!).toBeLessThan(enabled.fullSnapshotChars! / 20);
    expect((await session.changes()).text).toBe('No accessibility changes.');
  } finally { await session.close(); }
}, 30_000);
