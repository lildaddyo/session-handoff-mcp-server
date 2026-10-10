import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { registerHandoffTools } from './tools/handoff.js';
import { requireMcpAuth, logAuthStartupState, parseBodyLimit, parseIntEnv } from './security.js';

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

// Express 4 does not catch rejected promises from async handlers; on Node 20+
// an unhandled rejection kills the process, so one bad request could take the
// server down. Catch here and answer with a generic JSON-RPC error.
async function safeHandleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    await handleMcpRequest(req, res);
  } catch (err) {
    console.error('[session-handoff-mcp] /mcp handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
async function runHTTP(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  // Railway terminates TLS in one proxy hop; trust it so req.ip (and the
  // rate-limit key) is the real client address, not the proxy's.
  app.set('trust proxy', 1);
  // CORS first, so preflights never hit the body parser and 413/400 errors
  // still carry CORS headers a browser client can read.
  app.use(corsMiddleware);
  // 1 MB is far more than any tool call carries (a model cannot emit a
  // multi-megabyte argument); the old 10 MB limit only helped abusers.
  // MAX_BODY_SIZE is validated and capped at 4 MB (an unparseable value would
  // otherwise disable body-parser's limit entirely).
  app.use(express.json({ limit: parseBodyLimit(process.env.MAX_BODY_SIZE) }));

  // Per-IP limit on the MCP endpoint (covers /mcp and /mcp/<token>). A normal
  // session makes a handful of requests (initialize, tools/list, one or two
  // tool calls), so the default of 120/min leaves wide headroom while capping
  // CPU, Notion API burn and token guessing.
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: parseIntEnv(process.env.MCP_RATE_LIMIT_PER_MIN, 120, 1, 10_000),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  app.use('/mcp', mcpLimiter);

  // Health — no auth needed, no CORS gate. Stays up even when MCP_AUTH_TOKEN
  // is missing so Railway's healthcheck passes and the new (fail-closed)
  // deployment replaces any older one.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'session-handoff-mcp-server', version: '1.0.0' });
  });

  // MCP endpoint. Auth: /mcp/<token> (claude.ai connectors) or /mcp with
  // "Authorization: Bearer <token>" (Claude Code). See security.ts.
  // GET answers 405 directly. Routed through the stateless transport it opened
  // an SSE stream that never sends or closes (each GET held a connection open
  // until a proxy reset it). 405 + Allow: POST is what the MCP spec expects
  // from a stateless server and is what claude.ai's probe needs.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  };
  for (const path of ['/mcp', '/mcp/:token']) {
    app.get(path, requireMcpAuth, methodNotAllowed);
    app.post(path, requireMcpAuth, safeHandleMcpRequest);
  }

  // Body-parser errors (413 too large, 400 bad JSON) and anything else that
  // reaches Express's error path: answer in JSON without the stack trace the
  // default handler prints when NODE_ENV is not "production".
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const e = err as { status?: number; statusCode?: number; type?: string };
    const status = e.status ?? e.statusCode ?? 500;
    const message =
      status === 413 ? 'Request body too large'
      : status === 400 ? 'Parse error'
      : 'Internal error';
    if (status >= 500) console.error('[session-handoff-mcp] request error:', err);
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 400 ? -32700 : -32600, message }, id: null });
  });

  logAuthStartupState();
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
