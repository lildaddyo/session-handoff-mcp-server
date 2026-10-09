import { z } from 'zod';

// Size limits keep a single call bounded (CPU, memory, Notion payload). They
// sit well above anything a real handoff needs; the HTTP body limit (1 MB by
// default) is the outer bound.
const MAX_CONVERSATION_CHARS = 600_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_CONTEXT_DUMP_CHARS = 200_000;
const MAX_LIST_ITEMS = 25;
const MAX_ITEM_CHARS = 2_000;
const NotionPageId = z.string().max(200);
const ListItems = z.array(z.string().max(MAX_ITEM_CHARS)).max(MAX_LIST_ITEMS);

export const HandoffFullSchema = z.object({
  conversation: z.string()
    .min(50, 'Conversation content must be at least 50 characters')
    .max(MAX_CONVERSATION_CHARS)
    .describe('Full conversation text. Supports: labeled (User:/Claude:), JSON array [{role,content}], or raw text'),
  title: z.string().max(200).optional()
    .describe('Optional custom title. Default: "Session Handoff — YYYY-MM-DD HH:MM"'),
  summary: z.string().max(1000).optional()
    .describe('Optional manual summary override'),
  notion_parent_page_id: NotionPageId.optional()
    .describe('Notion parent page ID. Must be NOTION_PARENT_PAGE_ID or listed in NOTION_ALLOWED_PARENT_PAGE_IDS on the server'),
  push_to_notion: z.boolean().default(true)
    .describe('Whether to create Notion page. Default: true')
}).strict();

export const HandoffDocOnlySchema = z.object({
  conversation: z.string().min(50).max(MAX_CONVERSATION_CHARS)
    .describe('Full conversation text'),
  title: z.string().max(200).optional(),
  summary: z.string().max(1000).optional()
}).strict();

export const PushNotionSchema = z.object({
  title: z.string().min(1).max(200).describe('Page title'),
  summary: z.string().max(MAX_TEXT_CHARS).describe('Session summary'),
  completed_work: ListItems.describe('Completed work items'),
  key_decisions: ListItems.describe('Key decisions made'),
  open_threads: ListItems.describe('Open threads and next steps'),
  context_dump: z.string().max(MAX_CONTEXT_DUMP_CHARS).describe('Full transcript or context'),
  continuation_prompt: z.string().max(MAX_TEXT_CHARS).describe('Paste-ready continuation prompt'),
  notion_parent_page_id: NotionPageId.optional()
    .describe('Must be NOTION_PARENT_PAGE_ID or listed in NOTION_ALLOWED_PARENT_PAGE_IDS on the server')
}).strict();

export const ExtractContextSchema = z.object({
  conversation: z.string().min(50).max(MAX_CONVERSATION_CHARS).describe('Conversation text to analyze'),
  max_items: z.number().int().min(1).max(20).default(5)
    .describe('Max items per category. Default: 5')
}).strict();
