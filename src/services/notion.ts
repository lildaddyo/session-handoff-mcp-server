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

  const blocks: BlockObjectRequest[] = [
    {
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: `Session Date: ${doc.sessionDate} | Auto-generated handoff document` } }],
        icon: { type: 'emoji', emoji: '🔁' },
        color: 'blue_background'
      }
    },
    { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '📋 Session Summary' } }] } },
    { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: doc.summary } }] } },
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '✅ Completed Work' } }] } },
    ...doc.completedWork.map((item): BlockObjectRequest => ({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item } }] }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '🎯 Key Decisions Made' } }] } },
    ...doc.keyDecisions.map((item): BlockObjectRequest => ({
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item } }] }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '🔓 Open Threads / Next Steps' } }] } },
    ...doc.openThreads.map((item): BlockObjectRequest => ({
      type: 'to_do',
      to_do: { rich_text: [{ type: 'text', text: { content: item } }], checked: false }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '🧠 Full Context Dump' } }] } },
    ...chunkText(doc.contextDump, 2000).map((chunk): BlockObjectRequest => ({
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] }
    })),
    { type: 'divider', divider: {} },
    { type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '🚀 Continuation Prompt' } }] } },
    {
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: doc.continuationPrompt } }],
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

function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = remaining.lastIndexOf('\n', maxLength) || maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
