import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import packageRoot from './package-root.cjs';

/**
 * Chromium ships with this package: it is downloaded into `<package>/.browsers` at install time,
 * and Playwright is pointed there before it loads. A caller can still set
 * PLAYWRIGHT_BROWSERS_PATH to use a shared browser cache instead.
 *
 * This module must be evaluated before anything imports `playwright`, because Playwright reads
 * PLAYWRIGHT_BROWSERS_PATH once when its registry initializes.
 */
export const PACKAGE_ROOT = packageRoot;
export const BUNDLED_BROWSERS_DIR = join(PACKAGE_ROOT, '.browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH ??= BUNDLED_BROWSERS_DIR;

let installing: Promise<void> | undefined;

/** Download the pinned Chromium build into the configured browsers directory. */
export function installBundledChromium(): Promise<void> {
  installing ??= new Promise<void>((resolvePromise, reject) => {
    const cli = join(dirname(createRequire(join(PACKAGE_ROOT, 'package.json')).resolve('playwright/package.json')), 'cli.js');
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      env: process.env,
      // stdout belongs to the MCP stdio transport, so progress goes to stderr.
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Chromium download exited with code ${code}.`));
    });
  }).finally(() => { installing = undefined; });
  return installing;
}

/**
 * Make sure the executable Playwright will launch exists. A package installed with lifecycle
 * scripts disabled (for example pnpm without approved builds) downloads Chromium on first use.
 */
export async function ensureBundledChromium(executablePath: string): Promise<void> {
  if (existsSync(executablePath)) return;
  if (process.env.AGENT_BROWSER_AUTO_INSTALL === '0') {
    throw new Error(`Chromium is missing at ${executablePath}. Run: agent-browser install-browser`);
  }
  console.error(`agent-browser: Chromium not found, downloading it into ${process.env.PLAYWRIGHT_BROWSERS_PATH}...`);
  await installBundledChromium();
  if (!existsSync(executablePath)) throw new Error(`Chromium is still missing at ${executablePath}.`);
}

/** Run a Playwright launch, downloading Chromium once and retrying if its executable is missing. */
export async function withBundledChromium<T>(launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    if (!(error instanceof Error) || !/Executable doesn't exist/i.test(error.message)
      || process.env.AGENT_BROWSER_AUTO_INSTALL === '0') throw error;
    console.error(`agent-browser: Chromium not found, downloading it into ${process.env.PLAYWRIGHT_BROWSERS_PATH}...`);
    await installBundledChromium();
    return launch();
  }
}
