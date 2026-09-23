import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('Claude Agent SDK adapter', () => {
  it('publishes the browser palette through an in-process MCP server', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('test/fixtures/inspect-agent-sdk.ts')],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const tools = JSON.parse(result.stdout) as { expected: string[]; actual: string[] };
    expect(tools.actual).toEqual(tools.expected);
  });
});
