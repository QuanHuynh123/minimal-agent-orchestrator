#!/usr/bin/env node
/**
 * Persistent Session Memory Store ("Trí Nhớ Phiên" của Agent)
 * Part of Agent Runtime (agent-team/runtime/session-store.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TEAM_DIR = path.resolve(__dirname, '..');
export const SESSIONS_DIR = path.resolve(TEAM_DIR, 'state', 'sessions');

/**
 * Initializes a new clean session object.
 */
export function createNewSession(sessionId, role = 'general', model = '') {
  return {
    session_id: sessionId,
    role,
    model,
    summary: '',
    facts: [],
    last_decisions: [],
    tool_receipts: [],
    messages: [],
    compacted_memory: [],
    timestamps: {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  };
}

/**
 * Loads an existing session from disk or creates a new one.
 */
export function loadSession(sessionId, role = 'general', model = '') {
  if (!sessionId || typeof sessionId !== 'string') {
    sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // Sanitize session ID for filesystem safety
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const sessionPath = path.resolve(SESSIONS_DIR, `${safeId}.json`);

  if (fs.existsSync(sessionPath)) {
    try {
      const raw = fs.readFileSync(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...createNewSession(safeId, role, model),
        ...parsed,
        session_id: safeId
      };
    } catch {
      // Corrupt session file, create fresh
    }
  }

  return createNewSession(safeId, role, model);
}

/**
 * Saves session object atomically to disk (.tmp rename).
 */
export function saveSession(session) {
  if (!session || !session.session_id) return false;

  const safeId = session.session_id.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const sessionPath = path.resolve(SESSIONS_DIR, `${safeId}.json`);
  const tmpPath = `${sessionPath}.tmp.${Date.now()}`;

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  session.timestamps = session.timestamps || {};
  session.timestamps.updated_at = new Date().toISOString();

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(tmpPath, sessionPath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

/**
 * Groups messages into atomic turns so assistant tool-calls and their
 * corresponding tool results are NEVER separated or orphaned during compaction.
 */
export function groupMessagesIntoTurns(messages = []) {
  const turns = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const turnMsgs = [msg];
      const callIds = new Set(msg.tool_calls.map(tc => tc.id));
      i++;
      while (i < messages.length && messages[i].role === 'tool' && callIds.has(messages[i].tool_call_id)) {
        turnMsgs.push(messages[i]);
        i++;
      }
      turns.push({ type: 'tool_turn', messages: turnMsgs });
    } else {
      turns.push({ type: msg.role || 'unknown', messages: [msg] });
      i++;
    }
  }
  return turns;
}

export const COMPACTION_HIGH_WATERMARK_TOKENS = 32000;

/**
 * Context Compaction: Compacts old tool output messages to preserve context budget.
 * Converts raw multi-hundred-line file reads into concise receipts.
 * Guarantees atomic assistant tool-call / tool-result pair integrity.
 */
export function compactMessagesForContext(messages = [], maxFullTurns = 2, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  // Epoch Compaction Guard (SPEC Section 3.3):
  // When useEpochWatermark is true and total estimated tokens <= 32,000,
  // preserve 100% Append-Only history to maintain upstream KV Prefix Cache.
  if (options.useEpochWatermark) {
    const estTokens = Math.ceil(JSON.stringify(messages).length / 3.5);
    const watermark = options.highWatermarkTokens || COMPACTION_HIGH_WATERMARK_TOKENS;
    if (estTokens <= watermark) {
      const assistantCallIds = new Set();
      for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc.id) assistantCallIds.add(tc.id);
          }
        }
      }
      return messages.filter(m => {
        if (m.role === 'tool') {
          return m.tool_call_id && assistantCallIds.has(m.tool_call_id);
        }
        return true;
      });
    }
  }

  const turns = groupMessagesIntoTurns(messages);
  if (turns.length <= maxFullTurns) {
    return messages;
  }

  const cutoffTurnIndex = Math.max(0, turns.length - maxFullTurns);
  const compactedTurns = [];

  for (let turnIdx = 0; turnIdx < turns.length; turnIdx++) {
    const turn = turns[turnIdx];

    // Always preserve recent turns in full
    if (turnIdx >= cutoffTurnIndex) {
      compactedTurns.push(turn.messages);
      continue;
    }

    // Compact older turns while preserving atomic structure
    const compactedMsgs = [];
    for (const msg of turn.messages) {
      // 1. Compact tool results into receipts
      if (msg.role === 'tool' || msg.tool_call_id) {
        let preview = '';
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.file && parsed.total_lines) {
            preview = `[Tool Output: read_file(${parsed.file}, lines ${parsed.start_line}-${parsed.end_line}) -> OK (${parsed.total_lines} total lines)]`;
          } else if (parsed.matches) {
            preview = `[Tool Output: search_code found ${parsed.count} matches]`;
          } else if (parsed.files) {
            preview = `[Tool Output: list_files returned ${parsed.total} files]`;
          } else if (parsed.ok !== undefined) {
            preview = `[Tool Output: status ok=${parsed.ok}]`;
          } else {
            preview = String(msg.content).slice(0, 120);
          }
        } catch {
          preview = String(msg.content).slice(0, 120);
        }

        compactedMsgs.push({
          ...msg,
          content: preview
        });
        continue;
      }

      // 2. Compact older assistant messages with large content (preserve tool_calls intact)
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 500) {
        compactedMsgs.push({
          ...msg,
          content: msg.content.slice(0, 300) + '\n[... Compacted previous thoughts ...]'
        });
        continue;
      }

      // 3. Compact older user messages that carried massive scoped file dumps
      if (msg.role === 'user' && typeof msg.content === 'string') {
        let content = msg.content;
        if (content.includes('CURRENT SCOPED FILE CONTENTS:')) {
          const parts = content.split('CURRENT SCOPED FILE CONTENTS:');
          const header = parts[0].trim();
          const tail = parts[1] || '';
          let errorTail = '';
          const errIdx = tail.indexOf('PREVIOUS ATTEMPT FAILED');
          if (errIdx !== -1) {
            errorTail = '\n\n' + tail.slice(errIdx).trim();
          }
          content = `${header}\n\nCURRENT SCOPED FILE CONTENTS:\n[... Scoped file contents omitted from earlier attempts to save tokens. Use read_file tool to inspect specific lines ...]${errorTail}`;
        } else if (content.length > 2000) {
          content = content.slice(0, 1000) + '\n[... Compacted earlier prompt context ...]';
        }

        compactedMsgs.push({
          ...msg,
          content
        });
        continue;
      }

      compactedMsgs.push(msg);
    }

    compactedTurns.push(compactedMsgs);
  }

  // 4. Token Budget Guard: if maxBudgetTokens is provided, prune oldest intermediate turns
  const maxBudgetTokens = options.maxBudgetTokens || 0;
  if (maxBudgetTokens > 0) {
    let estTokens = Math.ceil(JSON.stringify(compactedTurns).length / 3.5);
    // Keep turn 0 (initial task prompt) and recent turns, drop intermediate oldest turns if over budget
    while (estTokens > maxBudgetTokens && compactedTurns.length > Math.max(2, maxFullTurns + 1)) {
      compactedTurns.splice(1, 1); // Drop oldest intermediate turn
      estTokens = Math.ceil(JSON.stringify(compactedTurns).length / 3.5);
    }
  }

  const flattened = compactedTurns.flat();

  // 5. Invariant Guard: Ensure 100% matching of assistant tool_calls & tool results
  const assistantCallIds = new Set();
  for (const m of flattened) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id) assistantCallIds.add(tc.id);
      }
    }
  }

  // Clean any orphaned tool messages that have no preceding assistant call
  const sanitized = [];
  for (const m of flattened) {
    if (m.role === 'tool') {
      if (m.tool_call_id && assistantCallIds.has(m.tool_call_id)) {
        sanitized.push(m);
      }
      // If orphaned, omit silently
    } else {
      sanitized.push(m);
    }
  }

  return sanitized;
}
