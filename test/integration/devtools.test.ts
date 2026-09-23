import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';

let server: Server;
let url: string;
let artifactsDir: string;
beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'devtools-test-'));
  server = createServer((req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'trace-123', 'set-cookie': 'private=secret' });
      res.end(JSON.stringify({ padding: 'x'.repeat(4000), errors: [{ message: 'GraphQL rejected input' }], password: 'do-not-capture' }));
    } else if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 300000 }); res.end('x'.repeat(300000));
    } else if (req.url === '/failed') req.socket.destroy();
    else if (req.url === '/frame') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<button>Frame action</button>'); }
    else if (req.url === '/dense-login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<style>${Array.from({ length: 80 }, (_, index) => `input { --theme-${index}: ${'x'.repeat(1000)}; }`).join('\n')}</style><form><input type="email" aria-label="Email"><input type="password"><button>Log in</button></form>`);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><style>#cta { color: rgb(255,0,0); } #cta:hover { color: rgb(0,0,255); } #cta::before { content: 'Buy'; }</style>
        <header>Site header</header><button id="cta">Inspect me</button><button>Duplicate</button><button>Duplicate</button>
        <button id="replace" onclick="document.querySelector('#cta').outerHTML='<button id=cta>Replacement</button>'">Replace</button>
        <button>Place order</button><input type="password" value="hidden-input"><iframe src="/frame"></iframe>
        <script>fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'cart',token:'private-token'})});
        fetch('/large');fetch('/failed').catch(()=>{}); console.error('Fixture console', {detail:'structured detail'});</script>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  url = `http://127.0.0.1:${address.port}`;
});

it.each(['headless', 'virtual-display'] as const)('%s returns usable compact control refs without the stylesheet payload', async (launchMode) => {
  const session = new BrowserSession({ launchMode, artifactsDir });
  try {
    await session.navigate(`${url}/dense-login`);
    const control = await session.inspect({ role: 'textbox', name: 'Email' }, []);
    expect(control.ref).toMatch(/^element-/);
    expect(control.attributes.type).toBe('email');
    expect(JSON.stringify(control).length).toBeLessThan(8000);
    expect(control.sourceRules).toEqual([]);
    expect(control.matchedRules).toEqual([]);
  } finally { await session.close(); }
}, 30000);
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(artifactsDir, { recursive: true, force: true });
});

it.each(['headless', 'virtual-display'] as const)('%s diagnoses a 200 GraphQL error beyond the excerpt, preserves IDs, and persists redacted evidence', async (launchMode) => {
  const session = new BrowserSession({ launchMode, artifactsDir });
  let manifest: string | null | undefined;
  try {
    await session.navigate(url);
    const request = session.requests({ url: '/api' }).requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error('No API capture');
    const detail = session.request(request.id);
    expect(detail.requestHeaders['content-type']).toContain('application/json');
    expect(detail.responseHeaders['x-request-id']).toBe('trace-123');
    expect(detail.responseHeaders).not.toHaveProperty('set-cookie');
    expect(detail.payload).not.toContain('private-token');
    const body = session.responseBody(request.id, 3500, 8000);
    expect(body.text).toContain('GraphQL rejected input');
    expect(body.text).not.toContain('do-not-capture');
    expect(session.requests({ url: '/large' }).requests[0]?.bodyState).toBe('too-large');
    const evidence = await session.evidence({ filter: 'all' });
    expect(evidence.network.some((r) => r.failure)).toBe(true);
    expect(evidence.console[0]?.location).toBeDefined();
    expect(evidence.cdp.some((event) => event.method === 'Runtime.consoleAPICalled')).toBe(true);
    expect(evidence.network.find((r) => r.requestId === request.id)?.sequence).toBeGreaterThan(0);
  } finally { manifest = (await session.close()).manifestPath; }
  if (!manifest) throw new Error('No manifest');
  const saved = await readFile(manifest, 'utf8');
  expect(saved).toContain('GraphQL rejected input');
  expect(saved).not.toContain('do-not-capture');
  expect(saved).not.toContain('private-token');
}, 30000);

it.each(['headless', 'virtual-display'] as const)('%s inspects hover styles, targets frames and duplicates, rejects stale refs, and links unique screenshots', async (launchMode) => {
  const session = new BrowserSession({ launchMode, artifactsDir });
  try {
    await session.navigate(url);
    await expect(session.inspect({ name: 'Duplicate' })).rejects.toThrow('matched 2');
    expect((await session.inspect({ role: 'banner' })).tag).toBe('header');
    await expect(session.inspect({ role: 'button' })).rejects.toThrow('matched 5');
    expect((await session.inspect({ role: 'button', index: 0 })).attributes.id).toBe('cta');
    const inspected = await session.inspect({ selector: '#cta' });
    expect(inspected.computed.color).toBe('rgb(255, 0, 0)');
    await session.hover({ kind: 'ref', ref: inspected.ref });
    const hovered = await session.inspect({ ref: inspected.ref });
    expect(hovered.computed.color).toBe('rgb(0, 0, 255)');
    expect(hovered.matchedRules.some((r) => r.selector === '#cta:hover')).toBe(true);
    expect(hovered.sourceRules.some((r) => r.selector === '#cta:hover' && r.line !== null)).toBe(true);
    const first = await session.screenshot('hover', { ref: inspected.ref });
    const second = await session.screenshot('hover', { fullPage: true });
    expect(first.path).not.toBe(second.path);
    await access(first.path);
    const frame = session.frames().find((f) => !f.main);
    expect((await session.inspect({ frameId: frame?.id, name: 'Frame action' })).tag).toBe('button');
    const password = await session.inspect({ selector: 'input' });
    expect(JSON.stringify(password)).not.toContain('hidden-input');
    const dangerous = await session.inspect({ name: 'Place order' });
    await session.click({ kind: 'ref', ref: dangerous.ref });
    await session.click({ kind: 'text', text: 'Replace' });
    await expect(session.inspect({ ref: inspected.ref })).rejects.toThrow('stale');
    const resized = await session.viewport(390, 844);
    expect(resized.kind).toBe('viewport');
    const evidence = await session.evidence();
    const manifest = JSON.parse(await readFile(evidence.manifestPath ?? '', 'utf8'));
    expect(manifest.artifacts.map((a: { artifactId: string }) => a.artifactId)).toContain(first.artifactId);
  } finally { await session.close(); }
}, 30000);
