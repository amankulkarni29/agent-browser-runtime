jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('node:fs/promises', () => ({ rm: jest.fn() }));
jest.mock('playwright', () => ({ chromium: { executablePath: jest.fn(), connectOverCDP: jest.fn() } }));
jest.mock('../../src/core/bundled-browser.js', () => ({
  ensureBundledChromium: jest.fn(async () => undefined),
  withBundledChromium: jest.fn((launch: () => Promise<unknown>) => launch()),
}));

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import { launchBrowser } from '../../src/core/browser-launcher.js';

class Supervisor extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode = null;
  cleanupFailed = false;

  send(message: { type: string }, callback: (error: Error | null) => void): void {
    if (message.type === 'start') {
      this.emit('message', { type: 'resources', profile: '/test/browser-profile' });
      this.emit('message', { type: 'ready', endpoint: 'http://127.0.0.1:1234' });
    } else if (message.type === 'close') {
      this.emit('message', { type: 'closed', cleanupFailed: this.cleanupFailed });
      this.connected = false;
      this.exitCode = this.cleanupFailed ? 1 : 0;
      this.emit('exit', this.exitCode, null);
    }
    callback(null);
  }
}

describe('browser launcher cleanup failures', () => {
  let supervisor: Supervisor;
  const browserClose = jest.fn<Promise<void>, []>();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    supervisor = new Supervisor();
    jest.mocked(spawn).mockReturnValue(supervisor as unknown as ReturnType<typeof spawn>);
    browserClose.mockResolvedValue(undefined);
    jest.mocked(chromium.connectOverCDP).mockResolvedValue({
      close: browserClose, contexts: () => [{}],
    } as unknown as Awaited<ReturnType<typeof chromium.connectOverCDP>>);
    jest.mocked(rm).mockResolvedValue(undefined);
  });

  afterEach(() => { jest.useRealTimers(); });

  it('rejects close when the supervisor and owner both fail to remove the profile', async () => {
    supervisor.cleanupFailed = true;
    const removalError = new Error('Profile removal denied');
    jest.mocked(rm).mockRejectedValue(removalError);
    const browser = await launchBrowser({ launchMode: 'virtual-display' });

    await expect(browser.close()).rejects.toBe(removalError);
    expect(rm).toHaveBeenCalledWith('/test/browser-profile', expect.objectContaining({ recursive: true, force: true }));
  });

  it('finishes supervisor cleanup when browser close times out and later rejects', async () => {
    let rejectBrowserClose: (error: Error) => void = () => { throw new Error('Browser close did not start.'); };
    browserClose.mockReturnValue(new Promise<void>((_resolve, reject) => { rejectBrowserClose = reject; }));
    const browser = await launchBrowser({ launchMode: 'virtual-display' });
    const closing = browser.close();

    await jest.advanceTimersByTimeAsync(2_000);
    await expect(closing).resolves.toBeUndefined();
    expect(supervisor.exitCode).toBe(0);
    rejectBrowserClose(new Error('Browser connection ended after the close deadline'));
    // Jest fails this test if the timed-out operation produces an unhandled rejection.
    await jest.advanceTimersByTimeAsync(1);
    await expect(browser.close()).resolves.toBeUndefined();
  });
});
