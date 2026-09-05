import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split(/\n/).map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m=>[m[1],m[2]]));
const client = new Client({ name: 'probe', version: '0.0.1' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL('https://agent.binance.com/mcp/agentic'), { requestInit: { headers: { Authorization: 'Bearer ' + env.BINANCE_MCP_AUTH_TOKEN } } });
await client.connect(transport);
const listed = (await client.listTools()).tools;
const exec = listed.find(t=>t.name==='tool_execute');
fs.writeFileSync('/tmp/mcp-tool-execute-schema.json', JSON.stringify(exec,null,2));
console.log('exec_schema', JSON.stringify(exec?.inputSchema,null,2));
for (const [name,args] of [['spot.ticker',{symbol:'BTCUSDT'}],['spot.tickerPrice',{symbol:'BTCUSDT'}],['spot.klines',{symbol:'BTCUSDT',interval:'1h',limit:3}],['spot.depth',{symbol:'BTCUSDT',limit:5}]]) {
  try {
    const r = await client.callTool({ name, arguments: args });
    fs.writeFileSync('/tmp/mcp-call-'+name.replace('.','-')+'.json', JSON.stringify(r,null,2));
    console.log('DIRECT', name, 'ok', JSON.stringify(r).slice(0,180));
  } catch (e) { console.log('DIRECT', name, 'ERR', e.message); }
}
if (exec) {
  try {
    const r = await client.callTool({ name: 'tool_execute', arguments: { name: 'spot.ticker', arguments: { symbol: 'BTCUSDT' } } });
    console.log('EXECUTE spot.ticker', JSON.stringify(r).slice(0,200));
  } catch (e) { console.log('EXECUTE ERR', e.message); }
}
await client.close();
