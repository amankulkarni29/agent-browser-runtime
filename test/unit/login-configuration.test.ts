import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginOptionsFromFile } from '../../src/adapters/login-configuration.js';
import { BrowserSession } from '../../src/index.js';

describe('private MCP login configuration', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'login-config-test-')); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  it('resolves the shared account only for an approved profile, brand and environment', async () => {
    const file = join(directory, 'login.json');
    writeFileSync(file, JSON.stringify({ profile: 'shared', credentials: { email: 'fixture@example.com', password: 'fixture-secret' }, brands: [{
      brand: 'acme', environment: 'stage', loginUrl: 'https://stage.example.com/login',
      usernameField: { kind: 'label', label: 'Email' }, passwordField: { kind: 'label', label: 'Password' },
      submitField: { kind: 'role', role: 'button', name: 'Sign in' }, successSignal: { kind: 'url', pattern: '/account' },
    }] }), { mode: 0o600 });
    const options = loginOptionsFromFile(file);
    expect(await options.accountCredentialProvider?.({ profile: 'shared', brand: 'acme', environment: 'stage' })).toEqual({ email: 'fixture@example.com', password: 'fixture-secret' });
    expect(await options.accountCredentialProvider?.({ profile: 'other', brand: 'acme', environment: 'stage' })).toBeUndefined();
    expect(await options.accountCredentialProvider?.({ profile: 'shared', brand: 'initech', environment: 'stage' })).toBeUndefined();
    expect(() => new BrowserSession({ ...options, isTraceEnabled: true })).toThrow('Tracing cannot');
  });
  it('resolves each named account from a multi-account file', async () => {
    const file = join(directory, 'accounts.json');
    writeFileSync(file, JSON.stringify({
      accounts: [
        { profile: 'first', credentials: { email: 'first-user', password: 'first-secret' } },
        { profile: 'second', credentials: { email: 'second-user', password: 'second-secret' } },
      ],
      brands: [{ brand: 'demo', environment: 'production', loginUrl: 'https://demo.example.com/',
        usernameField: { kind: 'selector', selector: '#user' }, passwordField: { kind: 'selector', selector: '#pass' },
        submitField: { kind: 'selector', selector: '#go' }, successSignal: { kind: 'url', pattern: '/home' } }],
    }), { mode: 0o600 });
    const options = loginOptionsFromFile(file);
    const resolve = (profile: string, brand = 'demo') => options.accountCredentialProvider?.({ profile, brand, environment: 'production' });
    expect(await resolve('first')).toEqual({ email: 'first-user', password: 'first-secret' });
    expect(await resolve('second')).toEqual({ email: 'second-user', password: 'second-secret' });
    expect(await resolve('third')).toBeUndefined();
    expect(await resolve('first', 'other')).toBeUndefined();
  });
  it('does not include private file contents in validation errors', () => {
    const file = join(directory, 'bad.json');
    writeFileSync(file, 'private-password-invalid-json');
    expect(() => loginOptionsFromFile(file)).toThrow('Could not load the private browser login configuration.');
  });
  it('keeps anonymous startup unchanged', () => expect(loginOptionsFromFile(undefined)).toEqual({}));
});
