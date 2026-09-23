import { ensureBundledChromium, withBundledChromium } from './bundled-browser.js';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BrowserRuntimeError } from './errors.js';
import supervisorPath from './browser-supervisor.cjs';
import type { BrowserSessionOptions } from './types.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ENVIRONMENT_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMROOT'];

export type OwnedBrowser = { browser: Browser; context: BrowserContext; close(): Promise<void> };

function browserEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(ENVIRONMENT_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function aborted(): BrowserRuntimeError {
  return new BrowserRuntimeError('Browser startup was cancelled.', 'BROWSER_UNAVAILABLE');
}

async function settleWithin(operation: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

function defaultLaunchArgs(): string[] {
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
  return args;
}

async function launchLegacy(options: BrowserSessionOptions, signal?: AbortSignal): Promise<OwnedBrowser> {
  const browser = await withBundledChromium(() => chromium.launch({
    headless: options.launchMode === 'headless' ? true : options.headless ?? true,
    args: options.launchArgs ?? defaultLaunchArgs(), env: browserEnvironment() }));
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= browser.close().finally(() => signal?.removeEventListener('abort', onAbort));
    return closing;
  };
  const onAbort = () => { void close().catch(() => console.error('BrowserLauncher: cancelled browser cleanup failed.')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw aborted();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT, locale: options.locale ?? 'en-US' });
    if (signal?.aborted) throw aborted();
    return { browser, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function launchBrowser(options: BrowserSessionOptions, signal?: AbortSignal): Promise<OwnedBrowser> {
  if (signal?.aborted) throw aborted();
  if (options.launchMode === 'headless' && options.headless === false) {
    throw new BrowserRuntimeError('Headless launch mode conflicts with headless: false.', 'INVALID_CONFIGURATION');
  }
  if (options.launchMode !== 'virtual-display') return launchLegacy(options, signal);
  if (options.headless === true || options.launchArgs?.length) {
    throw new BrowserRuntimeError('Virtual-display mode does not accept headless: true or custom launch arguments.', 'INVALID_CONFIGURATION');
  }

  await ensureBundledChromium(chromium.executablePath());
  const supervisor = spawn(process.execPath, [supervisorPath], {
    detached: true, env: browserEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let browser: Browser | undefined;
  let profile: string | undefined;
  let displayPid: number | undefined;
  let chromePid: number | undefined;
  let cleanupFailed = false;
  let cleanupConfirmed = false;
  let closing: Promise<void> | undefined;
  let resolveReady: (endpoint: string) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Abort may close the owner before execution reaches the await below.
  void ready.catch(() => {});
  const exited = new Promise<void>((resolve) => { supervisor.once('exit', () => resolve()); });
  const startupTimeout = setTimeout(() => rejectReady(new BrowserRuntimeError('Virtual-display browser startup timed out.', 'BROWSER_UNAVAILABLE')), 35_000);
  const startupFailure = () => rejectReady(new BrowserRuntimeError('Virtual-display browser owner exited during startup.', 'BROWSER_UNAVAILABLE'));
  supervisor.once('error', startupFailure);
  supervisor.once('exit', startupFailure);
  supervisor.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'resources') {
      if ('profile' in message && typeof message.profile === 'string') profile = message.profile;
      if ('displayPid' in message && typeof message.displayPid === 'number') displayPid = message.displayPid;
      if ('chromePid' in message && typeof message.chromePid === 'number') chromePid = message.chromePid;
    } else if (message.type === 'ready' && 'endpoint' in message && typeof message.endpoint === 'string') {
      resolveReady(message.endpoint);
    } else if (message.type === 'error') {
      const reason = 'reason' in message && typeof message.reason === 'string' && message.reason.length < 200
        ? message.reason : 'Virtual-display browser startup failed.';
      rejectReady(new BrowserRuntimeError(reason, 'BROWSER_UNAVAILABLE'));
    } else if (message.type === 'closed' && 'cleanupFailed' in message) {
      cleanupConfirmed = true;
      cleanupFailed = message.cleanupFailed === true;
    }
  });

  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(startupTimeout);
      signal?.removeEventListener('abort', onAbort);
      rejectReady(aborted());
      try { if (browser) await settleWithin(browser.close(), 2_000); }
      finally {
        if (supervisor.connected) supervisor.send({ type: 'close' }, () => {});
        await settleWithin(exited, 6_000);
        if (!cleanupConfirmed || cleanupFailed) {
          for (const pid of [chromePid, displayPid]) {
            if (pid) killGroup(pid);
          }
          if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
          await settleWithin(exited, 1_000);
          if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    })();
    return closing;
  }
  function onAbort(): void { void close().catch(() => console.error('BrowserLauncher: cancelled browser cleanup failed.')); }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw aborted();
    supervisor.send({ type: 'start', executable: chromium.executablePath(),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}), ...(options.locale ? { locale: options.locale } : {}) },
    (error) => { if (error) startupFailure(); });
    const endpoint = await ready;
    clearTimeout(startupTimeout);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    if (signal?.aborted || closing) throw aborted();
    const context = browser.contexts()[0];
    if (!context) throw new BrowserRuntimeError('Direct Chromium has no default browser context.', 'BROWSER_UNAVAILABLE');
    return { browser, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function killGroup(pid: number): void {
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
