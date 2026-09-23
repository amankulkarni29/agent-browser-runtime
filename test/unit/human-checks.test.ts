import { classifyFrameUrl, classifyPage, classifyResponseHeaders, compilePatterns, humanCheckKey } from '../../src/core/human-checks.js';
import { desktopNotifier, webhookNotifier, type ChallengeNotice } from '../../src/core/challenge-notifier.js';
import { browserSessionOptionsFromEnvironment, challengeChannels } from '../../src/adapters/environment.js';

const notice: ChallengeNotice = { runId: 'run-1', type: 'turnstile', category: 'challenge', url: 'https://shop.test/signup',
  detail: 'turnstile frame', detectedAt: '2026-09-23T10:00:00.000Z', screenshotPath: '/tmp/shot "1".jpg' };

it('recognises visible challenge frames and ignores invisible ones', () => {
  expect(classifyFrameUrl('https://www.google.com/recaptcha/api2/anchor?k=abc&size=normal')?.type).toBe('recaptcha');
  expect(classifyFrameUrl('https://www.google.com/recaptcha/api2/anchor?k=abc&size=invisible')).toBeUndefined();
  expect(classifyFrameUrl('https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox')?.type).toBe('hcaptcha');
  expect(classifyFrameUrl('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x')?.type).toBe('turnstile');
  expect(classifyFrameUrl('https://www.google.com/search?q=recaptcha')).toBeUndefined();
  expect(classifyFrameUrl('not a url')).toBeUndefined();
});

it('recognises challenge headers, titles, two-factor text, and caller patterns', () => {
  expect(classifyResponseHeaders('https://shop.test/', { 'CF-Mitigated': 'challenge' })?.type).toBe('cloudflare-challenge');
  expect(classifyResponseHeaders('https://shop.test/', { 'cf-mitigated': 'block' })).toBeUndefined();
  expect(classifyPage('https://shop.test/', 'Just a moment...', '').map((check) => check.type)).toEqual(['cloudflare-challenge']);
  expect(classifyPage('https://shop.test/', 'Sign in', 'Enter the verification code we sent').map((check) => check.category)).toEqual(['handoff']);
  expect(classifyPage('https://shop.test/', 'Home', 'Welcome back')).toEqual([]);
  const patterns = compilePatterns(['Approve on your phone (now)']);
  expect(classifyPage('https://shop.test/', 'Home', 'Please approve on your phone (now).', patterns)[0]?.type).toBe('custom');
  expect(humanCheckKey({ type: 'turnstile', category: 'challenge', source: 'frame', url: 'x', detail: '' }, 'https://shop.test/a?b=1#c'))
    .toBe('turnstile|https://shop.test/a');
});

it('builds desktop notifications without a shell and escapes AppleScript strings', async () => {
  const calls: [string, string[]][] = [];
  const exec = async (file: string, args: string[]) => { calls.push([file, args]); };
  await desktopNotifier('darwin', exec).notify({ ...notice, url: 'https://shop.test/"quoted"' });
  await desktopNotifier('linux', exec).notify(notice);
  expect(calls[0]).toEqual(['osascript', ['-e', 'display notification "https://shop.test/\\"quoted\\"" with title "Browser challenge: turnstile"']]);
  expect(calls[1]).toEqual(['notify-send', ['--app-name=agent-browser', 'Browser challenge: turnstile', 'https://shop.test/signup']]);
  await expect(desktopNotifier('win32', exec).notify(notice)).rejects.toThrow('not supported');
});

it('posts a webhook notice without cookies and only to HTTPS or loopback', async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  await webhookNotifier('https://hooks.example.com/abc', fakeFetch).notify(notice);
  expect(sent[0]?.body).toMatchObject({ text: 'Browser challenge: turnstile on https://shop.test/signup', runId: 'run-1', screenshotPath: '/tmp/shot "1".jpg' });
  expect(Object.keys(sent[0]!.body).sort()).toEqual(['category', 'detail', 'detectedAt', 'runId', 'screenshotPath', 'text', 'type', 'url']);
  expect(() => webhookNotifier('http://hooks.example.com/abc')).toThrow('HTTPS');
  expect(() => webhookNotifier('http://127.0.0.1:9/hook')).not.toThrow();
  const failing = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  await expect(webhookNotifier('https://hooks.example.com/abc', failing).notify(notice)).rejects.toThrow('500');
});

it('reads challenge channels and handoff patterns from the environment', () => {
  expect(challengeChannels({})).toEqual(['mcp']);
  expect(browserSessionOptionsFromEnvironment({ BROWSER_CHALLENGE_NOTIFY: 'mcp,desktop', BROWSER_HANDOFF_PATTERNS: 'Approve on phone' }))
    .toMatchObject({ challengeNotify: ['desktop'], handoffPatterns: ['Approve on phone'] });
  expect(() => browserSessionOptionsFromEnvironment({ BROWSER_CHALLENGE_NOTIFY: 'webhook' })).toThrow('BROWSER_CHALLENGE_WEBHOOK_URL');
  expect(() => challengeChannels({ BROWSER_CHALLENGE_NOTIFY: 'pager' })).toThrow('pager');
});
