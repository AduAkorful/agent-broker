import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const env = Object.fromEntries(fs.readFileSync('/home/aduakorful/dev/agent-broker/.env','utf8').split(/\n/).map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
const token = env.BINANCE_MCP_AUTH_TOKEN;
console.log('token_len', token?.length);
const client = new Client({ name: 'probe', version: '0.0.1' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL('https://agent.binance.com/mcp/agentic'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
await client.connect(transport);
const tools = (await client.listTools()).tools;
console.log('count', tools.length);
for (const t of tools) console.log(t.name);
const search = tools.find(t => t.name === 'tool_search');
console.log('has_tool_search', !!search);
if (search) {
  const r = await client.callTool({ name: 'tool_search', arguments: { query: 'spot ticker price kline depth order book' } });
  fs.writeFileSync('/tmp/mcp-tool-search.json', JSON.stringify(r, null, 2));
  console.log('wrote tool_search result');
}
await client.close();
