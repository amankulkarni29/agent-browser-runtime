import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';
import { inspectionTools } from '../../src/adapters/inspection-tools.js';
import type { CausalNode } from '../../src/core/action-causality.js';

const CART_SCRIPT = `function addToCart() {
  fetch('/api/cart', { method: 'POST' })
    .then((response) => response.json())
    .then((cart) => showCart(cart));
}
function showCart(cart) {
  if (cart.items.length === 0) console.error('Cart is empty');
  document.querySelector('#price').textContent = '$0';
}
function onBuyClick() {
  setTimeout(addToCart, 20);
}
function brokenHandler() {
  const cart = null;
  return cart.items;
}
document.querySelector('#buy').addEventListener('click', onBuyClick);
document.querySelector('#break').addEventListener('click', brokenHandler);
`;

let server: Server;
let url: string;
let artifactsDir: string;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'causality-test-'));
  server = createServer((request, response) => {
    if (request.url === '/cart.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(CART_SCRIPT);
    } else if (request.url === '/api/cart') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [] }));
    } else if (request.url === '/missing.png') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Cart fixture</title>
        <img src="/missing.png" alt="Product">
        <button id="buy">Buy</button><button id="break">Break</button><p id="price">$20</p>
        <script src="/cart.js"></script>`);
    }
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

function flatten(nodes: CausalNode[]): CausalNode[] {
  return nodes.flatMap((node) => [node, ...(node.kind === 'request' ? flatten(node.children) : [])]);
}

function findRequest(nodes: CausalNode[], path: string) {
  const found = flatten(nodes).find((node) => node.kind === 'request' && new URL(node.url).pathname === path);
  if (!found || found.kind !== 'request') throw new Error(`No request for ${path}`);
  return found;
}

it('links a click to the request its handler started through a timer and to the console error that followed', async () => {
  const session = new BrowserSession({ artifactsDir });
  try {
    await session.navigate(url);
    const click = await session.click({ kind: 'role', role: 'button', name: 'Buy' });
    const explanation = await session.explainAction(click.actionId);

    expect(explanation.action).toMatchObject({ kind: 'click', target: 'button "Buy"' });
    const cart = findRequest(explanation.chain, '/api/cart');
    expect(explanation.chain).toContain(cart);
    expect(cart).toMatchObject({ method: 'POST', status: 200, initiatorType: 'script', bodyExcerpt: '{"items":[]}' });
    expect(cart.origin[0]?.location).toMatchObject({ line: 2, functionName: 'addToCart' });
    expect(cart.origin[0]?.location.url).toMatch(/\/cart\.js$/);
    expect(cart.origin.slice(1)).toContainEqual(expect.objectContaining({
      via: 'setTimeout', location: expect.objectContaining({ functionName: 'onBuyClick' }),
    }));
    expect(cart.children).toContainEqual(expect.objectContaining({ kind: 'console', level: 'error', text: 'Cart is empty' }));

    expect(explanation.text).toContain('click button "Buy" (action 2)');
    expect(explanation.text).toMatch(/POST \/api\/cart → 200 \[request-\d+\]/);
    expect(explanation.text).toMatch(/started by cart\.js:2:\d+ \(addToCart\) ← setTimeout ← cart\.js:11:\d+ \(onBuyClick\)/);
    expect(explanation.text).toMatch(/console\.error "Cart is empty" at cart\.js:7:\d+ \(showCart\)/);
    // Page-load traffic belongs to the navigation, not the click.
    expect(flatten(explanation.chain).some((node) => node.kind === 'request' && node.url.endsWith('/missing.png'))).toBe(false);
  } finally { await session.close(); }
}, 30_000);

it('groups page-load resources under the document and names the script behind an uncaught exception', async () => {
  const session = new BrowserSession({ artifactsDir });
  try {
    const load = await session.navigate(url);
    const page = await session.explainAction(load.actionId);
    const documentRequest = findRequest(page.chain, '/');
    expect(page.chain).toContain(documentRequest);
    expect(documentRequest.children).toContainEqual(expect.objectContaining({ kind: 'request', status: 404, resourceType: 'Image' }));
    expect(documentRequest.children).toContainEqual(expect.objectContaining({ kind: 'request', resourceType: 'Script', initiatorType: 'parser' }));
    expect(page.summary).toMatchObject({ failedRequests: 1, navigations: 1 });
    expect(page.text).toMatch(/GET \/missing\.png \(image\) → 404 \[request-\d+\]/);

    await session.click({ kind: 'role', role: 'button', name: 'Break' });
    const broken = await session.explainAction();
    expect(broken.actionId).toBe(2);
    const exception = broken.chain.find((node) => node.kind === 'exception');
    expect(exception).toMatchObject({ message: expect.stringContaining('TypeError') });
    expect(exception?.kind === 'exception' && exception.origin[0]?.location).toMatchObject({ line: 15, functionName: 'brokenHandler' });
    expect(broken.text).toMatch(/at cart\.js:15:\d+ \(brokenHandler\)/);

    await expect(session.explainAction(3)).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  } finally { await session.close(); }
}, 30_000);

it('serves the shared tool definition with the structured tree only on request', async () => {
  const session = new BrowserSession({ artifactsDir });
  const tool = inspectionTools(session).find((entry) => entry.name === 'browser_explain_action');
  if (!tool) throw new Error('Missing browser_explain_action');
  try {
    await session.navigate(url);
    const text = await tool.run({}) as Record<string, unknown>;
    expect(text).not.toHaveProperty('chain');
    expect(text.text).toContain('navigate (action 1)');
    const json = await tool.run({ actionId: 1, format: 'json', filter: 'all' }) as Record<string, unknown>;
    expect(Array.isArray(json.chain)).toBe(true);
  } finally { await session.close(); }
}, 30_000);
