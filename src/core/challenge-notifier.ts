import { execFile } from 'node:child_process';
import { BrowserRuntimeError, getErrorMessage } from './errors.js';

/** What leaves the process: no cookies, headers, page text, or credentials. */
export type ChallengeNotice = {
  runId: string;
  type: string;
  category: 'challenge' | 'handoff';
  url: string;
  detail: string;
  detectedAt: string;
  screenshotPath: string | null;
};

export type ChallengeNotifier = { channel: string; notify(notice: ChallengeNotice): Promise<void> };

type Exec = (file: string, args: string[]) => Promise<void>;

const defaultExec: Exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5_000 }, (error) => (error ? reject(error) : resolve()));
});

export function noticeTitle(notice: ChallengeNotice): string {
  return notice.category === 'challenge' ? `Browser challenge: ${notice.type}` : `Browser needs a person: ${notice.type}`;
}

/** Native OS notification. Arguments are passed without a shell. */
export function desktopNotifier(platform = process.platform, exec: Exec = defaultExec): ChallengeNotifier {
  return {
    channel: 'desktop',
    async notify(notice) {
      const title = noticeTitle(notice);
      const message = `${notice.url}`.slice(0, 200);
      if (platform === 'darwin') {
        // AppleScript string literals need escaped quotes and backslashes.
        const quote = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;
        await exec('osascript', ['-e', `display notification ${quote(message)} with title ${quote(title)}`]);
      } else if (platform === 'linux') {
        await exec('notify-send', ['--app-name=agent-browser', title, message]);
      } else {
        throw new Error(`Desktop notifications are not supported on ${platform}.`);
      }
    },
  };
}

export function webhookNotifier(rawUrl: string, send: typeof fetch = fetch): ChallengeNotifier {
  let url: URL;
  try { url = new URL(rawUrl); } catch {
    throw new BrowserRuntimeError('BROWSER_CHALLENGE_WEBHOOK_URL is not a valid URL.', 'INVALID_CONFIGURATION');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new BrowserRuntimeError('The challenge webhook must use HTTPS (HTTP is allowed only for loopback).', 'INVALID_CONFIGURATION');
  }
  return {
    channel: 'webhook',
    async notify(notice) {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` lets Slack and Teams incoming webhooks show the notice without a custom app.
        body: JSON.stringify({ text: `${noticeTitle(notice)} on ${notice.url}`, ...notice }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Webhook answered ${response.status}.`);
    },
  };
}

/** Deliver without blocking browser actions; a failed channel is logged and does not affect others. */
export function dispatchNotice(notifiers: readonly ChallengeNotifier[], notice: ChallengeNotice, onFailure: (channel: string) => void): void {
  for (const notifier of notifiers) {
    void notifier.notify(notice).catch((error) => {
      console.error('ChallengeNotifier: delivery failed', { channel: notifier.channel, type: notice.type, error: getErrorMessage(error) });
      onFailure(notifier.channel);
    });
  }
}
