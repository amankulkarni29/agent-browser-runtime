import type { BrowserSessionOptions } from '../../src/index.js';
import { rm } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { BrowserSession } from '../../src/index.js';
import { startFixtureSite } from '../fixtures/site.js';

const artifactsDir = resolve('artifacts/test');
let server: Server | undefined;
let url: string;

beforeAll(async () => {
  ({ server, url } = await startFixtureSite());
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

describe.each(['headless', 'virtual-display'] as const)('%s exploratory browser session', (launchMode) => {
  const createSession = (options: BrowserSessionOptions) => new BrowserSession({ ...options, launchMode });
  it('waits for the page to settle before returning its accessibility snapshot', async () => {
    const session = createSession({ artifactsDir });
    try {
      const navigation = await session.navigate(url);
      const snapshot = await session.snapshot();

      expect(navigation.settled.networkQuiet).toBe(true);
      expect(snapshot.aria).toContain('Ready');
      expect(snapshot.aria).toContain('Create order');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('settles through a document that renavigates mid-poll', async () => {
    const session = createSession({ artifactsDir });
    try {
      // The fixture replaces its own document while settle() is polling, destroying the
      // execution context that page.evaluate reads. That must not surface as a failure.
      const navigation = await session.navigate(`${url}/renavigates`);

      expect(navigation.url).toBe(`${url}/renavigated`);
      expect(navigation.title).toBe('Renavigated fixture');
      expect(navigation.settled.domStable).toBe(true);

      const snapshot = await session.snapshot();
      expect(snapshot.aria).toContain('Final document');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('uses accessible controls and returns action-scoped browser evidence with response bodies', async () => {
    const session = createSession({ artifactsDir });
    try {
      await session.navigate(url);
      const checkpoint = session.checkpoint();
      await session.click({ kind: 'role', role: 'button', name: 'Create order' });

      const snapshot = await session.snapshot();
      const evidence = await session.evidence({ filter: 'all', since: checkpoint });

      expect(snapshot.aria).toContain('Created order-123');
      expect(evidence.network).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: expect.stringContaining('/api/order'),
            method: 'POST',
            status: 201,
            bodyExcerpt: expect.stringContaining('order-123'),
          }),
        ]),
      );
      expect(evidence.console).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: 'order created' })]),
      );
      expect(session.getEvidence({ filter: 'all', since: checkpoint }).network).toEqual(evidence.network);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('saves a trace and starts a fresh investigation after close', async () => {
    const session = createSession({
      artifactsDir,
      isTraceEnabled: true,
    });
    try {
      const first = await session.navigate(url);
      const closed = await session.close();

      expect(closed.runId).toBe(first.runId);
      expect(closed.tracePath).toMatch(/trace\.zip$/);
      await expect(access(closed.tracePath!)).resolves.toBeUndefined();

      const second = await session.navigate(url);
      expect(second.runId).not.toBe(first.runId);
      expect((await session.snapshot()).aria).toContain('Ready');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('does not save a trace unless tracing is enabled', async () => {
    const session = createSession({ artifactsDir });
    try {
      await session.navigate(url);

      expect((await session.close()).tracePath).toBeNull();
    } finally {
      await session.close();
    }
  }, 30_000);

  it('supports exploratory input, hover, overlays, screenshots, and unrestricted clicks', async () => {
    const session = createSession({ artifactsDir });
    try {
      await session.navigate(url);
      await session.type({ kind: 'label', label: 'Name' }, 'Ada');
      await session.hover({ kind: 'role', role: 'link', name: 'Product details' });
      expect((await session.snapshot()).aria).toContain('Hover details visible');
      await session.click({ kind: 'role', role: 'button', name: 'Place order' });

      await session.navigate(`${url}/overlay`);
      const dismissed = await session.dismissOverlay();
      expect(dismissed.dismissed).toBe(true);
      expect((await session.snapshot()).aria).not.toContain('Claim your sample');

      const screenshot = await session.screenshot('exploration');
      expect(screenshot.path).toMatch(/exploration-[a-f0-9-]+\.jpg$/);
      expect(screenshot.dataBase64.length).toBeGreaterThan(100);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('sends the bypass header only to first-party requests', async () => {
    const session = createSession({
      artifactsDir,
      bypassHeaderName: 'x-test-bypass',
      bypassHeaderToken: 'test-secret',
    });
    try {
      await session.navigate(`${url}/header-probe`);
      const snapshot = await session.snapshot();

      expect(snapshot.aria).toContain('test-secret');
      expect(snapshot.aria).toContain('null');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('refuses to combine tracing with a Vercel bypass secret so the secret can never reach a trace', () => {
    expect(
      () =>
        createSession({
          artifactsDir,
          vercelBypassSecret: 'shh',
          vercelBypassHosts: ['127.0.0.1'],
          isTraceEnabled: true,
        }),
    ).toThrow('Tracing cannot be enabled together with a Vercel bypass secret.');
  });

  it('requires the Vercel bypass secret and approved hosts to be configured together', () => {
    expect(() => createSession({ artifactsDir, vercelBypassSecret: 'shh' })).toThrow(
      'vercelBypassSecret and vercelBypassHosts must be configured together.',
    );
    expect(
      () => createSession({ artifactsDir, vercelBypassHosts: ['127.0.0.1'] }),
    ).toThrow('vercelBypassSecret and vercelBypassHosts must be configured together.');
  });

  it('sends the Vercel bypass header only on the bootstrap request, then continues on the cookie', async () => {
    const session = createSession({
      artifactsDir,
      vercelBypassSecret: 'test-vercel-secret',
      vercelBypassHosts: ['127.0.0.1'],
    });
    try {
      await session.navigate(`${url}/vercel-protected`);
      const first = await session.snapshot();
      // The fixture echoes the received header value back into the page so the test can confirm
      // it arrived — the runtime scrubs that echo from the snapshot before it ever reaches here.
      expect(first.aria).toContain('header-authorized:[REDACTED]');
      expect(first.aria).not.toContain('test-vercel-secret');

      await session.navigate(`${url}/vercel-protected`);
      const second = await session.snapshot();
      expect(second.aria).toContain('cookie-authorized:null');
      expect(second.aria).not.toContain('test-vercel-secret');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('never lets a redirect off the approved host receive the Vercel bypass secret', async () => {
    const session = createSession({
      artifactsDir,
      vercelBypassSecret: 'redirect-secret',
      vercelBypassHosts: ['127.0.0.1'],
    });
    try {
      await session.navigate(`${url}/vercel-redirect-to-localhost`);
      const snapshot = await session.snapshot();

      // The redirect target is a different host (localhost, not 127.0.0.1), so it never receives
      // the bootstrap header and is left unauthenticated by the fixture.
      expect(snapshot.aria).toContain('bypass-required:null');
      expect(snapshot.aria).not.toContain('redirect-secret');
    } finally {
      await session.close();
    }
  }, 30_000);

  it('never resends the Vercel bypass secret to a same-host subresource after the top-level bootstrap', async () => {
    const session = createSession({
      artifactsDir,
      vercelBypassSecret: 'subresource-secret',
      vercelBypassHosts: ['127.0.0.1'],
    });
    try {
      await session.navigate(`${url}/vercel-subresource-probe`);
      const snapshot = await session.snapshot();

      // The top-level document already consumed the one bootstrap request for this host, so the
      // page's own fetch to an API route must not receive the secret a second time. The ARIA
      // snapshot escapes the quotes in the status text, so match on the unquoted field instead.
      expect(snapshot.aria).toContain('header\\":null');
      expect(snapshot.aria).not.toContain('subresource-secret');
    } finally {
      await session.close();
    }
  }, 30_000);
});
