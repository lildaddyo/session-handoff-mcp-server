// Run with: npm test (builds first, then runs node --test against dist/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAuthToken,
  decideAuth,
  bearerToken,
  parseBodyLimit,
  parseIntEnv,
  normaliseNotionId,
  resolveParentPageId,
  takeNotionWriteSlot,
  resetNotionWriteCap,
  publicErrorMessage,
  MIN_TOKEN_LENGTH,
} from '../dist/security.js';

const TOKEN = 'a'.repeat(20) + 'B'.repeat(20); // 40 chars

test('token: unset, blank and short tokens fail closed', () => {
  assert.deepEqual(readAuthToken({}), { ok: false, reason: 'unset' });
  assert.deepEqual(readAuthToken({ MCP_AUTH_TOKEN: '' }), { ok: false, reason: 'unset' });
  assert.deepEqual(readAuthToken({ MCP_AUTH_TOKEN: '   ' }), { ok: false, reason: 'unset' });
  assert.deepEqual(readAuthToken({ MCP_AUTH_TOKEN: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }), { ok: false, reason: 'too_short' });
  assert.deepEqual(readAuthToken({ MCP_AUTH_TOKEN: ` ${TOKEN}\n` }), { ok: true, token: TOKEN });
});

test('auth: missing credentials', () => {
  assert.equal(decideAuth(TOKEN, undefined, undefined), 'missing');
  assert.equal(decideAuth(TOKEN, undefined, ''), 'missing');
});

test('auth: path token', () => {
  assert.equal(decideAuth(TOKEN, TOKEN, undefined), 'ok');
  assert.equal(decideAuth(TOKEN, TOKEN.slice(0, -1), undefined), 'invalid');
  assert.equal(decideAuth(TOKEN, TOKEN + 'x', undefined), 'invalid');
  assert.equal(decideAuth(TOKEN, TOKEN.toLowerCase(), undefined), 'invalid');
  assert.equal(decideAuth(TOKEN, '', undefined), 'invalid');
});

test('auth: bearer header', () => {
  assert.equal(decideAuth(TOKEN, undefined, `Bearer ${TOKEN}`), 'ok');
  assert.equal(decideAuth(TOKEN, undefined, `bearer ${TOKEN}`), 'ok');
  assert.equal(decideAuth(TOKEN, undefined, `Bearer  ${TOKEN} `), 'ok');
  assert.equal(decideAuth(TOKEN, undefined, `Bearer wrong`), 'invalid');
  assert.equal(decideAuth(TOKEN, undefined, `Basic ${TOKEN}`), 'invalid');
  assert.equal(decideAuth(TOKEN, undefined, TOKEN), 'invalid');
  assert.equal(decideAuth(TOKEN, undefined, ['Bearer x']), 'invalid');
  assert.equal(bearerToken(`Bearer ${TOKEN} extra`), undefined);
});

test('auth: when both are sent, both must match', () => {
  assert.equal(decideAuth(TOKEN, TOKEN, `Bearer ${TOKEN}`), 'ok');
  assert.equal(decideAuth(TOKEN, TOKEN, 'Bearer wrong'), 'invalid');
  assert.equal(decideAuth(TOKEN, 'wrong', `Bearer ${TOKEN}`), 'invalid');
});

test('body limit parsing never disables the limit', () => {
  assert.equal(parseBodyLimit(undefined), 1024 * 1024);
  assert.equal(parseBodyLimit(''), 1024 * 1024);
  assert.equal(parseBodyLimit('garbage'), 1024 * 1024);
  assert.equal(parseBodyLimit('0'), 1024 * 1024);
  assert.equal(parseBodyLimit('-5mb'), 1024 * 1024);
  assert.equal(parseBodyLimit('512kb'), 512 * 1024);
  assert.equal(parseBodyLimit('2MB'), 2 * 1024 * 1024);
  assert.equal(parseBodyLimit('100mb'), 4 * 1024 * 1024);
  assert.equal(parseBodyLimit('200000'), 200000);
});

test('int env parsing clamps', () => {
  assert.equal(parseIntEnv(undefined, 120, 1, 10000), 120);
  assert.equal(parseIntEnv('0', 120, 1, 10000), 120);
  assert.equal(parseIntEnv('-3', 120, 1, 10000), 120);
  assert.equal(parseIntEnv('abc', 120, 1, 10000), 120);
  assert.equal(parseIntEnv('30', 120, 1, 10000), 30);
  assert.equal(parseIntEnv('999999', 120, 1, 10000), 10000);
});

const P1 = '1234567890abcdef1234567890abcdef';
const P1_DASHED = '12345678-90ab-cdef-1234-567890abcdef';
const P2 = 'fedcba0987654321fedcba0987654321';

test('notion id normalisation', () => {
  assert.equal(normaliseNotionId(P1_DASHED), P1);
  assert.equal(normaliseNotionId(P1.toUpperCase()), P1);
  assert.equal(normaliseNotionId(`https://www.notion.so/ws/My-Page-${P1}`), P1);
  assert.equal(normaliseNotionId(`https://www.notion.so/Cafe-${P1}?pvs=4#${P2}`), P1);
  assert.equal(normaliseNotionId(`https://www.notion.so/ws/${P1_DASHED}`), P1);
  assert.equal(normaliseNotionId('a' + P1), undefined); // 33-hex run is not an id
  assert.equal(normaliseNotionId('not-an-id'), undefined);
  assert.equal(normaliseNotionId(''), undefined);
});

test('parent page: default, allowlist, rejection', () => {
  const env = { NOTION_PARENT_PAGE_ID: P1_DASHED };
  assert.equal(resolveParentPageId(undefined, env), P1);
  assert.equal(resolveParentPageId('', env), P1);
  assert.equal(resolveParentPageId(P1.toUpperCase(), env), P1);
  assert.throws(() => resolveParentPageId(P2, env), /allowlist/);
  assert.throws(() => resolveParentPageId('../../etc', env), /valid Notion page id/);
  assert.equal(resolveParentPageId(P2, { ...env, NOTION_ALLOWED_PARENT_PAGE_IDS: ` x , ${P2} ` }), P2);
  assert.throws(() => resolveParentPageId(undefined, {}), /not configured/);
  // No default configured: an override is still only accepted from the allowlist.
  assert.throws(() => resolveParentPageId(P2, {}), /allowlist/);
});

test('daily Notion write cap', () => {
  resetNotionWriteCap();
  const env = { NOTION_MAX_PAGES_PER_DAY: '2' };
  const day1 = new Date('2026-10-09T10:00:00Z');
  takeNotionWriteSlot(day1, env);
  takeNotionWriteSlot(day1, env);
  assert.throws(() => takeNotionWriteSlot(day1, env), /Daily Notion page limit/);
  takeNotionWriteSlot(new Date('2026-10-10T00:00:01Z'), env); // resets on a new UTC day
  resetNotionWriteCap();
});

test('error text: Notion details are reduced to a code', () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const notionErr = Object.assign(new Error('Could not find page with ID: secret-page. Make sure the relevant pages are shared'), { code: 'object_not_found' });
    assert.equal(publicErrorMessage(notionErr, 'Notion push'), 'Notion push failed (object_not_found)');
    assert.equal(publicErrorMessage(new Error('boom: internal detail'), 'Notion push'), 'Notion push failed');
  } finally {
    console.error = orig;
  }
});
