import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split(/\n/).map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
const client = new Client({ name: 'probe', version: '0.0.1' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL('https://agent.binance.com/mcp/agentic'), { requestInit: { headers: { Authorization: 'Bearer ' + env.BINANCE_MCP_AUTH_TOKEN } } });
await client.connect(transport);
const tools = (await client.listTools()).tools;
const searchTool = tools.find(t => t.name === 'tool_search');
fs.writeFileSync('/tmp/mcp-tool-search-schema.json', JSON.stringify(searchTool, null, 2));
console.log('search_schema_keys', Object.keys(searchTool||{}));
console.log('inputSchema', JSON.stringify(searchTool?.inputSchema, null, 2));
const cats = ['spot','market','market_data','trading','data','analysis','futures','wallet','earn'];
for (const category of cats) {
  try {
    const r = await client.callTool({ name: 'tool_search', arguments: { category } });
    fs.writeFileSync('/tmp/mcp-search-'+category+'.json', JSON.stringify(r, null, 2));
    const text = (r.content||[]).map(c=>c.text||'').join('\n');
    console.log('CAT', category, 'ok', 'text_len', text.length, 'preview', text.slice(0,200).replace(/\n/g,' '));
  } catch (e) { console.log('CAT', category, 'ERR', e.message); }
}
await client.close();
