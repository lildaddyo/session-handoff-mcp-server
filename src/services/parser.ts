import type { ConversationMessage, HandoffDoc, ParsedSession } from '../types.js';

const CHARS_PER_TOKEN = 4;

export function parseConversation(rawText: string): ParsedSession {
  const messages: ConversationMessage[] = [];
  let parsed = false;

  if (rawText.trim().startsWith('[')) {
    try {
      const jsonMessages = JSON.parse(rawText) as Array<{ role: string; content: string }>;
      for (const m of jsonMessages) {
        const role = m.role === 'user' || m.role === 'human' ? 'user' : 'assistant';
        messages.push({ role, content: m.content.trim() });
      }
      parsed = true;
    } catch { /* not JSON */ }
  }

  if (!parsed) {
    const labelPattern = /^(Human|User|Claude|Assistant)\s*:\s*/im;
    if (labelPattern.test(rawText)) {
      const parts = rawText.split(/\n(?=(?:Human|User|Claude|Assistant)\s*:)/i);
      for (const part of parts) {
        const match = part.match(/^(Human|User|Claude|Assistant)\s*:\s*([\s\S]+)/i);
        if (match) {
          const role: 'user' | 'assistant' = /human|user/i.test(match[1]) ? 'user' : 'assistant';
          messages.push({ role, content: match[2].trim() });
        }
      }
      parsed = true;
    }
  }

  if (!parsed || messages.length === 0) {
    messages.push({ role: 'user', content: rawText.trim() });
  }

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  return {
    messages,
    userMessageCount: messages.filter(m => m.role === 'user').length,
    assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
    estimatedTokens: Math.round(totalChars / CHARS_PER_TOKEN),
    topics: extractTopics(messages)
  };
}

function extractTopics(messages: ConversationMessage[]): string[] {
  const topics: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const firstLine = msg.content.split('\n')[0].replace(/^[#*->\s]+/, '').trim();
      if (firstLine.length > 10 && firstLine.length < 120) topics.push(firstLine);
    }
  }
  return [...new Set(topics)].slice(0, 10);
}

export function buildHandoffDoc(session: ParsedSession, overrides: Partial<HandoffDoc> = {}): HandoffDoc {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].slice(0, 5);

  const transcriptLines: string[] = [];
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    const label = m.role === 'user' ? '👤 USER' : '🤖 CLAUDE';
    transcriptLines.push(`--- [${i + 1}] ${label} ---\n${m.content}`);
  }

  const lastMessages = session.messages.slice(-6);
  const recentContext = lastMessages
    .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`)
    .join('\n\n');

  return {
    sessionTitle: overrides.sessionTitle ?? `Session Handoff — ${dateStr} ${timeStr}`,
    sessionDate: dateStr,
    summary: overrides.summary ?? buildSummary(session),
    keyDecisions: overrides.keyDecisions ?? extractKeyDecisions(session),
    openThreads: overrides.openThreads ?? extractOpenThreads(session),
    completedWork: overrides.completedWork ?? extractCompletedWork(session),
    contextDump: overrides.contextDump ?? transcriptLines.join('\n\n'),
    continuationPrompt: buildContinuationPrompt(session, recentContext),
    ...(overrides.notionPageUrl ? { notionPageUrl: overrides.notionPageUrl } : {})
  };
}

function buildSummary(session: ParsedSession): string {
  const topicList = session.topics.slice(0, 5).join(', ');
  return `Session with ${session.userMessageCount} user turns and ${session.assistantMessageCount} Claude responses (~${session.estimatedTokens.toLocaleString()} tokens). Topics: ${topicList || 'general work session'}.`;
}

function extractKeyDecisions(session: ParsedSession): string[] {
  const decisions: string[] = [];
  for (const msg of session.messages) {
    const patterns = [
      /(?:we (?:decided|agreed|chose|going with|will use)|decision:|✅|→ (?:use|go with|deploy|build))[^\n.]+/gi,
      /(?:final (?:answer|choice|decision|plan)|confirmed)[^\n.]+/gi
    ];
    for (const pattern of patterns) {
      const matches = msg.content.match(pattern);
      if (matches) decisions.push(...matches.map(m => m.trim()).filter(m => m.length > 15 && m.length < 200));
    }
  }
  return [...new Set(decisions)].slice(0, 8);
}

function extractOpenThreads(session: ParsedSession): string[] {
  const threads: string[] = [];
  const tail = session.messages.slice(Math.floor(session.messages.length * 0.8));
  for (const msg of tail) {
    const patterns = [
      /(?:next (?:step|up|thing)|todo|to do|follow[- ]?up|still need to|need to|we should|let's)[^\n.]+/gi,
      /(?:TBD|pending|outstanding|open question)[^\n.]+/gi
    ];
    for (const pattern of patterns) {
      const matches = msg.content.match(pattern);
      if (matches) threads.push(...matches.map(m => m.trim()).filter(m => m.length > 10 && m.length < 200));
    }
  }
  return [...new Set(threads)].slice(0, 8);
}

function extractCompletedWork(session: ParsedSession): string[] {
  const work: string[] = [];
  for (const msg of session.messages) {
    if (msg.role === 'assistant') {
      const patterns = [
        /(?:created|built|deployed|shipped|finished|completed|generated|wrote|implemented|set up)[^\n.]+/gi,
        /(?:✅|done:|complete:)[^\n.]+/gi
      ];
      for (const pattern of patterns) {
        const matches = msg.content.match(pattern);
        if (matches) work.push(...matches.map(m => m.trim()).filter(m => m.length > 10 && m.length < 200));
      }
    }
  }
  return [...new Set(work)].slice(0, 8);
}

function buildContinuationPrompt(session: ParsedSession, recentContext: string): string {
  return `## 🔁 SESSION CONTINUATION PROMPT

Paste this at the start of your new session:

---
You are continuing a previous Claude session. Here is the handoff context:

**Session Stats:** ${session.userMessageCount} exchanges, ~${session.estimatedTokens.toLocaleString()} tokens

**Where we left off:**
${recentContext}

**Your task:** Pick up exactly where we left off. Review the above context and continue seamlessly.
---`;
}
