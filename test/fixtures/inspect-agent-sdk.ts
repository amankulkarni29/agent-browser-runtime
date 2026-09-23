import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentSdkBrowserServer, BROWSER_TOOL_NAMES } from '../../src/adapters/agent-sdk.js';
import { BrowserSession } from '../../src/index.js';

const session = new BrowserSession();
const mcpServer = createAgentSdkBrowserServer(session);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'agent-sdk-adapter-test', version: '0.1.0' });

try {
  await mcpServer.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  process.stdout.write(
    `${JSON.stringify({
      expected: [...BROWSER_TOOL_NAMES].sort(),
      actual: tools.tools.map((item) => `mcp__browser__${item.name}`).sort(),
    })}\n`,
  );
} finally {
  await client.close();
  await mcpServer.instance.close();
  await session.close();
}
