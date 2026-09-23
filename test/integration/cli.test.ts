import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('CLI MCP configuration', () => {
  it('writes valid JSON to the requested file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-browser-cli-'));
    const outputPath = join(directory, 'mcp.json');

    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('src/cli.ts'), 'mcp-config', '--output', outputPath],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(0);
      const config = JSON.parse(await readFile(outputPath, 'utf8')) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };
      expect(config.mcpServers['agent-browser']).toEqual({
        command: process.execPath,
        args: [resolve('src/adapters/mcp-server.js')],
        env: { BROWSER_TRACE: '0' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
