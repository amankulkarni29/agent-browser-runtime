import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const typedValue = 'synthetic-private-access-code';
const unmetValue = 'synthetic-private-expected-value';
const invalidSequenceValue = 'synthetic-value-that-must-not-be-entered';
const passwordValue = 'synthetic-owner-password';
type ToolCall = { name: string; arguments: Record<string, unknown> };
type ToolResult = Awaited<ReturnType<Client['callTool']>>;
let fixtureServer: Server;
let fixtureUrl: string;
let artifactsDir: string;
let laterActions: number;

beforeAll(async () => {
  execFileSync('pnpm', ['build']);
  artifactsDir = await mkdtemp(join(tmpdir(), 'verified-actions-adapters-'));
  fixtureServer = createServer((request, response) => {
    if (request.url === '/later') {
      laterActions++;
      response.end('Later action ran');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Verified actions fixture</title>
      <label>Access code<input></label>
      <label>Owner password<input type="password" value="${passwordValue}"></label>
      <button onclick="document.querySelector('#result').textContent='Saved'">Apply</button>
      <button onclick="fetch('/later')">Continue</button>
      <p id="result">Waiting</p>`);
  });
  await new Promise<void>((resolvePromise) => fixtureServer.listen(0, '127.0.0.1', resolvePromise));
  const address = fixtureServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (fixtureServer) {
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolvePromise, reject) =>
      fixtureServer.close((error) => error ? reject(error) : resolvePromise()),
    );
  }
  if (artifactsDir) await rm(artifactsDir, { recursive: true, force: true });
});

function scenario(): ToolCall[] {
  const field = { kind: 'label', label: 'Access code' };
  return [
    { name: 'browser_navigate', arguments: { url: fixtureUrl } },
    { name: 'browser_sequence', arguments: { timeoutMs: 5_000, steps: [
      { kind: 'type', target: field, value: typedValue, expect: { kind: 'value', target: field, equals: typedValue } },
      { kind: 'click', target: { kind: 'role', role: 'button', name: 'Apply' },
        expect: { kind: 'text', target: { kind: 'selector', selector: '#result' }, equals: 'Saved' } },
    ] } },
    { name: 'browser_verify', arguments: {
      condition: { kind: 'text', target: { kind: 'selector', selector: '#result' }, equals: 'Saved' }, timeoutMs: 100,
    } },
    { name: 'browser_sequence', arguments: { timeoutMs: 500, steps: [
      { kind: 'verify', condition: { kind: 'url', equals: `${fixtureUrl}/${unmetValue}` } },
      { kind: 'click', target: { kind: 'role', role: 'button', name: 'Continue' } },
    ] } },
    { name: 'browser_navigate', arguments: { url: fixtureUrl } },
    { name: 'browser_sequence', arguments: { steps: [
      { kind: 'type', target: field, value: invalidSequenceValue },
      { kind: 'click', target: { kind: 'selector', selector: '' } },
    ] } },
    { name: 'browser_verify', arguments: { condition: { kind: 'value', target: field, equals: '' }, timeoutMs: 100 } },
    { name: 'browser_verify', arguments: {
      condition: { kind: 'value', target: { kind: 'label', label: 'Owner password' }, equals: passwordValue }, timeoutMs: 100,
    } },
  ];
}

function payload(result: ToolResult | undefined): unknown {
  const content = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) }).parse(result);
  return JSON.parse(content.content[0]!.text);
}

async function runCompiledStdio(calls: ToolCall[]): Promise<{ tools: string[]; results: ToolResult[] }> {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/adapters/mcp-server.js')], cwd: process.cwd(), stderr: 'pipe',
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), BROWSER_ARTIFACTS_DIR: artifactsDir, BROWSER_LAUNCH_MODE: 'headless' },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
  const client = new Client({ name: 'verified-actions-stdio-test', version: '1' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const results = [];
    for (const call of calls) results.push(await client.callTool(call));
    return { tools: tools.tools.map((tool) => tool.name), results };
  } catch (error) {
    throw new Error(`Compiled verified-action scenario failed. Server stderr: ${stderr || '(empty)'}`, { cause: error });
  } finally {
    await client.close();
  }
}

async function runInProcessSdk(calls: ToolCall[]): Promise<{ tools: string[]; results: ToolResult[] }> {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/verified-actions-sdk.ts')], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = once(child, 'exit');
  try {
    child.stdin.end(JSON.stringify({ artifactsDir, calls }));
    const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(20_000) });
    if (code !== 0 || signal !== null) throw new Error(`SDK scenario failed (${code ?? signal}): ${stderr}`);
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

describe.each([
  ['compiled stdio', runCompiledStdio],
  ['in-process Agent SDK', runInProcessSdk],
] as const)('%s verified actions', (_name, run) => {
  it('verifies actions, stops on an unmet condition, validates every step first, and omits private inputs from diagnostics', async () => {
    laterActions = 0;
    const { tools, results } = await run(scenario());
    expect(tools).toEqual(expect.arrayContaining(['browser_verify', 'browser_sequence']));
    expect(results[0]?.isError).not.toBe(true);
    expect(results[1]?.isError).not.toBe(true);
    expect(payload(results[1])).toMatchObject({ status: 'completed', evidenceSince: expect.any(Number), steps: [
      { index: 0, kind: 'type', status: 'verified', verification: { status: 'matched' } },
      { index: 1, kind: 'click', status: 'verified', verification: { status: 'matched' } },
    ] });
    expect(payload(results[2])).toMatchObject({ status: 'matched', kind: 'text' });
    expect(payload(results[3])).toMatchObject({ status: 'stopped', steps: [
      { index: 0, kind: 'verify', status: 'failed', verification: { status: 'unmet', diagnostic: { reason: 'condition_unmet' } } },
    ] });
    expect(laterActions).toBe(0);
    expect(results[4]?.isError).not.toBe(true);
    expect(results[5]?.isError).toBe(true);
    expect(payload(results[6])).toMatchObject({ status: 'matched', kind: 'value' });
    expect(payload(results[7])).toMatchObject({ status: 'error', kind: 'value', diagnostic: { reason: 'sensitive_value' } });
    const diagnostics = JSON.stringify([results[1], results[2], results[3], results[5], results[6], results[7]]);
    for (const privateValue of [typedValue, unmetValue, invalidSequenceValue, passwordValue]) expect(diagnostics).not.toContain(privateValue);
  }, 30_000);
});
