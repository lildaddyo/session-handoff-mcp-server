import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { registerHandoffTools } from './tools/handoff.js';

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'session-handoff-mcp-server', version: '1.0.0' });
  });

  app.get('/mcp', (_req, res) => {
    res.json({
      name: 'session-handoff-mcp-server',
      version: '1.0.0',
      transport: 'streamable-http'
    });
  });

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'session-handoff-mcp-server', version: '1.0.0' });
    registerHandoffTools(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? '3000');
  app.listen(port, () => console.error(`[session-handoff-mcp] HTTP server running on port ${port}`));
}

async function runStdio(): Promise<void> {
  const server = new McpServer({ name: 'session-handoff-mcp-server', version: '1.0.0' });
  registerHandoffTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const transport = process.env.TRANSPORT ?? 'http';
if (transport === 'http') {
  runHTTP().catch((err: unknown) => { console.error('Server error:', err); process.exit(1); });
} else {
  runStdio().catch((err: unknown) => { console.error('Server error:', err); process.exit(1); });
}
