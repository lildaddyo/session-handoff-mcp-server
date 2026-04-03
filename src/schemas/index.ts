import { z } from 'zod';

export const HandoffFullSchema = z.object({
  conversation: z.string()
    .min(50, 'Conversation content must be at least 50 characters')
    .describe('Full conversation text. Supports: labeled (User:/Claude:), JSON array [{role,content}], or raw text'),
  title: z.string().max(200).optional()
    .describe('Optional custom title. Default: "Session Handoff — YYYY-MM-DD HH:MM"'),
  summary: z.string().max(1000).optional()
    .describe('Optional manual summary override'),
  notion_parent_page_id: z.string().optional()
    .describe('Notion parent page ID. Overrides NOTION_PARENT_PAGE_ID env var'),
  push_to_notion: z.boolean().default(true)
    .describe('Whether to create Notion page. Default: true')
}).strict();

export const HandoffDocOnlySchema = z.object({
  conversation: z.string().min(50)
    .describe('Full conversation text'),
  title: z.string().max(200).optional(),
  summary: z.string().max(1000).optional()
}).strict();

export const PushNotionSchema = z.object({
  title: z.string().min(1).max(200).describe('Page title'),
  summary: z.string().describe('Session summary'),
  completed_work: z.array(z.string()).describe('Completed work items'),
  key_decisions: z.array(z.string()).describe('Key decisions made'),
  open_threads: z.array(z.string()).describe('Open threads and next steps'),
  context_dump: z.string().describe('Full transcript or context'),
  continuation_prompt: z.string().describe('Paste-ready continuation prompt'),
  notion_parent_page_id: z.string().optional()
}).strict();

export const ExtractContextSchema = z.object({
  conversation: z.string().min(50).describe('Conversation text to analyze'),
  max_items: z.number().int().min(1).max(20).default(5)
    .describe('Max items per category. Default: 5')
}).strict();
