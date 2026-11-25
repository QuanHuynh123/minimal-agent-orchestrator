#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function main() {
  const appJs = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
  const modalHtml = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'layouts', 'layout-config-modal.html'), 'utf8');

  // 1. Neither app.js ROLE_DOSSIER_DATA nor layout-config-modal.html should show raw "(Đọc từ team.yaml..." placeholders when empty
  assert.ok(
    !appJs.includes('(Đọc từ team.yaml'),
    'app.js ROLE_DOSSIER_DATA must replace "(Đọc từ team.yaml...)" placeholders with capability descriptions'
  );
  assert.ok(
    !modalHtml.includes('(Đọc từ team.yaml'),
    'layout-config-modal.html must replace "(Đọc từ team.yaml)" placeholders with capability descriptions'
  );

  // 2. Empty-config defaults must describe capabilities in Vietnamese without any model IDs
  const dossierBlockMatch = /const ROLE_DOSSIER_CATALOG\s*=\s*\{([\s\S]*?)\r?\n\s{4}\};/.exec(appJs);
  assert.ok(dossierBlockMatch, 'ROLE_DOSSIER_CATALOG block must exist in app.js');
  const block = dossierBlockMatch[1];

  const capabilityMarkers = [
    /Năng lực:/,
    /Vision/i,
    /SEARCH\/REPLACE/,
    /Anti-Self-Review/i
  ];
  for (const rx of capabilityMarkers) {
    assert.match(block, rx, `ROLE_DOSSIER_DATA must include capability description matching ${rx}`);
  }

  // Must not embed hardcoded vendor/model slugs in ROLE_DOSSIER_DATA or static recommendation HTML
  const forbiddenSlugs = /\b(?:ag|kr|deepseek-ai)\/|\bclaude-(?:sonnet|opus|haiku)-\d|\bgemini-\d|\bdeepseek-v\d/i;
  assert.doesNotMatch(block, forbiddenSlugs, 'ROLE_DOSSIER_DATA must NOT contain hardcoded model IDs');
  assert.ok(/\barchitect:\s*\{/.test(block), 'ROLE_DOSSIER_CATALOG must document architect role');
  const recSectionMatch = /<div class="dossier-rec-card">([\s\S]*?)<\/div>\s*<\/div>\s*<!-- COLUMN 2/.exec(modalHtml);
  assert.ok(recSectionMatch, 'dossier-rec-card section must exist in layout-config-modal.html');
  assert.doesNotMatch(recSectionMatch[1], forbiddenSlugs, 'Static Role Dossier HTML must NOT contain hardcoded model IDs');

  // 3. When team.yaml DOES configure models, renderRoleDossier still prefers live cfgPrimary/cfgSecondary
  assert.ok(
    appJs.includes("setTxt('dossier-rec-primary', cfgPrimary || roleInfo.rec.primary);")
      && appJs.includes("setTxt('dossier-rec-secondary', cfgSecondary || roleInfo.rec.secondary);"),
    'renderRoleDossier must display configured team.yaml model first and fall back to capability description when empty'
  );

  console.log('[PASS] test-role-dossier-capability');
}

main();
