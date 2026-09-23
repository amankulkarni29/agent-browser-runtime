import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, type AccountCredentials } from '../../src/index.js';

describe.each(['headless', 'virtual-display'] as const)('%s session cleanup', (launchMode) => {
  let server: Server;
  let url: string;
  let directory: string;
  let logoutCount: number;
  let unrelatedCloseCount: number;
  let session: BrowserSession;
  let credentialGate: Promise<AccountCredentials> | undefined;
  let providerStarted: (() => void) | undefined;
  let accountOverlay: 'escape' | 'close' | 'blocked' | undefined;

  beforeEach(async () => {
    logoutCount = 0;
    unrelatedCloseCount = 0;
    credentialGate = undefined;
    providerStarted = undefined;
    accountOverlay = undefined;
    directory = await mkdtemp(join(tmpdir(), 'runtime-cleanup-test-'));
    server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/untrusted-redirect') {
        response.end(`<script>location.href=${JSON.stringify(url.replace('127.0.0.1', 'localhost'))}</script>`);
      } else if (request.url === '/unrelated-close') {
        unrelatedCloseCount++;
        response.end('Unexpected unrelated action');
      } else if (request.url === '/logout') {
        logoutCount++;
        response.writeHead(302, { location: '/', 'set-cookie': 'session=; Max-Age=0; Path=/' });
        response.end();
      } else if (request.url === '/login' && request.method === 'POST') {
        request.resume();
        response.writeHead(302, { location: '/account', 'set-cookie': 'session=fixture; Path=/' });
        response.end();
      } else if (request.url === '/account') {
        const overlay = accountOverlay ? `<div role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:99;background:white">
          <p>Promotion</p>${accountOverlay === 'close' ? '<button aria-label="Close" onclick="this.parentElement.remove()">×</button>' : ''}
          </div>${accountOverlay === 'escape' ? '<script>addEventListener("keydown",event=>{if(event.key==="Escape")document.querySelector("[role=dialog]").remove()})</script>' : ''}
          ${accountOverlay === 'blocked' ? '<button style="position:fixed;right:0;top:0;z-index:100" onclick="fetch(\'/unrelated-close\')">Close</button>' : ''}` : '';
        response.end(`<h1>Account</h1><div id="logoutPage" onclick="location.href='/logout'">Logout</div>${overlay}<script>localStorage.setItem("private", "fixture");sessionStorage.setItem("private", "fixture");</script>`);
      } else if (request.url === '/login') {
        response.end('<form method="post"><label>Email<input name="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>');
      } else {
        response.end(`<h1>Anonymous</h1><p>cookie:${request.headers.cookie ?? 'none'}</p><p id="storage"></p><script>document.querySelector('#storage').textContent='storage:'+localStorage.getItem('private')+':'+sessionStorage.getItem('private');</script>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
    url = `http://127.0.0.1:${address.port}`;
    session = new BrowserSession({ launchMode, artifactsDir: directory,
      settleQuietMs: 50, settleTimeoutMs: 500,
      loginBrandConfigs: [{ brand: 'fixture', environment: 'test', loginUrl: `${url}/login`,
        usernameField: { kind: 'label', label: 'Email' }, passwordField: { kind: 'label', label: 'Password' },
        submitField: { kind: 'role', role: 'button', name: 'Sign in' },
        successSignal: { kind: 'url', pattern: '/account$' } }],
      accountCredentialProvider: () => {
        providerStarted?.();
        return credentialGate ?? { email: 'fixture@example.invalid', password: 'synthetic-fixture' };
      },
    });
  });

  afterEach(async () => {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  async function login(): Promise<void> {
    expect((await session.login({ profile: 'fixture', brand: 'fixture', environment: 'test' })).status).toBe('success');
  }

  it('logs out after returning to the account page and starts the next run with no cookies or storage', async () => {
    await login();
    await session.navigate(url);
    const [first, second] = await Promise.all([session.close(), session.close()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ closed: true, cleanup: { logout: 'attempted', warnings: [] } });
    expect(logoutCount).toBe(1);
    const manifest = JSON.parse(await readFile(first.manifestPath!, 'utf8'));
    expect(manifest.authentication.status).toBe('success');
    expect(manifest.cleanup.logout).toBe('attempted');
    await session.navigate(url);
    const snapshot = await session.snapshot();
    expect(snapshot.aria).toContain('cookie:none');
    expect(snapshot.aria).toContain('storage:null:null');
    expect(snapshot.runId).not.toBe(first.runId);
  }, 30_000);

  it('still logs out and closes when evidence can no longer be written', async () => {
    await login();
    const { manifestPath } = session.getEvidence();
    if (!manifestPath) throw new Error('Expected saved evidence.');
    await rm(manifestPath);
    // A directory at the manifest path causes rename to fail without mocking cleanup.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(manifestPath);
    await writeFile(join(manifestPath, 'keep'), 'fixture');
    const result = await session.close();
    expect(result.closed).toBe(true);
    expect(result.cleanup?.warnings).toContain('evidence-save');
    expect(logoutCount).toBe(1);
    await session.navigate(url);
    expect((await session.snapshot()).aria).toContain('cookie:none');
  }, 30_000);

  it.each(['escape', 'close'] as const)('dismisses a visible promotion with %s before normal logout', async (dismissal) => {
    accountOverlay = dismissal;
    await login();
    const result = await session.close();

    expect(result).toMatchObject({ closed: true, cleanup: { logout: 'attempted', warnings: [] } });
    expect(logoutCount).toBe(1);
    await session.navigate(url);
    const snapshot = await session.snapshot();
    expect(snapshot.aria).toContain('cookie:none');
    expect(snapshot.aria).toContain('storage:null:null');
  }, 30_000);

  it('still removes the session when an undismissible overlay blocks logout without clicking an unrelated Close button', async () => {
    accountOverlay = 'blocked';
    await login();
    const result = await session.close();

    expect(result).toMatchObject({ closed: true, cleanup: { logout: 'failed', warnings: ['logout'] } });
    expect(logoutCount).toBe(0);
    expect(unrelatedCloseCount).toBe(0);
    await session.navigate(url);
    const snapshot = await session.snapshot();
    expect(snapshot.aria).toContain('cookie:none');
    expect(snapshot.aria).toContain('storage:null:null');
  }, 30_000);

  it('closes anonymous sessions without trying to log out', async () => {
    await session.navigate(url);
    expect(await session.close()).toMatchObject({ closed: true, cleanup: { logout: 'not-needed', warnings: [] } });
    expect(logoutCount).toBe(0);
  }, 30_000);

  it('does not revive a closed session when a credential provider finishes late', async () => {
    let release: (credentials: AccountCredentials) => void = () => { throw new Error('Provider not initialized.'); };
    credentialGate = new Promise((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const pending = session.login({ profile: 'fixture', brand: 'fixture', environment: 'test' });
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await started;
    await session.close();
    release({ email: 'fixture@example.invalid', password: 'synthetic-fixture' });
    await cancelled;
    await session.navigate(url);
    expect((await session.snapshot()).aria).toContain('cookie:none');
    expect(logoutCount).toBe(0);
  }, 30_000);
});
