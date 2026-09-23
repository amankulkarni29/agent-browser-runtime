#!/usr/bin/env node
import { BUNDLED_BROWSERS_DIR, installBundledChromium, withBundledChromium } from './core/bundled-browser.js';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { BrowserSession, getErrorMessage } from './index.js';

async function doctor(): Promise<void> {
  const browser = await withBundledChromium(() => chromium.launch({ headless: true }));
  const version = browser.version();
  await browser.close();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    chromium: version,
    executablePath: chromium.executablePath(),
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
    bundled: process.env.PLAYWRIGHT_BROWSERS_PATH === BUNDLED_BROWSERS_DIR,
  })}\n`);
}

async function smoke(url: string): Promise<void> {
  const session = new BrowserSession();
  try {
    const navigation = await session.navigate(url);
    const snapshot = await session.snapshot();
    const evidence = await session.evidence({ filter: 'errors', since: navigation.evidenceSince });
    const closed = await session.close();
    process.stdout.write(`${JSON.stringify({ navigation, snapshot, evidence, closed }, null, 2)}\n`);
  } finally {
    await session.close();
  }
}

function createMcpConfig(): string {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'adapters', 'mcp-server.js');
  return `${JSON.stringify(
    {
      mcpServers: {
        'agent-browser': {
          command: process.execPath,
          args: [serverPath],
          env: { BROWSER_TRACE: '0' },
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function writeMcpConfig(args: string[]): Promise<void> {
  const outputFlagIndex = args.indexOf('--output');
  if (outputFlagIndex === -1) {
    process.stdout.write(createMcpConfig());
    return;
  }

  const outputPath = args[outputFlagIndex + 1];
  if (!outputPath) throw new Error('mcp-config: --output requires a file path');

  await writeFile(outputPath, createMcpConfig(), 'utf8');
  process.stdout.write(`Wrote MCP config to ${outputPath}\n`);
}

async function main(): Promise<void> {
  const [command = 'help', value, ...args] = process.argv.slice(2);
  if (command === 'doctor') return doctor();
  if (command === 'install-browser') return installBundledChromium();
  if (command === 'smoke') return smoke(value ?? 'https://example.com');
  if (command === 'mcp-config') return writeMcpConfig(value === undefined ? args : [value, ...args]);
  process.stdout.write(
    [
      'agent-browser doctor                        # launch the bundled Chromium and print its version',
      'agent-browser install-browser               # (re)download the bundled Chromium',
      'agent-browser smoke [url]                   # navigate, snapshot, and print evidence',
      'agent-browser mcp-config [--output <file>]  # print an MCP client config for this install',
      'agent-browser-mcp                           # stdio MCP server',
    ].join('\n') + '\n',
  );
}

main().catch((error) => {
  console.error('agent-browser: command failed', { error: getErrorMessage(error) });
  process.exitCode = 1;
});
