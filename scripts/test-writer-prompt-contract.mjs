#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoleSystemPrompt } from '../runtime/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const WRITER_MD_PATH = path.join(TEAM_DIR, 'roles', 'writer.md');

console.log('Testing Item 4: Writer system prompt contract & anti-hallucination rules...\n');

const rawPrompt = fs.readFileSync(WRITER_MD_PATH, 'utf8');
assert.ok(rawPrompt.length <= 4500, `writer.md must remain concise (< 4500 chars), got ${rawPrompt.length}`);

// 1. Only author SEARCH from directly observed text (window, read_file, ACTUAL FILE CONTENT)
assert.match(rawPrompt, /read_file/, 'writer.md must reference read_file');
assert.match(rawPrompt, /ACTUAL FILE CONTENT/, 'writer.md must reference ACTUAL FILE CONTENT returned by Applier');
assert.match(
  rawPrompt,
  /(?:CHỈ|chi)[^.\n]{0,80}SEARCH[^.\n]{0,120}(?:đã nhìn thấy|đã thấy|đã đọc)/i,
  'writer.md must require SEARCH blocks ONLY from text already seen'
);

// 2. Forbid writing SEARCH from memory when target region is unseen; allow parallel read_file in 1 turn
assert.match(
  rawPrompt,
  /(?:từ trí nhớ|trong trí nhớ|suy đoán|bịa)/i,
  'writer.md must explicitly forbid reconstructing SEARCH from memory'
);
assert.match(
  rawPrompt,
  /(?:nhiều\s+`?read_file`?.*(?:1|một)\s+lượt|parallel|cùng\s+lúc)/i,
  'writer.md must explain calling multiple read_file calls in 1 turn'
);
assert.match(
  rawPrompt,
  /thiếu ngữ cảnh/i,
  'writer.md must specify reporting missing context if target section cannot be read'
);

// 3. Keep SEARCH blocks concise (anchor lines only, avoid huge multi-dozen-line blocks)
assert.match(
  rawPrompt,
  /(?:ngắn gọn|vài dòng neo|neo vừa đủ)/i,
  'writer.md must advise keeping SEARCH blocks concise with only a few unique anchor lines'
);

// 4. Verify loadRoleSystemPrompt('writer') loads these rules
const loadedPrompt = loadRoleSystemPrompt('writer');
assert.ok(loadedPrompt.includes('ACTUAL FILE CONTENT'), 'loadRoleSystemPrompt("writer") must return updated writer.md rules');

console.log('✓ All Item 4 Writer prompt snapshot/contract checks passed.');
