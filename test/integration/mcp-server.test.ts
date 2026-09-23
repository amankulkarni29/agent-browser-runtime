import { access, rm, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureSite, TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD } from '../fixtures/site.js';

const artifactsDir = resolve('artifacts/mcp-test');
let fixtureServer: Server | undefined;
let fixtureUrl: string;

beforeAll(async () => {
  ({ server: fixtureServer, url: fixtureUrl } = await startFixtureSite());
});

afterAll(async () => {
  if (fixtureServer) {
    await new Promise<void>((resolvePromise, reject) =>
      fixtureServer!.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
  await rm(artifactsDir, { recursive: true, force: true });
});

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    BROWSER_ARTIFACTS_DIR: artifactsDir,
    ...overrides,
  };
}

function textPayload(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  if (!Array.isArray(result.content)) throw new Error('Expected MCP content.');
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected a text MCP result.');
  }
  return JSON.parse(first.text);
}

const executeFile = promisify(execFile);
type ProcessEntry = { pid: number; parentPid: number; command: string };

async function processTable(): Promise<ProcessEntry[]> {
  const { stdout } = await executeFile('ps', ['-axo', 'pid=,ppid=,command=']);
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
  });
}

function descendants(processes: ProcessEntry[], parentPid: number): ProcessEntry[] {
  const owned = new Set([parentPid]);
  let previousSize: number;
  do {
    previousSize = owned.size;
    for (const entry of processes) if (owned.has(entry.parentPid)) owned.add(entry.pid);
  } while (owned.size > previousSize);
  return processes.filter((entry) => entry.pid !== parentPid && owned.has(entry.pid));
}

async function stdioRequest(
  child: ChildProcessWithoutNullStreams, lines: Interface, id: number, method: string, params: unknown,
): Promise<unknown> {
  const response = once(lines, 'line', { signal: AbortSignal.timeout(30_000) });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const [line] = await response;
  const message = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown() }).parse(JSON.parse(line));
  expect(message.id).toBe(id);
  return message.result;
}

describe('stdio MCP adapter', () => {
  it('publishes the exploratory browser tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/adapters/mcp-server.ts')],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: environment(),
    });
    const client = new Client({ name: 'browser-runtime-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'browser_changes',
        'browser_click',
        'browser_close',
        'browser_dismiss_overlay',
        'browser_evidence',
        'browser_explain_action',
        'browser_export_test',
        'browser_fault',
        'browser_faults_clear',
        'browser_frames',
        'browser_hover',
        'browser_inspect',
        'browser_login',
        'browser_navigate',
        'browser_press',
        'browser_report',
        'browser_request',
        'browser_request_handoff',
        'browser_requests',
        'browser_response_body',
        'browser_screenshot',
        'browser_sequence',
        'browser_snapshot',
        'browser_type',
        'browser_verify',
        'browser_viewport',
        'browser_wait_for_settled',
      ]);
    } finally {
      await client.close();
    }
  }, 15_000);

  it('drives two investigations through one MCP connection', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/adapters/mcp-server.ts')],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: environment(),
    });
    const client = new Client({ name: 'browser-runtime-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      for (let run = 0; run < 2; run++) {
        const navigation = await client.callTool({
          name: 'browser_navigate',
          arguments: { url: fixtureUrl },
        });
        expect(navigation.isError).not.toBe(true);

        const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
        expect(snapshot.isError).not.toBe(true);
        expect(JSON.stringify(snapshot.content)).toContain('Ready');

        const evidence = textPayload(
          await client.callTool({ name: 'browser_evidence', arguments: { filter: 'all' } }),
        ) as { summary: Record<string, unknown>; network: Array<Record<string, unknown>> };
        expect(evidence.summary).toHaveProperty('total_requests');
        expect(evidence.summary).not.toHaveProperty('totalRequests');
        expect(evidence.network[0]).toHaveProperty('host');
        expect(evidence.network[0]).toHaveProperty('body');

        const close = await client.callTool({ name: 'browser_close', arguments: {} });
        expect(close.isError).not.toBe(true);
        expect(textPayload(close)).toMatchObject({ tracePath: null });
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it('exposes account references and discovered controls, never credential values', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/adapters/mcp-server.ts')],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: environment(),
    });
    const client = new Client({ name: 'browser-runtime-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const login = tools.tools.find((tool) => tool.name === 'browser_login');
      expect(Object.keys(login?.inputSchema.properties ?? {}).sort()).toEqual(['brand', 'controls', 'environment', 'profile']);

      // No private login file is configured, so this call must resolve
      // to a structured outcome rather than throw or reach the network.
      const result = await client.callTool({
        name: 'browser_login',
        arguments: { profile: 'qa-account', brand: 'acme', environment: 'test' },
      });

      expect(result.isError).not.toBe(true);
      expect(textPayload(result)).toMatchObject({ status: 'unsupported_host', brand: 'acme', environment: 'test' });
    } finally {
      await client.close();
    }
  }, 15_000);

  it('signs in over stdio from a clean build using discovered refs and a private runtime configuration', async () => {
    await rm(resolve('dist'), { recursive: true, force: true });
    execFileSync('pnpm', ['build']);
    await mkdir(artifactsDir, { recursive: true });
    const file = resolve(artifactsDir, 'private-login.json');
    await writeFile(file, JSON.stringify({ profile: 'shared', credentials: { email: TEST_ACCOUNT_EMAIL, password: TEST_ACCOUNT_PASSWORD },
      brands: [{ brand: 'acme', environment: 'test', loginUrl: `${fixtureUrl}/login`, credentialOrigins: [fixtureUrl],
        successSignal: { kind: 'url', pattern: '/account' } }] }), { mode: 0o600 });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve('dist/adapters/mcp-server.js')], cwd: process.cwd(), stderr: 'pipe',
      env: environment({ BROWSER_LOGIN_CONFIG_FILE: file }) });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
    const client = new Client({ name: 'login-test', version: '1' });
    try {
      await client.connect(transport);
      await client.callTool({ name: 'browser_navigate', arguments: { url: `${fixtureUrl}/login` } });
      const refs: string[] = [];
      for (const selector of ['input[type="email"]', 'input[type="password"]', 'button']) {
        const result = await client.callTool({ name: 'browser_inspect', arguments: { selector, properties: [] } });
        expect(result.isError ? textPayload(result) : null).toBeNull();
        refs.push(z.object({ ref: z.string() }).parse(textPayload(result)).ref);
      }
      const result = await client.callTool({ name: 'browser_login', arguments: { profile: 'shared', brand: 'acme', environment: 'test',
        controls: { usernameRef: refs[0], passwordRef: refs[1], submitRef: refs[2] } } });
      expect(textPayload(result)).toMatchObject({ status: 'success' });
      expect(JSON.stringify(result)).not.toContain(TEST_ACCOUNT_PASSWORD);
      await client.callTool({ name: 'browser_close', arguments: {} });
    } catch (error) {
      const safeStderr = stderr.replaceAll(TEST_ACCOUNT_EMAIL, '[REDACTED]').replaceAll(TEST_ACCOUNT_PASSWORD, '[REDACTED]');
      throw new Error(`Compiled MCP login failed. Server stderr: ${safeStderr || '(empty)'}`, { cause: error });
    } finally { await client.close(); await rm(file, { force: true }); }
  }, 30_000);

  it('records a trace when BROWSER_TRACE is 1', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/adapters/mcp-server.ts')],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: environment({ BROWSER_TRACE: '1' }),
    });
    const client = new Client({ name: 'browser-runtime-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      await client.callTool({ name: 'browser_navigate', arguments: { url: fixtureUrl } });
      const close = textPayload(
        await client.callTool({ name: 'browser_close', arguments: {} }),
      ) as { tracePath: string | null };

      expect(close.tracePath).toMatch(/trace\.zip$/);
      await expect(access(close.tracePath!)).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  }, 30_000);

  describe('stdin EOF cleanup from the compiled server', () => {
    beforeAll(() => { execFileSync('pnpm', ['build']); });

    it.each(['headless', 'virtual-display'] as const)('closes an active %s session without a signal', async (launchMode) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-eof-test-'));
      const child = spawn(process.execPath, [resolve('dist/adapters/mcp-server.js')], {
        cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
        env: environment({ BROWSER_LAUNCH_MODE: launchMode, TMPDIR: temporaryRoot }),
      });
      const lines = createInterface({ input: child.stdout });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
      const exited = once(child, 'exit');
      try {
        await stdioRequest(child, lines, 1, 'initialize', {
          protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const navigation = await stdioRequest(child, lines, 2, 'tools/call', {
          name: 'browser_navigate', arguments: { url: fixtureUrl },
        });
        expect(navigation).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining(fixtureUrl) }] });
        expect(navigation).not.toHaveProperty('isError', true);

        const prefix = launchMode === 'virtual-display' ? 'agent-browser-display-' : 'playwright_chromiumdev_profile-';
        const profileNames = (await readdir(temporaryRoot)).filter((name) => name.startsWith(prefix));
        expect(profileNames).toHaveLength(1);
        const processes = descendants(await processTable(), child.pid!);
        expect(processes.some((entry) => entry.command.includes(join(temporaryRoot, profileNames[0]!)))).toBe(true);
        if (launchMode === 'virtual-display') {
          expect(processes.some((entry) => entry.command.includes('browser-supervisor.cjs'))).toBe(true);
          if (process.platform === 'linux') expect(processes.some((entry) => entry.command.includes('Xvfb'))).toBe(true);
        }

        // Ending stdin is the only shutdown trigger. Client.close() can send SIGTERM.
        child.stdin.end();
        expect(await once(child, 'exit', { signal: AbortSignal.timeout(15_000) })).toEqual([0, null]);
        const deadline = Date.now() + 10_000;
        while (true) {
          const [remainingNames, remainingProcesses] = await Promise.all([readdir(temporaryRoot), processTable()]);
          const profilesRemain = remainingNames.some((name) => profileNames.includes(name));
          const processesRemain = remainingProcesses.some((entry) => processes.some((owned) => owned.pid === entry.pid));
          if (!profilesRemain && !processesRemain) break;
          if (Date.now() >= deadline) throw new Error('MCP stdin EOF left browser processes or a private profile behind.');
          await delay(50);
        }
      } catch (error) {
        throw new Error(`Compiled MCP EOF cleanup failed (${launchMode}). Server stderr: ${stderr || '(empty)'}`, { cause: error });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        lines.close();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
