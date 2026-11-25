import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import YAML from 'yaml';
import { verifyCsrfAndOrigin, parseJsonBody, buildLocalhostCorsHeaders } from './security.mjs';
import { resolveRepoRoot } from '../applier.mjs';
import {
  createSnapshot,
  scanSessions,
  readSessionDetails,
  isProcessAlive,
  loadYamlSafe
} from './state-reader.mjs';
import { loadMergedPolicy } from '../lib/policy-loader.mjs';
import { readLockFile } from '../lib/runtime-lock.mjs';
import { mutateVersionedJsonAtomic } from '../lib/state-store.mjs';
import { mutateTaskStateAtomic, transitionTaskState } from '../lib/task-persistence.mjs';
import {
  mergeConfirmedBranch,
  discardPendingBranch,
  isCommitMergedIntoHead
} from '../git-guard.mjs';
import {
  computeCanonicalQueueState,
  findTaskYamlFile,
  syncCanonicalTaskState,
  writeMorningReportFile,
  writeTaskYamlAtomic
} from '../lib/queue-state.mjs';
import { decomposeGoal } from '../goal-planner.mjs';

const inFlightRunnerSpawns = new Map();

export function ensureOrchestratorRunning({ lockFile, liveStatusFile, orchestratorScript, teamDir }) {
  const absLock = path.resolve(lockFile);
  const lockData = readLockFile(absLock);
  if (lockData && isProcessAlive(lockData.pid)) {
    return { alreadyRunning: true, pid: lockData.pid, reason: 'lock' };
  }

  const inFlight = inFlightRunnerSpawns.get(absLock);
  if (inFlight && inFlight.exitCode === null && isProcessAlive(inFlight.pid)) {
    return { alreadyRunning: true, pid: inFlight.pid, reason: 'in_flight' };
  }

  if (liveStatusFile && fs.existsSync(liveStatusFile)) {
    try {
      const live = JSON.parse(fs.readFileSync(liveStatusFile, 'utf8').replace(/^\uFEFF/, ''));
      if (live && live.active === true && Number.isInteger(live.pid) && live.pid > 0 && isProcessAlive(live.pid)) {
        return { alreadyRunning: true, pid: live.pid, reason: 'live_status' };
      }
    } catch {}
  }

  const resolvedScript = orchestratorScript
    ? path.resolve(orchestratorScript)
    : path.resolve(teamDir, 'scripts', 'orchestrator.mjs');
  const child = spawn(process.execPath, [resolvedScript, 'run'], {
    cwd: path.resolve(teamDir, '..'),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  inFlightRunnerSpawns.set(absLock, child);
  child.once('exit', () => {
    if (inFlightRunnerSpawns.get(absLock) === child) {
      inFlightRunnerSpawns.delete(absLock);
    }
  });
  child.unref();
  return { alreadyRunning: false, pid: child.pid, reason: 'spawned' };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export async function handleTasksRoutes(req, res, url, options = {}) {
  const snapshotPaths = options.snapshotPaths || {};
  const sessionsDir = options.SESSIONS_DIR || snapshotPaths.SESSIONS_DIR || path.resolve('agent-team/state/sessions');
  const tasksActiveDir = options.TASKS_ACTIVE_DIR || snapshotPaths.TASKS_ACTIVE_DIR || path.resolve('agent-team/tasks/active');
  const lockFile = options.LOCK_FILE || snapshotPaths.LOCK_FILE || path.resolve('agent-team/.orchestrator.lock');
  const teamDir = options.TEAM_DIR || snapshotPaths.TEAM_DIR || path.resolve('agent-team');
  const tasksArchiveDir = options.TASKS_ARCHIVE_DIR || snapshotPaths.TASKS_ARCHIVE_DIR || path.resolve(teamDir, 'tasks', 'archive');
  const taskStateFile = options.TASK_STATE_FILE || snapshotPaths.TASK_STATE_FILE || path.resolve(teamDir, 'state', 'task-state.json');
  const liveStatusFile = options.LIVE_STATUS_FILE || snapshotPaths.LIVE_STATUS_FILE || path.resolve(teamDir, 'state', 'live-status.json');
  const reportFile = options.REPORT_FILE || snapshotPaths.REPORT_FILE || path.resolve(teamDir, 'state', 'morning-report.md');

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    try {
      const snapshot = await createSnapshot(snapshotPaths);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...buildLocalhostCorsHeaders(req)
      });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        ...buildLocalhostCorsHeaders(req)
      });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    try {
      const sessions = scanSessions(sessionsDir);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...buildLocalhostCorsHeaders(req)
      });
      res.end(JSON.stringify({ ok: true, count: sessions.length, sessions }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        ...buildLocalhostCorsHeaders(req)
      });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    try {
      const sessionId = url.searchParams.get('id');
      const details = readSessionDetails(sessionId, sessionsDir);
      if (!details) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          ...buildLocalhostCorsHeaders(req)
        });
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...buildLocalhostCorsHeaders(req)
      });
      res.end(JSON.stringify({ ok: true, session: details }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        ...buildLocalhostCorsHeaders(req)
      });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/decompose') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      const policyCfg = loadMergedPolicy({ configDir: cfgDir });
      const repoRoot = options.REPO_ROOT || snapshotPaths.REPO_ROOT || resolveRepoRoot(policyCfg, { configDir: cfgDir, teamDir });
      const body = await parseJsonBody(req);
      const goal = String(body.goal || '').trim();
      if (!goal) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Goal cannot be empty' }));
        return true;
      }

      const preset = String(body.preset || 'auto').trim();
      const modeOverride = preset === 'consult' ? 'consult' : (body.mode || null);
      const writerModel = body.writer_model ? String(body.writer_model).trim() : null;
      console.log(`[Dashboard API] Decomposing goal with Router Agent (preset=${preset}${writerModel ? `, writer_model=${writerModel}` : ''}): "${goal}"...`);
      const decompRes = await decomposeGoal(goal, {
        dryRun: false,
        configDir: cfgDir,
        repoRoot,
        preset,
        mode: modeOverride,
        writerModel
      });
      res.writeHead(decompRes.ok ? 200 : (decompRes.validation_error ? 400 : 500), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(JSON.stringify(decompRes));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/approve-run') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      loadMergedPolicy({ configDir: cfgDir });
      const body = await parseJsonBody(req);
      const targetIds = (Array.isArray(body.task_ids) && body.task_ids.length > 0) ? new Set(body.task_ids) : null;

      // 1. Approve tasks: convert 'draft_review' to 'ready'
      let approvedCount = 0;
      if (fs.existsSync(tasksActiveDir)) {
        const files = fs.readdirSync(tasksActiveDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const f of files) {
          const filePath = path.resolve(tasksActiveDir, f);
          const parsed = loadYamlSafe(filePath);
          if (!parsed) continue;
          const raw = (parsed.task && typeof parsed.task === 'object') ? parsed.task : parsed;
          const tid = raw.task_id || raw.id;
          if (!tid) continue;

          if (raw.status === 'draft_review' && (!targetIds || targetIds.has(tid))) {
            raw.status = 'ready';
            raw.updated_at = new Date().toISOString();
            fs.writeFileSync(filePath, YAML.stringify(parsed), 'utf8');
            approvedCount++;
          }
        }
      }

      // 2. Ensure at most one Orchestrator is running in detached background process
      let launchInfo = { started: false, already_running: false, pid: null };
      if (body.start_orchestrator !== false) {
        const launchRes = ensureOrchestratorRunning({ lockFile, liveStatusFile, teamDir });
        if (launchRes.alreadyRunning) {
          sendJson(res, 200, {
            ok: true,
            approved_count: approvedCount,
            started: false,
            already_running: true,
            pid: launchRes.pid,
            message: 'Tasks approved. Orchestrator is already actively running.'
          });
          return true;
        }
        launchInfo = { started: true, already_running: false, pid: launchRes.pid };
      }

      sendJson(res, 200, {
        ok: true,
        approved_count: approvedCount,
        started: launchInfo.started,
        already_running: launchInfo.already_running,
        pid: launchInfo.pid,
        message: launchInfo.started
          ? `Approved ${approvedCount} task(s) and launched Orchestrator in background.`
          : `Approved ${approvedCount} task(s).`
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const lockData = fs.existsSync(lockFile) ? readLockFile(lockFile) : null;
      const pid = Number(lockData?.pid);
      if (!lockData || !Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
        if (lockData && fs.existsSync(lockFile)) {
          try { fs.unlinkSync(lockFile); } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: 'Orchestrator is not running.' }));
        return true;
      }

      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }, () => resolve());
        });
      } else {
        process.kill(pid, 'SIGTERM');
      }

      for (let i = 0; i < 6 && isProcessAlive(pid); i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (!isProcessAlive(pid)) {
        const latestLock = fs.existsSync(lockFile) ? readLockFile(lockFile) : null;
        if (latestLock?.pid === pid && fs.existsSync(lockFile)) {
          try { fs.unlinkSync(lockFile); } catch {}
        }
        if (fs.existsSync(liveStatusFile)) {
          mutateVersionedJsonAtomic(liveStatusFile, (prev) => ({
            ...prev,
            active: false,
            current_stage: 'idle',
            updated_at: new Date().toISOString()
          }), { allowCorruptFallback: true, fallbackFactory: () => ({}) });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pid, message: `Terminated Orchestrator process (PID: ${pid})` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // --- Task Operations: Detail, Delete, Save ---

  if (req.method === 'GET' && url.pathname === '/api/task/detail') {
    try {
      const taskId = String(url.searchParams.get('id') || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid task id' }));
        return true;
      }

      let foundPath = findTaskYamlFile(tasksActiveDir, taskId);
      let archived = false;
      if (!foundPath) {
        foundPath = findTaskYamlFile(tasksArchiveDir, taskId);
        archived = Boolean(foundPath);
      }

      let foundTask = null;
      let rawYaml = '';
      if (foundPath && fs.existsSync(foundPath)) {
        rawYaml = fs.readFileSync(foundPath, 'utf8');
        const parsed = loadYamlSafe(foundPath);
        foundTask = (parsed?.task && typeof parsed.task === 'object') ? parsed.task : parsed;
      }

      if (!foundTask) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `Task "${taskId}" not found in active or archive queue.` }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, task_id: taskId, archived, task: foundTask, raw_yaml: rawYaml }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/task/delete') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      loadMergedPolicy({ configDir: cfgDir });
      const body = await parseJsonBody(req);
      const taskId = String(body.task_id || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid task_id' }));
        return true;
      }
      let deleted = false;
      const candidateFiles = [
        path.resolve(tasksActiveDir, `${taskId}.yaml`),
        path.resolve(tasksActiveDir, `${taskId}.yml`)
      ];
      for (const f of candidateFiles) {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          deleted = true;
          break;
        }
      }
      if (!deleted && fs.existsSync(tasksActiveDir)) {
        const allFiles = fs.readdirSync(tasksActiveDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const af of allFiles) {
          const fp = path.resolve(tasksActiveDir, af);
          const parsed = loadYamlSafe(fp);
          const raw = (parsed?.task && typeof parsed.task === 'object') ? parsed.task : parsed;
          if (raw?.task_id === taskId || raw?.id === taskId) {
            fs.unlinkSync(fp);
            deleted = true;
            break;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, deleted, task_id: taskId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/task/retry') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      loadMergedPolicy({ configDir: cfgDir });
      const body = await parseJsonBody(req);
      const taskId = String(body.task_id || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        sendJson(res, 400, { ok: false, error: 'Invalid task_id' });
        return true;
      }

      const targetPath = findTaskYamlFile(tasksActiveDir, taskId);
      if (!targetPath) {
        sendJson(res, 404, { ok: false, error: `Task "${taskId}" not found in active queue.` });
        return true;
      }

      const parsed = loadYamlSafe(targetPath);
      if (!parsed || typeof parsed !== 'object') {
        sendJson(res, 400, { ok: false, error: `Task file "${taskId}" is unreadable or invalid YAML.` });
        return true;
      }

      const raw = (parsed.task && typeof parsed.task === 'object') ? parsed.task : parsed;
      const currentStatus = String(raw.status || '').toLowerCase();
      if (currentStatus !== 'blocked' && currentStatus !== 'failed') {
        sendJson(res, 409, { ok: false, error: `Task "${taskId}" has status "${currentStatus}" and cannot be retried.` });
        return true;
      }

      const nowIso = new Date().toISOString();
      raw.status = 'ready';
      delete raw.block_reason;
      delete raw.last_error;
      delete raw.failure_class;
      delete raw.pending_review_patch;
      raw.retried_at = nowIso;
      raw.updated_at = nowIso;
      writeTaskYamlAtomic(targetPath, parsed);

      let canonical = null;
      mutateTaskStateAtomic(taskStateFile, (taskState) => {
        canonical = writeMorningReportFile(taskState, {
          tasksActiveDir,
          tasksArchiveDir,
          reportFile
        });
        syncCanonicalTaskState(taskState, canonical);
      }, { fallbackFactory: () => ({ active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} }) });

      mutateVersionedJsonAtomic(liveStatusFile, (existingLive) => {
        const livePatch = {
          queue_stats: canonical.counts,
          updated_at: new Date().toISOString()
        };
        if (existingLive.current_task_id === taskId || (canonical.counts.blocked === 0 && existingLive.current_stage === 'blocked')) {
          livePatch.last_error = null;
          livePatch.task_final_status = 'ready';
          if (existingLive.current_stage === 'blocked') {
            livePatch.current_stage = 'idle';
          }
        }
        return {
          ...existingLive,
          ...livePatch
        };
      }, { allowCorruptFallback: true, fallbackFactory: () => ({}) });

      let launchInfo = { started: false, already_running: false, pid: null };
      if (body.start_orchestrator !== false) {
        const launchRes = ensureOrchestratorRunning({ lockFile, liveStatusFile, teamDir });
        launchInfo = {
          started: true,
          already_running: launchRes.alreadyRunning,
          pid: launchRes.pid
        };
      }

      sendJson(res, 200, {
        ok: true,
        task_id: taskId,
        status: 'ready',
        queue_stats: canonical.counts,
        ...launchInfo,
        message: launchInfo.already_running
          ? `Reset task "${taskId}" to ready. Orchestrator is already running.`
          : (launchInfo.started
              ? `Reset task "${taskId}" to ready and launched Orchestrator.`
              : `Reset task "${taskId}" to ready.`)
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/task/confirm-merge') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      const policyCfg = loadMergedPolicy({ configDir: cfgDir });
      const repoRoot = options.REPO_ROOT || snapshotPaths.REPO_ROOT || resolveRepoRoot(policyCfg, { configDir: cfgDir, teamDir });
      const body = await parseJsonBody(req);
      const taskId = String(body.task_id || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        sendJson(res, 400, { ok: false, error: 'Invalid task_id' });
        return true;
      }

      const targetPath = findTaskYamlFile(tasksActiveDir, taskId);
      if (!targetPath) {
        sendJson(res, 404, { ok: false, error: `Task "${taskId}" not found in active queue.` });
        return true;
      }

      const parsed = loadYamlSafe(targetPath);
      if (!parsed || typeof parsed !== 'object') {
        sendJson(res, 400, { ok: false, error: `Task file "${taskId}" is unreadable or invalid YAML.` });
        return true;
      }

      const raw = (parsed.task && typeof parsed.task === 'object') ? parsed.task : parsed;
      const currentStatus = String(raw.status || '').toLowerCase();
      if (currentStatus !== 'awaiting_confirmation') {
        sendJson(res, 409, { ok: false, error: `Task "${taskId}" has status "${currentStatus}" and is not awaiting confirmation.` });
        return true;
      }

      const pendingBranch = String(raw.pending_branch || '').trim();
      if (!pendingBranch || !pendingBranch.startsWith('ai-task/')) {
        sendJson(res, 400, { ok: false, error: `Task "${taskId}" has invalid or missing pending_branch "${pendingBranch}".` });
        return true;
      }

      const deleteBranch = body.delete_branch !== false;
      let mergeRes = mergeConfirmedBranch(pendingBranch, {
        baseBranch: raw.base_branch || null,
        confirmed: true,
        deleteBranch,
        cwd: repoRoot
      });

      if (!mergeRes.ok && !mergeRes.blocked && raw.commit_hash && isCommitMergedIntoHead(raw.commit_hash, { cwd: repoRoot })) {
        mergeRes = {
          ok: true,
          merged: true,
          alreadyMerged: true,
          branch: pendingBranch,
          baseBranch: raw.base_branch || null,
          branchDeleted: true,
          hash: raw.commit_hash
        };
      }

      if (!mergeRes.ok) {
        sendJson(res, 409, {
          ok: false,
          task_id: taskId,
          branch: pendingBranch,
          base_branch: raw.base_branch || null,
          reason: mergeRes.reason || 'merge_failed',
          error: mergeRes.error || `Failed to merge branch "${pendingBranch}".`
        });
        return true;
      }

      const nowIso = new Date().toISOString();
      const mergeCommit = mergeRes.hash || raw.commit_hash || null;
      if (mergeCommit) {
        raw.merged_commit_hash = mergeCommit;
        raw.commit_hash = mergeCommit;
      }
      raw.confirmed_at = nowIso;
      raw.updated_at = nowIso;

      const archivePath = path.resolve(tasksArchiveDir, path.basename(targetPath));
      let canonical = null;
      mutateTaskStateAtomic(taskStateFile, (taskState) => {
        transitionTaskState(raw, taskState, 'done', {
          actualModifiedFiles: Array.isArray(raw.last_report?.modified_files) ? raw.last_report.modified_files : (Array.isArray(raw.scope) ? raw.scope : []),
          validationPassed: true,
          retries: Number(raw.retries || 0),
          activeTaskPath: targetPath,
          archiveTaskPath: archivePath
        });
        canonical = writeMorningReportFile(taskState, {
          tasksActiveDir,
          tasksArchiveDir,
          reportFile
        });
        syncCanonicalTaskState(taskState, canonical);
      }, { fallbackFactory: () => ({ active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} }) });

      mutateVersionedJsonAtomic(liveStatusFile, (existingLive) => {
        const livePatch = {
          queue_stats: canonical.counts,
          updated_at: new Date().toISOString()
        };
        if (existingLive.current_task_id === taskId) {
          livePatch.last_error = null;
          livePatch.task_final_status = 'done';
          livePatch.task_completed_at = raw.completed_at || nowIso;
          if (existingLive.current_stage === 'awaiting_confirmation' || existingLive.current_stage === 'blocked') {
            livePatch.current_stage = 'done';
          }
        }
        return {
          ...existingLive,
          ...livePatch
        };
      }, { allowCorruptFallback: true, fallbackFactory: () => ({}) });

      sendJson(res, 200, {
        ok: true,
        task_id: taskId,
        status: 'done',
        branch: pendingBranch,
        base_branch: mergeRes.baseBranch || raw.base_branch || null,
        merge_commit: mergeCommit,
        branch_deleted: Boolean(mergeRes.branchDeleted),
        already_merged: Boolean(mergeRes.alreadyMerged),
        queue_stats: canonical.counts,
        message: `Merged branch "${pendingBranch}" and archived task "${taskId}".`
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/task/discard-branch') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      const policyCfg = loadMergedPolicy({ configDir: cfgDir });
      const repoRoot = options.REPO_ROOT || snapshotPaths.REPO_ROOT || resolveRepoRoot(policyCfg, { configDir: cfgDir, teamDir });
      const body = await parseJsonBody(req);
      const taskId = String(body.task_id || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        sendJson(res, 400, { ok: false, error: 'Invalid task_id' });
        return true;
      }

      const targetPath = findTaskYamlFile(tasksActiveDir, taskId);
      if (!targetPath) {
        sendJson(res, 404, { ok: false, error: `Task "${taskId}" not found in active queue.` });
        return true;
      }

      const parsed = loadYamlSafe(targetPath);
      if (!parsed || typeof parsed !== 'object') {
        sendJson(res, 400, { ok: false, error: `Task file "${taskId}" is unreadable or invalid YAML.` });
        return true;
      }

      const raw = (parsed.task && typeof parsed.task === 'object') ? parsed.task : parsed;
      const currentStatus = String(raw.status || '').toLowerCase();
      if (currentStatus !== 'awaiting_confirmation') {
        sendJson(res, 409, { ok: false, error: `Task "${taskId}" has status "${currentStatus}" and is not awaiting confirmation.` });
        return true;
      }

      const pendingBranch = String(raw.pending_branch || '').trim();
      if (!pendingBranch || !pendingBranch.startsWith('ai-task/')) {
        sendJson(res, 400, { ok: false, error: `Task "${taskId}" has invalid or missing pending_branch "${pendingBranch}".` });
        return true;
      }

      const discardRes = discardPendingBranch(pendingBranch, {
        baseBranch: raw.base_branch || null,
        confirmed: true,
        cwd: repoRoot
      });
      if (!discardRes.ok) {
        sendJson(res, 409, {
          ok: false,
          task_id: taskId,
          branch: pendingBranch,
          base_branch: raw.base_branch || null,
          reason: discardRes.reason || 'discard_failed',
          error: discardRes.error || `Failed to discard branch "${pendingBranch}".`
        });
        return true;
      }

      const nowIso = new Date().toISOString();
      delete raw.pending_branch;
      delete raw.base_branch;
      delete raw.requires_user_confirmation;
      delete raw.merge_command;
      delete raw.commit_hash;
      raw.discarded_branch = pendingBranch;
      raw.updated_at = nowIso;

      let canonical = null;
      mutateTaskStateAtomic(taskStateFile, (taskState) => {
        transitionTaskState(raw, taskState, 'blocked', {
          blockReason: `User discarded pending frontend branch ${pendingBranch}`,
          retries: Number(raw.retries || 0),
          activeTaskPath: targetPath
        });
        canonical = writeMorningReportFile(taskState, {
          tasksActiveDir,
          tasksArchiveDir,
          reportFile
        });
        syncCanonicalTaskState(taskState, canonical);
      }, { fallbackFactory: () => ({ active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} }) });

      mutateVersionedJsonAtomic(liveStatusFile, (existingLive) => {
        const livePatch = {
          queue_stats: canonical.counts,
          updated_at: new Date().toISOString()
        };
        if (existingLive.current_task_id === taskId) {
          livePatch.task_final_status = 'blocked';
          livePatch.last_error = `User discarded pending frontend branch ${pendingBranch}`;
        }
        return {
          ...existingLive,
          ...livePatch
        };
      }, { allowCorruptFallback: true, fallbackFactory: () => ({}) });

      sendJson(res, 200, {
        ok: true,
        task_id: taskId,
        status: 'blocked',
        discarded_branch: pendingBranch,
        branch_existed: Boolean(discardRes.existed),
        queue_stats: canonical.counts,
        message: `Discarded branch "${pendingBranch}" and marked task "${taskId}" as blocked.`
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  // Hook reserved for task editing & saving
  if (req.method === 'POST' && url.pathname === '/api/task/save') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const cfgDir = snapshotPaths.CONFIG_DIR || path.resolve(teamDir, 'config');
      loadMergedPolicy({ configDir: cfgDir });
      const body = await parseJsonBody(req);
      const taskId = String(body.task_id || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid task_id' }));
        return true;
      }
      let targetPath = path.resolve(tasksActiveDir, `${taskId}.yaml`);
      if (!fs.existsSync(targetPath) && fs.existsSync(tasksActiveDir)) {
        const allFiles = fs.readdirSync(tasksActiveDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const af of allFiles) {
          const fp = path.resolve(tasksActiveDir, af);
          const parsed = loadYamlSafe(fp);
          const raw = (parsed?.task && typeof parsed.task === 'object') ? parsed.task : parsed;
          if (raw?.task_id === taskId || raw?.id === taskId) {
            targetPath = fp;
            break;
          }
        }
      }
      let yamlContent = '';
      if (body.raw_yaml && typeof body.raw_yaml === 'string') {
        yamlContent = body.raw_yaml;
      } else if (body.task && typeof body.task === 'object') {
        let existing = {};
        if (fs.existsSync(targetPath)) {
          existing = loadYamlSafe(targetPath);
          if (!existing || typeof existing !== 'object') {
            throw new Error(`Existing task file is unreadable or invalid YAML: ${targetPath}`);
          }
        }
        const container = (existing?.task && typeof existing.task === 'object')
          ? { task: { ...existing.task, ...body.task, updated_at: new Date().toISOString() } }
          : { task: { ...body.task, updated_at: new Date().toISOString() } };
        yamlContent = YAML.stringify(container);
      } else {
        throw new Error('Either raw_yaml or task object must be provided');
      }
      fs.writeFileSync(targetPath, yamlContent, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: 'Task saved successfully', task_id: taskId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  return false;
}
