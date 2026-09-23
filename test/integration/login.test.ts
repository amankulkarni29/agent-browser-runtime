import type { BrowserSessionOptions } from '../../src/index.js';
import { rm, readdir, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import {
  BrowserSession,
  LOGIN_INTERFACE_VERSION,
  type AccountCredentialProvider,
  type LoginBrandConfig,
} from '../../src/index.js';
import { startFixtureSite, TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD } from '../fixtures/site.js';

const artifactsDir = resolve('artifacts/test-login');
let server: Server | undefined;
let url: string;
let localhostUrl: string;
let requestCount: () => number;

beforeAll(async () => {
  ({ server, url, requestCount } = await startFixtureSite());
  localhostUrl = `http://localhost:${new URL(url).port}`;
});

afterAll(async () => {
  const activeServer = server;
  if (activeServer) {
    await new Promise<void>((resolvePromise, reject) =>
      activeServer.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
  await rm(artifactsDir, { recursive: true, force: true });
});

const usernameField = { kind: 'label', label: 'Email' } as const;
const passwordField = { kind: 'label', label: 'Password' } as const;
const submitField = { kind: 'role', role: 'button', name: 'Sign in' } as const;
const invalidCredentialsSignal = { target: { kind: 'text', text: 'Invalid email or password' } } as const;

function normalBrandConfig(): LoginBrandConfig {
  return {
    brand: 'acme',
    environment: 'test',
    loginUrl: `${url}/login`,
    usernameField,
    passwordField,
    submitField,
    successSignal: { kind: 'url', pattern: '/account' },
    invalidCredentialsSignal,
  };
}

function ssoBrandConfig(): LoginBrandConfig {
  return {
    brand: 'acme',
    environment: 'sso-test',
    loginUrl: `${url}/login-sso`,
    usernameField,
    passwordField,
    submitField,
    successSignal: { kind: 'url', pattern: '/account' },
  };
}

function crossHostBrandConfig(): LoginBrandConfig {
  return {
    brand: 'globex',
    environment: 'test',
    loginUrl: `${localhostUrl}/login`,
    usernameField,
    passwordField,
    submitField,
    successSignal: { kind: 'url', pattern: '/account' },
  };
}

function mfaBrandConfig(): LoginBrandConfig {
  return {
    brand: 'initech',
    environment: 'test',
    loginUrl: `${url}/login-mfa`,
    usernameField,
    passwordField,
    submitField,
    successSignal: { kind: 'url', pattern: '/account' },
    challengeSignals: [{ target: { kind: 'text', text: 'Enter your verification code' }, challengeType: 'mfa' }],
  };
}

const validProvider: AccountCredentialProvider = ({ profile }) =>
  profile === 'qa-account' ? { email: TEST_ACCOUNT_EMAIL, password: TEST_ACCOUNT_PASSWORD } : undefined;

const invalidProvider: AccountCredentialProvider = ({ profile }) =>
  profile === 'qa-account' ? { email: TEST_ACCOUNT_EMAIL, password: 'wrong-password' } : undefined;

describe.each(['headless', 'virtual-display'] as const)('%s runtime-owned credential entry and login', (launchMode) => {
  const createSession = (options: BrowserSessionOptions) => new BrowserSession({ ...options, launchMode });
  it.each(['', '/', '/login'])('uses the approved discovered page when configured loginUrl differs (origin suffix %s)', async (suffix) => {
    const session = createSession({ artifactsDir,
      loginBrandConfigs: [{ brand: 'acme', environment: 'test', loginUrl: 'https://unused.example/login',
        credentialOrigins: [`${url}${suffix}`], successSignal: { kind: 'url', pattern: '/account' } }],
      accountCredentialProvider: validProvider });
    try {
      await session.navigate(`${url}/login`);
      const username = await session.inspect({ role: 'textbox', name: 'Email' }, []);
      const password = await session.inspect({ selector: 'input[type="password"]' }, []);
      const submit = await session.inspect({ role: 'button', name: 'Sign in' }, []);
      const outcome = await session.login({ profile: 'qa-account', brand: 'acme', environment: 'test',
        controls: { usernameRef: username.ref, passwordRef: password.ref, submitRef: submit.ref } });
      expect(outcome.status).toBe('success');
    } finally { await session.close(); }
  }, 30_000);
  it('preserves login proof after the event journal rolls over and the session closes', async () => {
    const session = createSession({ artifactsDir, maxEvidenceEvents: 1,
      loginBrandConfigs: [normalBrandConfig()], accountCredentialProvider: validProvider });
    try {
      expect((await session.login({ profile: 'qa-account', brand: 'acme', environment: 'test' })).status).toBe('success');
      await session.snapshot();
      await session.snapshot();
      expect(session.getEvidence().outcomes?.some((event) => event.method === 'Browser.login')).toBe(true);
      // Ordinary snapshots no longer evict a protected login event. A newer outcome
      // fills this one-event journal; durable authentication proof must still survive.
      expect((await session.verify({ kind: 'url', equals: `${url}/account` })).status).toBe('matched');
      const closed = await session.close();
      const manifest = JSON.parse(await readFile(closed.manifestPath!, 'utf8'));
      expect(manifest.events.some((event: { method: string }) => event.method === 'Browser.login')).toBe(false);
      expect(manifest.authentication).toMatchObject({ status: 'success', profile: 'qa-account', brand: 'acme', environment: 'test' });
    } finally { await session.close(); }
  }, 30_000);
  it('uses discovered DOM controls without configured field selectors', async () => {
    const session = createSession({ artifactsDir,
      loginBrandConfigs: [{ brand: 'acme', environment: 'test', loginUrl: `${url}/login`, credentialOrigins: [url], successSignal: { kind: 'url', pattern: '/account' } }],
      accountCredentialProvider: validProvider });
    try {
      await session.navigate(`${url}/login`);
      const username = await session.inspect({ role: 'textbox', name: 'Email' });
      const password = await session.inspect({ selector: 'input[type="password"]' });
      const submit = await session.inspect({ role: 'button', name: 'Sign in' });
      const outcome = await session.login({ profile: 'qa-account', brand: 'acme', environment: 'test',
        controls: { usernameRef: username.ref, passwordRef: password.ref, submitRef: submit.ref } });
      expect(outcome.status).toBe('success');
      expect((await session.snapshot()).aria).not.toContain(TEST_ACCOUNT_EMAIL);
    } finally { await session.close(); }
  }, 30_000);

  it('refuses discovered controls on an unapproved credential origin before resolving credentials', async () => {
    const provider = jest.fn(validProvider);
    const session = createSession({ artifactsDir,
      loginBrandConfigs: [{ ...normalBrandConfig(), credentialOrigins: ['https://approved.example'] }], accountCredentialProvider: provider });
    try {
      await session.navigate(`${url}/login`);
      const username = await session.inspect({ role: 'textbox', name: 'Email' });
      const password = await session.inspect({ selector: 'input[type="password"]' });
      const submit = await session.inspect({ role: 'button', name: 'Sign in' });
      await expect(session.login({ profile: 'qa-account', brand: 'acme', environment: 'test',
        controls: { usernameRef: username.ref, passwordRef: password.ref, submitRef: submit.ref } })).rejects.toThrow('approved credential origins');
      expect(provider).not.toHaveBeenCalled();
    } finally { await session.close(); }
  }, 30_000);

  it('rejects stale login refs before resolving credentials', async () => {
    const provider = jest.fn(validProvider);
    const session = createSession({ artifactsDir,
      loginBrandConfigs: [normalBrandConfig()], accountCredentialProvider: provider });
    try {
      await session.navigate(`${url}/login`);
      const username = await session.inspect({ role: 'textbox', name: 'Email' });
      await session.navigate(`${url}/login`);
      await expect(session.login({ profile: 'qa-account', brand: 'acme', environment: 'test',
        controls: { usernameRef: username.ref, passwordRef: username.ref, submitRef: username.ref } })).rejects.toThrow();
      expect(provider).not.toHaveBeenCalled();
    } finally { await session.close(); }
  }, 30_000);
  it('signs in with a trusted profile and confirms an authenticated-session signal', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    try {
      const outcome = await session.login({ profile: 'qa-account', brand: 'acme', environment: 'test' });

      expect(outcome).toMatchObject({ version: LOGIN_INTERFACE_VERSION, status: 'success', brand: 'acme', environment: 'test' });
      expect(outcome.status === 'success' && outcome.url).toMatch(/\/account$/);
      expect((await session.snapshot()).aria).toContain('Signed in');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('returns invalid_credentials and clears session state instead of retrying', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: invalidProvider,
    });
    try {
      const outcome = await session.login({ profile: 'qa-account', brand: 'acme', environment: 'test' });

      expect(outcome).toMatchObject({ status: 'invalid_credentials', brand: 'acme', environment: 'test' });

      // A retry attempt at the protected page must land back on the login form, proving no
      // partial session was left behind by the rejected attempt.
      await session.navigate(`${url}/account`);
      expect((await session.snapshot()).aria).toContain('Sign in');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('returns missing_credentials without contacting the login host when no secret is available', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    const before = requestCount();
    try {
      const outcome = await session.login({ profile: 'unknown-profile', brand: 'acme', environment: 'test' });

      expect(outcome).toMatchObject({ status: 'missing_credentials', brand: 'acme', environment: 'test' });
      expect(requestCount()).toBe(before);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('returns unsupported_host without contacting any host for an unconfigured brand/environment', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    const before = requestCount();
    try {
      const outcome = await session.login({ profile: 'qa-account', brand: 'unknown-brand', environment: 'test' });

      expect(outcome).toMatchObject({ status: 'unsupported_host', brand: 'unknown-brand', environment: 'test' });
      expect(requestCount()).toBe(before);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('follows an approved identity-provider redirect to a different host before confirming success', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [ssoBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    try {
      const outcome = await session.login({ profile: 'qa-account', brand: 'acme', environment: 'sso-test' });

      expect(outcome).toMatchObject({ status: 'success', brand: 'acme', environment: 'sso-test' });
    } finally {
      await session.close();
    }
  }, 30_000);

  it('signs in on a login page hosted on a different host than the current page', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [crossHostBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    try {
      await session.navigate(url);

      const outcome = await session.login({ profile: 'qa-account', brand: 'globex', environment: 'test' });

      expect(outcome).toMatchObject({ status: 'success', brand: 'globex', environment: 'test' });
    } finally {
      await session.close();
    }
  }, 30_000);

  it('reports an interactive challenge instead of guessing or retrying through it', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [mfaBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    try {
      const outcome = await session.login({ profile: 'qa-account', brand: 'initech', environment: 'test' });

      expect(outcome).toMatchObject({ status: 'interactive_challenge', challengeType: 'mfa', brand: 'initech', environment: 'test' });
    } finally {
      await session.close();
    }
  }, 30_000);

  it('redacts credential values from evidence and snapshots even when a page echoes them back', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: invalidProvider,
    });
    try {
      await session.login({ profile: 'qa-account', brand: 'acme', environment: 'test' });
      await expect(session.snapshot()).rejects.toThrow('No browser page is active');
      for (const run of await readdir(artifactsDir)) {
        const manifest = await readFile(resolve(artifactsDir, run, 'evidence.json'), 'utf8');
        expect(manifest).not.toContain('wrong-password');
        expect(manifest).not.toContain(TEST_ACCOUNT_EMAIL);
      }
    } finally {
      await session.close();
    }
  }, 30_000);

  it('keeps browsing available without ever calling login (anonymous operation)', async () => {
    const session = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    try {
      await session.navigate(url);
      const snapshot = await session.snapshot();
      const evidence = await session.evidence({ filter: 'all' });

      expect(snapshot.aria).toContain('Ready');
      expect(JSON.stringify(evidence)).not.toContain(TEST_ACCOUNT_EMAIL);
      expect(JSON.stringify(evidence)).not.toContain(TEST_ACCOUNT_PASSWORD);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('keeps sessions independent: one session signing in leaves another session anonymous', async () => {
    const signedIn = createSession({
      artifactsDir,
      loginBrandConfigs: [normalBrandConfig()],
      accountCredentialProvider: validProvider,
    });
    const anonymous = createSession({ artifactsDir });
    try {
      const outcome = await signedIn.login({ profile: 'qa-account', brand: 'acme', environment: 'test' });
      expect(outcome.status).toBe('success');

      await anonymous.navigate(`${url}/account`);
      const anonymousSnapshot = await anonymous.snapshot();

      expect(anonymousSnapshot.aria).toContain('Sign in');
      expect(JSON.stringify(await anonymous.evidence({ filter: 'all' }))).not.toContain(TEST_ACCOUNT_PASSWORD);
      expect((outcome.status === 'success' && outcome.runId)).not.toBe(
        (await anonymous.navigate(url)).runId,
      );
    } finally {
      await signedIn.close();
      await anonymous.close();
    }
  }, 30_000);
});
