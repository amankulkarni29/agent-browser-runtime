#!/usr/bin/env node
// Downloads the pinned Chromium build into <package>/.browsers so the runtime is self-contained.
// Set AGENT_BROWSER_SKIP_BROWSER_DOWNLOAD=1 (or PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1) to skip,
// for example when PLAYWRIGHT_BROWSERS_PATH points at a browser cache you manage yourself.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.AGENT_BROWSER_SKIP_BROWSER_DOWNLOAD === '1' || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  console.log('agent-browser: skipping Chromium download.');
  process.exit(0);
}

const require = createRequire(join(packageRoot, 'package.json'));
const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(packageRoot, '.browsers') };
console.log(`agent-browser: installing Chromium into ${env.PLAYWRIGHT_BROWSERS_PATH}`);
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], { env, stdio: 'inherit' });
if (result.status !== 0) {
  // Never fail the package install. The runtime downloads Chromium on first launch instead.
  console.warn('agent-browser: Chromium download failed. It will be retried on first launch, or run: agent-browser install-browser');
}
