#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as validatorMod from './validator.mjs';
import { formatValidationErrorForRetry } from './lib/context-builders.mjs';

function makeTempGitRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-deleted-id-gate-'));
	execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
	execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
	return dir;
}

function writeAndCommit(dir, files, msg) {
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, 'utf8');
	}
	execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'ignore' });
}

function getDiff(dir) {
	return execFileSync('git', ['diff', '-U3'], { cwd: dir, encoding: 'utf8' });
}

assert.equal(
	typeof validatorMod.evaluateDeletedIdentifierGate,
	'function',
	'validator.mjs must export evaluateDeletedIdentifierGate()'
);
const { evaluateDeletedIdentifierGate } = validatorMod;

// 1. HTML id, custom class (excluding Tailwind), inline script fn/const -> orphan refs in product JS fail with file:line, tests warn, docs/agent-team/fixtures excluded
{
	const repo = makeTempGitRepo();
	try {
		writeAndCommit(repo, {
			'ui_web/app.html': [
				'<div id="main-shell">',
				'  <div id="widget-bar" class="widget-panel-box flex rounded-lg text-zinc-400">Bar</div>',
				'</div>',
				'<script>',
				'const WIDGET_MODE = "compact";',
				'function renderWidgetBar() { return WIDGET_MODE; }',
				'function keepAlive() { const flex = 1; return flex; }',
				'</script>'
			].join('\n') + '\n',
			'ui_web/panel.js': [
				'export function initPanel() {',
				'  const el = document.getElementById("widget-bar");',
				'  const box = document.querySelector(".widget-panel-box");',
				'  renderWidgetBar();',
				'  return WIDGET_MODE;',
				'}'
			].join('\n') + '\n',
			'tests/test_ui.py': [
				'def test_old_widget():',
				'    assert "widget-bar" != ""',
				'    assert "renderWidgetBar" != ""'
			].join('\n') + '\n',
			'docs/notes.md': 'Old widget-bar and WIDGET_MODE notes\n',
			'agent-team/scratch.js': 'const x = "widget-bar"; renderWidgetBar();\n',
			'fixtures/sample.js': 'const y = "widget-bar"; renderWidgetBar();\n'
		}, 'init');

		// Modify ui_web/app.html without updating ui_web/panel.js
		fs.writeFileSync(path.join(repo, 'ui_web/app.html'), [
			'<div id="main-shell">',
			'</div>',
			'<script>',
			'function keepAlive() { const flex = 1; return flex; }',
			'</script>'
		].join('\n') + '\n', 'utf8');

		const diffText = getDiff(repo);
		const res = evaluateDeletedIdentifierGate(diffText, { kind: 'remove' }, { repoRoot: repo });
		assert.equal(res.ok, false, 'Must fail when deleted HTML id / custom class / JS symbol still referenced in product code');

		const deletedNames = new Set((res.deletedIdentifiers || []).map(d => d.name || d));
		assert.ok(deletedNames.has('widget-bar'), 'Should detect deleted HTML id widget-bar');
		assert.ok(deletedNames.has('widget-panel-box'), 'Should detect deleted custom CSS class widget-panel-box');
		assert.ok(deletedNames.has('renderWidgetBar'), 'Should detect deleted inline script function renderWidgetBar');
		assert.ok(deletedNames.has('WIDGET_MODE'), 'Should detect deleted top-level const WIDGET_MODE');
		assert.ok(!deletedNames.has('flex'), 'Should NOT treat Tailwind utility class flex as deleted custom class');
		assert.ok(!deletedNames.has('rounded-lg'), 'Should NOT treat Tailwind utility rounded-lg as deleted custom class');
		assert.ok(!deletedNames.has('text-zinc-400'), 'Should NOT treat Tailwind utility text-zinc-400 as deleted custom class');

		const violationText = (res.violations || []).join('\n');
		assert.match(violationText, /ui_web\/panel\.js:2\b/, 'Must report orphan ref file:line for getElementById("widget-bar")');
		assert.match(violationText, /ui_web\/panel\.js:3\b/, 'Must report orphan ref file:line for .widget-panel-box');
		assert.match(violationText, /ui_web\/panel\.js:4\b/, 'Must report orphan ref file:line for renderWidgetBar()');
		assert.match(violationText, /ui_web\/panel\.js:5\b/, 'Must report orphan ref file:line for WIDGET_MODE');

		assert.ok(!violationText.includes('docs/notes.md'), 'Must exclude docs/');
		assert.ok(!violationText.includes('agent-team/scratch.js'), 'Must exclude agent-team/');
		assert.ok(!violationText.includes('fixtures/sample.js'), 'Must exclude fixtures/');
		assert.ok(!violationText.includes('tests/test_ui.py'), 'Test references must not be in blocking violations');

		const warningText = (res.warnings || []).join('\n');
		assert.match(warningText, /tests\/test_ui\.py:2\b/, 'Must warn on leftover reference inside tests/');

		const formattedRetry = formatValidationErrorForRetry(res.retryPrompt, 700, { repoRoot: repo });
		assert.match(formattedRetry, /\[DELETED_IDENTIFIER_ORPHAN_REFS\]/);
		assert.match(formattedRetry, /ui_web\/panel\.js:2\b/);

		// Skipped for kind=feature
		const featRes = evaluateDeletedIdentifierGate(diffText, { kind: 'feature' }, { repoRoot: repo });
		assert.equal(featRes.ok, true);
		assert.equal(featRes.skipped, true);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
}

// 2. Python def & module constant deleted under kind=refactor -> caught via Tree-sitter + repo scan
{
	const repo = makeTempGitRepo();
	try {
		writeAndCommit(repo, {
			'core/legacy.py': [
				'LEGACY_RATIO = 0.5',
				'',
				'class LegacyHelper:',
				'\tdef run(self):',
				'\t\treturn 1',
				'',
				'def compute_legacy_score(x):',
				'\treturn x * LEGACY_RATIO'
			].join('\n') + '\n',
			'core/runner.py': [
				'from core.legacy import LEGACY_RATIO, compute_legacy_score',
				'',
				'def execute():',
				'\treturn compute_legacy_score(2) + LEGACY_RATIO'
			].join('\n') + '\n'
		}, 'init');

		fs.writeFileSync(path.join(repo, 'core/legacy.py'), [
			'class ModernHelper:',
			'\tdef run(self):',
			'\t\treturn 2'
		].join('\n') + '\n', 'utf8');

		const res = evaluateDeletedIdentifierGate(getDiff(repo), { kind: 'refactor' }, { repoRoot: repo });
		assert.equal(res.ok, false, 'kind=refactor must also fail on orphan Python references');
		const violationText = (res.violations || []).join('\n');
		assert.match(violationText, /core\/runner\.py:1\b/);
		assert.match(violationText, /core\/runner\.py:4\b/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
}

// 3. Re-declared identifier or test-only reference passes (test ref -> warnings only)
{
	const repo = makeTempGitRepo();
	try {
		writeAndCommit(repo, {
			'core/service.js': [
				'export function movedHelper(v) { return v + 1; }',
				'export function deprecatedHelper(v) { return v - 1; }'
			].join('\n') + '\n',
			'core/consumer.js': [
				'import { movedHelper } from "./service.js";',
				'export const out = movedHelper(1);'
			].join('\n') + '\n',
			'tests/service.test.js': [
				'import { deprecatedHelper } from "../core/service.js";',
				'console.assert(deprecatedHelper(2) === 1);'
			].join('\n') + '\n'
		}, 'init');

		fs.writeFileSync(path.join(repo, 'core/service.js'), [
			'// moved down',
			'export function movedHelper(v) { return v + 2; }'
		].join('\n') + '\n', 'utf8');

		const res = evaluateDeletedIdentifierGate(getDiff(repo), { kind: 'remove' }, { repoRoot: repo });
		assert.equal(res.ok, true, 'Should pass when movedHelper is re-declared and deprecatedHelper is referenced only in tests');
		const deletedNames = new Set((res.deletedIdentifiers || []).map(d => d.name || d));
		assert.ok(!deletedNames.has('movedHelper'), 'Re-declared symbol must not be treated as deleted');
		assert.ok(deletedNames.has('deprecatedHelper'));
		assert.ok((res.warnings || []).some(w => w.includes('tests/service.test.js:')), 'Should emit warning for test reference');
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
}

console.log('test-deleted-identifier-gate.mjs: ALL PASSED');
