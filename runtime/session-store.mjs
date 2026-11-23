#!/usr/bin/env node
/**
 * Persistent Session Memory Store ("Trí Nhớ Phiên" của Agent)
 * Part of Agent Runtime (agent-team/runtime/session-store.mjs)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTextTokens } from './provider-gateway.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TEAM_DIR = path.resolve(__dirname, '..');
export const SESSIONS_DIR = process.env.AGENT_TEAM_STATE_DIR
  ? path.resolve(process.env.AGENT_TEAM_STATE_DIR, 'sessions')
  : path.resolve(TEAM_DIR, 'state', 'sessions');

/**
 * Generates a collision-resistant per-run identifier so retries across orchestrator
 * invocations never reuse previous runs' session JSON files.
 */
export function createTaskRunId(nowMs = Date.now()) {
  const tsPart = Number(nowMs || Date.now()).toString(36);
  const randPart = crypto.randomBytes(3).toString('hex');
  return `run-${tsPart}-${randPart}`;
}

/**
 * Builds a structured per-run session ID embedding `run_id`.
 */
export function buildTaskStepSessionId({
  taskId = 'task',
  runId = null,
  role = 'writer',
  step = null,
  bucketIndex = null,
  attempt = 1
} = {}) {
  const safeTask = String(taskId || 'task').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const safeRun = String(runId || createTaskRunId()).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const safeRole = String(role || 'writer').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  if (safeRole === 'consult') {
    return `${safeTask}-${safeRun}-consult`;
  }
  if (step !== null && step !== undefined && step !== '') {
    return `${safeTask}-${safeRun}-${safeRole}-step${step}-att${Number(attempt || 1)}`;
  }
  if (bucketIndex !== null && bucketIndex !== undefined && bucketIndex !== '') {
    return `${safeTask}-${safeRun}-${safeRole}-b${bucketIndex}-att${Number(attempt || 1)}`;
  }
  return `${safeTask}-${safeRun}-${safeRole}-att${Number(attempt || 1)}`;
}

/**
 * Archives previous/completed session JSON files for `taskId` out of `sessionsDir`
 * into `state/runs/<task>/<run>/` WITHOUT deleting any session history.
 */
export function archivePriorTaskSessions({
  taskId,
  currentRunId = null,
  onlyRunId = null,
  sessionsDir = SESSIONS_DIR,
  runsDir = path.resolve(TEAM_DIR, 'state', 'runs')
} = {}) {
  if (!taskId || !sessionsDir || !fs.existsSync(sessionsDir)) {
    return { archived: [], count: 0 };
  }
  const safeTaskSession = String(taskId).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const safeTaskRunDir = String(taskId).replace(/[^A-Za-z0-9_.-]/g, '_');
  const safeCurrentRun = currentRunId ? String(currentRunId).replace(/[^a-zA-Z0-9_\-\.]/g, '_') : null;
  const safeOnlyRun = onlyRunId ? String(onlyRunId).replace(/[^a-zA-Z0-9_\-\.]/g, '_') : null;

  const archived = [];
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return { archived: [], count: 0 };
  }

  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const fileName = ent.name;
    if (!fileName.startsWith(`${safeTaskSession}-`)) continue;

    const remainder = fileName.slice(safeTaskSession.length + 1);
    const runMatch = remainder.match(/^(run-[A-Za-z0-9]+-[A-Za-z0-9]+)-/);
    const legacyMatch = remainder.match(/^(?:writer|frontend_writer|backend_writer|designer|architect|techlead|reviewer|consult|step\d+)(?:-|\.json$)/);
    if (!runMatch && !legacyMatch) continue;

    let runFolder = runMatch ? runMatch[1] : null;
    if (safeOnlyRun && runFolder !== safeOnlyRun) continue;
    if (safeCurrentRun && runFolder === safeCurrentRun) continue;

    const srcPath = path.resolve(sessionsDir, fileName);
    if (!runFolder) {
      let tsTag = 'legacy';
      try {
        const raw = fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        const iso = parsed?.timestamps?.created_at || parsed?.timestamps?.updated_at;
        if (iso) {
          tsTag = `legacy-${String(iso).replace(/[:.]/g, '-').slice(0, 19)}`;
        }
      } catch {}
      runFolder = tsTag;
    }

    const destDir = path.resolve(runsDir, safeTaskRunDir, runFolder);
    fs.mkdirSync(destDir, { recursive: true });
    let destPath = path.resolve(destDir, fileName);
    if (fs.existsSync(destPath)) {
      const base = fileName.slice(0, -5);
      destPath = path.resolve(destDir, `${base}.${Date.now()}.json`);
    }

    try {
      fs.renameSync(srcPath, destPath);
      archived.push({ from: srcPath, to: destPath, run_dir: runFolder });
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        fs.copyFileSync(srcPath, destPath);
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(srcPath);
          archived.push({ from: srcPath, to: destPath, run_dir: runFolder });
        }
      }
    }
  }

  return { archived, count: archived.length };
}

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
export function loadSession(sessionId, role = 'general', model = '', options = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // Sanitize session ID for filesystem safety
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const targetDir = options.sessionsDir ? path.resolve(options.sessionsDir) : SESSIONS_DIR;
  const sessionPath = path.resolve(targetDir, `${safeId}.json`);

  if (fs.existsSync(sessionPath)) {
    try {
      const raw = fs.readFileSync(sessionPath, 'utf8').replace(/^\uFEFF/, '');
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
export function saveSession(session, options = {}) {
  if (!session || !session.session_id) return false;

  const safeId = session.session_id.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const targetDir = options.sessionsDir ? path.resolve(options.sessionsDir) : SESSIONS_DIR;
  const sessionPath = path.resolve(targetDir, `${safeId}.json`);
  const tmpPath = `${sessionPath}.tmp.${Date.now()}`;

  fs.mkdirSync(targetDir, { recursive: true });

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
 * Estimates total payload tokens across messages and tool schemas.
 * Normalizes Base64 image blocks (~1024 tokens per image instead of counting raw Base64 bytes)
 * and accounts for tool schema definitions + message framing overhead.
 */
export function estimatePayloadTokens(messages = [], tools = []) {
  let totalTokens = 0;

  if (Array.isArray(tools) && tools.length > 0) {
    totalTokens += estimateTextTokens(JSON.stringify(tools).length);
  }

  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m) continue;
    totalTokens += 4; // Per-message framing overhead

    if (typeof m.content === 'string') {
      totalTokens += estimateTextTokens(m.content.length);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block) continue;
        if (block.type === 'image_url' || block.type === 'image') {
          totalTokens += 1024; // Normalized vision tile token budget
        } else if (typeof block.text === 'string') {
          totalTokens += estimateTextTokens(block.text.length);
        } else {
          totalTokens += estimateTextTokens(JSON.stringify(block).length);
        }
      }
    }

    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      totalTokens += estimateTextTokens(JSON.stringify(m.tool_calls).length);
    }
  }

  return totalTokens;
}

/**
 * Groups messages into atomic turns so assistant tool-calls and their
 * corresponding tool results are NEVER separated, reordered, or orphaned.
 * Handles multiple tool calls per turn, out-of-order tool results, and missing results.
 */
export function groupMessagesIntoTurns(messages = []) {
  const turns = [];
  const consumedIndices = new Set();

  for (let i = 0; i < messages.length; i++) {
    if (consumedIndices.has(i)) continue;
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const turnMsgs = [msg];
      const expectedCallIds = msg.tool_calls.map(tc => tc.id).filter(Boolean);
      const foundResultsById = new Map();

      // Scan ahead up to the next assistant/user turn (or end of array) to collect matching tool results
      for (let j = i + 1; j < messages.length; j++) {
        if (consumedIndices.has(j)) continue;
        const candidate = messages[j];
        if (!candidate) continue;
        if (candidate.role === 'tool' && candidate.tool_call_id && expectedCallIds.includes(candidate.tool_call_id)) {
          foundResultsById.set(candidate.tool_call_id, candidate);
          consumedIndices.add(j);
        } else if (candidate.role === 'assistant' || candidate.role === 'user') {
          break;
        }
      }

      // Append tool results in the exact order declared by msg.tool_calls, synthesizing a fallback if missing
      for (const callId of expectedCallIds) {
        if (foundResultsById.has(callId)) {
          turnMsgs.push(foundResultsById.get(callId));
        } else {
          turnMsgs.push({
            role: 'tool',
            tool_call_id: callId,
            content: JSON.stringify({ ok: false, error: 'Tool result missing or interrupted' })
          });
        }
      }

      turns.push({ type: 'tool_turn', messages: turnMsgs });
    } else if (msg.role === 'tool') {
      // Orphaned tool message that didn't match any preceding assistant.tool_calls — skip
      consumedIndices.add(i);
    } else {
      turns.push({ type: msg.role || 'unknown', messages: [msg] });
    }
  }
  return turns;
}

export const COMPACTION_HIGH_WATERMARK_TOKENS = 32000;

/**
 * Context Compaction & Persistent Epoch Checkpoint:
 * - When useEpochWatermark is true and total estimated tokens <= 32,000,
 *   preserves 100% Append-Only history (with strict tool-call symmetry) to maintain upstream KV Prefix Cache.
 * - When estimated tokens exceed 32,000, compacts older turns into a persistent Epoch Checkpoint
 *   and updates the underlying session array in-place (unless options.persistCheckpoint === false)
 *   so subsequent turns drop below the watermark and resume Append-Only caching.
 */
export function compactMessagesForContext(messages = [], maxFullTurns = 2, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const turns = groupMessagesIntoTurns(messages);
  const symmetricMessages = turns.map(t => t.messages).flat();

  // Epoch Compaction Guard (SPEC Section 3.3):
  if (options.useEpochWatermark) {
    const estTokens = estimatePayloadTokens(symmetricMessages, options.tools || []);
    const watermark = options.highWatermarkTokens || COMPACTION_HIGH_WATERMARK_TOKENS;
    if (estTokens <= watermark) {
      if (options.persistCheckpoint !== false && symmetricMessages.length !== messages.length) {
        messages.splice(0, messages.length, ...symmetricMessages);
      }
      return symmetricMessages;
    }
  }

  if (turns.length <= maxFullTurns) {
    return symmetricMessages;
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
          content = `${header}\n\n[COMPACTED EPOCH SUMMARY]\nCURRENT SCOPED FILE CONTENTS:\n[... Scoped file contents omitted from earlier attempts to save tokens. Use read_file tool to inspect specific lines ...]${errorTail}`;
        } else if (content.length > 2000) {
          content = `[COMPACTED EPOCH SUMMARY]\n` + content.slice(0, 1000) + '\n[... Compacted earlier prompt context ...]';
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
    let estTokens = estimatePayloadTokens(compactedTurns.flat(), options.tools || []);
    // Keep turn 0 (initial task prompt) and recent turns, drop intermediate oldest turns if over budget
    while (estTokens > maxBudgetTokens && compactedTurns.length > Math.max(2, maxFullTurns + 1)) {
      compactedTurns.splice(1, 1); // Drop oldest intermediate turn
      estTokens = estimatePayloadTokens(compactedTurns.flat(), options.tools || []);
    }
  }

  const sanitized = compactedTurns.flat();

  // 5. Persist Epoch Checkpoint in-place when Epoch Watermark triggered compaction
  if (options.useEpochWatermark && options.persistCheckpoint !== false) {
    messages.splice(0, messages.length, ...sanitized);
  }

  return sanitized;
}
