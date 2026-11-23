#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../..');

function runProcessLogged(command, args, cwd, logStream, timeoutMs = 240000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const useCmdWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) || (process.platform === 'win32' && command === 'npm');
    const spawnCmd = useCmdWrapper ? 'cmd.exe' : command;
    const spawnArgs = useCmdWrapper ? ['/c', command, ...args] : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let tailPreview = '';
    const appendTail = (text) => {
      tailPreview = (tailPreview + text).slice(-2000);
    };

    logStream.write('--- STDOUT (UNTRUNCATED) ---\n');
    const stderrChunks = [];
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      logStream.write(chunk);
      appendTail(chunk.toString('utf8'));
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      logStream.write(`\n--- SPAWN ERROR ---\n${err.stack || err.message}\n`);
      resolve({ code: -1, timedOut, ms: Date.now() - t0, stdoutBytes, stderrBytes, error: err.message });
    });

    child.on('exit', code => {
      clearTimeout(timer);
      logStream.write('\n--- STDERR (UNTRUNCATED) ---\n');
      for (const chunk of stderrChunks) {
        logStream.write(chunk);
        appendTail(chunk.toString('utf8'));
      }
      logStream.write(`\n--- END (exit=${code ?? -1}, timedOut=${timedOut}, stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes}) ---\n`);
      resolve({
        code: code ?? -1,
        timedOut,
        ms: Date.now() - t0,
        stdoutBytes,
        stderrBytes,
        tailPreview
      });
    });
  });
}

function unlinkJunctionSafe(junctionPath) {
  if (!fs.existsSync(junctionPath)) return;
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'rmdir', junctionPath], { stdio: 'ignore' });
  } else {
    fs.unlinkSync(junctionPath);
  }
}

function closeStream(stream) {
  return new Promise(resolve => {
    stream.end(resolve);
  });
}

function resolveCommits(repoRoot, options = {}) {
  if (Array.isArray(options.commits) && options.commits.length > 0) {
    return options.commits.map(c => (
      typeof c === 'string'
        ? { sha: c, subject: '' }
        : { sha: String(c.sha), subject: String(c.subject || '') }
    ));
  }
  const spec = options.range || options.ref || 'HEAD';
  const args = options.range
    ? ['log', '--reverse', '--format=%h|%s', spec]
    : ['log', '-n', String(options.count || 1), '--reverse', '--format=%h|%s', spec];
  const raw = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map(line => {
    const idx = line.indexOf('|');
    return idx === -1
      ? { sha: line.trim(), subject: '' }
      : { sha: line.slice(0, idx).trim(), subject: line.slice(idx + 1) };
  });
}

function normalizeSkipEntry(raw) {
  return String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^scripts\//, '').replace(/\.mjs$/i, '').toLowerCase();
}

function shouldSkipStep(step, skipSet) {
  if (!skipSet || skipSet.size === 0) return false;
  const labelNorm = normalizeSkipEntry(step.label);
  const argNorm = normalizeSkipEntry(step.scriptArg || step.label);
  return skipSet.has(labelNorm) || skipSet.has(argNorm);
}

function parseSuiteCommands(wtWorkDir, scriptName = 'test:offline') {
  const pkgPath = path.join(wtWorkDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  const scriptCmd = pkg?.scripts?.[scriptName];
  if (!scriptCmd || typeof scriptCmd !== 'string') return null;

  const segments = scriptCmd.split(/\s*&&\s*/).map(s => s.trim()).filter(Boolean);
  if (segments.length <= 1 && !/\btest-[^&\s]+\.mjs\b/i.test(scriptCmd)) return null;

  return segments.map((seg, idx) => {
    const tokens = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [seg];
    const unquoted = tokens.map(t => t.replace(/^["']|["']$/g, ''));
    const rawCmd = unquoted[0] || 'node';
    const command = rawCmd === 'node' ? process.execPath : rawCmd;
    const args = unquoted.slice(1);
    const scriptArg = args.find(a => /\.mjs$/i.test(a)) || unquoted.join(' ');
    const label = path.posix.basename(scriptArg.replace(/\\/g, '/')).replace(/\.mjs$/i, '') || `step-${idx + 1}`;
    return { label, scriptArg, command, args, raw: seg };
  });
}

async function runSuiteContinueOnError({ wtWorkDir, suiteSteps, skipSet, logStream, timeoutMs }) {
  const passed_tests = [];
  const failed_tests = [];
  const skipped_tests = [];
  const suite_results = [];
  let totalMs = 0;
  let totalStdout = 0;
  let totalStderr = 0;
  let anyTimedOut = false;
  let firstFailCode = 0;

  for (const step of suiteSteps) {
    if (shouldSkipStep(step, skipSet)) {
      skipped_tests.push(step.label);
      suite_results.push({ name: step.label, status: 'SKIP', exitCode: 0, timedOut: false, ms: 0 });
      logStream.write(`\n=== [SKIP] ${step.label} (${step.raw}) ===\n`);
      continue;
    }

    logStream.write(`\n=== [RUN] ${step.label} (${step.raw}) ===\n`);
    const res = await runProcessLogged(step.command, step.args, wtWorkDir, logStream, timeoutMs);
    totalMs += res.ms;
    totalStdout += res.stdoutBytes;
    totalStderr += res.stderrBytes;
    if (res.timedOut) anyTimedOut = true;

    const stepOk = res.code === 0 && !res.timedOut;
    if (stepOk) {
      passed_tests.push(step.label);
      suite_results.push({ name: step.label, status: 'PASS', exitCode: 0, timedOut: false, ms: res.ms });
    } else {
      failed_tests.push(step.label);
      if (firstFailCode === 0) firstFailCode = res.code || 1;
      suite_results.push({ name: step.label, status: 'FAIL', exitCode: res.code, timedOut: Boolean(res.timedOut), ms: res.ms });
    }
  }

  logStream.write([
    '',
    '=== SUITE SUMMARY (CONTINUE-ON-ERROR) ===',
    `PASSED (${passed_tests.length}): ${passed_tests.join(', ') || 'none'}`,
    `FAILED (${failed_tests.length}): ${failed_tests.join(', ') || 'none'}`,
    `SKIPPED (${skipped_tests.length}): ${skipped_tests.join(', ') || 'none'}`
  ].join('\n') + '\n');

  return {
    ok: failed_tests.length === 0 && !anyTimedOut,
    code: failed_tests.length === 0 && !anyTimedOut ? 0 : (firstFailCode || 1),
    timedOut: anyTimedOut,
    ms: totalMs,
    stdoutBytes: totalStdout,
    stderrBytes: totalStderr,
    passed_tests,
    failed_tests,
    skipped_tests,
    suite_results
  };
}

/**
 * Runs a command across one or more commits in isolated detached git worktrees,
 * saving full untruncated stdout and stderr logs for every commit to disk.
 * When executing an npm suite (`test:offline` by default), runs every test file sequentially
 * without stopping on the first failure, supports `--skip`, and reports all failures.
 */
export async function runWorktreeBatchVerification(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const commits = resolveCommits(repoRoot, options);
  if (commits.length === 0) {
    throw new Error('No commits resolved for worktree batch verification');
  }

  const command = options.command || 'npm';
  const withCockpit = Boolean(options.withCockpit);
  const scriptName = options.scriptName || (withCockpit ? 'test' : 'test:offline');
  const args = Array.isArray(options.args) ? options.args : ['run', scriptName];
  const continueOnError = options.continueOnError !== false && !options.failFast;
  const rawSkips = Array.isArray(options.skip) ? options.skip : (options.skip ? String(options.skip).split(',') : []);
  const skipSet = new Set(rawSkips.map(normalizeSkipEntry).filter(Boolean));
  const cwdSubdir = options.cwdSubdir ?? 'agent-team';
  const timeoutMs = Number(options.timeoutMs ?? 240000);
  const junctionNodeModules = options.junctionNodeModules !== false;
  const srcNodeModules = path.join(repoRoot, 'agent-team', 'node_modules');

  const logDir = path.resolve(
    options.logDir || path.join(os.tmpdir(), `td-wt-logs-${Date.now()}`)
  );
  fs.mkdirSync(logDir, { recursive: true });

  const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'td-wt-batch-'));
  const results = [];

  try {
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const safeSha = c.sha.replace(/[^a-zA-Z0-9._-]/g, '_');
      const idxLabel = String(i + 1).padStart(2, '0');
      const logFile = path.join(logDir, `${idxLabel}-${safeSha}.log`);
      const wtDir = path.join(wtParent, `wt-${idxLabel}-${safeSha}`);
      const wtWorkDir = cwdSubdir === '.' ? wtDir : path.join(wtDir, cwdSubdir);
      const wtNm = path.join(wtDir, 'agent-team', 'node_modules');

      const logStream = fs.createWriteStream(logFile, { encoding: 'utf8' });
      logStream.write(`Commit: ${c.sha}\nSubject: ${c.subject}\nCommand: ${command} ${args.join(' ')}\nSkip: ${Array.from(skipSet).join(', ') || 'none'}\nStarted: ${new Date().toISOString()}\n\n`);

      const entry = {
        index: i + 1,
        sha: c.sha,
        subject: c.subject,
        ok: false,
        exitCode: -1,
        timedOut: false,
        ms: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        logFile,
        passed_tests: [],
        failed_tests: [],
        skipped_tests: [],
        suite_results: [],
        error: null
      };

      try {
        execFileSync('git', ['worktree', 'add', '--detach', wtDir, c.sha], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        if (junctionNodeModules && fs.existsSync(srcNodeModules) && !fs.existsSync(wtNm)) {
          fs.mkdirSync(path.dirname(wtNm), { recursive: true });
          execFileSync('cmd.exe', ['/c', 'mklink', '/J', wtNm.replace(/\//g, '\\'), srcNodeModules.replace(/\//g, '\\')], {
            stdio: ['ignore', 'pipe', 'pipe']
          });
        }

        const isNpmSuiteRun = command === 'npm' && args[0] === 'run' && typeof args[1] === 'string' && continueOnError;
        const suiteSteps = isNpmSuiteRun ? parseSuiteCommands(wtWorkDir, args[1]) : null;

        if (suiteSteps && suiteSteps.length > 0) {
          const suiteRun = await runSuiteContinueOnError({
            wtWorkDir,
            suiteSteps,
            skipSet,
            logStream,
            timeoutMs
          });
          entry.exitCode = suiteRun.code;
          entry.timedOut = suiteRun.timedOut;
          entry.ms = suiteRun.ms;
          entry.stdoutBytes = suiteRun.stdoutBytes;
          entry.stderrBytes = suiteRun.stderrBytes;
          entry.ok = suiteRun.ok;
          entry.passed_tests = suiteRun.passed_tests;
          entry.failed_tests = suiteRun.failed_tests;
          entry.skipped_tests = suiteRun.skipped_tests;
          entry.suite_results = suiteRun.suite_results;
        } else {
          const runRes = await runProcessLogged(command, args, wtWorkDir, logStream, timeoutMs);
          entry.exitCode = runRes.code;
          entry.timedOut = Boolean(runRes.timedOut);
          entry.ms = runRes.ms;
          entry.stdoutBytes = runRes.stdoutBytes;
          entry.stderrBytes = runRes.stderrBytes;
          entry.ok = runRes.code === 0 && !runRes.timedOut;
          if (runRes.error) entry.error = runRes.error;
        }
      } catch (err) {
        entry.error = err.stack || err.message;
        logStream.write(`\n--- HARNESS ERROR ---\n${entry.error}\n`);
      } finally {
        await closeStream(logStream);
        if (junctionNodeModules) {
          try { unlinkJunctionSafe(wtNm); } catch {}
        }
        try {
          execFileSync('git', ['worktree', 'remove', '--force', wtDir], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch {}
      }

      results.push(entry);
      const status = entry.ok ? 'PASS' : 'FAIL';
      const failNote = entry.failed_tests.length > 0 ? ` | failed=[${entry.failed_tests.join(', ')}]` : '';
      const skipNote = entry.skipped_tests.length > 0 ? ` | skipped=[${entry.skipped_tests.join(', ')}]` : '';
      console.log(`[${entry.index}/${commits.length}] ${entry.sha} | ${status} (${entry.ms}ms${failNote}${skipNote}, log=${entry.logFile})`);
    }
  } finally {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' }); } catch {}
    try { fs.rmSync(wtParent, { recursive: true, force: true }); } catch {}
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const summaryLogFile = path.join(logDir, 'summary.log');
  const summaryJsonFile = path.join(logDir, 'summary.json');

  const summaryLines = [
    `WORKTREE BATCH SUMMARY: ${passed}/${results.length} PASS, ${failed}/${results.length} FAIL`,
    `Log directory: ${logDir}`,
    ...results.map(r => `[${r.index}/${results.length}] ${r.sha} | ${r.ok ? 'PASS' : 'FAIL'} | exit=${r.exitCode} | ${r.ms}ms | passed=${r.passed_tests.length} failed=[${r.failed_tests.join(', ')}] skipped=[${r.skipped_tests.join(', ')}] | ${r.subject} | log=${r.logFile}`)
  ];
  fs.writeFileSync(summaryLogFile, summaryLines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(summaryJsonFile, JSON.stringify({
    passed,
    failed,
    total: results.length,
    logDir,
    results
  }, null, 2), 'utf8');

  return {
    passed,
    failed,
    total: results.length,
    logDir,
    summaryLogFile,
    summaryJsonFile,
    results
  };
}

export function parseCliArgs(argv) {
  const opts = { skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--range' && v) { opts.range = v; i++; }
    else if (k === '--ref' && v) { opts.ref = v; i++; }
    else if (k === '--count' && v) { opts.count = Number(v); i++; }
    else if (k === '--commits' && v) { opts.commits = v.split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (k === '--skip' && v) { opts.skip.push(...v.split(',').map(s => s.trim()).filter(Boolean)); i++; }
    else if (k === '--script' && v) { opts.scriptName = v; i++; }
    else if (k === '--with-cockpit') { opts.withCockpit = true; }
    else if (k === '--fail-fast') { opts.failFast = true; }
    else if (k === '--log-dir' && v) { opts.logDir = v; i++; }
    else if (k === '--timeout-ms' && v) { opts.timeoutMs = Number(v); i++; }
    else if (k === '--repo' && v) { opts.repoRoot = v; i++; }
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  runWorktreeBatchVerification(cliOpts).then(res => {
    console.log(`\nFull untruncated logs written to: ${res.logDir}`);
    console.log(`Summary file: ${res.summaryLogFile}`);
    if (res.failed > 0) process.exit(1);
  }).catch(err => {
    console.error('Worktree batch verification error:', err);
    process.exit(1);
  });
}
