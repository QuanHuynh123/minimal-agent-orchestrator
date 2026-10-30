#!/usr/bin/env node
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export function hashString(str) {
  return crypto.createHash('sha1').update(str || '').digest('hex');
}

export function loadProjectConfig() {
  const cfgPath = path.resolve(__dirname, '..', 'config', 'project.yaml');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  return YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
}

export function runCommandAsync(cmd, cwd = REPO_ROOT, timeoutMs = 60000) {
  return new Promise(resolve => {
    const opts = {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      shell: process.platform === 'win32' ? true : undefined
    };
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          exitCode: err.code || 1,
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : (err.message || '')
        });
      } else {
        resolve({
          ok: true,
          exitCode: 0,
          stdout: stdout ? stdout.toString() : '',
          stderr: stderr ? stderr.toString() : ''
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
