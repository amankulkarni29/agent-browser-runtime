import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createAgentSdkBrowserServer } from '../../src/adapters/agent-sdk.js';
import { BrowserSession } from '../../src/index.js';

let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const configuration = z.object({
  artifactsDir: z.string(),
  calls: z.array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })),
}).parse(JSON.parse(input));

const session = new BrowserSession({ launchMode: 'headless',
  artifactsDir: configuration.artifactsDir, settleQuietMs: 50, settleTimeoutMs: 500 });
const server = createAgentSdkBrowserServer(session);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verified-actions-sdk-test', version: '1' });

try {
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const results = [];
  for (const call of configuration.calls) results.push(await client.callTool(call));
  process.stdout.write(`${JSON.stringify({ tools: tools.tools.map((tool) => tool.name), results })}\n`);
} finally {
  await client.close();
  await server.instance.close();
  await session.close();
}
