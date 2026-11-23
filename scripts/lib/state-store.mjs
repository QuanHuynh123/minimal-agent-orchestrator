#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireSingleInstanceLock,
  readLockFile,
  releaseSingleInstanceLock
} from './runtime-lock.mjs';

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  }
}

export class RevisionConflictError extends Error {
  constructor(filePath, expectedRevision, actualRevision) {
    super(
      `[StateStore] Revision conflict on "${filePath}": expected revision ${expectedRevision}, found ${actualRevision}`
    );
    this.name = 'RevisionConflictError';
    this.code = 'REVISION_CONFLICT';
    this.filePath = filePath;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class RevisionRetryExhaustedError extends Error {
  constructor(lastError, { attempts = 1, maxRetries = 0, delaysMs = [] } = {}) {
    const filePath = lastError?.filePath || 'unknown';
    const expectedRevision = lastError?.expectedRevision ?? 'unknown';
    const actualRevision = lastError?.actualRevision ?? 'unknown';
    super(
      `[StateStore] Revision conflict retries exhausted after ${attempts} attempts (maxRetries=${maxRetries}) on "${filePath}": expected revision ${expectedRevision}, found ${actualRevision}.`
    );
    this.name = 'RevisionRetryExhaustedError';
    this.code = 'REVISION_RETRY_EXHAUSTED';
    this.attempts = attempts;
    this.maxRetries = maxRetries;
    this.delaysMs = delaysMs;
    this.filePath = filePath;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.cause = lastError;
  }
}

export class StateLockTimeoutError extends Error {
  constructor(filePath, lockFilePath, timeoutMs, holder = null) {
    const holderDesc = holder?.pid ? ` (held by PID ${holder.pid})` : '';
    super(
      `[StateStore] Timed out after ${timeoutMs}ms acquiring state lock "${lockFilePath}" for "${filePath}"${holderDesc}`
    );
    this.name = 'StateLockTimeoutError';
    this.code = 'STATE_LOCK_TIMEOUT';
    this.filePath = filePath;
    this.lockFilePath = lockFilePath;
    this.timeoutMs = timeoutMs;
    this.holder = holder;
  }
}

export function normalizeRevision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function stripUtf8Bom(raw = '') {
  return typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : '';
}

export function parseJsonNoBom(raw = '', label = 'JSON') {
  const clean = stripUtf8Bom(raw);
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${err.message}`);
  }
}

function isTransientWindowsFsError(err) {
  return err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
}

export function renameWithRetrySync(tmpPath, targetPath, maxRetries = 15) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      if (attempt < maxRetries && isTransientWindowsFsError(err)) {
        sleepSync(10 + attempt * 5);
        continue;
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
  }
}

export function writeFileAtomicRaw(filePath, serializedContent) {
  const absPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp.${process.pid}.${process.hrtime.bigint()}.${Math.random().toString(36).slice(2, 8)}`;
  const cleanContent = stripUtf8Bom(String(serializedContent ?? ''));
  fs.writeFileSync(tmpPath, cleanContent, 'utf8');
  renameWithRetrySync(tmpPath, absPath);
  return true;
}

export function writeJsonAtomicRaw(filePath, payload) {
  return writeFileAtomicRaw(filePath, JSON.stringify(payload, null, 2));
}

export function withStateFileLock(filePath, fn, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('[StateStore] withStateFileLock requires a valid filePath');
  }
  const absPath = path.resolve(filePath);
  const lockFilePath = options.lockFilePath ? path.resolve(options.lockFilePath) : `${absPath}.lock`;
  const timeoutMs = Number(options.timeoutMs ?? 10000);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let lockRes = null;
    try {
      lockRes = acquireSingleInstanceLock(lockFilePath, {
        role: 'state-lock',
        port: null,
        pid: process.pid,
        corruptGraceMs: 1000,
        maxAttempts: 5,
        logger: options.logger ?? (() => {})
      });
    } catch (err) {
      if (!isTransientWindowsFsError(err)) {
        throw err;
      }
    }

    if (lockRes?.ok) {
      const instanceId = lockRes.lock.instance_id;
      try {
        return fn();
      } finally {
        for (let attempt = 0; attempt < 15; attempt++) {
          const released = releaseSingleInstanceLock(lockFilePath, { instanceId });
          if (released || !fs.existsSync(lockFilePath)) break;
          const cur = readLockFile(lockFilePath);
          if (cur && cur.instance_id !== instanceId) break;
          sleepSync(10 + attempt * 4);
        }
      }
    }

    if (Date.now() >= deadline) {
      throw new StateLockTimeoutError(absPath, lockFilePath, timeoutMs, readLockFile(lockFilePath));
    }
    sleepSync(12 + Math.floor(Math.random() * 20));
  }
}

function cloneFallback(fallbackFactory) {
  const base = typeof fallbackFactory === 'function' ? fallbackFactory() : fallbackFactory;
  return base && typeof base === 'object' ? { ...base } : {};
}

function readDiskVersionedUnsafe(absPath, fallbackFactory, allowCorruptFallback = false) {
  if (!fs.existsSync(absPath)) {
    const data = cloneFallback(fallbackFactory);
    return { data: { ...data, revision: 0 }, revision: 0, existed: false };
  }
  try {
    const raw = stripUtf8Bom(fs.readFileSync(absPath, 'utf8'));
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON root must be an object');
    }
    const rev = normalizeRevision(parsed.revision);
    return { data: { ...parsed, revision: rev }, revision: rev, existed: true };
  } catch (err) {
    if (allowCorruptFallback) {
      const data = cloneFallback(fallbackFactory);
      return { data: { ...data, revision: 0 }, revision: 0, existed: true };
    }
    throw new Error(`[StateStore] Failed parsing "${absPath}": ${err.message}`);
  }
}

export function readVersionedJson(filePath, fallbackFactory = () => ({}), options = {}) {
  const absPath = path.resolve(filePath);
  return readDiskVersionedUnsafe(absPath, fallbackFactory, Boolean(options.allowCorruptFallback)).data;
}

export function writeVersionedJsonAtomic(filePath, payload, options = {}) {
  const absPath = path.resolve(filePath);
  const {
    fallbackFactory = () => ({}),
    allowCorruptFallback = false,
    expectedRevision,
    prepare
  } = options;

  return withStateFileLock(absPath, () => {
    const current = readDiskVersionedUnsafe(absPath, fallbackFactory, allowCorruptFallback);
    const hasExplicitExpected = expectedRevision !== undefined && expectedRevision !== null;
    const expected = hasExplicitExpected
      ? normalizeRevision(expectedRevision)
      : (Number.isInteger(payload?.revision) && payload.revision >= 0 ? payload.revision : null);

    if (expected !== null && expected !== current.revision) {
      throw new RevisionConflictError(absPath, expected, current.revision);
    }

    const nextRevision = current.revision + 1;
    let nextPayload = { ...(payload && typeof payload === 'object' ? payload : {}), revision: nextRevision };
    if (typeof prepare === 'function') {
      nextPayload = prepare(nextPayload);
    }
    nextPayload.revision = nextRevision;
    writeJsonAtomicRaw(absPath, nextPayload);
    return nextPayload;
  }, options);
}

export function mutateVersionedJsonAtomic(filePath, mutatorFn, options = {}) {
  if (typeof mutatorFn !== 'function') {
    throw new Error('[StateStore] mutateVersionedJsonAtomic requires a mutator function');
  }
  const absPath = path.resolve(filePath);
  const {
    fallbackFactory = () => ({}),
    allowCorruptFallback = false,
    expectedRevision,
    prepare
  } = options;

  return withStateFileLock(absPath, () => {
    const current = readDiskVersionedUnsafe(absPath, fallbackFactory, allowCorruptFallback);
    if (expectedRevision !== undefined && expectedRevision !== null) {
      const expected = normalizeRevision(expectedRevision);
      if (expected !== current.revision) {
        throw new RevisionConflictError(absPath, expected, current.revision);
      }
    }

    const workingCopy = { ...current.data };
    const returned = mutatorFn(workingCopy, {
      revision: current.revision,
      existed: current.existed
    });
    const baseNext = (returned && typeof returned === 'object') ? returned : workingCopy;
    const nextRevision = current.revision + 1;
    let nextPayload = { ...baseNext, revision: nextRevision };
    if (typeof prepare === 'function') {
      nextPayload = prepare(nextPayload);
    }
    nextPayload.revision = nextRevision;
    writeJsonAtomicRaw(absPath, nextPayload);
    return nextPayload;
  }, options);
}

function isRevisionConflictErr(err) {
  return Boolean(err && (err instanceof RevisionConflictError || err.code === 'REVISION_CONFLICT'));
}

function normalizeRetryOptions(options = {}) {
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : 4;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) && options.baseDelayMs >= 0 ? options.baseDelayMs : 25;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) && options.maxDelayMs >= 0 ? Math.max(baseDelayMs, options.maxDelayMs) : Math.max(baseDelayMs, 500);
  const jitterRatio = Number.isFinite(options.jitterRatio) && options.jitterRatio >= 0 ? Math.min(options.jitterRatio, 1) : 0.25;
  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    jitterRatio,
    randomFn: typeof options.randomFn === 'function' ? options.randomFn : Math.random,
    onRetry: typeof options.onRetry === 'function' ? options.onRetry : null
  };
}

export function computeRetryBackoffMs(attempt = 0, options = {}) {
  const cfg = normalizeRetryOptions(options);
  const expDelay = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * (2 ** Math.max(0, attempt)));
  const jitterSpan = expDelay * cfg.jitterRatio;
  const jitter = jitterSpan > 0 ? jitterSpan * Math.max(0, Math.min(1, cfg.randomFn())) : 0;
  return Math.min(cfg.maxDelayMs, Math.max(0, Math.round(expDelay + jitter)));
}

function prepareConflictRetryDelay(err, attempt, cfg, delaysMs) {
  if (!isRevisionConflictErr(err)) {
    throw err;
  }
  if (attempt >= cfg.maxRetries) {
    throw new RevisionRetryExhaustedError(err, {
      attempts: attempt + 1,
      maxRetries: cfg.maxRetries,
      delaysMs
    });
  }
  const delayMs = computeRetryBackoffMs(attempt, cfg);
  delaysMs.push(delayMs);
  cfg.onRetry?.({
    attempt: attempt + 1,
    maxRetries: cfg.maxRetries,
    delayMs,
    error: err
  });
  return delayMs;
}

export function retryOnRevisionConflictSync(operationFn, options = {}) {
  if (typeof operationFn !== 'function') {
    throw new Error('[StateStore] retryOnRevisionConflictSync requires a function');
  }
  const cfg = normalizeRetryOptions(options);
  const sleepFn = typeof options.sleepFn === 'function' ? options.sleepFn : sleepSync;
  const delaysMs = [];

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return operationFn(attempt);
    } catch (err) {
      const delayMs = prepareConflictRetryDelay(err, attempt, cfg, delaysMs);
      sleepFn(delayMs);
    }
  }
}

export async function retryOnRevisionConflict(operationFn, options = {}) {
  if (typeof operationFn !== 'function') {
    throw new Error('[StateStore] retryOnRevisionConflict requires a function');
  }
  const cfg = normalizeRetryOptions(options);
  const sleepAsyncFn = typeof options.sleepFn === 'function'
    ? options.sleepFn
    : (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const delaysMs = [];

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await operationFn(attempt);
    } catch (err) {
      const delayMs = prepareConflictRetryDelay(err, attempt, cfg, delaysMs);
      await sleepAsyncFn(delayMs);
    }
  }
}

export function updateVersionedJsonWithRetry(filePath, computeNextFn, options = {}) {
  if (typeof computeNextFn !== 'function') {
    throw new Error('[StateStore] updateVersionedJsonWithRetry requires a computeNextFn function');
  }
  const absPath = path.resolve(filePath);
  const {
    fallbackFactory = () => ({}),
    allowCorruptFallback = false
  } = options;

  return retryOnRevisionConflictSync((attempt) => {
    const current = readVersionedJson(absPath, fallbackFactory, { allowCorruptFallback });
    const nextPayload = computeNextFn(current, attempt);
    return writeVersionedJsonAtomic(absPath, nextPayload, {
      ...options,
      expectedRevision: current.revision
    });
  }, options);
}
