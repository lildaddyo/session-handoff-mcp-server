export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HandoffDoc {
  sessionTitle: string;
  sessionDate: string;
  summary: string;
  keyDecisions: string[];
  openThreads: string[];
  completedWork: string[];
  contextDump: string;
  continuationPrompt: string;
  notionPageUrl?: string;
}

export interface ParsedSession {
  messages: ConversationMessage[];
  userMessageCount: number;
  assistantMessageCount: number;
  estimatedTokens: number;
  topics: string[];
}

export interface NotionPageResult {
  id: string;
  url: string;
  title: string;
}
