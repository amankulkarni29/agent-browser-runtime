import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';
import * as verification from '../../src/core/login-verification.js';

let server: Server;
let url: string;
let artifactsDir: string;
jest.mock('../../src/core/login-verification.js', () => {
  const actual = jest.requireActual<typeof import('../../src/core/login-verification.js')>('../../src/core/login-verification.js');
  return { ...actual, waitForLoginSubmit: jest.fn(actual.waitForLoginSubmit) };
});
const realWait = jest.requireActual<typeof import('../../src/core/login-verification.js')>('../../src/core/login-verification.js').waitForLoginSubmit;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'runtime-login-verification-session-'));
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/account' ? '<h1>Account Info</h1>' : `<!doctype html>
      <form id="login" onsubmit="event.preventDefault();location.href='/account'">
        <label>Email<input name="email"></label><label>Password<input type="password"></label>
        <button disabled>Sign in</button>
      </form><div id="widget"></div>
      <script>addEventListener('message',event=>{if(event.data==='verified')document.querySelector('button').disabled=false})</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not start');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(artifactsDir, { recursive: true, force: true });
});

it.each(['configured', 'discovered'])('waits for real verification readiness in the %s login path', async mode => {
  // Intercept the external provider at the helper boundary after BrowserSession installs its
  // navigation route. The helper itself still drives a real closed-shadow iframe and pointer.
  const wait = jest.mocked(verification.waitForLoginSubmit).mockImplementation(async (page, submit, options) => {
    await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({ contentType: 'text/html', body: `
      <div id="host"></div><script>const root=document.querySelector('#host').attachShadow({mode:'closed'});
        root.innerHTML='<label><input type="checkbox">Verify you are human</label>';
        root.addEventListener('click',event=>{if(event.target instanceof HTMLInputElement)parent.postMessage('verified','*')});</script>` }));
    await page.evaluate(() => {
      document.querySelector('#widget')!.attachShadow({ mode: 'closed' }).innerHTML = '<iframe src="https://challenges.cloudflare.com/turnstile/widget" style="width:320px;height:120px"></iframe>';
    });
    return realWait(page, submit, options);
  });
  const session = new BrowserSession({ artifactsDir, actionTimeoutMs: 1000,
    settleQuietMs: 10, settleTimeoutMs: 100,
    accountCredentialProvider: () => ({ email: 'fixture@example.test', password: 'fixture-password' }),
    loginBrandConfigs: [{ brand: 'fixture', environment: 'test', loginUrl: url, credentialOrigins: [url],
      usernameField: { kind: 'label', label: 'Email' }, passwordField: { kind: 'label', label: 'Password' },
      submitField: { kind: 'role', role: 'button', name: 'Sign in' },
      successSignal: { kind: 'url', pattern: '/account$' }, loginTimeoutMs: 2000 }],
  });
  try {
    let controls;
    if (mode === 'discovered') {
      await session.navigate(url);
      const username = await session.inspect({ selector: 'input[name="email"]' }, []);
      const password = await session.inspect({ selector: 'input[type="password"]' }, []);
      const submit = await session.inspect({ role: 'button', name: 'Sign in' }, []);
      controls = { usernameRef: username.ref, passwordRef: password.ref, submitRef: submit.ref };
    }
    const result = await session.login({ profile: 'fixture', brand: 'fixture', environment: 'test', ...(controls ? { controls } : {}) });
    expect(result.status).toBe('success');
    expect(wait).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(await readFile(session.getEvidence().manifestPath!, 'utf8'));
    expect(manifest.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'Browser.loginVerification', params: { method: 'visible-checkbox', clicks: 1 } }),
    ]));
  } finally { await session.close(); wait.mockReset().mockImplementation(realWait); }
}, 15_000);
