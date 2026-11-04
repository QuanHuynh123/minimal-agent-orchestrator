import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { verifyCsrfAndOrigin, parseJsonBody } from './security.mjs';
import {
  createSnapshot,
  scanSessions,
  readSessionDetails,
  isProcessAlive,
  loadYamlSafe
} from './state-reader.mjs';
import { decomposeGoal } from '../goal-planner.mjs';

export async function handleTasksRoutes(req, res, url, options = {}) {
  const sessionsDir = options.SESSIONS_DIR || path.resolve('agent-team/state/sessions');
  const tasksActiveDir = options.TASKS_ACTIVE_DIR || path.resolve('agent-team/tasks/active');
  const lockFile = options.LOCK_FILE || path.resolve('agent-team/.orchestrator.lock');
  const teamDir = options.TEAM_DIR || path.resolve('agent-team');
  const snapshotPaths = options.snapshotPaths || {};

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    try {
      const snapshot = await createSnapshot(snapshotPaths);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
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
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: true, count: sessions.length, sessions }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
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
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: true, session: details }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
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
      const body = await parseJsonBody(req);
      const goal = String(body.goal || '').trim();
      if (!goal) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Goal cannot be empty' }));
        return true;
      }

      console.log(`[Dashboard API] Decomposing goal with Router Agent: "${goal}"...`);
      const decompRes = await decomposeGoal(goal, { dryRun: false });
      res.writeHead(decompRes.ok ? 200 : 500, {
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
      const body = await parseJsonBody(req);
      const targetIds = Array.isArray(body.task_ids) ? new Set(body.task_ids) : null;

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

      // 2. Check if Orchestrator is already running
      const lockData = fs.existsSync(lockFile) ? loadYamlSafe(lockFile) : null;
      if (lockData && isProcessAlive(lockData.pid)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          approved_count: approvedCount,
          message: 'Tasks approved. Orchestrator is already actively running.'
        }));
        return true;
      }

      // 3. Spawn Orchestrator in detached background process
      const orchestratorScript = path.resolve(teamDir, 'scripts', 'orchestrator.mjs');
      const child = spawn(process.execPath, [orchestratorScript, 'run'], {
        cwd: path.resolve(teamDir, '..'),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      child.unref();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        approved_count: approvedCount,
        message: `Approved ${approvedCount} task(s) and launched Orchestrator in background.`,
        pid: child.pid
      }));
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
      const lockData = fs.existsSync(lockFile) ? loadYamlSafe(lockFile) : null;
      if (!lockData || !isProcessAlive(lockData.pid)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: 'Orchestrator is not running.' }));
        return true;
      }

      process.kill(lockData.pid, 'SIGTERM');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: `Terminated Orchestrator process (PID: ${lockData.pid})` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  return false;
}
