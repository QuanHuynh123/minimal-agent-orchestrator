#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const PROCESS_START_TOLERANCE_MS = 1500;
const selfStartTimeCache = new Map();

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  }
}

/**
 * Checks whether a PID currently exists in the OS process table.
 * Treats EPERM (process exists under another user/elevation level) as alive.
 */
export function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const killFn = typeof options.kill === 'function' ? options.kill : process.kill.bind(process);
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function queryOsProcessStartTimeMs(pid) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `([DateTimeOffset][System.Diagnostics.Process]::GetProcessById(${Number(pid)}).StartTime).ToUnixTimeMilliseconds()`
        ],
        { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      const parsed = Number(out);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(parsed);
      }
    } catch {
      return null;
    }
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const statLine = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = statLine.lastIndexOf(')');
      if (rparen !== -1) {
        const rest = statLine.slice(rparen + 2).trim().split(/\s+/);
        // Field 22 in /proc/[pid]/stat (index 19 after comm + space) is starttime in clock ticks
        const startTicks = Number(rest[19]);
        const procStat = fs.readFileSync('/proc/stat', 'utf8');
        const btimeMatch = procStat.match(/^btime\s+(\d+)/m);
        if (Number.isFinite(startTicks) && btimeMatch) {
          let clkTck = 100;
          try {
            const rawClk = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            const parsedClk = Number(rawClk);
            if (Number.isFinite(parsedClk) && parsedClk > 0) clkTck = parsedClk;
          } catch {}
          return Math.round((Number(btimeMatch[1]) + startTicks / clkTck) * 1000);
        }
      }
    } catch {}
  }

  try {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const parsed = Date.parse(lstart);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {}
  return null;
}

/**
 * Returns process creation timestamp in Unix ms, or null if inaccessible/nonexistent.
 */
export function getProcessStartTimeMs(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof options.getProcessStartTime === 'function') {
    const val = options.getProcessStartTime(pid);
    return Number.isFinite(val) && val > 0 ? Math.round(val) : null;
  }
  if (pid === process.pid) {
    if (!selfStartTimeCache.has(pid)) {
      selfStartTimeCache.set(pid, Math.round(Date.now() - process.uptime() * 1000));
    }
    return selfStartTimeCache.get(pid);
  }
  const queried = queryOsProcessStartTimeMs(pid);
  if (Number.isFinite(queried) && queried > 0) {
    return queried;
  }
  return null;
}

function checkLockOwnerStatus(existing, options = {}) {
  const killFn = options.killFn;
  if (!existing || !Number.isInteger(existing.pid)) {
    return { alive: false, pidReused: false };
  }
  if (!isProcessAlive(existing.pid, { kill: killFn })) {
    return { alive: false, pidReused: false };
  }

  const toleranceMs = Number(options.processStartToleranceMs ?? PROCESS_START_TOLERANCE_MS);
  const recordedStartMs = Number.isFinite(existing.process_start_ms)
    ? existing.process_start_ms
    : (typeof existing.process_started_at === 'string' ? Date.parse(existing.process_started_at) : NaN);
  const lockCreatedMs = typeof existing.started_at === 'string' ? Date.parse(existing.started_at) : NaN;

  if (!Number.isFinite(recordedStartMs) && !Number.isFinite(lockCreatedMs)) {
    return {
      alive: true,
      pidReused: false,
      startTimeUnavailable: true,
      startTimeReason: 'missing_start_time_metadata'
    };
  }

  if (typeof options.getProcessStartTime !== 'function') {
    const ageAnchorMs = Number.isFinite(recordedStartMs) ? recordedStartMs : lockCreatedMs;
    if (Number.isFinite(ageAnchorMs) && Date.now() - ageAnchorMs <= toleranceMs) {
      return { alive: true, pidReused: false, startTimeUnavailable: false };
    }
  }

  const actualStartMs = getProcessStartTimeMs(existing.pid, options);
  if (!Number.isFinite(actualStartMs) || actualStartMs <= 0) {
    // Fail closed if OS denies querying an existing live PID (e.g., elevated admin owner)
    return {
      alive: true,
      pidReused: false,
      startTimeUnavailable: true,
      startTimeReason: 'os_start_time_unreadable'
    };
  }

  // Only a newer start time (beyond tolerance) proves PID reuse; V8 boot delay can only push recordedStartMs later.
  if (Number.isFinite(recordedStartMs) && actualStartMs > recordedStartMs + toleranceMs) {
    return { alive: false, pidReused: true, startTimeUnavailable: false, actualStartMs, recordedStartMs };
  }
  if (!Number.isFinite(recordedStartMs) && Number.isFinite(lockCreatedMs) && actualStartMs > lockCreatedMs + toleranceMs) {
    return { alive: false, pidReused: true, startTimeUnavailable: false, actualStartMs, recordedStartMs: lockCreatedMs };
  }
  return { alive: true, pidReused: false, startTimeUnavailable: false };
}

export function normalizeLockPort(port) {
  if (port === null || port === undefined || port === '') return null;
  const num = Number(port);
  return Number.isInteger(num) && num >= 0 && num <= 65535 ? num : null;
}

export function readLockFile(lockFilePath) {
  if (!lockFilePath || !fs.existsSync(lockFilePath)) return null;
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

export function formatLockConflictMessage(owner = {}, role = 'instance', ownerStatus = {}) {
  const normalizedRole = String(role || 'instance').toLowerCase();
  const label = normalizedRole === 'cockpit' ? 'Cockpit' : (normalizedRole === 'orchestrator' ? 'Orchestrator' : String(role || 'Instance'));
  const pidText = owner?.pid ?? 'unknown';
  const portText = (owner?.port !== null && owner?.port !== undefined && owner?.port !== '')
    ? String(owner.port)
    : 'none';
  const startedText = owner?.started_at || 'unknown';
  if (ownerStatus?.startTimeUnavailable) {
    const scriptHint = normalizedRole === 'cockpit'
      ? 'node agent-team/scripts/dashboard.mjs --force-unlock'
      : 'node agent-team/scripts/orchestrator.mjs --force-unlock';
    return `[${label}] Refusing to start (fail-closed): PID ${pidText} appears alive in the OS process table, but process start time could not be read (${ownerStatus.startTimeReason || 'os_start_time_unreadable'}), so PID reuse cannot be ruled out (Port: ${portText}, Started: ${startedText}). Verify PID ${pidText} is not an active ${label}; if safe to clear manually, run: ${scriptHint}`;
  }
  return `[${label}] Refusing to start: another instance already holds lock (PID: ${pidText}, Port: ${portText}, Started: ${startedText}).`;
}

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function renameWithRetrySync(src, dest, renameFn = fs.renameSync, maxRetries = 12) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      renameFn(src, dest);
      return;
    } catch (err) {
      if (!TRANSIENT_FS_CODES.has(err?.code) || i === maxRetries) {
        throw err;
      }
      sleepSync(12 + i * 5);
    }
  }
}

function unlinkWithRetrySync(targetPath, maxRetries = 8) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      fs.unlinkSync(targetPath);
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return true;
      if (!TRANSIENT_FS_CODES.has(err?.code) || i === maxRetries) {
        throw err;
      }
      sleepSync(10 + i * 5);
    }
  }
  return false;
}

/**
 * Publishes `tmpPath` (already populated with full JSON and closed) at `targetPath` in one atomic directory operation.
 * Never performs a 2-step `openSync('wx') + writeSync` directly on `targetPath`, so an appearing `.lock`/`.reclaim`
 * file always contains complete valid JSON:
 *  1. Primary path: `fs.linkSync(tmpPath, targetPath)` (atomic exclusive hardlink; retries transient Windows
 *     `EPERM`/`EBUSY`/`EACCES` before falling back).
 *  2. Non-hardlink / sandbox fallback (`EXDEV`, `ENOTSUP`, `EOPNOTSUPP`, `EINVAL`, or persistent `EPERM` after retries):
 *     serializes via OS-atomic `mkdirSync(createMutexDir)` + non-overwrite check + `renameSync(tmpPath, targetPath)`.
 * `corruptGraceMs` therefore applies strictly to genuine crash stubs (e.g., power loss / corrupt leftover files).
 */
function acquireMkdirRenameCreate(tmpPath, targetPath, options = {}) {
  const createMutexDir = `${targetPath}.mkguard`;
  const corruptGraceMs = Number(options.corruptGraceMs ?? 1500);
  const renameFn = typeof options.renameSync === 'function' ? options.renameSync : fs.renameSync;
  const deadline = Date.now() + Math.max(500, corruptGraceMs);

  while (Date.now() < deadline) {
    let acquiredDir = false;
    try {
      fs.mkdirSync(createMutexDir);
      acquiredDir = true;
    } catch (mkErr) {
      if (mkErr?.code !== 'EEXIST') {
        throw mkErr;
      }
      if (fs.existsSync(targetPath)) {
        return { ok: false, code: 'EEXIST' };
      }
      try {
        const stat = fs.statSync(createMutexDir);
        if (Date.now() - stat.mtimeMs >= corruptGraceMs) {
          fs.rmdirSync(createMutexDir);
          continue;
        }
      } catch {}
      sleepSync(12);
      continue;
    }

    try {
      if (fs.existsSync(targetPath)) {
        return { ok: false, code: 'EEXIST' };
      }
      renameWithRetrySync(tmpPath, targetPath, renameFn);
      return { ok: true, method: 'mkdir_rename' };
    } finally {
      if (acquiredDir) {
        try { fs.rmdirSync(createMutexDir); } catch {}
      }
    }
  }
  return { ok: false, code: 'EEXIST' };
}

function tryAtomicCreateFile(tmpPath, _serialized, targetPath, options = {}) {
  const linkFn = typeof options.linkSync === 'function' ? options.linkSync : fs.linkSync;
  const maxLinkRetries = Number.isInteger(options.linkRetries) ? options.linkRetries : 2;
  const fallbackCodes = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL']);

  for (let i = 0; i <= maxLinkRetries; i++) {
    try {
      linkFn(tmpPath, targetPath);
      return { ok: true, method: 'link' };
    } catch (err) {
      if (err?.code === 'EEXIST') {
        return { ok: false, code: 'EEXIST' };
      }
      if (TRANSIENT_FS_CODES.has(err?.code)) {
        if (i < maxLinkRetries) {
          sleepSync(12 + i * 5);
          continue;
        }
        // Persistent EPERM/EACCES (e.g. Windows sandbox disallowing CreateHardLink):
        // publish complete tmpPath atomically under mkdirSync mutex without 2-step empty file creation.
        return acquireMkdirRenameCreate(tmpPath, targetPath, options);
      }
      if (fallbackCodes.has(err?.code)) {
        return acquireMkdirRenameCreate(tmpPath, targetPath, options);
      }
      throw err;
    }
  }
  return { ok: false, code: 'EEXIST' };
}

export function acquireShortReclaimGuard(reclaimPath, timeoutMs = 1500, options = {}) {
  if (!reclaimPath) return false;
  const absReclaimPath = path.resolve(reclaimPath);
  fs.mkdirSync(path.dirname(absReclaimPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  const corruptGraceMs = Number(options.corruptGraceMs ?? 1500);
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const instanceId = options.instanceId || crypto.randomUUID();
  const trackProcessStart = options.trackProcessStart !== undefined ? Boolean(options.trackProcessStart) : true;
  const processStartMs = trackProcessStart
    ? (Number.isFinite(options.selfStartTimeMs)
        ? Math.round(options.selfStartTimeMs)
        : (pid === process.pid ? getProcessStartTimeMs(pid) : getProcessStartTimeMs(pid, options)))
    : null;
  const guardPayload = JSON.stringify({
    pid,
    instance_id: instanceId,
    started_at: new Date().toISOString(),
    ...(Number.isFinite(processStartMs) && processStartMs > 0
      ? {
          process_started_at: new Date(processStartMs).toISOString(),
          process_start_ms: processStartMs
        }
      : {}),
    ts: Date.now()
  });

  const tmpGuardPath = `${absReclaimPath}.tmp.${pid}.${process.hrtime.bigint()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpGuardPath, guardPayload, { flag: 'wx', encoding: 'utf8' });

  try {
    do {
      const created = tryAtomicCreateFile(tmpGuardPath, guardPayload, absReclaimPath, options);
      if (created.ok) {
        return true;
      }

      const existing = readLockFile(absReclaimPath);
      if (existing && Number.isInteger(existing.pid)) {
        if (existing.pid === pid && existing.instance_id === instanceId) {
          return true;
        }
        const ownerStatus = checkLockOwnerStatus(existing, options);
        if (!ownerStatus.alive) {
          // Owner died or PID was reused: re-verify same guard identity before evicting
          const stillSame = readLockFile(absReclaimPath);
          if (stillSame && stillSame.pid === existing.pid && stillSame.instance_id === existing.instance_id) {
            unlinkWithRetrySync(absReclaimPath);
          }
          continue;
        }
        // Live owner holds .reclaim: exclude strictly by owner liveness, never elapsed time
      } else {
        if (!fs.existsSync(absReclaimPath)) {
          continue;
        }
        // Corrupt/unparseable mid-write file: allow brief grace period before cleanup
        try {
          const stat = fs.statSync(absReclaimPath);
          if (Date.now() - stat.mtimeMs >= corruptGraceMs) {
            unlinkWithRetrySync(absReclaimPath);
            continue;
          }
        } catch {
          continue;
        }
      }

      sleepSync(20);
    } while (Date.now() < deadline);
    return false;
  } finally {
    try {
      if (fs.existsSync(tmpGuardPath)) fs.unlinkSync(tmpGuardPath);
    } catch {}
  }
}

export function releaseShortReclaimGuard(reclaimPath, options = {}) {
  if (!reclaimPath) return false;
  const absReclaimPath = path.resolve(reclaimPath);
  if (!fs.existsSync(absReclaimPath)) return false;

  const expectedPid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const current = readLockFile(absReclaimPath);
  if (current) {
    if (Number.isInteger(current.pid) && current.pid !== expectedPid) {
      return false;
    }
    if (options.instanceId && current.instance_id && current.instance_id !== options.instanceId) {
      return false;
    }
  }
  try {
    unlinkWithRetrySync(absReclaimPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically acquires a single-instance lock file containing `{ pid, port, started_at, role, instance_id }`.
 * - Rejects immediately if an active live PID holds the lock, returning clear PID/port/timestamp info.
 * - Replaces stale locks whose owner PID is dead under an exclusive reclaim guard.
 */
export function acquireSingleInstanceLock(lockFilePath, options = {}) {
  if (!lockFilePath) {
    throw new Error('acquireSingleInstanceLock requires a valid lockFilePath');
  }
  const absLockPath = path.resolve(lockFilePath);
  fs.mkdirSync(path.dirname(absLockPath), { recursive: true });

  const role = options.role || 'orchestrator';
  const pid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const port = normalizeLockPort(options.port);
  const startedAt = options.startedAt || new Date().toISOString();
  const trackProcessStart = options.trackProcessStart !== undefined ? Boolean(options.trackProcessStart) : role !== 'state-lock';
  const processStartMs = trackProcessStart
    ? (Number.isFinite(options.processStartMs) ? Math.round(options.processStartMs) : getProcessStartTimeMs(pid, options))
    : null;
  const instanceId = options.instanceId || crypto.randomUUID();
  const corruptGraceMs = Number(options.corruptGraceMs ?? 1500);
  const maxAttempts = Number(options.maxAttempts ?? 20);
  const log = typeof options.logger === 'function' ? options.logger : console.warn;

  const lockPayload = {
    pid,
    port,
    started_at: startedAt,
    ...(Number.isFinite(processStartMs) && processStartMs > 0
      ? {
          process_started_at: new Date(processStartMs).toISOString(),
          process_start_ms: processStartMs
        }
      : {}),
    role,
    instance_id: instanceId
  };
  const serialized = JSON.stringify(lockPayload);
  const tmpPath = `${absLockPath}.tmp.${pid}.${process.hrtime.bigint()}.${Math.random().toString(36).slice(2, 8)}`;
  const reclaimPath = `${absLockPath}.reclaim`;

  fs.writeFileSync(tmpPath, serialized, { flag: 'wx', encoding: 'utf8' });

  let replacedStalePid = null;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const created = tryAtomicCreateFile(tmpPath, serialized, absLockPath, options);
      if (created.ok) {
        return {
          ok: true,
          lock: lockPayload,
          lockFile: absLockPath,
          replacedStalePid
        };
      }

      // EEXIST: inspect existing lock carefully
      const existing = readLockFile(absLockPath);
      if (!existing) {
        let ageMs = corruptGraceMs + 1;
        try {
          ageMs = Date.now() - fs.statSync(absLockPath).mtimeMs;
        } catch {}
        if (ageMs < corruptGraceMs) {
          sleepSync(35);
          continue;
        }
      }

      if (existing && Number.isInteger(existing.pid)) {
        if (existing.pid === pid && existing.instance_id === instanceId) {
          return {
            ok: true,
            lock: existing,
            lockFile: absLockPath,
            replacedStalePid
          };
        }
        const ownerStatus = checkLockOwnerStatus(existing, options);
        if (ownerStatus.alive) {
          return {
            ok: false,
            reason: 'already_running',
            startTimeUnavailable: Boolean(ownerStatus.startTimeUnavailable),
            startTimeReason: ownerStatus.startTimeReason || null,
            owner: existing,
            lockFile: absLockPath,
            message: formatLockConflictMessage(existing, existing.role || role, ownerStatus)
          };
        }
      }

      // Dead PID, reused PID, or stale corrupt lock: serialize reclamation across concurrent starters
      const guardInstanceId = crypto.randomUUID();
      const gotGuard = acquireShortReclaimGuard(reclaimPath, Number(options.reclaimTimeoutMs ?? 1500), {
        ...options,
        pid,
        instanceId: guardInstanceId,
        selfStartTimeMs: processStartMs
      });
      if (!gotGuard) {
        sleepSync(25);
        continue;
      }

      try {
        const recheck = readLockFile(absLockPath);
        const recheckStatus = checkLockOwnerStatus(recheck, options);
        if (recheck && Number.isInteger(recheck.pid) && recheckStatus.alive) {
          return {
            ok: false,
            reason: 'already_running',
            startTimeUnavailable: Boolean(recheckStatus.startTimeUnavailable),
            startTimeReason: recheckStatus.startTimeReason || null,
            owner: recheck,
            lockFile: absLockPath,
            message: formatLockConflictMessage(recheck, recheck.role || role, recheckStatus)
          };
        }

        if (fs.existsSync(absLockPath)) {
          replacedStalePid = recheck?.pid ?? 'corrupt';
          const stalePort = recheck?.port ?? 'none';
          const roleTitle = role === 'cockpit' ? 'Cockpit' : 'Orchestrator';
          const reasonLabel = recheckStatus.pidReused ? 'reused PID' : 'dead PID';
          log(`[${roleTitle}] Reclaiming stale lock from ${reasonLabel}: ${replacedStalePid} (Port: ${stalePort}).`);
          unlinkWithRetrySync(absLockPath);
        }
      } finally {
        releaseShortReclaimGuard(reclaimPath, { pid, instanceId: guardInstanceId });
      }
    }

    const finalOwner = readLockFile(absLockPath) || {};
    return {
      ok: false,
      reason: 'lock_contention',
      owner: finalOwner,
      lockFile: absLockPath,
      message: formatLockConflictMessage(finalOwner, finalOwner.role || role)
    };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export function updateSingleInstanceLockPort(lockFilePath, newPort, options = {}) {
  if (!lockFilePath) return false;
  const absLockPath = path.resolve(lockFilePath);
  const expectedPid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const current = readLockFile(absLockPath);
  if (!current || current.pid !== expectedPid) return false;
  if (options.instanceId && current.instance_id !== options.instanceId) return false;

  const updated = {
    ...current,
    port: normalizeLockPort(newPort)
  };
  const tmpPath = `${absLockPath}.tmp.${expectedPid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const renameFn = typeof options.renameSync === 'function' ? options.renameSync : fs.renameSync;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(updated), 'utf8');
    renameWithRetrySync(tmpPath, absLockPath, renameFn);
    return true;
  } catch {
    try {
      if (fs.existsSync(tmpPath)) unlinkWithRetrySync(tmpPath);
    } catch {}
    return false;
  }
}

export function releaseSingleInstanceLock(lockFilePath, options = {}) {
  if (!lockFilePath) return false;
  const absLockPath = path.resolve(lockFilePath);
  if (!fs.existsSync(absLockPath)) return false;

  const expectedPid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const current = readLockFile(absLockPath);
  if (!current || current.pid !== expectedPid) {
    return false;
  }
  if (options.instanceId && current.instance_id !== options.instanceId) {
    return false;
  }

  try {
    unlinkWithRetrySync(absLockPath);
    return true;
  } catch {
    return false;
  }
}

function promptForceUnlockConfirmation(questionText, input = process.stdin, output = process.stdout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      resolve(String(answer || '').trim());
    };
    const rl = readline.createInterface({ input, output });
    rl.once('close', () => finish(''));
    rl.once('SIGINT', () => finish(''));
    rl.question(questionText, finish);
  });
}

export function forceUnlockSingleInstanceLock(lockFilePath, options = {}) {
  if (!lockFilePath) {
    throw new Error('forceUnlockSingleInstanceLock requires a valid lockFilePath');
  }
  if (options.confirmed !== true) {
    throw new Error('[Lock] Refusing forceUnlockSingleInstanceLock without explicit confirmed: true');
  }
  const absLockPath = path.resolve(lockFilePath);
  const reclaimPath = `${absLockPath}.reclaim`;
  const previousOwner = readLockFile(absLockPath);
  const previousReclaimOwner = readLockFile(reclaimPath);
  const lockExisted = fs.existsSync(absLockPath);
  const reclaimExisted = fs.existsSync(reclaimPath);

  const removedLock = lockExisted ? unlinkWithRetrySync(absLockPath) : false;
  const removedReclaim = reclaimExisted ? unlinkWithRetrySync(reclaimPath) : false;
  return {
    ok: true,
    lockFile: absLockPath,
    reclaimFile: reclaimPath,
    existed: lockExisted || reclaimExisted,
    removedLock,
    removedReclaim,
    previousOwner,
    previousReclaimOwner
  };
}

export async function runForceUnlockCli(options = {}) {
  const role = options.role || 'orchestrator';
  const label = String(role).toLowerCase() === 'cockpit' ? 'Cockpit' : 'Orchestrator';
  const lockFilePath = options.lockFilePath;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const log = typeof options.logger === 'function' ? options.logger : console.log;
  const errLog = typeof options.errorLogger === 'function' ? options.errorLogger : console.error;
  const killFn = options.killFn;

  if (!lockFilePath) {
    errLog(`[${label}] Force unlock failed: lock file path not specified.`);
    return { ok: false, code: 1 };
  }

  const absLockPath = path.resolve(lockFilePath);
  const reclaimPath = `${absLockPath}.reclaim`;
  const lockExisted = fs.existsSync(absLockPath);
  const reclaimExisted = fs.existsSync(reclaimPath);

  if (!lockExisted && !reclaimExisted) {
    log(`[${label}] No lock file present at ${absLockPath}. Nothing to unlock.`);
    return { ok: true, code: 0, existed: false };
  }

  const owner = readLockFile(absLockPath);
  const reclaimOwner = readLockFile(reclaimPath);
  const holder = owner || reclaimOwner || {};
  const pidText = holder?.pid ?? 'unknown';
  const portText = (holder?.port !== null && holder?.port !== undefined && holder?.port !== '')
    ? String(holder.port)
    : 'none';
  const startedText = holder?.started_at || 'unknown';
  const pidAlive = Number.isInteger(holder?.pid) ? isProcessAlive(holder.pid, { kill: killFn }) : false;

  log(`[${label}] Manual force-unlock target: ${absLockPath}`);
  log(`[${label}] Lock holder -> PID: ${pidText} (${pidAlive ? 'ALIVE / EPERM in OS table' : 'not running'}), Port: ${portText}, Started: ${startedText}`);
  if (reclaimExisted) {
    log(`[${label}] Reclaim guard present: ${reclaimPath}`);
  }
  if (pidAlive) {
    log(`[${label}] WARNING: PID ${pidText} still exists in OS process table! Only proceed if verified not an active ${label}.`);
  }

  const hasYesFlag = argv.some(arg => arg === '--yes' || arg === '-y' || arg === '--confirm');
  let confirmed = hasYesFlag;
  if (!confirmed) {
    const answer = typeof options.promptFn === 'function'
      ? await options.promptFn()
      : await promptForceUnlockConfirmation(
          `[${label}] Type "UNLOCK" or "yes" to remove the lock file (or re-run with --yes): `,
          options.stdin || process.stdin,
          options.stdout || process.stdout
        );
    const normalized = String(answer || '').trim().toLowerCase();
    confirmed = normalized === 'unlock' || normalized === 'yes';
  }

  if (!confirmed) {
    errLog(`[${label}] Force unlock aborted: explicit confirmation ("UNLOCK", "yes", or --yes) was not provided.`);
    return { ok: false, code: 1, existed: true, removedLock: false, removedReclaim: false };
  }

  const result = forceUnlockSingleInstanceLock(absLockPath, { confirmed: true });
  log(`[${label}] Force-unlocked ${absLockPath} (removed PID: ${pidText}, Port: ${portText}, removedReclaim: ${result.removedReclaim}).`);
  return { ...result, code: 0 };
}
