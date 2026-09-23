import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { launchBrowser } from '../../src/core/browser-launcher.js';
import { startFixtureSite } from '../fixtures/site.js';

type LaunchedBrowser = Awaited<ReturnType<typeof launchBrowser>>;
type ProcessEntry = { pid: number; parentPid: number; command: string };

const executeFile = promisify(execFile);
const activeBrowsers: LaunchedBrowser[] = [];
const originalTmpDir = process.env.TMPDIR;
let temporaryRoot: string;
let server: Server | undefined;
let url: string;

async function profiles(): Promise<string[]> {
  return (await readdir(temporaryRoot))
    .filter((name) => name.startsWith('agent-browser-display-'))
    .map((name) => join(temporaryRoot, name));
}

async function processTable(): Promise<ProcessEntry[]> {
  const { stdout } = await executeFile('ps', ['-axo', 'pid=,ppid=,command=']);
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
  });
}

async function profileProcesses(profilePaths: string[]): Promise<ProcessEntry[]> {
  const processes = await processTable();
  const owned = new Set(
    processes.filter((entry) => profilePaths.some((path) => entry.command.includes(path))).map((entry) => entry.pid),
  );
  let previousSize: number;
  do {
    previousSize = owned.size;
    for (const entry of processes) {
      if (owned.has(entry.parentPid)) owned.add(entry.pid);
    }
  } while (owned.size > previousSize);
  return processes.filter((entry) => owned.has(entry.pid));
}

async function waitUntil(check: () => Promise<boolean>, failure: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(failure);
    await delay(50);
  }
}

async function expectResourcesRemoved(profilePaths: string[], processes: ProcessEntry[]): Promise<void> {
  await waitUntil(async () => {
    const [remainingProfiles, remainingProcesses] = await Promise.all([profiles(), processTable()]);
    return !remainingProfiles.some((path) => profilePaths.includes(path)) &&
      !remainingProcesses.some((entry) => processes.some((previous) => previous.pid === entry.pid));
  }, 'Browser processes or their private profiles remained after cleanup.');
}

async function startBrowser(signal?: AbortSignal): Promise<LaunchedBrowser> {
  const launched = await launchBrowser({ launchMode: 'virtual-display' }, signal);
  activeBrowsers.push(launched);
  return launched;
}

async function waitForOwnerReady(owner: ChildProcess): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => finish(new Error('Browser owner did not start in time.')), 30_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes('launcher-ready\n')) finish();
    };
    const onErrorData = (chunk: Buffer): void => { errors = `${errors}${chunk.toString()}`.slice(-3_000); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(new Error(`Browser owner exited before launch (${code ?? signal}): ${errors}`));
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      owner.stdout?.off('data', onData);
      owner.stderr?.off('data', onErrorData);
      owner.off('exit', onExit);
      owner.off('error', finish);
      if (error) reject(error);
      else resolvePromise();
    };
    owner.stdout?.on('data', onData);
    owner.stderr?.on('data', onErrorData);
    owner.once('exit', onExit);
    owner.once('error', finish);
  });
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-browser-launcher-test-'));
  process.env.TMPDIR = temporaryRoot;
  ({ server, url } = await startFixtureSite());
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(activeBrowsers.splice(0).map((launched) => launched.close()));
});

afterAll(async () => {
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
  if (server) {
    const activeServer = server;
    await new Promise<void>((resolvePromise, reject) =>
      activeServer.close((error) => error ? reject(error) : resolvePromise()),
    );
  }
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('virtual display browser lifecycle', () => {
  it('isolates simultaneous sessions in private profiles with native browser identity', async () => {
    const results = await Promise.allSettled([startBrowser(), startBrowser()]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    const [first, second] = activeBrowsers;
    if (!first || !second) throw new Error('Both browser sessions must start.');
    const profilePaths = await profiles();
    expect(profilePaths).toHaveLength(2);
    for (const path of profilePaths) expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(first.browser).not.toBe(second.browser);
    expect(first.browser.contexts()).toEqual([first.context]);
    expect(second.browser.contexts()).toEqual([second.context]);

    const [firstPage, secondPage] = await Promise.all([first.context.newPage(), second.context.newPage()]);
    await Promise.all([firstPage.goto(url), secondPage.goto(url)]);
    await first.context.addCookies([{ name: 'session', value: 'first-browser', url }]);
    await firstPage.evaluate(() => localStorage.setItem('session', 'first-browser'));
    expect((await first.context.cookies(url)).map((cookie) => cookie.value)).toContain('first-browser');
    expect(await second.context.cookies(url)).toEqual([]);
    expect(await secondPage.evaluate(() => localStorage.getItem('session'))).toBeNull();
    expect(await firstPage.evaluate(() => navigator.userAgent)).not.toContain('HeadlessChrome');
    expect(await firstPage.evaluate(() => navigator.webdriver)).toBe(false);

    const processes = await profileProcesses(profilePaths);
    expect(processes.length).toBeGreaterThanOrEqual(2);
    await Promise.all([first.close(), second.close()]);
    await expectResourcesRemoved(profilePaths, processes);
  }, 60_000);

  it('terminates the browser and removes its profile when close is called more than once', async () => {
    const launched = await startBrowser();
    const profilePaths = await profiles();
    const processes = await profileProcesses(profilePaths);
    expect(profilePaths).toHaveLength(1);
    expect(processes.length).toBeGreaterThan(0);

    await Promise.all([launched.close(), launched.close()]);
    await launched.close();

    expect(launched.browser.isConnected()).toBe(false);
    await expectResourcesRemoved(profilePaths, processes);
  }, 30_000);

  it('removes startup resources when the browser executable cannot start', async () => {
    jest.spyOn(chromium, 'executablePath').mockReturnValue(join(temporaryRoot, 'missing-browser'));

    await expect(startBrowser()).rejects.toThrow();

    expect(await profiles()).toEqual([]);
    expect(await profileProcesses([temporaryRoot])).toEqual([]);
  }, 30_000);

  it('creates no browser resources for an already aborted launch', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(startBrowser(controller.signal)).rejects.toThrow(/abort|cancel/i);

    expect(await profiles()).toEqual([]);
    expect(await profileProcesses([temporaryRoot])).toEqual([]);
  });

  it('terminates the whole process tree when startup is aborted before CDP is ready', async () => {
    jest.spyOn(chromium, 'executablePath').mockReturnValue(resolve('test/fixtures/launcher-unresponsive-browser.cjs'));
    const controller = new AbortController();
    const launchFailure = expect(startBrowser(controller.signal)).rejects.toThrow(/abort|cancel/i);
    let profilePaths: string[] = [];
    let processes: ProcessEntry[] = [];
    try {
      await waitUntil(async () => {
        profilePaths = await profiles();
        processes = await profileProcesses(profilePaths);
        return profilePaths.length === 1 && processes.length >= 2;
      }, 'The unresponsive browser and its child did not start.');
      controller.abort();
      await launchFailure;
      await expectResourcesRemoved(profilePaths, processes);
    } finally {
      controller.abort();
      await launchFailure;
    }
  }, 30_000);

  it('closes a live browser and removes its profile when its signal is aborted', async () => {
    const controller = new AbortController();
    const launched = await startBrowser(controller.signal);
    const profilePaths = await profiles();
    const processes = await profileProcesses(profilePaths);

    controller.abort();

    await expectResourcesRemoved(profilePaths, processes);
    expect(launched.browser.isConnected()).toBe(false);
  }, 30_000);

  it('terminates browser processes and deletes their profile after the owner is killed', async () => {
    const owner = spawn(process.execPath, ['--import', 'tsx', resolve('test/fixtures/launcher-owner.ts')], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    owner.stderr?.resume();
    const ownerExit = once(owner, 'exit');
    try {
      await waitForOwnerReady(owner);
      const profilePaths = await profiles();
      const processes = await profileProcesses(profilePaths);
      expect(profilePaths).toHaveLength(1);
      expect(processes.length).toBeGreaterThan(0);

      expect(owner.kill('SIGKILL')).toBe(true);
      await ownerExit;

      await expectResourcesRemoved(profilePaths, processes);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await ownerExit;
    }
  }, 60_000);
});
