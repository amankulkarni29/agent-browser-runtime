import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';

let server: Server;
let url: string;
let artifactsDir: string;
const credentials = { email: 'diagnostic-account@example.test', password: 'never-print-this-login-password' };

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'runtime-login-diagnostics-'));
  server = createServer((request, response) => {
    if (request.url === '/navigation') { request.socket.destroy(); return; }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><form onsubmit="event.preventDefault()">
      <label>Email <input name="email" ${request.url === '/username' ? 'readonly' : ''}></label>
      <label>Password <input type="password" ${request.url === '/password' ? 'readonly' : ''}></label>
      <button ${request.url === '/submit' ? 'disabled' : ''}>Sign in</button>
      </form>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not start.');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(artifactsDir, { recursive: true, force: true });
});

describe.each(['headless', 'virtual-display'] as const)('%s login failure diagnostics', (launchMode) => {
  it.each([
    ['navigation', 'navigation'],
    ['username', 'username'],
    ['password', 'password'],
    ['submit', 'submit'],
    ['success', 'success_signal'],
  ])('retains the %s failure phase without credentials and still closes the session', async (route, phase) => {
    const runDirectory = await mkdtemp(join(artifactsDir, `${route}-`));
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = new BrowserSession({
      launchMode, artifactsDir: runDirectory,
      actionTimeoutMs: 300, navigationTimeoutMs: 500, settleQuietMs: 10, settleTimeoutMs: 100,
      accountCredentialProvider: () => credentials,
      loginBrandConfigs: [{
        brand: 'fixture', environment: 'test', loginUrl: `${url}/${route}`,
        usernameField: { kind: 'label', label: 'Email' },
        passwordField: { kind: 'label', label: 'Password' },
        submitField: { kind: 'role', role: 'button', name: 'Sign in' },
        successSignal: { kind: 'url', pattern: '/account$' }, loginTimeoutMs: 100,
      }],
    });
    try {
      const outcome = await session.login({ profile: 'fixture', brand: 'fixture', environment: 'test' });
      expect(outcome).toMatchObject({ status: 'timeout', diagnostic: { phase, reason: expect.any(String), message: expect.any(String) } });
      if (route === 'submit') expect(outcome).toMatchObject({ diagnostic: { reason: 'target_disabled' } });
      if (route === 'success') expect(outcome).toMatchObject({ diagnostic: { reason: 'success_signal_missing' } });
      await expect(session.snapshot()).rejects.toThrow('No browser page is active');
      const runs = await readdir(runDirectory);
      expect(runs).toHaveLength(1);
      const manifestText = await readFile(join(runDirectory, runs[0]!, 'evidence.json'), 'utf8');
      const manifest = JSON.parse(manifestText);
      expect(manifest.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'Browser.login', params: expect.objectContaining({ status: 'timeout', diagnostic: expect.objectContaining({ phase }) }) }),
      ]));
      for (const text of [JSON.stringify(outcome), manifestText, JSON.stringify(stderr.mock.calls)]) {
        expect(text).not.toContain(credentials.email);
        expect(text).not.toContain(credentials.password);
      }
    } finally {
      await session.close();
      stderr.mockRestore();
    }
  }, 20_000);
});
