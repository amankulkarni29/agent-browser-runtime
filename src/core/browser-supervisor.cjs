// Standalone process owner. Importing it returns its path without starting a browser.
module.exports = __filename;

function runBrowserSupervisor() {
  // This process loads no application configuration or credentials.
  const { spawn } = require('node:child_process');
  const { mkdtemp, chmod, rm } = require('node:fs/promises');
  const { createServer } = require('node:net');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { setTimeout: delay } = require('node:timers/promises');
  let profile;
  let display;
  let chrome;
  let stopping = false;
  let shutdownPromise;
  let started = false;
  let startup;
  let startupStage = 'profile';
  function send(message) {
    // A missing parent is an expected cleanup trigger, never a reason to print browser data.
    if (process.connected)
      process.send?.(message, () => { });
  }
  function resources() {
    send({ type: 'resources', profile, displayPid: display?.pid, chromePid: chrome?.pid });
  }
  function signal(child, value) {
    if (!child?.pid)
      return;
    try {
      process.kill(-child.pid, value);
    }
    catch (error) {
      if (error.code !== 'ESRCH')
        throw error;
    }
  }
  async function stop(child) {
    if (!child?.pid)
      return;
    signal(child, 'SIGTERM');
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        process.kill(-child.pid, 0);
      }
      catch (error) {
        if (error.code === 'ESRCH')
          return;
        throw error;
      }
      await delay(100);
    }
    signal(child, 'SIGKILL');
    await delay(100);
  }
  function shutdown(reason) {
    if (shutdownPromise)
      return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([stop(chrome), stop(display)]);
      // An abort can race the asynchronous profile creation. Let startup observe stopping
      // before deleting the directory, so its pending mkdir cannot recreate an orphan.
      await startup;
      const finalStops = await Promise.allSettled([stop(chrome), stop(display)]);
      let failed = results.some((result) => result.status === 'rejected');
      failed ||= finalStops.some((result) => result.status === 'rejected');
      if (profile) {
        try {
          await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
        catch {
          failed = true;
        }
      }
      if (reason)
        send({ type: 'error', reason });
      if (process.connected) {
        await new Promise((resolve) => process.send({ type: 'closed', cleanupFailed: failed }, () => resolve()));
      }
      process.exit(reason || failed ? 1 : 0);
    })();
    return shutdownPromise;
  }
  function assertRunning() {
    if (stopping || !process.connected)
      throw new Error('Browser owner disconnected.');
  }
  async function start(configuration) {
    try {
      profile = await mkdtemp(join(tmpdir(), 'agent-browser-display-'));
      await chmod(profile, 0o700);
      resources();
      assertRunning();
      let displayName = process.env.DISPLAY;
      if (process.platform === 'linux') {
        startupStage = 'display';
        display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
        resources();
        const child = display;
        const number = await new Promise((resolve, reject) => {
          let text = '';
          const timeout = setTimeout(() => reject(new Error('Virtual display startup timed out.')), 10_000);
          const fail = () => { clearTimeout(timeout); reject(new Error('Virtual display could not start.')); };
          child.once('error', fail);
          child.once('exit', fail);
        child.stdio[3]?.on('data', (chunk) => {
          text += chunk.toString();
          if (text.length > 64) { fail(); return; }
            if (text.includes('\n')) {
              clearTimeout(timeout);
              child.removeListener('exit', fail);
              resolve(text.trim());
            }
          });
        });
        if (!/^\d+$/.test(number))
          throw new Error('Virtual display address is invalid.');
        displayName = `:${number}`;
      }
      else if (process.platform !== 'darwin') {
        startupStage = 'platform';
        throw new Error('Virtual-display mode requires Linux or macOS.');
      }
      assertRunning();
      startupStage = 'port';
      const listener = createServer();
      const port = await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
          const address = listener.address();
          if (!address || typeof address === 'string')
            reject(new Error('Browser port allocation failed.'));
          else
            resolve(address.port);
        });
      });
      await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      assertRunning();
      const args = [
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--no-sandbox', '--disable-dev-shm-usage',
      ];
      if (configuration.userAgent)
        args.push(`--user-agent=${configuration.userAgent}`);
      if (configuration.locale)
        args.push(`--lang=${configuration.locale}`);
      args.push('about:blank');
      startupStage = 'chromium';
      chrome = spawn(configuration.executable, args, {
        detached: true,
        env: { ...process.env, ...(displayName ? { DISPLAY: displayName } : {}) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      resources();
      let launchFailed = false;
      let endpoint;
      let stderrTail = '';
      chrome.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096);
        const match = stderrTail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n/);
        if (match?.[1] && new URL(match[1]).port === String(port))
          endpoint = match[1];
      });
      chrome.once('error', () => { launchFailed = true; });
      chrome.once('exit', () => { if (!stopping)
        void shutdown('Chromium exited unexpectedly.'); });
      display?.once('exit', () => { if (!stopping)
        void shutdown('Virtual display exited unexpectedly.'); });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        assertRunning();
        if (launchFailed)
          throw new Error('Chromium could not start.');
        if (endpoint) {
          send({ type: 'ready', endpoint });
          return;
        }
        await delay(100);
      }
      startupStage = 'cdp';
      throw new Error('Chromium debug endpoint startup timed out.');
    }
    catch {
      const reasons = {
        profile: 'Private browser profile could not be created.',
        display: 'Virtual display could not start. Verify that Xvfb is installed.',
        platform: 'Virtual-display mode requires Linux or macOS.',
        port: 'A loopback browser debugging port could not be allocated.',
        chromium: 'Chromium could not start. Verify that the browser executable is installed.',
        cdp: 'Chromium did not expose its own debugging endpoint before timeout.',
      };
      void shutdown(reasons[startupStage]);
    }
  }
  process.once('disconnect', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.on('message', (message) => {
    if (!message || typeof message !== 'object')
      return;
    if ('type' in message && message.type === 'close') {
      void shutdown();
      return;
    }
    if (started || !('type' in message) || message.type !== 'start'
      || !('executable' in message) || typeof message.executable !== 'string')
      return;
    started = true;
    startup = start(message);
  });
  if (!process.connected)
    void shutdown();
}

if (require.main === module) runBrowserSupervisor();
