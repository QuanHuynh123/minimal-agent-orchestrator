/**
 * Prefix Invariance Checker for Multi-Turn LLM Requests.
 *
 * Verifies byte-for-byte immutability of outbound prompt prefixes across turns
 * (messages[0..N-1], tools, system, and model) so KV cache hits remain valid.
 */

import crypto from 'node:crypto';

function sha256Hex(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function extractPayloadObject(entry) {
  if (!entry || typeof entry !== 'object') return {};
  if (entry.payload && typeof entry.payload === 'object') return entry.payload;
  return entry;
}

function messageContentText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(part => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n');
  }
  return '';
}

function previewText(str, maxLen = 72) {
  const oneLine = String(str || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

function classifyPrefixMessageMutation(index, prevMsg, currMsg) {
  const prevText = messageContentText(prevMsg);
  const currText = messageContentText(currMsg);
  const hasThinkBefore = /<think>[\s\S]*?<\/think>/i.test(prevText);
  const hasThinkAfter = /<think>[\s\S]*?<\/think>/i.test(currText);

  if (prevMsg?.role === 'assistant' && hasThinkBefore && !hasThinkAfter) {
    return {
      kind: 'inline_thinking_stripped',
      likely_source: 'agent-team/runtime/index.mjs:284 -> stripOldInlineThinking (lines 34-55)',
      detail: `assistant message[${index}] had <think>...</think> stripped (${Buffer.byteLength(prevText, 'utf8')}B -> ${Buffer.byteLength(currText, 'utf8')}B)`
    };
  }

  return {
    kind: 'prefix_message_mutated',
    likely_source: 'unknown message mutation between turns',
    detail: `message[${index}] (role=${currMsg?.role || prevMsg?.role || 'unknown'}) changed: "${previewText(prevText)}" -> "${previewText(currText)}"`
  };
}

/**
 * Inspects consecutive outbound HTTP payloads from a multi-turn agent loop.
 *
 * @param {Array<Object>} capturedPayloads
 * @returns {{ ok: boolean, total_turns: number, first_break_turn: number|null, breaks: Array<Object> }}
 */
export function inspectPayloadPrefixInvariance(capturedPayloads = []) {
  const list = Array.isArray(capturedPayloads) ? capturedPayloads : [];
  const breaks = [];

  for (let i = 0; i < list.length - 1; i++) {
    const fromTurn = i + 1;
    const toTurn = i + 2;
    const prev = extractPayloadObject(list[i]);
    const curr = extractPayloadObject(list[i + 1]);

    if ((prev.model || null) !== (curr.model || null)) {
      breaks.push({
        from_turn: fromTurn,
        to_turn: toTurn,
        kind: 'model_changed',
        likely_source: 'provider failover or dynamic model switch mid-loop',
        detail: `model changed from ${prev.model || 'null'} to ${curr.model || 'null'}`
      });
    }

    const prevSystemJson = JSON.stringify(prev.system ?? null);
    const currSystemJson = JSON.stringify(curr.system ?? null);
    if (prevSystemJson !== currSystemJson) {
      breaks.push({
        from_turn: fromTurn,
        to_turn: toTurn,
        kind: 'system_changed',
        likely_source: 'system prompt mutated between turns',
        detail: `system field bytes changed (${Buffer.byteLength(prevSystemJson, 'utf8')}B -> ${Buffer.byteLength(currSystemJson, 'utf8')}B)`
      });
    }

    const prevToolsJson = JSON.stringify(prev.tools ?? null);
    const currToolsJson = JSON.stringify(curr.tools ?? null);
    if (prevToolsJson !== currToolsJson) {
      const prevHasTools = Array.isArray(prev.tools) && prev.tools.length > 0;
      const currMissingTools = !Array.isArray(curr.tools) || curr.tools.length === 0;
      if (prevHasTools && currMissingTools) {
        const currToolsState = curr.tools === null ? 'null' : (curr.tools === undefined ? 'omitted' : 'empty');
        breaks.push({
          from_turn: fromTurn,
          to_turn: toTurn,
          kind: 'tools_dropped',
          likely_source: 'agent-team/runtime/index.mjs:448 (synthesis tools: null) or agent-team/scripts/goal-planner.mjs:247 (disableTools: true)',
          detail: `tools dropped from ${prev.tools.length} definitions to ${currToolsState}`
        });
      } else {
        breaks.push({
          from_turn: fromTurn,
          to_turn: toTurn,
          kind: 'tools_changed',
          likely_source: 'tool definitions changed mid-session',
          detail: `tools JSON changed (${Buffer.byteLength(prevToolsJson, 'utf8')}B -> ${Buffer.byteLength(currToolsJson, 'utf8')}B)`
        });
      }
    }

    const prevMessages = Array.isArray(prev.messages) ? prev.messages : [];
    const currMessages = Array.isArray(curr.messages) ? curr.messages : [];
    if (currMessages.length < prevMessages.length) {
      breaks.push({
        from_turn: fromTurn,
        to_turn: toTurn,
        kind: 'messages_truncated',
        likely_source: 'agent-team/runtime/index.mjs (history truncation)',
        detail: `messages length shrank from ${prevMessages.length} to ${currMessages.length}`
      });
    }

    const prefixLen = Math.min(prevMessages.length, currMessages.length);
    for (let msgIdx = 0; msgIdx < prefixLen; msgIdx++) {
      const prevMsgJson = JSON.stringify(prevMessages[msgIdx]);
      const currMsgJson = JSON.stringify(currMessages[msgIdx]);
      if (prevMsgJson !== currMsgJson) {
        const classified = classifyPrefixMessageMutation(msgIdx, prevMessages[msgIdx], currMessages[msgIdx]);
        breaks.push({
          from_turn: fromTurn,
          to_turn: toTurn,
          message_index: msgIdx,
          role: currMessages[msgIdx]?.role || prevMessages[msgIdx]?.role || 'unknown',
          prev_bytes: Buffer.byteLength(prevMsgJson, 'utf8'),
          curr_bytes: Buffer.byteLength(currMsgJson, 'utf8'),
          ...classified
        });
      }
    }
  }

  return {
    ok: breaks.length === 0,
    total_turns: list.length,
    first_break_turn: breaks.length > 0 ? breaks[0].to_turn : null,
    breaks
  };
}

/**
 * Throws an assertion error if outbound turn prefixes are not byte-identical.
 *
 * @param {Array<Object>} capturedPayloads
 * @param {string} label
 * @returns {Object}
 */
export function assertPrefixInvariant(capturedPayloads, label = 'agent-loop') {
  const report = inspectPayloadPrefixInvariance(capturedPayloads);
  if (!report.ok) {
    const lines = report.breaks.map(b =>
      `  Turn ${b.from_turn}->${b.to_turn} [${b.kind}]` +
      (b.message_index !== undefined ? ` msg[${b.message_index}]` : '') +
      ` (${b.likely_source}): ${b.detail}`
    );
    throw new Error(`Prefix invariance failed for ${label} (${report.breaks.length} break(s)):\n${lines.join('\n')}`);
  }
  return report;
}

const KNOWN_USER_SECTION_PREFIXES = [
  { label: 'USER GOAL', rx: /^USER GOAL:/i },
  { label: 'TASK ID / HEADER', rx: /^TASK ID:/i },
  { label: 'ALLOWED DIRECTORIES', rx: /^ALLOWED DIRECTORIES:/i },
  { label: 'AVAILABLE SQUAD MODELS', rx: /^AVAILABLE SQUAD MODELS:/i },
  { label: 'PROJECT CONVENTIONS', rx: /^<project_conventions\b/i },
  { label: 'AVAILABLE WORKSPACE FILES', rx: /^AVAILABLE WORKSPACE FILES\b/i },
  { label: 'CODEBASE SKELETON & SYMBOL MAP', rx: /^CODEBASE SKELETON & SYMBOL MAP\b/i },
  { label: 'GOAL-FOCUSED SYMBOL & IMPORT GRAPH', rx: /^GOAL-FOCUSED SYMBOL & IMPORT GRAPH\b/i },
  { label: 'EMBEDDED CODE SNIPPETS', rx: /^(?:EMBEDDED CODE SNIPPETS|DETERMINISTIC PRE-LOOKUP CANDIDATES)\b/i },
  { label: 'DIRECTIVE', rx: /^DIRECTIVE:/i },
  { label: 'INSTRUCTION', rx: /^INSTRUCTION(?:\s|\(|:)/i }
];

function detectVolatileMarkers(text = '') {
  const markers = [];
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) markers.push('iso_timestamp');
  if (/\bT-\d{4}-\d{2}-\d{2}-\d{4}-\d+\b/.test(text)) markers.push('task_id');
  if (/\bplanner-[a-z0-9]+\b/i.test(text)) markers.push('session_id');
  return markers;
}

export function splitPromptSectionsForHash(text = '') {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const paragraphs = raw.split(/\n\n+/);
  const sections = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const matched = KNOWN_USER_SECTION_PREFIXES.find(s => s.rx.test(trimmed));
    if (matched) {
      sections.push({ label: matched.label, chunks: [trimmed] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].chunks.push(trimmed);
    } else {
      sections.push({ label: 'UNLABELED_PREFIX', chunks: [trimmed] });
    }
  }

  return sections.map((s, idx) => ({
    index: idx,
    label: s.label,
    text: s.chunks.join('\n\n')
  }));
}

/**
 * Computes per-part SHA-256 hashes (model, system, tools, messages[i], and user prompt subsections)
 * between two offline Turn-1 payloads and identifies volatile sections appearing before static ones.
 *
 * @param {Object} run1Payload
 * @param {Object} run2Payload
 */
export function analyzeTurn1PayloadHashes(run1Payload, run2Payload) {
  const p1 = extractPayloadObject(run1Payload);
  const p2 = extractPayloadObject(run2Payload);

  const msgs1 = Array.isArray(p1.messages) ? p1.messages : [];
  const msgs2 = Array.isArray(p2.messages) ? p2.messages : [];

  const sysMsg1 = p1.system !== undefined ? p1.system : (msgs1.find(m => m?.role === 'system')?.content ?? null);
  const sysMsg2 = p2.system !== undefined ? p2.system : (msgs2.find(m => m?.role === 'system')?.content ?? null);
  const sysHash1 = sha256Hex(sysMsg1);
  const sysHash2 = sha256Hex(sysMsg2);

  const tools1 = p1.tools ?? null;
  const tools2 = p2.tools ?? null;
  const toolsHash1 = sha256Hex(tools1);
  const toolsHash2 = sha256Hex(tools2);

  const modelHash1 = sha256Hex(p1.model ?? null);
  const modelHash2 = sha256Hex(p2.model ?? null);

  const parts = [
    {
      part: 'model',
      bytes_1: Buffer.byteLength(JSON.stringify(p1.model ?? null), 'utf8'),
      bytes_2: Buffer.byteLength(JSON.stringify(p2.model ?? null), 'utf8'),
      sha256_1: modelHash1,
      sha256_2: modelHash2,
      equal: modelHash1 === modelHash2
    },
    {
      part: 'system',
      bytes_1: Buffer.byteLength(typeof sysMsg1 === 'string' ? sysMsg1 : JSON.stringify(sysMsg1 ?? null), 'utf8'),
      bytes_2: Buffer.byteLength(typeof sysMsg2 === 'string' ? sysMsg2 : JSON.stringify(sysMsg2 ?? null), 'utf8'),
      sha256_1: sysHash1,
      sha256_2: sysHash2,
      equal: sysHash1 === sysHash2
    },
    {
      part: 'tools',
      bytes_1: Buffer.byteLength(JSON.stringify(tools1), 'utf8'),
      bytes_2: Buffer.byteLength(JSON.stringify(tools2), 'utf8'),
      sha256_1: toolsHash1,
      sha256_2: toolsHash2,
      equal: toolsHash1 === toolsHash2
    }
  ];

  const maxMsgs = Math.max(msgs1.length, msgs2.length);
  const messages = [];
  for (let i = 0; i < maxMsgs; i++) {
    const m1 = msgs1[i] ?? null;
    const m2 = msgs2[i] ?? null;
    const j1 = JSON.stringify(m1);
    const j2 = JSON.stringify(m2);
    const h1 = sha256Hex(j1);
    const h2 = sha256Hex(j2);
    const entry = {
      index: i,
      part: `messages[${i}]`,
      role_1: m1?.role || null,
      role_2: m2?.role || null,
      bytes_1: Buffer.byteLength(j1, 'utf8'),
      bytes_2: Buffer.byteLength(j2, 'utf8'),
      sha256_1: h1,
      sha256_2: h2,
      equal: h1 === h2
    };
    messages.push(entry);
    parts.push(entry);
  }

  const u1 = msgs1.find(m => m?.role === 'user') || null;
  const u2 = msgs2.find(m => m?.role === 'user') || null;
  const secs1 = splitPromptSectionsForHash(messageContentText(u1));
  const secs2 = splitPromptSectionsForHash(messageContentText(u2));
  const sec2ByLabel = new Map(secs2.map(s => [s.label, s]));

  const userSubsections = secs1.map((s1, idx) => {
    const s2 = secs2[idx]?.label === s1.label ? secs2[idx] : sec2ByLabel.get(s1.label) || null;
    const h1 = sha256Hex(s1.text);
    const h2 = s2 ? sha256Hex(s2.text) : null;
    const equal = Boolean(s2 && h1 === h2 && secs2[idx]?.label === s1.label);
    const volatileReasons = [];
    if (!equal) {
      if (s1.label === 'USER GOAL') volatileReasons.push('user_goal_text');
      else if (s1.label === 'CODEBASE SKELETON & SYMBOL MAP') volatileReasons.push('query_ranked_skeleton');
      else if (s1.label === 'GOAL-FOCUSED SYMBOL & IMPORT GRAPH') volatileReasons.push('query_focused_symbol_graph');
      else if (s1.label === 'EMBEDDED CODE SNIPPETS') volatileReasons.push('query_prelookup_matches');
      else if (s1.label === 'DIRECTIVE') volatileReasons.push('conditional_intent_directive');
      else if (s1.label === 'PROJECT CONVENTIONS') volatileReasons.push('repo_rules_changed');
      else volatileReasons.push('content_or_position_changed');
      volatileReasons.push(...detectVolatileMarkers(s1.text));
      if (s2) volatileReasons.push(...detectVolatileMarkers(s2.text));
    }
    return {
      index: idx,
      label: s1.label,
      bytes_1: Buffer.byteLength(s1.text, 'utf8'),
      bytes_2: s2 ? Buffer.byteLength(s2.text, 'utf8') : 0,
      sha256_1: h1,
      sha256_2: h2,
      equal,
      volatile_reasons: [...new Set(volatileReasons)]
    };
  });

  // Flag any volatile subsection appearing BEFORE at least one static subsection
  const lastStaticIdx = userSubsections.reduce((acc, s, i) => (s.equal ? i : acc), -1);
  const volatileBeforeStatic = userSubsections
    .filter((s, idx) => !s.equal && lastStaticIdx !== -1 && idx < lastStaticIdx)
    .map(s => ({
      index: s.index,
      label: s.label,
      precedes_static_through_index: lastStaticIdx,
      reasons: s.volatile_reasons
    }));

  return {
    model_hash_equal: modelHash1 === modelHash2,
    system_hash_equal: sysHash1 === sysHash2,
    tools_hash_equal: toolsHash1 === toolsHash2,
    parts,
    messages,
    differing_parts: parts.filter(p => !p.equal).map(p => p.part),
    user_subsections: userSubsections,
    volatile_before_static: volatileBeforeStatic
  };
}
