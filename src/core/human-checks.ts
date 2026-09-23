/**
 * Recognise pages and frames that need a person: CAPTCHA and bot challenges, two-factor prompts,
 * and caller-supplied text. Detection only; the runtime never tries to solve a challenge.
 */
export type HumanCheckType = 'recaptcha' | 'hcaptcha' | 'turnstile' | 'cloudflare-challenge' | 'aws-waf-captcha' | 'arkose'
  | 'two-factor' | 'custom';

export type HumanCheck = {
  type: HumanCheckType;
  /** challenge: a bot check the person must clear. handoff: a step only the person can do. */
  category: 'challenge' | 'handoff';
  source: 'frame' | 'header' | 'title' | 'text';
  url: string;
  detail: string;
};

const FRAME_PROVIDERS: { type: HumanCheckType; test: (url: URL) => boolean }[] = [
  // Invisible reCAPTCHA loads an anchor frame on many pages without asking the person anything.
  { type: 'recaptcha', test: (url) => /(^|\.)(google\.com|recaptcha\.net)$/.test(url.hostname) &&
    /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/.test(url.pathname) && url.searchParams.get('size') !== 'invisible' },
  { type: 'hcaptcha', test: (url) => /(^|\.)hcaptcha\.com$/.test(url.hostname) && /\/captcha\//.test(url.pathname) &&
    !/frame=invisible/.test(url.hash) },
  { type: 'turnstile', test: (url) => url.hostname === 'challenges.cloudflare.com' && /\/(turnstile|cdn-cgi\/challenge-platform)\//.test(url.pathname) },
  { type: 'aws-waf-captcha', test: (url) => /\.captcha\.awswaf\.com$|\.captcha-sdk\.awswaf\.com$/.test(url.hostname) },
  { type: 'arkose', test: (url) => /(^|\.)(arkoselabs\.com|funcaptcha\.com)$/.test(url.hostname) },
];

const CHALLENGE_TITLES = [/^just a moment\.{0,3}$/i, /attention required!? \| cloudflare/i, /^verify you are (a )?human/i,
  /^human verification$/i];
const TWO_FACTOR_TEXT = /(enter (the |your )?(verification|security|one-time|6-digit) code|two-factor authentication|2-step verification|authenticator app|we (sent|texted) (you )?a code)/i;

export function classifyFrameUrl(raw: string): HumanCheck | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const provider = FRAME_PROVIDERS.find((candidate) => candidate.test(url));
  return provider ? { type: provider.type, category: 'challenge', source: 'frame', url: `${url.origin}${url.pathname}`, detail: `${provider.type} frame` } : undefined;
}

export function classifyResponseHeaders(url: string, headers: Record<string, string>): HumanCheck | undefined {
  const mitigated = Object.entries(headers).find(([name]) => name.toLowerCase() === 'cf-mitigated')?.[1];
  if (mitigated?.toLowerCase() === 'challenge') {
    return { type: 'cloudflare-challenge', category: 'challenge', source: 'header', url, detail: 'cf-mitigated: challenge' };
  }
  return undefined;
}

/** Title and visible text checks for the current page. */
export function classifyPage(url: string, title: string, text: string, patterns: readonly RegExp[] = []): HumanCheck[] {
  const found: HumanCheck[] = [];
  if (CHALLENGE_TITLES.some((pattern) => pattern.test(title.trim()))) {
    found.push({ type: 'cloudflare-challenge', category: 'challenge', source: 'title', url, detail: `title "${title.trim().slice(0, 80)}"` });
  }
  const twoFactor = TWO_FACTOR_TEXT.exec(text);
  if (twoFactor) found.push({ type: 'two-factor', category: 'handoff', source: 'text', url, detail: `text "${twoFactor[0]}"` });
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) found.push({ type: 'custom', category: 'handoff', source: 'text', url, detail: `text "${match[0].slice(0, 80)}" matched ${pattern}` });
  }
  return found;
}

/** Caller patterns are plain text, matched case-insensitively. */
export function compilePatterns(patterns: readonly string[] | undefined): RegExp[] {
  return (patterns ?? []).filter(Boolean).slice(0, 20)
    .map((pattern) => new RegExp(pattern.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

export function humanCheckKey(check: HumanCheck, pageUrl: string): string {
  let page = pageUrl;
  try { const url = new URL(pageUrl); page = `${url.origin}${url.pathname}`; } catch { /* keep raw */ }
  return `${check.type}|${page}`;
}
