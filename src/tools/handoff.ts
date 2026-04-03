import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHandoffPage } from '../services/notion.js';
import { parseConversation, buildHandoffDoc } from '../services/parser.js';
import { HandoffFullSchema, HandoffDocOnlySchema, PushNotionSchema, ExtractContextSchema } from '../schemas/index.js';
import type { HandoffDoc } from '../types.js';

function getParentPageId(override?: string): string {
  const id = override ?? process.env.NOTION_PARENT_PAGE_ID;
  if (!id) throw new Error('Notion parent page ID required. Pass notion_parent_page_id or set NOTION_PARENT_PAGE_ID env var');
  return id;
}

function formatHandoffOutput(doc: HandoffDoc): string {
  const lines: string[] = [
    `# ${doc.sessionTitle}`,
    `**Date:** ${doc.sessionDate}`,
    '',
    '## Summary',
    doc.summary,
    '',
    '## ✅ Completed Work',
    ...doc.completedWork.map(i => `- ${i}`),
    '',
    '## 🎯 Key Decisions',
    ...doc.keyDecisions.map(i => `- ${i}`),
    '',
    '## 🔓 Open Threads',
    ...doc.openThreads.map(i => `- [ ] ${i}`),
  ];
  if (doc.notionPageUrl) lines.push('', '## 📄 Notion Page', doc.notionPageUrl);
  lines.push('', '---', '', doc.continuationPrompt);
  return lines.join('\n');
}

export function registerHandoffTools(server: McpServer): void {

  server.registerTool('handoff_full', {
    title: 'Full Session Handoff',
    description: `PRIMARY handoff tool. Takes raw conversation → extracts structure → generates continuation prompt → pushes Notion page. One call does everything.
Args: conversation (string), title? (string), summary? (string), notion_parent_page_id? (string), push_to_notion (boolean, default true)
Returns: Full structured handoff doc + Notion URL + paste-ready continuation prompt`,
    inputSchema: HandoffFullSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (params) => {
    try {
      const session = parseConversation(params.conversation);
      const doc = buildHandoffDoc(session, {
        ...(params.title ? { sessionTitle: params.title } : {}),
        ...(params.summary ? { summary: params.summary } : {})
      });
      if (params.push_to_notion) {
        try {
          const parentId = getParentPageId(params.notion_parent_page_id);
          const notionResult = await createHandoffPage(doc, parentId);
          doc.notionPageUrl = notionResult.url;
        } catch (notionErr) {
          doc.notionPageUrl = `[Notion push failed: ${notionErr instanceof Error ? notionErr.message : String(notionErr)}]`;
        }
      }
      return { content: [{ type: 'text', text: formatHandoffOutput(doc) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  server.registerTool('handoff_generate_doc', {
    title: 'Generate Handoff Document',
    description: 'Parse conversation and generate structured handoff doc without pushing to Notion. Use for local preview or before handoff_push_notion.',
    inputSchema: HandoffDocOnlySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (params) => {
    try {
      const session = parseConversation(params.conversation);
      const doc = buildHandoffDoc(session, {
        ...(params.title ? { sessionTitle: params.title } : {}),
        ...(params.summary ? { summary: params.summary } : {})
      });
      return { content: [{ type: 'text', text: formatHandoffOutput(doc) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  server.registerTool('handoff_push_notion', {
    title: 'Push Handoff to Notion',
    description: 'Creates a structured Notion page from a pre-built handoff document. Use after reviewing handoff_generate_doc output.',
    inputSchema: PushNotionSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (params) => {
    try {
      const parentId = getParentPageId(params.notion_parent_page_id);
      const doc: HandoffDoc = {
        sessionTitle: params.title,
        sessionDate: new Date().toISOString().split('T')[0],
        summary: params.summary,
        completedWork: params.completed_work,
        keyDecisions: params.key_decisions,
        openThreads: params.open_threads,
        contextDump: params.context_dump,
        continuationPrompt: params.continuation_prompt
      };
      const result = await createHandoffPage(doc, parentId);
      return { content: [{ type: 'text', text: `✅ Notion page created!\n\nTitle: ${result.title}\nURL: ${result.url}\nID: ${result.id}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  server.registerTool('handoff_extract_context', {
    title: 'Extract Session Context',
    description: 'Lightweight mid-session scan. Returns token usage %, topics, decisions, open threads as JSON. Use to check session health without full handoff.',
    inputSchema: ExtractContextSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (params) => {
    try {
      const session = parseConversation(params.conversation);
      const doc = buildHandoffDoc(session);
      const result = {
        stats: {
          user_turns: session.userMessageCount,
          assistant_turns: session.assistantMessageCount,
          estimated_tokens: session.estimatedTokens,
          capacity_pct: Math.round((session.estimatedTokens / 200000) * 100)
        },
        topics: session.topics.slice(0, params.max_items),
        key_decisions: doc.keyDecisions.slice(0, params.max_items),
        open_threads: doc.openThreads.slice(0, params.max_items),
        completed_work: doc.completedWork.slice(0, params.max_items)
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
}
