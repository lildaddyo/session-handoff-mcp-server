import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// ─── Auth token ───────────────────────────────────────────────────────────────
// The HTTP transport writes to Notion with the server's NOTION_API_KEY, so
// every /mcp request must carry the shared secret MCP_AUTH_TOKEN, either as
//   - a path segment:  /mcp/<token>   (claude.ai custom connectors, which cannot
//                                      send custom headers), or
//   - a header:        Authorization: Bearer <token>   (Claude Code, scripts).
// If both are sent, both must match. Comparison is constant-time.
//
// Fail closed: when MCP_AUTH_TOKEN is unset, empty, or shorter than
// MIN_TOKEN_LENGTH, every /mcp request gets 503. /health stays up so a
// Railway deploy still passes its healthcheck (a failed healthcheck would
// leave the OLD, unauthenticated deployment serving traffic).

export const MIN_TOKEN_LENGTH = 32;

export type TokenState =
  | { ok: true; token: string }
  | { ok: false; reason: 'unset' | 'too_short' };

export function readAuthToken(env: NodeJS.ProcessEnv = process.env): TokenState {
  const raw = (env.MCP_AUTH_TOKEN ?? '').trim();
  if (!raw) return { ok: false, reason: 'unset' };
  if (raw.length < MIN_TOKEN_LENGTH) return { ok: false, reason: 'too_short' };
  return { ok: true, token: raw };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string compare (hashing first removes the length leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** Extracts the token from "Authorization: Bearer <token>" (scheme is case-insensitive). */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : undefined;
}

export type AuthDecision = 'ok' | 'missing' | 'invalid';

/** Pure decision function, exported for tests. */
export function decideAuth(
  expected: string,
  pathToken: string | undefined,
  authorizationHeader: string | string[] | undefined
): AuthDecision {
  const headerPresent = authorizationHeader !== undefined && authorizationHeader !== '';
  const fromHeader = bearerToken(authorizationHeader);
  const pathPresent = pathToken !== undefined;

  if (!pathPresent && !headerPresent) return 'missing';
  // A malformed Authorization header (not "Bearer <token>") is a failure, not
  // something to silently ignore.
  if (headerPresent && (fromHeader === undefined || !safeEqual(fromHeader, expected))) return 'invalid';
  if (pathPresent && !safeEqual(pathToken, expected)) return 'invalid';
  return 'ok';
}

function jsonRpcError(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

let warnedUnset = false;

export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const state = readAuthToken();
  if (!state.ok) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.error(
        `[session-handoff-mcp] SECURITY: MCP_AUTH_TOKEN is ${state.reason === 'unset' ? 'not set' : `shorter than ${MIN_TOKEN_LENGTH} chars`}; ` +
          'refusing every /mcp request (fail closed). Set a random token of at least ' +
          `${MIN_TOKEN_LENGTH} characters and redeploy.`
      );
    }
    jsonRpcError(res, 503, 'Server is not configured for authenticated access');
    return;
  }
  const pathToken = typeof req.params?.token === 'string' ? req.params.token : undefined;
  const decision = decideAuth(state.token, pathToken, req.headers.authorization);
  if (decision !== 'ok') {
    res.setHeader('WWW-Authenticate', 'Bearer realm="session-handoff-mcp"');
    jsonRpcError(res, 401, 'Unauthorized');
    return;
  }
  next();
}

export function logAuthStartupState(): void {
  const state = readAuthToken();
  if (state.ok) {
    console.error('[session-handoff-mcp] /mcp auth: enabled (path token or Bearer header).');
  } else {
    console.error(
      `[session-handoff-mcp] SECURITY WARNING: MCP_AUTH_TOKEN ${state.reason === 'unset' ? 'is not set' : 'is too short'}. ` +
        'All /mcp requests will be refused with 503 until it is set.'
    );
  }
}

// ─── Body size ────────────────────────────────────────────────────────────────
const DEFAULT_BODY_BYTES = 1024 * 1024; // 1 MB
const MAX_BODY_BYTES = 4 * 1024 * 1024; // hard ceiling, whatever the env says

/**
 * Parses MAX_BODY_SIZE ("512kb", "1mb", "200000"). Invalid, empty, zero or
 * oversized values fall back to the default/ceiling instead of reaching
 * body-parser, which treats an unparseable limit as "no limit".
 */
export function parseBodyLimit(raw: string | undefined): number {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return DEFAULT_BODY_BYTES;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/.exec(v);
  if (!m) return DEFAULT_BODY_BYTES;
  const mult = m[2] === 'mb' ? 1024 * 1024 : m[2] === 'kb' ? 1024 : 1;
  const bytes = Math.floor(parseFloat(m[1]) * mult);
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_BODY_BYTES;
  return Math.min(bytes, MAX_BODY_BYTES);
}

/** Positive integer from env, clamped to [min, max]; falls back on anything invalid. */
export function parseIntEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

// ─── Notion parent page allowlist ─────────────────────────────────────────────
/** Normalises a Notion page id or URL to 32 lowercase hex chars, or undefined. */
export function normaliseNotionId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Drop ?query and #fragment (a #fragment can hold a block id).
  const s = value.trim().toLowerCase().replace(/[?#].*$/, '');
  // Dashed UUID form: 8-4-4-4-12.
  const dashed = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
  if (dashed) return dashed[dashed.length - 1].replace(/-/g, '');
  // Compact form: an exact 32-hex run, not part of a longer hex run. Dashes are
  // kept here so a URL slug ("My-Page-<id>") cannot merge into the id.
  const compact = [...s.matchAll(/(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])/g)];
  // Take the last one (Notion URLs end with the id).
  return compact.length ? compact[compact.length - 1][1] : undefined;
}

/**
 * Resolves the parent page for a Notion write. A caller-supplied override is
 * only honoured if it is the configured default (NOTION_PARENT_PAGE_ID) or is
 * listed in NOTION_ALLOWED_PARENT_PAGE_IDS (comma-separated ids or URLs).
 */
export function resolveParentPageId(override: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const defaultId = normaliseNotionId(env.NOTION_PARENT_PAGE_ID);
  if (override === undefined || override.trim() === '') {
    if (!defaultId) throw new UserFacingError('Notion parent page is not configured on the server (NOTION_PARENT_PAGE_ID)');
    return defaultId;
  }
  const wanted = normaliseNotionId(override);
  if (!wanted) throw new UserFacingError('notion_parent_page_id is not a valid Notion page id');
  const allowed = new Set<string>();
  if (defaultId) allowed.add(defaultId);
  for (const part of (env.NOTION_ALLOWED_PARENT_PAGE_IDS ?? '').split(',')) {
    const id = normaliseNotionId(part);
    if (id) allowed.add(id);
  }
  if (!allowed.has(wanted)) {
    throw new UserFacingError('notion_parent_page_id is not on the server allowlist (NOTION_ALLOWED_PARENT_PAGE_IDS)');
  }
  return wanted;
}

// ─── Global Notion write cap ──────────────────────────────────────────────────
// A process-wide cap on Notion pages created per UTC day, on top of the
// per-IP request limit, so a leaked token cannot flood the workspace.
let capDay = '';
let capCount = 0;

export function takeNotionWriteSlot(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): void {
  const limit = parseIntEnv(env.NOTION_MAX_PAGES_PER_DAY, 50, 1, 10_000);
  const day = now.toISOString().slice(0, 10);
  if (day !== capDay) {
    capDay = day;
    capCount = 0;
  }
  if (capCount >= limit) {
    throw new UserFacingError(`Daily Notion page limit reached (${limit}/day); try again tomorrow (UTC)`);
  }
  capCount += 1;
}

/** Test helper. */
export function resetNotionWriteCap(): void {
  capDay = '';
  capCount = 0;
}

// ─── Safe error text ──────────────────────────────────────────────────────────
/**
 * Error text that is safe to return to an MCP caller: our own validation
 * messages pass through, Notion API errors are reduced to their code, anything
 * else becomes a generic message. The full error is logged server-side.
 */
export class UserFacingError extends Error {}

export function publicErrorMessage(err: unknown, context: string): string {
  if (err instanceof UserFacingError) return err.message;
  console.error(`[session-handoff-mcp] ${context} failed:`, err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z_]{3,40}$/.test(code)) return `${context} failed (${code})`;
  return `${context} failed`;
}
