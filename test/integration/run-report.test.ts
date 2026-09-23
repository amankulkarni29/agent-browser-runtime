import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BrowserSession } from '../../src/index.js';
import { reportTools } from '../../src/adapters/report-tools.js';

let server: Server;
let url: string;
let artifactsDir: string;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'report-test-'));
  server = createServer((request, response) => {
    if (request.url === '/missing.png') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Shop</title><img src="/missing.png" alt="Product">
      <button onclick="undefinedHandler()">Buy</button>`);
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

it('writes a readable run folder, a formatted manifest, and an HTML report with the action timeline', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  const tool = reportTools(session)[0]!;
  let manifestPath: string | null | undefined;
  let reportPath: string | null | undefined;
  try {
    await session.navigate(url);
    const click = await session.click({ kind: 'role', role: 'button', name: 'Buy' });
    const shot = await session.screenshot('after-buy');
    expect(() => tool.run({ title: 'x', goal: 'g', summary: 's', extra: true })).toThrow();

    const result = await tool.run({
      title: 'Shop QA <script>alert(1)</script>',
      goal: 'Check that buying works.',
      summary: 'Buying throws an uncaught error.',
      findings: [
        { title: 'Buy button throws', severity: 'high', steps: ['Open the shop', 'Click Buy'], expected: 'Item added',
          actual: 'ReferenceError', actionIds: [click.actionId], evidence: ['ReferenceError: undefinedHandler is not defined'] },
        { title: 'Analytics ping aborted', severity: 'info', scope: 'third-party' },
      ],
      githubIssue: { repository: 'example/shop', title: 'Buy button throws ReferenceError', body: 'Steps:\n1. Click Buy', labels: ['bug'] },
      notes: ['Checkout was not tested.'],
    }) as { path: string; actions: number; findings: number };

    expect(result).toMatchObject({ actions: 2, findings: 2 });
    expect(basename(dirname(result.path))).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_127\.0\.0\.1_[0-9a-f]{8}$/);
    const html = await readFile(result.path, 'utf8');
    expect(html).toContain('Shop QA &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('id="action-2"');
    expect(html).toMatch(/uncaught ReferenceError: undefinedHandler is not defined/);
    expect(html).toMatch(/GET \/missing\.png \(image\) → 404/);
    expect(html).toContain(`src="${basename(shot.path)}"`);
    expect(html).toContain('Third-party noise');
    expect(html).toContain('Buy button throws ReferenceError');
    expect(html).toContain('Checkout was not tested.');
  } finally { ({ manifestPath, reportPath } = await session.close()); }

  const manifest = await readFile(manifestPath!, 'utf8');
  expect(manifest.split('\n').length).toBeGreaterThan(50);
  expect(JSON.parse(manifest).cleanup).toEqual({ logout: 'not-needed', warnings: [] });
  expect(await readdir(dirname(manifestPath!))).toContain('report.html');
  // close() rewrites the report with the agent's findings and the complete timeline.
  expect(await readFile(reportPath!, 'utf8')).toContain('Buy button throws ReferenceError');
}, 30_000);

it('writes a timeline-only report on close when the agent never called browser_report', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  await session.navigate(url);
  const { reportPath } = await session.close();
  const html = await readFile(reportPath!, 'utf8');
  expect(html).toContain('Browser session on 127.0.0.1');
  expect(html).toContain('without calling browser_report');
  expect(html).toContain('id="action-1"');
}, 30_000);
