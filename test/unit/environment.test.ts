import { browserSessionOptionsFromEnvironment } from '../../src/adapters/environment.js';

describe('browser environment configuration', () => {
  it('uses an explicit launch mode without the legacy headless setting', () => {
    expect(browserSessionOptionsFromEnvironment({ BROWSER_LAUNCH_MODE: 'virtual-display' }))
      .toMatchObject({ launchMode: 'virtual-display' });
    expect(browserSessionOptionsFromEnvironment({ BROWSER_LAUNCH_MODE: 'virtual-display' }).headless).toBeUndefined();
    expect(browserSessionOptionsFromEnvironment({ BROWSER_LAUNCH_MODE: 'headless' }).launchMode).toBe('headless');
    expect(browserSessionOptionsFromEnvironment({}).headless).toBe(true);
  });

  it('rejects unknown and conflicting launch configuration', () => {
    expect(() => browserSessionOptionsFromEnvironment({ BROWSER_LAUNCH_MODE: 'auto' })).toThrow('BROWSER_LAUNCH_MODE');
    expect(() => browserSessionOptionsFromEnvironment({ BROWSER_LAUNCH_MODE: 'virtual-display', HEADED: '0' })).toThrow('not both');
  });
  it('disables tracing by default', () => {
    expect(browserSessionOptionsFromEnvironment({}).isTraceEnabled).toBe(false);
  });

  it('accepts 0 and 1 for boolean variables', () => {
    expect(browserSessionOptionsFromEnvironment({ BROWSER_TRACE: '1' }).isTraceEnabled).toBe(true);
    expect(browserSessionOptionsFromEnvironment({ BROWSER_TRACE: '0' }).isTraceEnabled).toBe(false);
  });

  it('rejects unsupported boolean values', () => {
    expect(() => browserSessionOptionsFromEnvironment({ BROWSER_TRACE: 'true' })).toThrow(
      'BROWSER_TRACE must be 0 or 1.',
    );
  });

  it('reads the Vercel bypass secret and approved hosts', () => {
    const options = browserSessionOptionsFromEnvironment({
      BROWSER_VERCEL_BYPASS_SECRET: 'shh',
      BROWSER_VERCEL_BYPASS_HOSTS: 'preview.vercel.app, stage.example.com',
    });
    expect(options.vercelBypassSecret).toBe('shh');
    expect(options.vercelBypassHosts).toEqual(['preview.vercel.app', 'stage.example.com']);
  });

  it('leaves the Vercel bypass options unset when not configured', () => {
    const options = browserSessionOptionsFromEnvironment({});
    expect(options.vercelBypassSecret).toBeUndefined();
    expect(options.vercelBypassHosts).toBeUndefined();
  });
});
