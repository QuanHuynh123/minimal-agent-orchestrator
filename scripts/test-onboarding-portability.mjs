#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRepoRoot } from './applier.mjs';
import { buildVerificationCommandsForTests, checkScopeWithDependents } from './goal-planner.mjs';
import { parseDiagnosticCommand } from '../runtime/tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (/\.(?:mjs|js)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function runTests() {
  console.log('Testing Onboarding & Cross-Platform Portability (v3.2.1)...\n');

  const tmpSpaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td space test '));
  try {
    // 1. resolveRepoRoot inside space-containing paths
    const embeddedApp = path.join(tmpSpaceRoot, 'my-app');
    const embeddedTeam = path.join(embeddedApp, 'agent-team');
    fs.mkdirSync(path.join(embeddedApp, '.git'), { recursive: true });
    fs.mkdirSync(path.join(embeddedTeam, '.git'), { recursive: true });
    assert.equal(
      resolveRepoRoot({ policy: {} }, { teamDir: embeddedTeam }),
      path.resolve(embeddedApp),
      'Embedded my-app/agent-team with BOTH .git dirs must resolve to my-app'
    );

    const uninitApp = path.join(tmpSpaceRoot, 'uninit-app');
    const uninitTeam = path.join(uninitApp, 'agent-team');
    fs.mkdirSync(path.join(uninitTeam, '.git'), { recursive: true });
    assert.equal(
      resolveRepoRoot({ policy: {} }, { teamDir: uninitTeam }),
      path.resolve(uninitApp),
      'Embedded uninit-app/agent-team before host git init must still resolve to uninit-app'
    );

    const standaloneDir = path.join(tmpSpaceRoot, 'minimal-agent-orchestrator');
    fs.mkdirSync(path.join(standaloneDir, '.git'), { recursive: true });
    assert.equal(
      resolveRepoRoot({ policy: {} }, { teamDir: standaloneDir }),
      path.resolve(standaloneDir),
      'Standalone clone without parent .git must resolve to standaloneDir'
    );

    const overrideTarget = path.join(embeddedApp, 'custom-host');
    assert.equal(
      resolveRepoRoot({ policy: { repo_root: '../custom-host' } }, { teamDir: embeddedTeam }),
      path.resolve(overrideTarget),
      'Explicit policy.repo_root override must win'
    );

    // 2. Zero unsafe `new URL(import.meta.url).pathname` usages in scripts/ & runtime/
    const selfName = path.basename(__filename);
    const codeFiles = [
      ...walkFiles(path.join(TEAM_DIR, 'scripts')),
      ...walkFiles(path.join(TEAM_DIR, 'runtime'))
    ];
    for (const filePath of codeFiles) {
      if (path.basename(filePath) === selfName) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      assert.equal(
        /new\s+URL\(\s*import\.meta\.url\s*\)\.pathname/.test(content),
        false,
        `Unsafe URL.pathname found in ${path.relative(TEAM_DIR, filePath)}; use fileURLToPath(import.meta.url)`
      );
    }

    // 3. Cross-platform & multi-framework buildVerificationCommandsForTests + checkScopeWithDependents
    const winVenvApp = path.join(tmpSpaceRoot, 'win-venv-app');
    fs.mkdirSync(path.join(winVenvApp, '.venv', 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(winVenvApp, '.venv', 'Scripts', 'python.exe'), '', 'utf8');
    const winCmds = buildVerificationCommandsForTests(['tests/test_alpha.py'], {
      repoRoot: winVenvApp,
      platform: 'win32'
    });
    assert.deepEqual(winCmds, ['.\\\.venv\\Scripts\\python.exe -m unittest -v tests.test_alpha']);

    const linuxVenvApp = path.join(tmpSpaceRoot, 'linux-venv-app');
    fs.mkdirSync(path.join(linuxVenvApp, '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(linuxVenvApp, '.venv', 'bin', 'python'), '', 'utf8');
    const linuxCmds = buildVerificationCommandsForTests(['tests/test_alpha.py'], {
      repoRoot: linuxVenvApp,
      platform: 'linux'
    });
    assert.deepEqual(linuxCmds, ['./.venv/bin/python -m unittest -v tests.test_alpha']);

    const bareWinApp = path.join(tmpSpaceRoot, 'bare-win-app');
    fs.mkdirSync(bareWinApp, { recursive: true });
    assert.deepEqual(
      buildVerificationCommandsForTests(['tests/test_alpha.py'], { repoRoot: bareWinApp, platform: 'win32' }),
      ['python -m unittest -v tests.test_alpha']
    );
    assert.deepEqual(
      buildVerificationCommandsForTests(['tests/test_alpha.py'], { repoRoot: bareWinApp, platform: 'linux' }),
      ['python3 -m unittest -v tests.test_alpha']
    );

    const pytestCmds = buildVerificationCommandsForTests(['tests/test_alpha.py'], {
      repoRoot: bareWinApp,
      policyConfig: {
        policy: { validation: { fast_checks: [{ name: 'pytest', run: 'pytest -q' }] } }
      }
    });
    assert.deepEqual(pytestCmds, ['pytest tests/test_alpha.py']);

    const jsApp = path.join(tmpSpaceRoot, 'js-app');
    fs.mkdirSync(path.join(jsApp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(jsApp, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(jsApp, 'src', 'calc.js'),
      'export function computeBonus(x) { return x * 2; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(jsApp, 'tests', 'calc.test.js'),
      "import test from 'node:test';\nimport { computeBonus } from '../src/calc.js';\ntest('ok', () => computeBonus(2));\n",
      'utf8'
    );
    const deps = checkScopeWithDependents(['src/calc.js'], jsApp, {
      candidateFiles: ['src/calc.js', 'tests/calc.test.js'],
      goal: 'Update computeBonus calculation',
      title: 'Update computeBonus',
      policyConfig: {
        policy: {
          validation: {
            fast_checks: [{ name: 'node_tests', run: 'node --test tests/calc.test.js' }]
          }
        }
      }
    });
    assert.deepEqual(deps.test_dependents, ['tests/calc.test.js']);
    assert.deepEqual(deps.verification_commands, ['node --test tests/calc.test.js']);

    // 4. parseDiagnosticCommand allow/block rules for node --test and pytest/POSIX venv
    assert.equal(parseDiagnosticCommand('node --test tests/app.test.js').ok, true);
    assert.equal(parseDiagnosticCommand('./.venv/bin/python -m pytest tests/test_a.py').ok, true);
    assert.equal(parseDiagnosticCommand('pytest tests/test_a.py').ok, true);
    assert.equal(parseDiagnosticCommand('node --test ../escape.js').ok, false);
    assert.equal(parseDiagnosticCommand('node --test --eval 1').ok, false);
    assert.equal(parseDiagnosticCommand('node -e "1"').ok, false);
  } finally {
    fs.rmSync(tmpSpaceRoot, { recursive: true, force: true });
  }

  console.log('[PASS] test-onboarding-portability (resolveRepoRoot, URL spaces, cross-platform tests, diagnostic command guard)');
}

runTests();
