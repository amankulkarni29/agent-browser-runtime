#!/usr/bin/env node
// End-to-end demo: starts the stdio MCP server exactly as an MCP client would, serves a small
// local page, and drives it through the model-facing tools.
//
//   pnpm build && node examples/demo.mjs [--public]
//
// --public also visits https://example.com and follows its outbound link to another host.
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const includePublic = process.argv.includes('--public');

const page = `<!doctype html>
<title>Agent Browser Demo</title>
<h1>Demo store</h1>
<label>Email <input id="email" type="email"></label>
<button id="subscribe" onclick="subscribe()">Subscribe</button>
<button onclick="document.getElementById('status').textContent = 'Order placed'">Place order</button>
<p id="status" role="status">Idle</p>
<style>#subscribe:hover { background: rebeccapurple; color: white; }</style>
<script>
  console.error('Demo console error: analytics key missing');
  async function subscribe() {
    const email = document.getElementById('email').value;
    const response = await fetch('/api/subscribe', { method: 'POST', body: JSON.stringify({ email }) });
    const body = await response.json();
    document.getElementById('status').textContent = body.message;
  }
  fetch('/api/broken').catch(() => {});
</script>`;

const server = createServer((request, response) => {
  if (request.url === '/api/subscribe') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: `Subscribed ${JSON.parse(body).email}` }));
    });
    return;
  }
  if (request.url === '/api/broken') {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'inventory service unavailable' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const artifactsDir = await mkdtemp(join(tmpdir(), 'agent-browser-demo-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist/adapters/mcp-server.js')],
  env: { ...process.env, BROWSER_ARTIFACTS_DIR: artifactsDir },
  stderr: 'inherit',
});
const client = new Client({ name: 'agent-browser-demo', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === 'text')?.text ?? '{}';
  const value = JSON.parse(text);
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return { value, result };
}

function step(title, detail) {
  console.log(`\n▶ ${title}`);
  if (detail !== undefined) console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
}

try {
  const { tools } = await client.listTools();
  step(`MCP server exposes ${tools.length} tools`, tools.map((tool) => tool.name).join(', '));

  const navigation = (await call('browser_navigate', { url })).value;
  step('Navigate to a localhost page (no allowlist or private-host flag needed)', { url: navigation.url, title: navigation.title, settled: navigation.settled });

  step('Accessibility snapshot', (await call('browser_snapshot')).value.aria);

  const inspected = (await call('browser_inspect', { selector: '#subscribe', properties: ['background-color', 'color'] })).value;
  step('Inspect the Subscribe button (DOM identity, geometry, computed styles)', { ref: inspected.ref, computed: inspected.computed, sourceRules: inspected.sourceRules?.map((rule) => rule.selector) });

  const sequence = (await call('browser_sequence', { steps: [
    { kind: 'type', target: { kind: 'label', label: 'Email' }, value: 'ada@example.com' },
    { kind: 'click', target: { kind: 'role', role: 'button', name: 'Subscribe' },
      expect: { kind: 'text', target: { kind: 'selector', selector: '#status' }, equals: 'Subscribed ada@example.com' } },
  ] })).value;
  step('Verified sequence: type, click, and check the result', { status: sequence.status, steps: sequence.steps?.map((item) => item.status) });

  await call('browser_click', { name: 'Place order', role: 'button' });
  step('Click "Place order" (previously blocked by the irreversible-action guard)', (await call('browser_snapshot')).value.aria.match(/status.*$/m)?.[0]);

  const evidence = (await call('browser_evidence', { filter: 'errors' })).value;
  step('Error evidence captured through CDP', {
    summary: evidence.summary,
    console: evidence.console?.map((item) => item.text),
    network: evidence.network?.map((item) => `${item.status} ${item.method} ${item.url} ${(item.body ?? '').slice(0, 80)}`),
  });

  const requests = (await call('browser_requests')).value;
  const subscribe = requests.requests?.find((item) => item.url.endsWith('/api/subscribe'));
  if (subscribe) {
    const body = (await call('browser_response_body', { requestId: subscribe.id })).value;
    step('Captured API response body by request ID', { request: `${subscribe.method} ${subscribe.url} → ${subscribe.status}`, body: body.body ?? body });
  }

  const shot = await call('browser_screenshot', { name: 'demo' });
  const image = shot.result.content.find((item) => item.type === 'image');
  step('Screenshot', { path: shot.value.path, bytesBase64: image?.data.length });

  if (includePublic) {
    const example = (await call('browser_navigate', { url: 'https://example.com' })).value;
    step('Navigate to a public site in the same session', { url: example.url, title: example.title });
    const followed = (await call('browser_click', { name: 'Learn more', role: 'link' })).value;
    step('Follow a link to a different host (no allowlist)', { url: followed.url, title: followed.title });
  }

  const closed = (await call('browser_close')).value;
  step('Close the session', { closed: closed.closed, manifestPath: closed.manifestPath });
} finally {
  await client.close();
  server.close();
}
