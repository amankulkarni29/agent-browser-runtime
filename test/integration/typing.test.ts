import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrowserRuntimeError, BrowserSession } from '../../src/index.js';

const artifactsDir = resolve(`artifacts/typing-test-${process.pid}`);
const promoName = 'Do You Have A Promo Code?';
const privateValue = 'TYPED_VALUE_MUST_NOT_APPEAR_IN_ERRORS';
const existingValue = 'EXISTING_VALUE_MUST_NOT_APPEAR_IN_ERRORS';
let fixtureServer: Server;
let fixtureUrl: string;

const fixture = `<!doctype html><html><head><title>Typing fixture</title></head><body>
  <input id="promo" placeholder="${promoName}"><output id="echo-promo"></output>
  <label for="labelled">Labelled field</label><input id="labelled"><output id="echo-labelled"></output>
  <input id="aria" aria-label="ARIA field"><output id="echo-aria"></output>
  <span id="field-name">Referenced label</span><input id="labelledby" aria-labelledby="field-name"><output id="echo-labelledby"></output>
  <div id="editable" role="textbox" aria-label="Editable notes" contenteditable="true"></div><output id="echo-editable"></output>
  <input id="hidden" aria-label="Shared name" hidden value="hidden unchanged">
  <input id="visible" aria-label="Shared name"><output id="echo-visible"></output>
  <input id="duplicate-a" aria-label="Duplicate name" value="first unchanged">
  <input id="duplicate-b" placeholder="Duplicate name" value="second unchanged">
  <input id="disabled" aria-label="Disabled field" disabled value="${existingValue}">
  <input id="readonly" aria-label="Read-only field" readonly value="${existingValue}">
  <input id="reference" aria-label="Reference field"><output id="echo-reference"></output>
  <button id="replace">Replace reference input</button>
  <script>
    document.addEventListener('input', event => {
      const echo = document.getElementById('echo-' + event.target.id);
      if (echo) echo.textContent = event.target.value ?? event.target.textContent;
    });
    document.getElementById('replace').addEventListener('click', () => {
      const input = document.getElementById('reference');
      const replacement = input.cloneNode();
      replacement.value = 'replacement unchanged';
      input.replaceWith(replacement);
    });
  </script>
</body></html>`;

beforeAll(async () => {
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(fixture);
  });
  await new Promise<void>((resolvePromise, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = fixtureServer.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP fixture address.');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
  execFileSync('pnpm', ['build'], { cwd: process.cwd(), stdio: 'pipe' });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolvePromise, reject) => fixtureServer?.close((error) => error ? reject(error) : resolvePromise()));
  await rm(artifactsDir, { recursive: true, force: true });
});

async function expectInputEvent(session: BrowserSession, id: string, value: string) {
  const echoed = await session.inspect({ selector: `#echo-${id}` }, []);
  expect(echoed.html).toContain(`>${value}</output>`);
}

async function typingError(session: BrowserSession, name: string): Promise<BrowserRuntimeError> {
  try {
    await session.type({ kind: 'label', label: name }, privateValue);
  } catch (error) {
    if (!(error instanceof BrowserRuntimeError)) throw error;
    const serialized = `${error.message} ${JSON.stringify(error.metadata)}`;
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(existingValue);
    return error;
  }
  throw new Error('Expected typing to reject the field without changing it.');
}

function textPayload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content;
  if (!Array.isArray(content) || content[0]?.type !== 'text' || typeof content[0].text !== 'string') {
    throw new Error('Expected a text MCP response.');
  }
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe.each(['headless', 'virtual-display'] as const)('%s typing controls', (launchMode) => {
  let session: BrowserSession;

  beforeAll(() => {
    session = new BrowserSession({ launchMode, artifactsDir,
      actionTimeoutMs: 300, settleQuietMs: 50, settleTimeoutMs: 500 });
  });
  beforeEach(async () => { await session.navigate(fixtureUrl); }, 15_000);
  afterAll(async () => { await session.close(); }, 20_000);

  it('fills a placeholder-only field using the name shown in the snapshot', async () => {
    expect((await session.snapshot()).aria).toContain(`textbox "${promoName}"`);
    await session.type({ kind: 'label', label: promoName }, 'TEST');
    await expectInputEvent(session, 'promo', 'TEST');
  });

  it.each([
    ['Labelled field', 'labelled'],
    ['ARIA field', 'aria'],
    ['Referenced label', 'labelledby'],
    ['Editable notes', 'editable'],
  ])('fills the uniquely named control %s', async (name, id) => {
    await session.type({ kind: 'label', label: name }, 'Named value');
    await expectInputEvent(session, id, 'Named value');
  });

  it('keeps explicit role and selector targets usable', async () => {
    await session.type({ kind: 'role', role: 'textbox', name: promoName }, 'Role value');
    await expectInputEvent(session, 'promo', 'Role value');
    await session.type({ kind: 'selector', selector: '#labelled' }, 'Selector value');
    await expectInputEvent(session, 'labelled', 'Selector value');
  });

  it('ignores a hidden duplicate and fills the visible field', async () => {
    await session.type({ kind: 'label', label: 'Shared name' }, 'Visible value');
    await expectInputEvent(session, 'visible', 'Visible value');
    const hidden = await session.inspect({ selector: '#hidden' }, []);
    expect(hidden.attributes.hidden).toBeDefined();
  });

  it('rejects multiple visible matches before changing either field', async () => {
    const error = await typingError(session, 'Duplicate name');
    expect(error.message).toMatch(/multiple|ambig|more than one/i);
    expect(error.message).toMatch(/inspect|ref/i);
    const snapshot = await session.snapshot();
    expect(snapshot.aria).toContain('first unchanged');
    expect(snapshot.aria).toContain('second unchanged');
    expect(snapshot.aria).not.toContain(privateValue);
  });

  it.each([
    ['Disabled field', /disabled/i],
    ['Read-only field', /read.?only|not editable/i],
  ])('explains why %s cannot be filled without exposing values', async (name, reason) => {
    const error = await typingError(session, name);
    expect(error.message).toMatch(reason);
    expect(['ACTION_FAILED', 'ACTION_BLOCKED']).toContain(error.code);
  });

  it('returns an actionable safe reason when the field is missing', async () => {
    const error = await typingError(session, 'Missing field');
    expect(error.message).toMatch(/not found|no.*(?:field|input|element|control)|could not find/i);
    expect(error.message).toMatch(/inspect|snapshot/i);
  });

  it('persists the failed typing reason through close without recording field values', async () => {
    const since = session.checkpoint();
    const error = await typingError(session, 'Disabled field');
    const closed = await session.close();
    expect(closed.closed).toBe(true);
    if (!closed.manifestPath) throw new Error('Expected a saved evidence manifest.');
    const manifest = JSON.parse(await readFile(closed.manifestPath, 'utf8')) as {
      events: Array<{ sequence: number; method: string; params: Record<string, unknown> }>;
    };
    const failures = manifest.events.filter((event) => event.sequence > since && event.method === 'Browser.actionFailed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.params).toMatchObject({ kind: 'type', reason: error.metadata.reason, message: expect.stringMatching(/disabled/i) });
    const serialized = JSON.stringify(failures);
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain(existingValue);
  });

  it('fills a ref but refuses to follow it to a replacement DOM node', async () => {
    const { ref } = await session.inspect({ selector: '#reference' }, []);
    await session.type({ kind: 'ref', ref }, 'Original value');
    await expectInputEvent(session, 'reference', 'Original value');
    await session.click({ kind: 'role', role: 'button', name: 'Replace reference input' });
    await expect(session.type({ kind: 'ref', ref }, 'Wrong node')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await session.snapshot()).aria).toContain('replacement unchanged');
  });

  describe('compiled stdio MCP', () => {
    let client: Client;
    let stderr: string;

    beforeEach(async () => {
      stderr = '';
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/adapters/mcp-server.js')],
        cwd: process.cwd(), stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), BROWSER_ARTIFACTS_DIR: artifactsDir, BROWSER_LAUNCH_MODE: launchMode,
        },
      });
      transport.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
      client = new Client({ name: 'typing-test', version: '1.0.0' });
      await client.connect(transport);
      const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: fixtureUrl } });
      if (navigation.isError) throw new Error(`MCP fixture navigation failed: ${stderr}`);
    }, 15_000);
    afterEach(async () => { await client?.close(); }, 20_000);

    it('fills the snapshot name and an inspected ref through the public tool', async () => {
      const snapshot = textPayload(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
      expect(snapshot.aria).toContain(`textbox "${promoName}"`);
      const result = await client.callTool({ name: 'browser_type', arguments: { name: promoName, text: 'MCP value' } });
      expect(result.isError).not.toBe(true);
      const echo = textPayload(await client.callTool({ name: 'browser_inspect', arguments: { selector: '#echo-promo', properties: [] } }));
      expect(echo.html).toContain('>MCP value</output>');
      const inspected = textPayload(await client.callTool({ name: 'browser_inspect', arguments: { selector: '#reference', properties: [] } }));
      const byRef = await client.callTool({ name: 'browser_type', arguments: { name: inspected.ref, text: 'Ref value' } });
      expect(byRef.isError).not.toBe(true);
      const refEcho = textPayload(await client.callTool({ name: 'browser_inspect', arguments: { selector: '#echo-reference', properties: [] } }));
      expect(refEcho.html).toContain('>Ref value</output>');
    }, 20_000);

    it('preserves actionable failure reasons without exposing the supplied value', async () => {
      for (const [name, reason] of [
        ['Disabled field', /disabled/i],
        ['Read-only field', /read.?only|not editable/i],
        ['Missing field', /not found|no.*(?:field|input|element|control)|could not find/i],
        ['Duplicate name', /multiple|ambig|more than one/i],
      ] as const) {
        const result = await client.callTool({ name: 'browser_type', arguments: { name, text: privateValue } });
        expect(result.isError).toBe(true);
        expect(textPayload(result).error).toMatch(reason);
        expect(JSON.stringify(result)).not.toContain(privateValue);
        expect(JSON.stringify(result)).not.toContain(existingValue);
      }
      expect(stderr).not.toContain(privateValue);
      expect(stderr).not.toContain(existingValue);
    }, 40_000);
  });
});
