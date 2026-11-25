#!/usr/bin/env node
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from './applier.mjs';
import { partitionScopeByDomain } from './lib/risk-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolveRepoRoot();

function getExecOpts(cwd = REPO_ROOT, timeoutMs = 30000) {
  return {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32' ? true : undefined
  };
}

const execOpts = getExecOpts(REPO_ROOT);

export function isCleanWorktree(targetFiles = [], options = {}) {
  try {
    const runOpts = options?.cwd ? getExecOpts(options.cwd) : execOpts;
    if (Array.isArray(targetFiles) && targetFiles.length > 0) {
      const pathArgs = targetFiles.map(f => `"${f.replace(/"/g, '')}"`).join(' ');
      const status = execSync(`git status --porcelain -- ${pathArgs}`, runOpts).trim();
      return status.length === 0;
    }
    const status = execSync('git status --porcelain', runOpts).trim();
    return status.length === 0;
  } catch (err) {
    return false;
  }
}

export function getModifiedFiles(targetFiles = [], options = {}) {
  try {
    const runOpts = options?.cwd ? getExecOpts(options.cwd) : execOpts;
    const pathArgs = Array.isArray(targetFiles) && targetFiles.length > 0
      ? `-- ${targetFiles.map(f => `"${f.replace(/"/g, '')}"`).join(' ')}`
      : '';
    const raw = execSync(`git diff --name-only ${pathArgs}`.trim(), runOpts).trim();
    const staged = execSync(`git diff --cached --name-only ${pathArgs}`.trim(), runOpts).trim();
    const untracked = execSync(`git ls-files --others --exclude-standard ${pathArgs}`.trim(), runOpts).trim();
    const all = [...raw.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
      .map(s => s.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    return Array.from(new Set(all));
  } catch {
    return [];
  }
}

export function formatDirtyWorktreeBlockMessage(scopeFiles = [], dirtyFiles = null) {
  const normalizeList = (arr) => Array.from(new Set(
    (Array.isArray(arr) ? arr : [])
      .map(f => String(f || '').trim().replace(/\\/g, '/').replace(/"/g, ''))
      .filter(Boolean)
  ));

  let targets = Array.isArray(dirtyFiles)
    ? normalizeList(dirtyFiles)
    : normalizeList(getModifiedFiles(scopeFiles));
  if (targets.length === 0) {
    targets = normalizeList(scopeFiles);
  }

  if (targets.length === 0) {
    return [
      'Blocked: worktree has uncommitted modifications before task start.',
      'Run git commit or git stash, then click Retry:',
      '  git status && git commit -m "chore: save manual changes"',
      '  git stash push -u -m "wip before orchestrator"'
    ].join('\n');
  }

  const quotedArgs = targets.map(f => `"${f}"`).join(' ');
  return [
    `Blocked: scoped file(s) have uncommitted modifications before task start: ${targets.join(', ')}`,
    'Run one of the following commands (commit or stash), then click Retry:',
    `  Commit: git add -- ${quotedArgs} && git commit -m "chore: save manual changes"`,
    `  Stash:  git stash push -u -m "wip before orchestrator" -- ${quotedArgs}`
  ].join('\n');
}

export function getScopedDiff(targetFiles = [], options = {}) {
  try {
    const runOpts = options.cwd ? getExecOpts(options.cwd) : execOpts;
    const files = Array.isArray(targetFiles) ? targetFiles.filter(Boolean) : [];
    const maxFuncLines = Number.isFinite(Number(options.maxFuncDiffLines)) ? Number(options.maxFuncDiffLines) : 120;
    const maxFuncChars = Number.isFinite(Number(options.maxFuncDiffChars)) ? Number(options.maxFuncDiffChars) : 6000;
    const fallbackCtx = Number.isFinite(Number(options.fallbackContextLines)) ? Number(options.fallbackContextLines) : 8;

    const runDiffFor = (pathArgs, extraFlag) => {
      const cmd = `git diff ${extraFlag || ''} HEAD ${pathArgs}`.replace(/\s+/g, ' ').trim();
      return execSync(cmd, { ...runOpts, maxBuffer: 10 * 1024 * 1024 }).trim();
    };

    if (options.functionContext && files.length > 0) {
      const chunks = [];
      for (const f of files) {
        const cleanArg = `-- "${String(f).replace(/"/g, '')}"`;
        let diffPart = runDiffFor(cleanArg, '--function-context');
        if (diffPart && (diffPart.split('\n').length > maxFuncLines || diffPart.length > maxFuncChars)) {
          diffPart = runDiffFor(cleanArg, `-U${fallbackCtx}`);
        }
        if (diffPart) chunks.push(diffPart);
      }
      return chunks.join('\n').trim();
    }

    const pathArgs = files.length > 0
      ? `-- ${files.map(f => `"${String(f).replace(/"/g, '')}"`).join(' ')}`
      : '';
    const ctxFlag = options.functionContext ? '--function-context' : '';
    const rawDiff = runDiffFor(pathArgs, ctxFlag);
    if (options.functionContext && rawDiff && (rawDiff.split('\n').length > maxFuncLines || rawDiff.length > maxFuncChars)) {
      return runDiffFor(pathArgs, `-U${fallbackCtx}`);
    }
    return rawDiff;
  } catch {
    return '';
  }
}

export function snapshot() {
  try {
    const head = execSync('git rev-parse HEAD', execOpts).trim();
    return { ok: true, head };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Guarded rollback. `rollback([])` runs `git checkout -- .` on the WHOLE repo, so callers that derive
 * targets dynamically must go through this helper, which refuses empty/invalid lists and never calls
 * the underlying rollback in that case. Targets are trimmed and de-duplicated.
 */
export function safeRollback(targetFiles, { rollbackFn = rollback } = {}) {
  const targets = Array.isArray(targetFiles)
    ? Array.from(new Set(targetFiles.map(f => String(f ?? '').trim()).filter(Boolean)))
    : [];
  if (targets.length === 0) {
    return { ok: false, skipped: true, error: 'safeRollback refused: empty target list (would revert the whole repo)' };
  }
  return rollbackFn(targets);
}

export function rollback(targetFiles = []) {
  try {
    if (Array.isArray(targetFiles) && targetFiles.length > 0) {
      // Revert specific scoped files (both tracked and untracked)
      for (const f of targetFiles) {
        const cleanFile = f.replace(/"/g, '');
        try {
          execSync(`git checkout -- "${cleanFile}"`, execOpts);
        } catch {
          // If untracked new file, remove it safely
          try {
            execSync(`git clean -f -- "${cleanFile}"`, execOpts);
          } catch {}
        }
      }
    } else {
      // Revert tracked changes only
      execSync('git checkout -- .', execOpts);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function commitDone(taskId, message, prefix = '[AI-Task]', targetFiles = [], options = {}) {
  try {
    const runOpts = options.cwd ? getExecOpts(options.cwd) : execOpts;
    const cleanTargets = (Array.isArray(targetFiles) ? targetFiles : [])
      .map(f => f.trim().replace(/\\/g, '/').replace(/"/g, ''))
      .filter(Boolean);

    if (cleanTargets.length === 0) {
      return { ok: false, error: 'Refusing to run unscoped git add -A: targetFiles list is empty.' };
    }

    const pathArgs = cleanTargets.map(f => `"${f}"`).join(' ');
    execSync(`git add -- ${pathArgs}`, runOpts);
    const commitMsg = `${prefix} ${taskId}: ${message}`.replace(/"/g, '\\"');
    execSync(`git commit -m "${commitMsg}" -- ${pathArgs}`, runOpts);
    const hash = execSync('git rev-parse HEAD', runOpts).trim();
    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function resolveGitCommitStrategy(actualModifiedFiles = [], task = {}, policyConfig = {}) {
  const { frontendScope } = partitionScopeByDomain(actualModifiedFiles, policyConfig);
  const confirmGateEnabled =
    policyConfig?.policy?.git_hygiene?.confirm_frontend_branch_before_merge ??
    policyConfig?.git_hygiene?.confirm_frontend_branch_before_merge ??
    true;
  const alreadyConfirmed = Boolean(task?.frontend_merge_confirmed || task?.approval?.frontend_confirmed);
  const hasFrontendChanges = frontendScope.length > 0;
  const highRiskNeedsConfirm = Boolean(task?.post_patch_confirmation_required) && !Boolean(task?.approval?.high_risk_confirmed);
  return {
    mode: ((hasFrontendChanges && confirmGateEnabled && !alreadyConfirmed) || highRiskNeedsConfirm) ? 'branch_confirm' : 'direct',
    hasFrontendChanges,
    highRiskNeedsConfirm,
    frontendFiles: frontendScope
  };
}

export function commitToBranch(taskId, message, prefix = '[AI-Task]', targetFiles = [], options = {}) {
  const runOpts = options.cwd ? getExecOpts(options.cwd) : execOpts;
  const cleanTargets = (Array.isArray(targetFiles) ? targetFiles : [])
    .map(f => f.trim().replace(/\\/g, '/').replace(/"/g, ''))
    .filter(Boolean);

  if (cleanTargets.length === 0) {
    return { ok: false, error: 'Refusing to run unscoped git add -A: targetFiles list is empty.' };
  }

  let baseBranch = null;
  let createdBranch = null;
  try {
    const rawBranch = execSync('git rev-parse --abbrev-ref HEAD', runOpts).trim();
    if (rawBranch.startsWith('ai-task/')) {
      return {
        ok: false,
        blocked: true,
        reason: 'already_on_task_branch',
        error: `Cannot finalize frontend branch: currently checked out on task branch "${rawBranch}". Preserving all changes; switch to base branch first.`
      };
    }

    const cleanTargetsSet = new Set(cleanTargets);
    const dirtyAll = getModifiedFiles([], { cwd: options.cwd });
    const dirtyOutside = dirtyAll.filter(f => !cleanTargetsSet.has(f));
    if (dirtyOutside.length > 0) {
      return {
        ok: false,
        blocked: true,
        reason: 'uncommitted_changes_outside_targets',
        uncommittedFiles: dirtyOutside,
        error: `Cannot finalize frontend branch: working tree has uncommitted changes outside target files (${dirtyOutside.join(', ')}). Preserving all uncommitted changes intact; commit or stash unrelated edits before finalizing.`
      };
    }

    baseBranch = (!rawBranch || rawBranch === 'HEAD')
      ? execSync('git rev-parse HEAD', runOpts).trim()
      : rawBranch;

    const safeId = String(taskId || 'task').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
    let candidate = String(options.branchName || `ai-task/${safeId}`).replace(/[^A-Za-z0-9._/-]/g, '-');
    try {
      execSync(`git show-ref --verify --quiet "refs/heads/${candidate}"`, runOpts);
      candidate = `${candidate}-${Date.now().toString(36)}`;
    } catch {}

    createdBranch = candidate;
    execSync(`git checkout -b "${createdBranch}"`, runOpts);
    const pathArgs = cleanTargets.map(f => `"${f}"`).join(' ');
    execSync(`git add -- ${pathArgs}`, runOpts);
    const commitMsg = `${prefix} ${taskId}: ${message}`.replace(/"/g, '\\"');
    execSync(`git commit -m "${commitMsg}" -- ${pathArgs}`, runOpts);
    const hash = execSync('git rev-parse HEAD', runOpts).trim();
    execSync(`git checkout "${baseBranch}"`, runOpts);

    return {
      ok: true,
      hash,
      branch: createdBranch,
      baseBranch,
      requiresConfirmation: true,
      mergeCommand: `git merge --no-ff ${createdBranch}`
    };
  } catch (err) {
    if (baseBranch) {
      try {
        execSync(`git checkout "${baseBranch}"`, runOpts);
      } catch {}
    }
    return { ok: false, error: err.message, branch: createdBranch, baseBranch };
  }
}

export function mergeConfirmedBranch(branchName, options = {}) {
  if (options.confirmed !== true) {
    return {
      ok: false,
      blocked: true,
      merged: false,
      reason: 'confirmation_required',
      error: `Frontend branch "${branchName}" requires explicit user confirmation (confirmed: true) before merging.`
    };
  }
  const cleanBranch = String(branchName || '').trim();
  if (!cleanBranch || /[\s;&|`$"\\]/.test(cleanBranch)) {
    return { ok: false, blocked: true, merged: false, error: `Invalid branch name: "${branchName}"` };
  }
  const runOpts = options.cwd ? getExecOpts(options.cwd) : execOpts;
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', runOpts).trim();
    const expectedBaseBranch = options.baseBranch ? String(options.baseBranch).trim() : null;

    const dirtyFiles = getModifiedFiles([], { cwd: options.cwd });
    if (dirtyFiles.length > 0) {
      return {
        ok: false,
        blocked: true,
        merged: false,
        branch: cleanBranch,
        currentBranch,
        reason: 'uncommitted_changes_before_merge',
        uncommittedFiles: dirtyFiles,
        error: `Blocked merge of "${cleanBranch}": working tree has uncommitted changes (${dirtyFiles.join(', ')}). Preserving all uncommitted changes; commit or stash edits first.`
      };
    }

    if (currentBranch === cleanBranch || currentBranch.startsWith('ai-task/')) {
      return {
        ok: false,
        blocked: true,
        merged: false,
        branch: cleanBranch,
        currentBranch,
        targetBaseBranch: expectedBaseBranch,
        reason: 'on_task_branch_cannot_merge',
        error: `Blocked merge: currently checked out on branch "${currentBranch}". Switch to base branch${expectedBaseBranch ? ` "${expectedBaseBranch}"` : ''} before merging "${cleanBranch}" to avoid self-merge or losing work.`
      };
    }

    if (expectedBaseBranch && currentBranch !== expectedBaseBranch) {
      return {
        ok: false,
        blocked: true,
        merged: false,
        branch: cleanBranch,
        currentBranch,
        targetBaseBranch: expectedBaseBranch,
        reason: 'wrong_current_branch',
        error: `Blocked merge of "${cleanBranch}": currently on branch "${currentBranch}" instead of base branch "${expectedBaseBranch}". Switch to "${expectedBaseBranch}" first.`
      };
    }

    execSync(`git merge --no-ff "${cleanBranch}" -m "Merge confirmed frontend task branch ${cleanBranch}"`, runOpts);
    const hash = execSync('git rev-parse HEAD', runOpts).trim();
    let branchDeleted = false;
    if (options.deleteBranch === true && cleanBranch.startsWith('ai-task/')) {
      try {
        execSync(`git branch -d "${cleanBranch}"`, runOpts);
        branchDeleted = true;
      } catch {
        branchDeleted = false;
      }
    }
    return {
      ok: true,
      merged: true,
      branch: cleanBranch,
      baseBranch: currentBranch,
      branchDeleted,
      hash
    };
  } catch (err) {
    try {
      execSync('git rev-parse -q --verify MERGE_HEAD', runOpts);
      execSync('git merge --abort', runOpts);
    } catch {}
    return { ok: false, merged: false, reason: 'merge_conflict_or_error', error: err.message, branch: cleanBranch };
  }
}

export function isCommitMergedIntoHead(commitOrRef, options = {}) {
  const cleanRef = String(commitOrRef || '').trim();
  if (!cleanRef || (!/^[0-9a-f]{7,40}$/i.test(cleanRef) && !/^refs\/heads\/ai-task\/[A-Za-z0-9._-]+$/.test(cleanRef))) {
    return false;
  }
  const runOpts = options.cwd ? getExecOpts(options.cwd) : execOpts;
  try {
    execSync(`git merge-base --is-ancestor "${cleanRef}" HEAD`, runOpts);
    return true;
  } catch {
    return false;
  }
}

export function discardPendingBranch(branchName, options = {}) {
  if (options.confirmed !== true) {
    return {
      ok: false,
      blocked: true,
      discarded: false,
      reason: 'confirmation_required',
      error: `Discarding branch "${branchName}" requires explicit user confirmation (confirmed: true).`
    };
  }
  const cleanBranch = String(branchName || '').trim();
  if (!cleanBranch || !cleanBranch.startsWith('ai-task/') || cleanBranch.startsWith('-') || cleanBranch.includes('..') || /[\s;&|`$"\\]/.test(cleanBranch)) {
    return { ok: false, blocked: true, discarded: false, reason: 'invalid_branch_name', error: `Invalid task branch name: "${branchName}"` };
  }
  const runOpts = options.cwd ? getExecOpts(options.cwd) : execOpts;
  const expectedBaseBranch = options.baseBranch ? String(options.baseBranch).trim() : null;
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', runOpts).trim();
    if (currentBranch === cleanBranch) {
      return {
        ok: false,
        blocked: true,
        discarded: false,
        branch: cleanBranch,
        currentBranch,
        targetBaseBranch: expectedBaseBranch,
        reason: 'on_task_branch_cannot_discard',
        error: `Blocked discard: currently checked out on "${currentBranch}". Switch to base branch${expectedBaseBranch ? ` "${expectedBaseBranch}"` : ''} first.`
      };
    }

    let existed = false;
    try {
      execSync(`git show-ref --verify --quiet "refs/heads/${cleanBranch}"`, runOpts);
      existed = true;
    } catch {
      existed = false;
    }

    if (existed) {
      execSync(`git branch -D "${cleanBranch}"`, runOpts);
    }
    return { ok: true, discarded: true, branch: cleanBranch, currentBranch, existed };
  } catch (err) {
    return { ok: false, discarded: false, error: err.message, branch: cleanBranch };
  }
}

export function finalizeTaskCommitWithFrontendGate({
  task = {},
  actualModifiedFiles = [],
  commitPrefix = '[AI-Task]',
  finalSuccessStatus = 'done',
  policyConfig = {},
  cwd = null
} = {}) {
  const strategy = resolveGitCommitStrategy(actualModifiedFiles, task, policyConfig);
  if (strategy.mode === 'branch_confirm') {
    const branchRes = commitToBranch(
      task.task_id,
      task.title || task.goal || 'complete task',
      commitPrefix,
      actualModifiedFiles,
      { cwd }
    );
    if (!branchRes.ok) {
      return {
        ok: false,
        blocked: Boolean(branchRes.blocked),
        reason: branchRes.reason || null,
        uncommittedFiles: branchRes.uncommittedFiles || [],
        error: branchRes.error,
        awaitingConfirmation: false,
        finalSuccessStatus
      };
    }
    task.commit_hash = branchRes.hash;
    task.pending_branch = branchRes.branch;
    task.base_branch = branchRes.baseBranch;
    task.requires_user_confirmation = true;
    task.merge_command = branchRes.mergeCommand;
    return {
      ok: true,
      awaitingConfirmation: true,
      finalSuccessStatus: 'awaiting_confirmation',
      hash: branchRes.hash,
      branch: branchRes.branch,
      baseBranch: branchRes.baseBranch,
      mergeCommand: branchRes.mergeCommand,
      frontendFiles: strategy.frontendFiles
    };
  }

  const directRes = commitDone(
    task.task_id,
    task.title || task.goal || 'complete task',
    commitPrefix,
    actualModifiedFiles,
    { cwd }
  );
  if (!directRes.ok) {
    return { ok: false, error: directRes.error, awaitingConfirmation: false, finalSuccessStatus };
  }
  task.commit_hash = directRes.hash;
  return {
    ok: true,
    awaitingConfirmation: false,
    finalSuccessStatus,
    hash: directRes.hash,
    branch: null,
    baseBranch: null,
    mergeCommand: null,
    frontendFiles: []
  };
}

// CLI direct execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const [,, cmd, arg1, arg2] = process.argv;
  if (cmd === 'is-clean') {
    const clean = isCleanWorktree();
    console.log(JSON.stringify({ clean }));
    process.exit(clean ? 0 : 1);
  } else if (cmd === 'snapshot') {
    console.log(JSON.stringify(snapshot()));
  } else if (cmd === 'rollback') {
    console.log(JSON.stringify(rollback()));
  } else if (cmd === 'commit') {
    console.log(JSON.stringify(commitDone(arg1 || 'T-AUTO', arg2 || 'orchestrated update')));
  } else {
    console.log('Usage: node git-guard.mjs [is-clean|snapshot|rollback|commit]');
  }
}
