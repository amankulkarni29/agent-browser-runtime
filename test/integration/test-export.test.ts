import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BrowserSession } from '../../src/index.js';
import { reportTools } from '../../src/adapters/report-tools.js';

const execute = promisify(execFile);
async function run(command: string, args: string[], options: Parameters<typeof execute>[2]) {
  try { return await execute(command, args, options); }
  catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    throw new Error(`${command} ${args.join(' ')} failed:\n${stdout}\n${stderr}`);
  }
}
// The exported spec imports @playwright/test, so it must live under this package's node_modules.
const artifactsDir = resolve('.tmp-test-export');
let server: Server;
let url: string;
let cartTotal = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/api/cart' && request.method === 'POST') {
      cartTotal++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ count: 1 }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Shop</title><main>
      <label>Email <input type="email"></label><label>Password <input type="password"></label>
      <button class="icon-add" onclick="fetch('/api/cart',{method:'POST'}).then(r=>r.json()).then(b=>{document.querySelector('#count').textContent='Cart '+b.count})">+</button>
      <p id="count">Cart 0</p></main>`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  url = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  await rm(artifactsDir, { recursive: true, force: true });
});

it('exports an exploration as a Playwright test that passes live and with recorded responses', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  const exportTool = reportTools(session).find((tool) => tool.name === 'browser_export_test')!;
  let exported: { specPath: string; harPath: string | null; steps: number; assertions: number };
  try {
    await session.navigate(url);
    await session.type({ kind: 'label', label: 'Email' }, 'qa@example.com');
    await session.type({ kind: 'label', label: 'Password' }, 'hunter2-secret');
    const add = await session.inspect({ selector: 'button.icon-add' }, []);
    await session.click({ kind: 'ref', ref: add.ref });
    expect(await session.verify({ kind: 'text', target: { kind: 'selector', selector: '#count' }, equals: 'Cart 1' })).toMatchObject({ status: 'matched' });
    expect(await session.verify({ kind: 'text', target: { kind: 'selector', selector: '#count' }, equals: 'Cart 9' }, 1_500)).toMatchObject({ status: 'unmet' });
    expect(() => exportTool.run({ name: '../escape' })).toThrow();
    exported = await exportTool.run({ name: 'shop-flow' }) as typeof exported;
  } finally { await session.close(); }

  expect(exported).toMatchObject({ steps: 6, assertions: 1 });
  const spec = await readFile(exported.specPath, 'utf8');
  expect(spec).toContain(`await page.goto('${url}');`);
  expect(spec).toContain(`.fill('qa@example.com');`);
  expect(spec).not.toContain('hunter2-secret');
  expect(spec).toContain("process.env.TEST_SECRET_VALUE ?? ''");
  expect(spec).toContain(`page.locator('main > button').first().click();`);
  expect(spec).toContain(`await expect(page.locator('#count').first()).toHaveText('Cart 1');`);
  expect(spec).toContain("// Not met during exploration, so left out: await expect(page.locator('#count').first()).toHaveText('Cart 9');");
  expect(exported.harPath).not.toBeNull();

  // Playwright Test refuses to start inside a Jest worker, so the child gets a clean environment.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('JEST')));
  const options = { cwd: dirname(exported.specPath), env: { ...environment, PLAYWRIGHT_BROWSERS_PATH: resolve('.browsers'), CI: '1' } };
  const npx = join(resolve('node_modules/.bin'), 'playwright');
  const before = cartTotal;
  await run(npx, ['test', 'shop-flow.spec.ts', '--reporter=line', '--workers=1'], options);
  expect(cartTotal).toBe(before + 1);
  await run(npx, ['test', 'shop-flow.spec.ts', '--reporter=line', '--workers=1'], { ...options, env: { ...options.env, REPLAY: 'har' } });
  expect(cartTotal).toBe(before + 1);
}, 120_000);
