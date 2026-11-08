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

      const preset = String(body.preset || 'auto').trim();
      const modeOverride = preset === 'consult' ? 'consult' : (body.mode || null);
      console.log(`[Dashboard API] Decomposing goal with Router Agent (preset=${preset}): "${goal}"...`);
      const decompRes = await decomposeGoal(goal, {
        dryRun: false,
        preset,
        mode: modeOverride
      });
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

  // --- Task Operations: Detail, Delete, Save ---

  if (req.method === 'GET' && url.pathname === '/api/task/detail') {
    try {
      const taskId = String(url.searchParams.get('id') || '').trim();
      if (!taskId || taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid task id' }));
        return true;
      }
      let foundTask = null;
      let rawYaml = '';
      if (fs.existsSync(tasksActiveDir)) {
        const allFiles = fs.readdirSync(tasksActiveDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const af of allFiles) {
          const fp = path.resolve(tasksActiveDir, af);
          const rawContent = fs.readFileSync(fp, 'utf8');
          const parsed = loadYamlSafe(fp);
          const raw = (parsed?.task && typeof parsed.task === 'object') ? parsed.task : parsed;
          if (raw?.task_id === taskId || raw?.id === taskId || af === `${taskId}.yaml` || af === `${taskId}.yml`) {
            foundTask = raw;
            rawYaml = rawContent;
            break;
          }
        }
      }
      if (!foundTask) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `Task "${taskId}" not found in active queue.` }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, task_id: taskId, task: foundTask, raw_yaml: rawYaml }));
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

  // Hook reserved for task editing & saving
  if (req.method === 'POST' && url.pathname === '/api/task/save') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
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
        const existing = fs.existsSync(targetPath) ? loadYamlSafe(targetPath) : {};
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
