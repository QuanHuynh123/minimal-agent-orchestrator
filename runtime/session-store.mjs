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
 * Context Compaction: Compacts old tool output messages to preserve context budget.
 * Converts raw multi-hundred-line file reads into concise receipts.
 */
export function compactMessagesForContext(messages = [], maxFullTurns = 2) {
  if (!Array.isArray(messages) || messages.length <= maxFullTurns * 2) {
    return messages;
  }

  const compacted = [];
  const cutoffIndex = Math.max(0, messages.length - (maxFullTurns * 2));

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Always preserve recent messages in full
    if (i >= cutoffIndex) {
      compacted.push(msg);
      continue;
    }

    // Compact older tool execution responses
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

      compacted.push({
        ...msg,
        content: preview
      });
      continue;
    }

    // Compact older assistant messages that had large text
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 500) {
      compacted.push({
        ...msg,
        content: msg.content.slice(0, 300) + '\n[... Compacted previous thoughts ...]'
      });
      continue;
    }

    // Compact older user messages that carried massive scoped file dumps
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

      compacted.push({
        ...msg,
        content
      });
      continue;
    }

    compacted.push(msg);
  }

  return compacted;
}
