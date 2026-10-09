import { Client } from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints.js';
import type { HandoffDoc, NotionPageResult } from '../types.js';

let notionClient: Client | null = null;

export function getNotionClient(): Client {
  if (!notionClient) {
    const token = process.env.NOTION_API_KEY;
    if (!token) throw new Error('NOTION_API_KEY environment variable is required');
    notionClient = new Client({ auth: token });
  }
  return notionClient;
}

export async function createHandoffPage(doc: HandoffDoc, parentPageId: string): Promise<NotionPageResult> {
  const notion = getNotionClient();

  // Notion accepts at most 100 child blocks per pages.create call. 14 blocks
  // are fixed; the lists come next; the context dump gets what is left and is
  // truncated with a note instead of failing the whole push.
  const fixedBlocks = 14 + doc.completedWork.length + doc.keyDecisions.length + doc.openThreads.length;
  const dumpBudget = Math.max(1, MAX_CHILD_BLOCKS - fixedBlocks);
  let contextBlocks = chunkText(doc.contextDump, MAX_TEXT_CONTENT);
  if (contextBlocks.length > dumpBudget) {
    contextBlocks = contextBlocks.slice(0, dumpBudget - 1);
    contextBlocks.push('[Context truncated: Notion allows 100 blocks per page create.]');
  }

  const blocks: BlockObjectRequest[] = [
    {
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: `Session Date: ${doc.sessionDate} | Auto-generated handoff document` } }],
        icon: { type: 'emoji', emoji: '🔁' },
        color: 'blue_background'
      }
    },
    { type: 'heading_2', heading_2: { rich_text: richText('📋 Session Summary') } },
    { type: 'paragraph', paragraph: { rich_text: richText(doc.summary) } },
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: richText('✅ Completed Work') } },
    ...doc.completedWork.map((item): BlockObjectRequest => ({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(item) }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: richText('🎯 Key Decisions Made') } },
    ...doc.keyDecisions.map((item): BlockObjectRequest => ({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(item) }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: richText('🔓 Open Threads / Next Steps') } },
    ...doc.openThreads.map((item): BlockObjectRequest => ({
      type: 'to_do',
      to_do: { rich_text: richText(item), checked: false }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: richText('🧠 Full Context Dump') } },
    ...contextBlocks.map((chunk): BlockObjectRequest => ({
      type: 'paragraph',
      paragraph: { rich_text: richText(chunk) }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: richText('🚀 Continuation Prompt') } },
    {
      type: 'callout',
      callout: {
        rich_text: richText(doc.continuationPrompt),
        icon: { type: 'emoji', emoji: '📎' },
        color: 'yellow_background'
      }
    }
  ];

  const response = await notion.pages.create({
    parent: { page_id: parentPageId },
    icon: { type: 'emoji', emoji: '🔁' },
    properties: {
      title: { title: [{ type: 'text', text: { content: doc.sessionTitle } }] }
    },
    children: blocks
  });

  return {
    id: response.id,
    url: (response as unknown as { url: string }).url ?? `https://notion.so/${response.id.replace(/-/g, '')}`,
    title: doc.sessionTitle
  };
}

const MAX_CHILD_BLOCKS = 100;
const MAX_TEXT_CONTENT = 2000; // Notion limit per rich_text text object
const MAX_RICH_TEXT_ITEMS = 100; // Notion limit per rich_text array

/** Splits text into <=2000-char text objects (Notion rejects longer ones). */
function richText(content: string): Array<{ type: 'text'; text: { content: string } }> {
  const parts: string[] = [];
  for (let i = 0; i < content.length; i += MAX_TEXT_CONTENT) parts.push(content.slice(i, i + MAX_TEXT_CONTENT));
  if (parts.length === 0) parts.push('');
  return parts.slice(0, MAX_RICH_TEXT_ITEMS).map(c => ({ type: 'text' as const, text: { content: c } }));
}

function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    // lastIndexOf returns -1 when there is no newline; the old `|| maxLength`
    // only caught 0, so text without newlines produced an oversized chunk.
    const nl = remaining.lastIndexOf('\n', maxLength);
    const splitAt = nl > 0 ? nl : maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
