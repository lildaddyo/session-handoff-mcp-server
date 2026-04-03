import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { registerHandoffTools } from './tools/handoff.js';

// ─── CORS middleware ──────────────────────────────────────────────────────────
// claude.ai makes browser-side cross-origin requests; without these headers
// every response is silently blocked before JS can read it.
function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin ?? '*';
  const allowed =
    origin === '*' ||
    origin.endsWith('.anthropic.com') ||
    origin.endsWith('.claude.ai') ||
    origin === 'https://claude.ai';

  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : 'https://claude.ai');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, Mcp-Session-Id'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle preflight immediately — no body, no further middleware.
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

// ─── MCP handler factory ──────────────────────────────────────────────────────
// The SDK's StreamableHTTPServerTransport requires Accept to include at least
// one of: application/json OR text/event-stream.  claude.ai's browser client
// may not send both, so we normalise Accept before handing off to the transport.
function normaliseMcpAccept(req: Request): void {
  const accept = req.headers['accept'] ?? '';
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    req.headers['accept'] = 'application/json, text/event-stream';
  }
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  normaliseMcpAccept(req);
  const server = new McpServer({ name: 'session-handoff-mcp-server', version: '1.0.0' });
  registerHandoffTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close().catch(() => {}); });
  await server.connect(transport);
  // Pass body only for POST (GET has no body)
  await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(corsMiddleware);

  // Health — no auth needed, no CORS gate
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'session-handoff-mcp-server', version: '1.0.0' });
  });

  // GET /mcp — routed through the transport.
  // In stateless mode the SDK returns 405; that is correct per the MCP spec and
  // tells claude.ai "stateless HTTP, POST only".  A bare JSON response was
  // misleading and could confuse the discovery handshake.
  app.get('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  // POST /mcp — main JSON-RPC entry point
  app.post('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  const port = parseInt(process.env.PORT ?? '3000');
  app.listen(port, () =>
    console.error(`[session-handoff-mcp] HTTP server running on port ${port}`)
  );
}

// ─── Stdio server ─────────────────────────────────────────────────────────────
async function runStdio(): Promise<void> {
  const server = new McpServer({ name: 'session-handoff-mcp-server', version: '1.0.0' });
  registerHandoffTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const transport = process.env.TRANSPORT ?? 'http';
if (transport === 'http') {
  runHTTP().catch((err: unknown) => { console.error('Server error:', err); process.exit(1); });
} else {
  runStdio().catch((err: unknown) => { console.error('Server error:', err); process.exit(1); });
}
