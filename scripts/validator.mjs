#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
  const cfgPath = path.resolve(__dirname, '..', 'config', 'project.yaml');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  return YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

export function runCommandAsync(cmd, cwd = REPO_ROOT, timeoutMs = 60000) {
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
      killProcessTree(child.pid);
    }, timeoutMs);

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
  const cfg = projectConfig || loadProjectConfig();
  if (!cfg?.project?.validation?.fast_checks) {
    return { ok: true, message: 'No fast_checks defined.' };
  }

  for (const item of cfg.project.validation.fast_checks) {
    const res = await runCommandAsync(item.run, REPO_ROOT, item.timeout_sec ? item.timeout_sec * 1000 : 30000);
    if (!res.ok) {
      const errCombined = `${res.stdout}\n${res.stderr}`.trim();
      const errHash = hashString(errCombined);
      return {
        ok: false,
        stage: 'fast_checks',
        checkName: item.name,
        command: item.run,
        exitCode: res.exitCode,
        errorCombined,
        errorHash
      };
    }
  }

  return { ok: true };
}

export async function validateSuite(projectConfig) {
  const cfg = projectConfig || loadProjectConfig();
  if (!cfg?.project?.validation?.suite_checks) {
    return { ok: true, message: 'No suite_checks defined.' };
  }

  for (const item of cfg.project.validation.suite_checks) {
    const res = await runCommandAsync(item.run, REPO_ROOT, item.timeout_sec ? item.timeout_sec * 1000 : 120000);
    if (!res.ok) {
      const errCombined = `${res.stdout}\n${res.stderr}`.trim();
      const errHash = hashString(errCombined);
      return {
        ok: false,
        stage: 'suite_checks',
        checkName: item.name,
        command: item.run,
        exitCode: res.exitCode,
        errorCombined,
        errorHash
      };
    }
  }

  return { ok: true };
}

// CLI direct execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const mode = process.argv[2] || 'fast';
  console.log(`Running validator in "${mode}" mode...`);
  const checkPromise = mode === 'suite' ? validateSuite() : validateFast();
  checkPromise.then(res => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  });
}
