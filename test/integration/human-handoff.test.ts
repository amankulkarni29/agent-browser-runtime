import { createServer, type Server } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/index.js';
import type { ChallengeNotice } from '../../src/core/challenge-notifier.js';

let server: Server;
let url: string;
let artifactsDir: string;
const webhookBodies: Record<string, unknown>[] = [];

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'handoff-test-'));
  server = createServer((request, response) => {
    if (request.url === '/hook') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => { webhookBodies.push(JSON.parse(body)); response.writeHead(204); response.end(); });
      return;
    }
    const pages: Record<string, [number, Record<string, string>, string]> = {
      '/challenge': [403, { 'cf-mitigated': 'challenge', 'set-cookie': 'cf_clearance=private-cookie' }, '<title>Just a moment...</title><p>Checking your browser</p>'],
      '/widget': [200, {}, '<title>Sign up</title><form><input aria-label="Email"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/test"></iframe></form>'],
      '/two-factor': [200, {}, '<title>Verify</title><p>Enter the verification code from your authenticator app</p><input aria-label="Code">'],
      '/clears': [200, {}, '<title>Just a moment...</title><script>setTimeout(() => { document.title = "Shop"; }, 1500)</script><p>Wait</p>'],
      '/': [200, {}, '<title>Shop</title><button>Buy</button>'],
    };
    const [status, headers, body] = pages[request.url ?? '/'] ?? pages['/']!;
    response.writeHead(status, { 'content-type': 'text/html', ...headers });
    response.end(`<!doctype html>${body}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(artifactsDir, { recursive: true, force: true });
});

it('reports a challenge once with a screenshot, notifies the webhook without cookies, and never retries it', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless', challengeNotify: ['webhook'], challengeWebhookUrl: `${url}/hook` });
  const notices: ChallengeNotice[] = [];
  session.onHumanCheck((notice) => notices.push(notice));
  try {
    const receipt = await session.navigate(`${url}/challenge`);
    expect(receipt.attention).toMatchObject({ status: 'challenge_detected', checks: [expect.objectContaining({ type: 'cloudflare-challenge' })] });
    const shot = receipt.attention!.checks[0]!.screenshotPath!;
    await expect(access(shot)).resolves.toBeUndefined();
    await session.navigate(`${url}/challenge`);
    expect(notices).toHaveLength(1);
    const evidence = await session.evidence({ filter: 'all' });
    expect(evidence.outcomes?.filter((event) => event.method === 'Browser.challenge')).toHaveLength(1);
    for (let attempt = 0; attempt < 20 && webhookBodies.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(webhookBodies[0]).toMatchObject({ type: 'cloudflare-challenge', category: 'challenge', screenshotPath: shot });
    expect(JSON.stringify(webhookBodies)).not.toContain('private-cookie');

    await session.addFault({ urlPattern: 'challenges.cloudflare.com', action: 'status', status: 200, body: '<p>widget</p>', contentType: 'text/html' });
    const widget = await session.navigate(`${url}/widget`);
    expect(widget.attention?.checks.map((check) => check.type)).toContain('turnstile');

    const code = await session.navigate(`${url}/two-factor`);
    expect(code.attention).toMatchObject({ status: 'handoff_required', checks: [expect.objectContaining({ type: 'two-factor' })] });
    expect((await session.navigate(`${url}/`)).attention).toBeUndefined();
  } finally { await session.close(); }
}, 30_000);

it('refuses handoff when nobody can see the browser', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless' });
  try {
    await session.navigate(`${url}/`);
    expect(await session.requestHandoff('Complete the prompt', 5_000)).toMatchObject({ status: 'unavailable' });
  } finally { await session.close(); }
}, 30_000);

it('waits for the person, blocks other actions, and ends on Done or when the challenge clears', async () => {
  const session = new BrowserSession({ artifactsDir, launchMode: 'headless', allowHeadlessHandoff: true, isRawCdpEnabled: true });
  try {
    await session.navigate(`${url}/`);
    const waiting = session.requestHandoff('Approve the purchase', 20_000);
    let bannerShown = false;
    for (let attempt = 0; attempt < 30 && !bannerShown; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const probe = await session.cdp('Runtime.evaluate', { expression: '!!document.getElementById("agent-browser-handoff")', returnByValue: true });
      bannerShown = (probe.result as { result: { value: boolean } }).result.value;
    }
    expect(bannerShown).toBe(true);
    await expect(session.click({ kind: 'role', role: 'button', name: 'Buy' })).rejects.toMatchObject({ metadata: { reason: 'waiting_for_human' } });
    await session.cdp('Runtime.evaluate', { expression: 'document.querySelector("#agent-browser-handoff button").click()' });
    expect(await waiting).toMatchObject({ status: 'completed' });
    await expect(session.click({ kind: 'role', role: 'button', name: 'Buy' })).resolves.toMatchObject({ kind: 'click' });

    await session.navigate(`${url}/clears`);
    expect(await session.requestHandoff('Clear the check', 20_000)).toMatchObject({ status: 'cleared' });
  } finally { await session.close(); }
}, 45_000);
