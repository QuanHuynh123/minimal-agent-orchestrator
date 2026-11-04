#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  checkAllowedDirs,
  checkForbidden,
  isFileInScope,
  normalizeOrThrow,
  resolveRepoRoot
} from './applier.mjs';
import { getModifiedFiles } from './git-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = resolveRepoRoot();

/**
 * Strips volatile timing, memory addresses, and ISO timestamps before hashing
 * so identical test failures produce a deterministic SHA-1 hash across runs.
 */
export function normalizeErrorForHash(str = '') {
  return String(str)
    .replace(/\r\n/g, '\n')
    .replace(/Ran \d+ tests? in [\d.]+s/gi, 'Ran N tests in Xs')
    .replace(/\b\d+\.\d+\s*(?:ms|s|sec|seconds)\b/gi, '<DURATION>')
    .replace(/0x[0-9a-fA-F]{6,16}/g, '0x<ADDR>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ISO_TIME>')
    .replace(/\.tmp\.\d+/g, '.tmp.<TS>')
    .trim();
}

export function hashString(str) {
  return crypto.createHash('sha1').update(normalizeErrorForHash(str)).digest('hex');
}

export function loadProjectConfig() {
  const localPath = path.resolve(__dirname, '..', 'config', 'project.local.yaml');
  if (fs.existsSync(localPath)) {
    return YAML.parse(fs.readFileSync(localPath, 'utf8'));
  }
  const cfgPath = path.resolve(__dirname, '..', 'config', 'project.yaml');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  return YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
}

export function loadPolicyConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config', 'policy.yaml');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  return YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
}

export function checkCommandGuardrails(cmd = '', timeoutMs = 60000, guardrails = {}) {
  const banUnbounded = guardrails.ban_unbounded_commands ?? true;
  const blockCurlAlias = guardrails.block_powershell_curl_alias ?? true;

  if (banUnbounded && (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs))) {
    return {
      ok: false,
      error: `GUARDRAIL (HR-1): Unbounded command without explicit timeout is forbidden: "${cmd}"`
    };
  }

  if (blockCurlAlias && process.platform === 'win32') {
    const hasBareCurl = /(?:^|[;&|]\s*)curl(?!\.exe)\b/i.test(cmd);
    if (hasBareCurl) {
      return {
        ok: false,
        error: `GUARDRAIL (HR-2): Bare PowerShell 'curl' alias is forbidden on Windows. Use 'curl.exe --connect-timeout 2 --max-time 5': "${cmd}"`
      };
    }
  }

  return { ok: true };
}

/**
 * Runtime Permission & Scope Audit Gate for IDE Direct / Quick Mode.
 * Inspects git modified files and verifies none violate protected_files, allowed_dirs, or declared scope.
 */
export function auditGitScope(declaredScope = [], options = {}) {
  const projCfg = options.projectConfig || loadProjectConfig() || {};
  const repoRoot = resolveRepoRoot(projCfg);
  const allowedDirs = options.allowedDirs || projCfg.project?.allowed_dirs || ['*'];
  const protectedFiles = options.protectedFiles || projCfg.project?.protected_files || [];
  const targetFilter = options.checkAllWorktree ? [] : declaredScope;

  const modified = options.modifiedFiles || getModifiedFiles(targetFilter);
  const violations = [];

  for (const rawFile of modified) {
    let relPath;
    try {
      relPath = normalizeOrThrow(repoRoot, rawFile);
    } catch (err) {
      violations.push(`Illegal path "${rawFile}": ${err.message}`);
      continue;
    }

    const fCheck = checkForbidden(relPath, protectedFiles, options.forbiddenFiles || []);
    if (fCheck.forbidden) {
      violations.push(`SECURITY: Protected file modified "${relPath}" (matched "${fCheck.pattern}")`);
      continue;
    }

    if (!checkAllowedDirs(relPath, allowedDirs)) {
      violations.push(`Outside allowed_dirs: "${relPath}"`);
      continue;
    }

    if (declaredScope.length > 0 && !isFileInScope(relPath, declaredScope)) {
      violations.push(`Out-of-scope file modified: "${relPath}" (declared scope: ${declaredScope.join(', ')})`);
    }
  }

  return {
    ok: violations.length === 0,
    modified_files: modified,
    violations
  };
}

function killProcessTree(pid, killTree = true) {
  if (!pid) return;
  try {
    if (process.platform === 'win32' && killTree) {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else if (process.platform !== 'win32' && killTree) {
      process.kill(-pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

export function runCommandAsync(cmd, cwd = REPO_ROOT, timeoutMs = 60000, guardrails = null) {
  const effectiveGuardrails = guardrails || loadPolicyConfig()?.policy?.execution_guardrails || {};
  const effectiveTimeout = timeoutMs || (effectiveGuardrails.default_cli_timeout_sec || 60) * 1000;
  const killTree = effectiveGuardrails.kill_process_tree_on_timeout ?? true;

  const guardCheck = checkCommandGuardrails(cmd, effectiveTimeout, effectiveGuardrails);
  if (!guardCheck.ok) {
    return Promise.resolve({
      ok: false,
      exitCode: 126,
      timedOut: false,
      stdout: '',
      stderr: guardCheck.error
    });
  }

  return new Promise(resolve => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, killTree);
    }, effectiveTimeout);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        timedOut,
        stdout,
        stderr: stderr || err.message || 'Process spawn error'
      });
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          exitCode: 124,
          timedOut: true,
          stdout,
          stderr: `${stderr}\n[Validator] Command timed out after ${timeoutMs}ms and process tree was terminated.`.trim()
        });
      } else if (code !== 0) {
        resolve({
          ok: false,
          exitCode: code ?? 1,
          timedOut: false,
          stdout,
          stderr
        });
      } else {
        resolve({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout,
          stderr
        });
      }
    });
  });
}

export async function validateFast(projectConfig) {
  const cfg = projectConfig || loadProjectConfig() || {};
  const repoRoot = resolveRepoRoot(cfg);
  const fastChecks = cfg?.project?.validation?.fast_checks
    || cfg?.validation?.fast_checks;

  if (!fastChecks || fastChecks.length === 0) {
    return { ok: true, skipped: true, message: 'No fast_checks defined in project.yaml.' };
  }

  for (const item of fastChecks) {
    const res = await runCommandAsync(item.run, repoRoot, item.timeout_sec ? item.timeout_sec * 1000 : 30000);
    if (!res.ok) {
      const errCombined = `${res.stdout}\n${res.stderr}`.trim();
      const errHash = hashString(errCombined);
      return {
        ok: false,
        stage: 'fast_checks',
        checkName: item.name,
        command: item.run,
        exitCode: res.exitCode,
        errorCombined: errCombined,
        errorHash: errHash
      };
    }
  }

  return { ok: true };
}

export async function validateSuite(projectConfig) {
  const cfg = projectConfig || loadProjectConfig() || {};
  const repoRoot = resolveRepoRoot(cfg);
  const suiteChecks = cfg?.project?.validation?.suite_checks
    || cfg?.validation?.suite_checks;

  if (!suiteChecks || suiteChecks.length === 0) {
    return { ok: true, skipped: true, message: 'No suite_checks defined in project.yaml.' };
  }

  for (const item of suiteChecks) {
    const res = await runCommandAsync(item.run, repoRoot, item.timeout_sec ? item.timeout_sec * 1000 : 120000);
    if (!res.ok) {
      const errCombined = `${res.stdout}\n${res.stderr}`.trim();
      const errHash = hashString(errCombined);
      return {
        ok: false,
        stage: 'suite_checks',
        checkName: item.name,
        command: item.run,
        exitCode: res.exitCode,
        errorCombined: errCombined,
        errorHash: errHash
      };
    }
  }

  return { ok: true };
}

// CLI direct execution (supports: node validator.mjs [fast|suite|scope] [--scope file1,file2])
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const mode = (args[0] && !args[0].startsWith('--')) ? args[0] : 'fast';
  const scopeIdx = args.indexOf('--scope');
  const scopeFiles = scopeIdx !== -1 && args[scopeIdx + 1]
    ? args[scopeIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  (async () => {
    console.log(`Running validator in "${mode}" mode${scopeFiles.length ? ` (scope: ${scopeFiles.join(', ')})` : ''}...`);
    if (scopeFiles.length > 0 || mode === 'scope') {
      const scopeAudit = auditGitScope(scopeFiles);
      if (!scopeAudit.ok) {
        console.log(JSON.stringify({ ok: false, stage: 'scope_audit', ...scopeAudit }, null, 2));
        process.exit(1);
      }
      if (mode === 'scope') {
        console.log(JSON.stringify({ ok: true, stage: 'scope_audit', ...scopeAudit }, null, 2));
        process.exit(0);
      }
    }
    const res = mode === 'suite' ? await validateSuite() : await validateFast();
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  })();
}
