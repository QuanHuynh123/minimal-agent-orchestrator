#!/usr/bin/env node
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function runProcessWait(scriptPath, args = [], env = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(TEAM_DIR, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', d => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Timed out ${path.basename(scriptPath)}`));
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runTests() {
  console.log('Testing Atomic Locked Revision-Checked State Writes (Commit 3)...\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-state-conc-'));
  const stateDir = path.join(tmpRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const taskStateFile = path.join(stateDir, 'task-state.json');
  const liveStatusFile = path.join(stateDir, 'live-status.json');

  try {
    // 1. Revision Conflict Rejection (explicit stale expectedRevision must fail-closed)
    console.log('1. Testing explicit stale-revision rejection (RevisionConflictError)...');
    const stateStore = await import('./lib/state-store.mjs');
    const {
      RevisionConflictError,
      readVersionedJson,
      writeVersionedJsonAtomic,
      mutateVersionedJsonAtomic
    } = stateStore;
    assert.strictEqual(typeof writeVersionedJsonAtomic, 'function');
    assert.strictEqual(typeof mutateVersionedJsonAtomic, 'function');

    const w1 = writeVersionedJsonAtomic(taskStateFile, {
      version: '2.1',
      active_tasks: [],
      completed_tasks: [{ task_id: 'T-REV-1', status: 'done' }],
      blocked_tasks: [],
      metrics: { total_input_tokens: 100 }
    }, { expectedRevision: 0 });
    assert.strictEqual(w1.revision, 1, 'First write from revision 0 must yield revision 1');

    assert.throws(() => {
      writeVersionedJsonAtomic(taskStateFile, {
        version: '2.1',
        completed_tasks: [{ task_id: 'T-STALE', status: 'done' }]
      }, { expectedRevision: 0 });
    }, err => err instanceof RevisionConflictError && err.code === 'REVISION_CONFLICT', 'Stale expectedRevision=0 must throw RevisionConflictError');

    const afterRejected = readVersionedJson(taskStateFile);
    assert.strictEqual(afterRejected.revision, 1, 'Rejected write must preserve revision 1');
    assert.strictEqual(afterRejected.completed_tasks[0].task_id, 'T-REV-1', 'Rejected write must not corrupt disk state');
    console.log('✓ Stale-revision rejection verified.');

    // 2. Concurrent N=8 OS processes updating task-state.json with 0 lost updates
    console.log('2. Testing 8 concurrent processes writing task-state.json (zero lost updates)...');
    const N = 8;
    const taskStateConcurrentFile = path.join(stateDir, 'concurrent-task-state.json');
    writeVersionedJsonAtomic(taskStateConcurrentFile, {
      version: '2.1',
      active_tasks: [],
      completed_tasks: [],
      blocked_tasks: [],
      metrics: { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 }
    }, { expectedRevision: 0 });

    const taskWorkerScript = path.join(tmpRoot, 'task-worker.mjs');
    fs.writeFileSync(taskWorkerScript, [
      `import { mutateTaskStateAtomic } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, 'lib', 'task-persistence.mjs')).href)};`,
      `const statePath = process.argv[2];`,
      `const idx = Number(process.argv[3]);`,
      `mutateTaskStateAtomic(statePath, (state) => {`,
      `  state.completed_tasks = [...(state.completed_tasks || []), { task_id: \`T-CONC-\${idx}\`, status: 'done' }];`,
      `  state.metrics = { ...(state.metrics || {}), total_input_tokens: Number(state.metrics?.total_input_tokens || 0) + ((idx + 1) * 10) };`,
      `});`
    ].join('\n'), 'utf8');

    const workerResults = await Promise.all(
      Array.from({ length: N }, (_, i) => runProcessWait(taskWorkerScript, [taskStateConcurrentFile, String(i)]))
    );
    for (let i = 0; i < N; i++) {
      assert.strictEqual(workerResults[i].code, 0, `Worker ${i} failed:\n${workerResults[i].stderr}`);
    }

    const finalTaskState = JSON.parse(fs.readFileSync(taskStateConcurrentFile, 'utf8'));
    assert.strictEqual(finalTaskState.revision, 1 + N, `Expected final task-state revision ${1 + N}, got ${finalTaskState.revision}`);
    assert.strictEqual(finalTaskState.completed_tasks.length, N, `Expected ${N} completed tasks (0 lost updates), got ${finalTaskState.completed_tasks.length}`);
    for (let i = 0; i < N; i++) {
      assert.ok(finalTaskState.completed_tasks.some(t => t.task_id === `T-CONC-${i}`), `Missing update from worker ${i}`);
    }
    assert.strictEqual(finalTaskState.metrics.total_input_tokens, 360, 'Expected exact cumulative metrics sum 360');
    console.log(`✓ ${N} concurrent processes wrote task-state.json cleanly (revision=${finalTaskState.revision}, 0 lost updates).`);

    // 3. Concurrent N=8 OS processes patching live-status.json via updateLiveStatusFilePatch
    console.log('3. Testing 8 concurrent processes patching live-status.json (zero lost updates)...');
    const liveWorkerScript = path.join(tmpRoot, 'live-worker.mjs');
    fs.writeFileSync(liveWorkerScript, [
      `import { updateLiveStatusFilePatch } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, 'lib', 'queue-state.mjs')).href)};`,
      `const livePath = process.argv[2];`,
      `const idx = Number(process.argv[3]);`,
      `const ok = updateLiveStatusFilePatch(livePath, { [\`slot_\${idx}\`]: \`done-\${idx}\` });`,
      `if (!ok) { console.error('updateLiveStatusFilePatch returned false'); process.exit(1); }`
    ].join('\n'), 'utf8');

    const liveResults = await Promise.all(
      Array.from({ length: N }, (_, i) => runProcessWait(liveWorkerScript, [liveStatusFile, String(i)]))
    );
    for (let i = 0; i < N; i++) {
      assert.strictEqual(liveResults[i].code, 0, `Live worker ${i} failed:\n${liveResults[i].stderr}`);
    }

    const finalLive = JSON.parse(fs.readFileSync(liveStatusFile, 'utf8'));
    assert.strictEqual(finalLive.revision, N, `Expected live-status revision ${N}, got ${finalLive.revision}`);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(finalLive[`slot_${i}`], `done-${i}`, `Lost update on slot_${i} in live-status.json`);
    }
    console.log(`✓ ${N} concurrent processes patched live-status.json cleanly (revision=${finalLive.revision}, 0 lost updates).`);

    // 4. Verify saveStateAtomic bumps revision monotonically & rejects explicit stale expectedRevision
    console.log('4. Testing saveStateAtomic revision tracking & conflict check...');
    const { saveStateAtomic } = await import('./lib/task-persistence.mjs');
    const seqPath = path.join(stateDir, 'seq-state.json');
    const memState = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
    saveStateAtomic(seqPath, memState);
    assert.strictEqual(memState.revision, 1, 'saveStateAtomic must set initial revision=1');
    saveStateAtomic(seqPath, memState);
    assert.strictEqual(memState.revision, 2, 'Second saveStateAtomic must advance revision=2');
    assert.throws(() => {
      saveStateAtomic(seqPath, { ...memState, revision: 1 }, { expectedRevision: 1 });
    }, err => err instanceof RevisionConflictError && err.code === 'REVISION_CONFLICT', 'saveStateAtomic must reject stale expectedRevision');

    // Verify no leftover lock or temp files
    const leftovers = fs.readdirSync(stateDir).filter(f => f.includes('.tmp.') || f.endsWith('.lock'));
    assert.deepStrictEqual(leftovers, [], `Unexpected leftover lock/temp files in stateDir: ${leftovers.join(', ')}`);
    console.log('✓ saveStateAtomic revision tracking & clean lock cleanup verified.');

    // 5. RevisionConflictError bounded retry + exponential backoff recovery & exhaustion
    console.log('5. Testing RevisionConflictError bounded retry with backoff & clear exhaustion error...');
    const {
      RevisionRetryExhaustedError,
      retryOnRevisionConflictSync,
      retryOnRevisionConflict,
      updateVersionedJsonWithRetry,
      computeRetryBackoffMs
    } = stateStore;
    assert.strictEqual(typeof RevisionRetryExhaustedError, 'function', 'state-store must export RevisionRetryExhaustedError');
    assert.strictEqual(typeof retryOnRevisionConflictSync, 'function', 'state-store must export retryOnRevisionConflictSync');
    assert.strictEqual(typeof retryOnRevisionConflict, 'function', 'state-store must export retryOnRevisionConflict');
    assert.strictEqual(typeof updateVersionedJsonWithRetry, 'function', 'state-store must export updateVersionedJsonWithRetry');
    assert.strictEqual(typeof computeRetryBackoffMs, 'function', 'state-store must export computeRetryBackoffMs');

    // Verify backoff exponential growth and maxDelayMs bound
    const d0 = computeRetryBackoffMs(0, { baseDelayMs: 10, maxDelayMs: 25, jitterRatio: 0 });
    const d1 = computeRetryBackoffMs(1, { baseDelayMs: 10, maxDelayMs: 25, jitterRatio: 0 });
    const d2 = computeRetryBackoffMs(2, { baseDelayMs: 10, maxDelayMs: 25, jitterRatio: 0 });
    assert.strictEqual(d0, 10);
    assert.strictEqual(d1, 20);
    assert.strictEqual(d2, 25, 'Backoff delay must be bounded by maxDelayMs');

    // Branch A: Succeeds within maxRetries after external concurrent writes trigger RevisionConflictError
    const retryPath = path.join(stateDir, 'retry-recover.json');
    writeVersionedJsonAtomic(retryPath, { counter: 0 }, { expectedRevision: 0 });
    const retryLog = [];
    const recovered = updateVersionedJsonWithRetry(
      retryPath,
      (current, attempt) => {
        if (attempt < 2) {
          // Concurrent writer advances disk revision behind our back -> triggers RevisionConflictError
          writeVersionedJsonAtomic(retryPath, {
            ...current,
            external_bump: attempt + 1
          }, { expectedRevision: current.revision });
        }
        return {
          ...current,
          counter: (current.counter || 0) + 10
        };
      },
      {
        maxRetries: 4,
        baseDelayMs: 10,
        maxDelayMs: 80,
        jitterRatio: 0,
        onRetry: info => retryLog.push(info)
      }
    );
    assert.strictEqual(retryLog.length, 2, `Expected 2 conflict retries before success, got ${retryLog.length}`);
    assert.strictEqual(retryLog[0].delayMs, 10);
    assert.strictEqual(retryLog[1].delayMs, 20);
    assert.strictEqual(recovered.revision, 4, `Expected final revision 4 after 1 init + 2 external bumps + 1 own commit, got ${recovered.revision}`);
    assert.strictEqual(recovered.external_bump, 2, 'Recovered state must incorporate latest external concurrent update');
    assert.strictEqual(recovered.counter, 10);

    // Branch B: Retries exhausted -> throws clear RevisionRetryExhaustedError with diagnostic metadata
    const exhaustPath = path.join(stateDir, 'retry-exhaust.json');
    writeVersionedJsonAtomic(exhaustPath, { counter: 0 }, { expectedRevision: 0 });
    const exhaustLog = [];
    let exhaustAttempts = 0;
    assert.throws(() => {
      updateVersionedJsonWithRetry(
        exhaustPath,
        (current) => {
          exhaustAttempts++;
          // Always conflict on every attempt
          writeVersionedJsonAtomic(exhaustPath, { ...current, spoiler: exhaustAttempts }, { expectedRevision: current.revision });
          return { ...current, mine: exhaustAttempts };
        },
        {
          maxRetries: 2,
          baseDelayMs: 5,
          maxDelayMs: 20,
          jitterRatio: 0,
          onRetry: info => exhaustLog.push(info)
        }
      );
    }, err => {
      assert.ok(err instanceof RevisionRetryExhaustedError, `Expected RevisionRetryExhaustedError, got ${err?.name}: ${err?.message}`);
      assert.strictEqual(err.code, 'REVISION_RETRY_EXHAUSTED');
      assert.strictEqual(err.maxRetries, 2);
      assert.strictEqual(err.attempts, 3, 'Total attempts must be maxRetries + 1');
      assert.strictEqual(err.filePath, path.resolve(exhaustPath));
      assert.strictEqual(err.expectedRevision, 3);
      assert.strictEqual(err.actualRevision, 4);
      assert.match(err.message, /exhausted|retries/i);
      assert.match(err.message, /retry-exhaust\.json/);
      return true;
    });
    assert.strictEqual(exhaustAttempts, 3, 'Must stop cleanly after maxRetries retries (3 total attempts)');
    assert.strictEqual(exhaustLog.length, 2, 'onRetry must fire exactly maxRetries times');

    // Verify non-RevisionConflictError fails fast with 0 retries
    let nonConflictCalls = 0;
    assert.throws(() => {
      retryOnRevisionConflictSync(() => {
        nonConflictCalls++;
        throw new TypeError('unrelated fatal error');
      }, { maxRetries: 3, baseDelayMs: 5 });
    }, /unrelated fatal error/);
    assert.strictEqual(nonConflictCalls, 1, 'Non-revision errors must not be retried');

    // Verify async retryOnRevisionConflict covers both recovery & exhaustion
    let asyncCalls = 0;
    const asyncOk = await retryOnRevisionConflict(async () => {
      asyncCalls++;
      if (asyncCalls === 1) throw new RevisionConflictError(retryPath, 1, 2);
      return 'async-recovered';
    }, { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 15, jitterRatio: 0 });
    assert.strictEqual(asyncOk, 'async-recovered');
    assert.strictEqual(asyncCalls, 2);

    await assert.rejects(async () => {
      await retryOnRevisionConflict(async () => {
        throw new RevisionConflictError(exhaustPath, 4, 5);
      }, { maxRetries: 1, baseDelayMs: 5, maxDelayMs: 15, jitterRatio: 0 });
    }, err => err instanceof RevisionRetryExhaustedError && err.code === 'REVISION_RETRY_EXHAUSTED' && err.attempts === 2);

    console.log('✓ RevisionConflictError bounded retry with backoff & clear exhaustion verified.');

    // 6. Orchestrator behavior on RevisionConflictError recovery & RevisionRetryExhaustedError fail-loud teardown
    console.log('6. Testing Orchestrator behavior on RevisionRetryExhaustedError...');
    const orchMod = await import('./orchestrator.mjs');
    assert.strictEqual(
      typeof orchMod.persistTaskStateWithConflictRecovery,
      'function',
      'orchestrator.mjs must export persistTaskStateWithConflictRecovery'
    );
    assert.strictEqual(
      typeof orchMod.handleOrchestratorFatalError,
      'function',
      'orchestrator.mjs must export handleOrchestratorFatalError'
    );

    const {
      persistTaskStateWithConflictRecovery,
      handleOrchestratorFatalError
    } = orchMod;

    // 4a. Recovery after initial RevisionConflictError via bounded merge retry
    const retryDelaysSeen = [];
    const recoveredState = { revision: 2, completed_tasks: [], blocked_tasks: [], active_tasks: [], metrics: {} };
    let mergeAttempt = 0;
    persistTaskStateWithConflictRecovery({
      state: recoveredState,
      saveFn: () => {
        throw new stateStore.RevisionConflictError(taskStateFile, 2, 3);
      },
      mergeFn: () => {
        mergeAttempt++;
        if (mergeAttempt === 1) {
          throw new stateStore.RevisionConflictError(taskStateFile, 3, 4);
        }
        return { revision: 5, completed_tasks: [{ task_id: 'T-ORCH-RECOVER' }], blocked_tasks: [], active_tasks: [] };
      },
      retryOptions: {
        maxRetries: 3,
        baseDelayMs: 5,
        maxDelayMs: 15,
        jitterRatio: 0,
        onRetry: (info) => retryDelaysSeen.push(info.delayMs)
      },
      liveStatusUpdater: () => {},
      logger: () => {}
    });
    assert.strictEqual(mergeAttempt, 2, 'Should retry merge after transient RevisionConflictError');
    assert.strictEqual(recoveredState.revision, 5, 'Recovered state must reflect merged disk revision');
    assert.deepStrictEqual(retryDelaysSeen, [5], 'Retry backoff delay should be recorded');

    // 4b. Exhausted retries -> throws RevisionRetryExhaustedError, updates liveStatus to blocked/inactive, never swallows error
    const exhaustedLogs = [];
    const liveUpdates = [];
    const exhaustedState = { revision: 2, completed_tasks: [], blocked_tasks: [], active_tasks: [] };
    let thrownExhausted = null;
    try {
      persistTaskStateWithConflictRecovery({
        state: exhaustedState,
        saveFn: () => {
          throw new stateStore.RevisionConflictError(taskStateFile, 2, 4);
        },
        mergeFn: () => {
          throw new stateStore.RevisionConflictError(taskStateFile, 3, 6);
        },
        retryOptions: {
          maxRetries: 2,
          baseDelayMs: 4,
          maxDelayMs: 10,
          jitterRatio: 0
        },
        liveStatusUpdater: (patch) => liveUpdates.push(patch),
        logger: (msg) => exhaustedLogs.push(String(msg))
      });
    } catch (err) {
      thrownExhausted = err;
    }
    assert.ok(
      thrownExhausted instanceof stateStore.RevisionRetryExhaustedError && thrownExhausted.code === 'REVISION_RETRY_EXHAUSTED',
      `Expected RevisionRetryExhaustedError to be thrown fail-loud, got: ${thrownExhausted}`
    );
    assert.strictEqual(thrownExhausted.attempts, 3);
    assert.strictEqual(thrownExhausted.maxRetries, 2);
    assert.strictEqual(thrownExhausted.expectedRevision, 3);
    assert.strictEqual(thrownExhausted.actualRevision, 6);
    assert.ok(liveUpdates.length >= 1, 'liveStatusUpdater must be notified on RevisionRetryExhaustedError');
    const lastLivePatch = liveUpdates[liveUpdates.length - 1];
    assert.strictEqual(lastLivePatch.active, false);
    assert.strictEqual(lastLivePatch.current_stage, 'blocked');
    assert.strictEqual(lastLivePatch.revision_conflict_exhausted, true);
    assert.ok(String(lastLivePatch.last_error || '').includes('exhausted'), 'last_error must explain exhaustion');
    assert.ok(exhaustedLogs.some(l => l.includes('CRITICAL') && l.includes('revision')), 'Exhaustion must log diagnostic error');

    // 4c. Orchestrator fatal handler releases real .orchestrator.lock & resets real live-status.json on disk
    const isolatedChildCode = [
      "import assert from 'node:assert';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      `const orchUrl = ${JSON.stringify(pathToFileURL(path.resolve(__dirname, 'orchestrator.mjs')).href)};`,
      `const storeUrl = ${JSON.stringify(pathToFileURL(path.resolve(__dirname, 'lib', 'state-store.mjs')).href)};`,
      'const orch = await import(orchUrl);',
      'const store = await import(storeUrl);',
      'const lockPath = process.env.ORCHESTRATOR_LOCK_FILE;',
      'const livePath = path.join(process.env.AGENT_TEAM_STATE_DIR, "live-status.json");',
      'assert.strictEqual(orch.acquireLock(lockPath), true);',
      'assert.strictEqual(fs.existsSync(lockPath), true);',
      'orch.updateLiveStatus({ active: true, current_stage: "executing", current_task_id: "T-EXH-1" });',
      'const innerErr = new store.RevisionConflictError("task-state.json", 4, 7);',
      'const exhErr = new store.RevisionRetryExhaustedError(innerErr, { attempts: 5, maxRetries: 4, delaysMs: [25, 50, 100, 200] });',
      'const res = orch.handleOrchestratorFatalError(exhErr);',
      'assert.strictEqual(res.code, 1);',
      'assert.strictEqual(res.isRevisionExhausted, true);',
      'assert.strictEqual(fs.existsSync(lockPath), false, "Orchestrator fatal handler must release lock");',
      'const liveDisk = JSON.parse(fs.readFileSync(livePath, "utf8"));',
      'assert.strictEqual(liveDisk.active, false);',
      'assert.strictEqual(liveDisk.current_stage, "blocked");',
      'assert.strictEqual(liveDisk.revision_conflict_exhausted, true);',
      'process.exit(res.code);'
    ].join('\n');
    const orchExhaustedLock = path.join(tmpRoot, '.orchestrator-exhausted.lock');
    const orchChildScript = path.join(tmpRoot, 'verify_orch_exhausted.mjs');
    fs.writeFileSync(orchChildScript, isolatedChildCode, 'utf8');
    const childRes = await runProcessWait(orchChildScript, [], {
      AGENT_TEAM_STATE_DIR: stateDir,
      ORCHESTRATOR_LOCK_FILE: orchExhaustedLock
    }, 10000);
    assert.strictEqual(childRes.code, 1, `Isolated RevisionRetryExhaustedError run must exit 1, stderr: ${childRes.stderr}`);
    assert.strictEqual(fs.existsSync(orchExhaustedLock), false);
    console.log('✓ Orchestrator RevisionRetryExhaustedError recovery & fail-loud teardown verified.');

    // 7. Per-field merge contract in persistTaskStateWithConflictRecovery
    console.log('7. Testing persistTaskStateWithConflictRecovery per-field merge rules...');
    assert.strictEqual(
      typeof orchMod.mergeTaskStateOnConflict,
      'function',
      'orchestrator.mjs must export mergeTaskStateOnConflict'
    );
    const { saveStateAtomic: saveStateAtomicBase } = await import('./lib/task-persistence.mjs');
    const mergeStateFile = path.join(stateDir, 'task-state-merge-fields.json');

    // Initial disk rev 1
    writeVersionedJsonAtomic(mergeStateFile, {
      version: '2.1',
      active_tasks: [{ task_id: 'T-MERGE-DONE', status: 'executing', tokens_used: 1200, error_history: [{ stage: 'apply', error: 'disk-err-1' }] }],
      completed_tasks: [{ task_id: 'T-X', status: 'done', tokens_used: 9000, error_history: [{ stage: 'val', error: 'x-old' }] }],
      blocked_tasks: [{ task_id: 'T-DISK-BLOCKED', status: 'blocked', last_error: 'concurrent-block', tokens_used: 500, error_history: [{ stage: 'val', error: 'e0' }] }],
      metrics: { total_input_tokens: 8000, total_output_tokens: 1500, total_cost_est_usd: 0.25 }
    });

    // Simulate concurrent process moving disk to rev 2 while stale Orchestrator still holds revision 1
    const diskRev2 = mutateVersionedJsonAtomic(mergeStateFile, (d) => {
      d.active_tasks.push({ task_id: 'T-DISK-CONCURRENT', status: 'ready', tokens_used: 400 });
      const b = d.blocked_tasks.find(t => t.task_id === 'T-DISK-BLOCKED');
      b.last_error = 'disk-newer-err';
      b.error_history.push({ stage: 'val', error: 'disk-e-extra' });
      b.tokens_used = 750;
      d.metrics.total_input_tokens = 12000;
      return d;
    });
    assert.strictEqual(diskRev2.revision, 2);

    // Stale in-memory state (revision: 1 -> will hit RevisionConflictError on saveFn!)
    const staleIncomingState = {
      version: '2.1',
      revision: 1,
      active_tasks: [
        { task_id: 'T-LOCAL-ACTIVE', status: 'ready', tokens_used: 250 }
      ],
      completed_tasks: [
        {
          task_id: 'T-MERGE-DONE',
          status: 'done',
          last_error: 'should-be-cleared-when-done',
          block_reason: 'should-be-cleared-when-done',
          tokens_used: 3500,
          error_history: [
            { stage: 'apply', error: 'disk-err-1' },
            { stage: 'val', error: 'local-err-2' }
          ]
        }
      ],
      blocked_tasks: [
        // Stale lower tokens_used & stale T-X reversal attempt (must NOT revert disk's done T-X!)
        {
          task_id: 'T-DISK-BLOCKED',
          status: 'blocked',
          last_error: 'local-block-err',
          tokens_used: 300,
          error_history: [
            { stage: 'val', error: 'e0' },
            { stage: 'val', error: 'local-e1' }
          ]
        },
        {
          task_id: 'T-X',
          status: 'blocked',
          last_error: 'stale-reversal',
          tokens_used: 4000,
          error_history: [{ stage: 'val', error: 'x-stale' }]
        }
      ],
      metrics: { total_input_tokens: 10000, total_output_tokens: 2200, total_cost_est_usd: 0.42 }
    };

    const mergedSaved = persistTaskStateWithConflictRecovery({
      state: staleIncomingState,
      stateFilePath: mergeStateFile,
      saveFn: (s) => saveStateAtomicBase(mergeStateFile, s),
      retryOptions: { maxRetries: 3, baseDelayMs: 5, jitterRatio: 0 },
      liveStatusUpdater: () => {},
      logger: () => {}
    });
    assert.strictEqual(mergedSaved.revision, 3, 'Conflict merge recovery must commit revision 3 on disk');

    const finalDisk = readVersionedJson(mergeStateFile);
    const findIn = (arr, id) => (arr || []).find(t => (t.task_id || t.id) === id);

    // Verify lists placement (mutual exclusion, zero lost concurrent tasks)
    assert.ok(findIn(finalDisk.completed_tasks, 'T-MERGE-DONE'), 'T-MERGE-DONE must be in completed_tasks');
    assert.ok(findIn(finalDisk.completed_tasks, 'T-X'), 'Already-done T-X on disk must remain in completed_tasks');
    assert.ok(!findIn(finalDisk.active_tasks, 'T-MERGE-DONE') && !findIn(finalDisk.blocked_tasks, 'T-MERGE-DONE'));
    assert.ok(!findIn(finalDisk.blocked_tasks, 'T-X') && !findIn(finalDisk.active_tasks, 'T-X'));
    assert.ok(findIn(finalDisk.active_tasks, 'T-DISK-CONCURRENT'), 'Concurrent disk task must not be lost');
    assert.ok(findIn(finalDisk.active_tasks, 'T-LOCAL-ACTIVE'), 'Incoming active task must be preserved');
    assert.ok(findIn(finalDisk.blocked_tasks, 'T-DISK-BLOCKED'), 'Blocked task must remain in blocked_tasks');

    // Verify status, last_error, error_history, tokens_used on every merged task
    const mergedDone = findIn(finalDisk.completed_tasks, 'T-MERGE-DONE');
    assert.strictEqual(mergedDone.status, 'done');
    assert.strictEqual(mergedDone.last_error, undefined, 'Done task must clear last_error');
    assert.strictEqual(mergedDone.block_reason, undefined, 'Done task must clear block_reason');
    assert.strictEqual(mergedDone.tokens_used, 3500, 'tokens_used must keep monotonic max');
    assert.strictEqual(mergedDone.error_history.length, 2, 'error_history must dedupe & union disk+local');

    const mergedX = findIn(finalDisk.completed_tasks, 'T-X');
    assert.strictEqual(mergedX.status, 'done', 'status=done on disk must not revert to blocked from stale state');
    assert.strictEqual(mergedX.last_error, undefined, 'Done T-X must not retain stale last_error');
    assert.strictEqual(mergedX.tokens_used, 9000, 'Done T-X must retain max tokens_used (9000 vs 4000)');
    assert.strictEqual(mergedX.error_history.length, 2, 'T-X error_history must merge both x-old and x-stale');

    const mergedBlocked = findIn(finalDisk.blocked_tasks, 'T-DISK-BLOCKED');
    assert.strictEqual(mergedBlocked.status, 'blocked');
    assert.strictEqual(mergedBlocked.last_error, 'local-block-err', 'Blocked task must preserve non-empty last_error');
    assert.strictEqual(mergedBlocked.tokens_used, 750, 'Blocked task must take max tokens_used (disk 750 > local 300)');
    assert.deepStrictEqual(
      mergedBlocked.error_history.map(e => e.error),
      ['e0', 'disk-e-extra', 'local-e1'],
      'error_history must preserve disk additions + local additions without duplicates'
    );

    // Metrics must take monotonic max per field (never roll back disk's 12000 -> 10000)
    assert.strictEqual(finalDisk.metrics.total_input_tokens, 12000);
    assert.strictEqual(finalDisk.metrics.total_output_tokens, 2200);
    assert.strictEqual(finalDisk.metrics.total_cost_est_usd, 0.42);
    console.log('✓ persistTaskStateWithConflictRecovery per-field merge rules verified.');

    // =========================================================================
    // Spec v4.1 (§5.1 - §5.5): Idempotent run metrics, PA A2, Round-Trip & Read-Only Archive
    // =========================================================================
    console.log('\n8. Testing Spec v4.1 idempotent run metrics, PA A2 & read-only archive invariants...');
    const { transitionTaskState } = await import('./lib/task-persistence.mjs');
    const {
      computeCanonicalQueueState,
      syncCanonicalTaskState,
      writeMorningReportFile
    } = await import('./lib/queue-state.mjs');

    function hashDirectoryTree(dirPath) {
      const hash = crypto.createHash('sha256');
      const walk = (curDir, relPrefix = '') => {
        const entries = fs.readdirSync(curDir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const ent of entries) {
          const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
          const abs = path.join(curDir, ent.name);
          if (ent.isDirectory()) {
            hash.update(`D:${rel}\n`);
            walk(abs, rel);
          } else {
            hash.update(`F:${rel}\n`);
            hash.update(fs.readFileSync(abs));
            hash.update('\n');
          }
        }
      };
      walk(dirPath);
      return hash.digest('hex');
    }

    function extractTopLevelFunctionBody(src, fnName) {
      const sigRe = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
      const match = sigRe.exec(src);
      if (!match) return null;
      const parenStart = match.index + match[0].length - 1;
      let pDepth = 0;
      let parenEnd = -1;
      let pStr = null;
      for (let i = parenStart; i < src.length; i++) {
        const ch = src[i];
        if (pStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === pStr) pStr = null;
          continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') { pStr = ch; continue; }
        if (ch === '(') pDepth++;
        else if (ch === ')') {
          pDepth--;
          if (pDepth === 0) { parenEnd = i; break; }
        }
      }
      if (parenEnd === -1) return null;
      const braceStart = src.indexOf('{', parenEnd + 1);
      if (braceStart === -1) return null;
      let depth = 0;
      let inStr = null;
      let inLineComment = false;
      let inBlockComment = false;
      for (let i = braceStart; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];
        if (inLineComment) {
          if (ch === '\n') inLineComment = false;
          continue;
        }
        if (inBlockComment) {
          if (ch === '*' && next === '/') {
            inBlockComment = false;
            i++;
          }
          continue;
        }
        if (inStr) {
          if (ch === '\\') {
            i++;
            continue;
          }
          if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '/' && next === '/') {
          inLineComment = true;
          i++;
          continue;
        }
        if (ch === '/' && next === '*') {
          inBlockComment = true;
          i++;
          continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
          inStr = ch;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            return src.slice(braceStart, i + 1);
          }
        }
      }
      return null;
    }

    const specTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-spec-v41-'));
    const tmpTasksRoot = path.join(specTmpRoot, 'tasks');
    const tmpActiveDir = path.join(tmpTasksRoot, 'active');
    const tmpArchiveDir = path.join(tmpTasksRoot, 'archive');
    fs.mkdirSync(tmpActiveDir, { recursive: true });
    fs.mkdirSync(tmpArchiveDir, { recursive: true });

    try {
      // §5.1 Ca 1 — Idempotent cùng run_id
      const taskA = {
        task_id: 'T-METRIC-A',
        title: 'Metric idempotency test',
        mode: 'quick',
        status: 'ready',
        run_id: 'run-1',
        steps: [{ step: '2.1', role: 'writer', cost_est_usd: 0.25, run_id: 'run-1' }]
      };
      const state = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };

      transitionTaskState(taskA, state, 'done', {
        retries: 2,
        activeTaskPath: path.join(tmpActiveDir, 'T-METRIC-A.yaml'),
        archiveTaskPath: path.join(tmpArchiveDir, 'T-METRIC-A.yaml')
      });
      const costAfterFirst = state.metrics.total_cost_est_usd;

      const canonical1 = computeCanonicalQueueState({
        tasksActiveDir: tmpActiveDir,
        tasksArchiveDir: tmpArchiveDir,
        taskState: state
      });
      syncCanonicalTaskState(state, canonical1);

      // Gọi lại lần 2 với cùng run_id = 'run-1'
      transitionTaskState(taskA, state, 'done', {
        retries: 2,
        activeTaskPath: path.join(tmpActiveDir, 'T-METRIC-A.yaml'),
        archiveTaskPath: path.join(tmpArchiveDir, 'T-METRIC-A.yaml')
      });

      assert.strictEqual(state.metrics.total_runs, 1, 'Ca 1: cùng run_id chỉ được đếm 1 run');
      assert.strictEqual(state.metrics.total_retries, 2, 'Ca 1: retries phải bằng 2, không nhân đôi');
      assert.strictEqual(state.metrics.total_cost_est_usd, 0.25, 'Ca 1: cost phải bằng 0.25');
      assert.strictEqual(state.metrics.total_cost_est_usd, costAfterFirst, 'Ca 1: cost không tăng ở lần gọi trùng');
      assert.strictEqual(taskA.last_counted_run_id, 'run-1');

      // §5.2 Ca 2 — Rerun task với run_id mới (Đúng chuẩn đường sản xuất orchestrator.mjs#L1002-L1020, kèm kiểm chứng PA A2)
      taskA.status = 'ready';
      taskA.steps_history = [...(taskA.steps_history || []), ...(taskA.steps || [])];
      taskA.steps = [
        { step: '2.1', role: 'writer', cost_est_usd: 0.25, run_id: 'run-1' },
        { step: '2.1', role: 'writer', cost_est_usd: 0.30, run_id: 'run-2' }
      ];
      taskA.run_id = 'run-2';

      transitionTaskState(taskA, state, 'done', {
        retries: 1,
        activeTaskPath: path.join(tmpActiveDir, 'T-METRIC-A.yaml'),
        archiveTaskPath: path.join(tmpArchiveDir, 'T-METRIC-A.yaml')
      });

      assert.strictEqual(state.metrics.total_runs, 2, 'Ca 2: run_id mới phải tăng total_runs lên 2');
      assert.strictEqual(state.metrics.total_retries, 3, 'Ca 2: 2 (Ca 1) + 1 (Ca 2) = 3');
      assert.strictEqual(state.metrics.total_cost_est_usd, 0.55, 'Ca 2: 0.25 (run-1) + 0.30 (run-2) = 0.55 (PA A2 không cộng trùng step run-1)');

      // §5.3 Ca 3 — Round-trip qua syncCanonicalTaskState & Không ghi đè chéo khi thêm Task B
      state.metrics.total_input_tokens = 1000;
      state.metrics.total_output_tokens = 500;

      const canonical2 = computeCanonicalQueueState({
        tasksActiveDir: tmpActiveDir,
        tasksArchiveDir: tmpArchiveDir,
        taskState: state
      });
      syncCanonicalTaskState(state, canonical2);

      assert.strictEqual(state.metrics.total_runs, 2);
      assert.strictEqual(state.metrics.tasks_completed, 1, 'Ca 3: phải bằng 1 tuyệt đối');
      assert.strictEqual(canonical2.counts.completed, 1);
      assert.ok(Number.isFinite(state.metrics.cost_per_completed_task), 'Ca 3: cost_per_completed_task phải là số hữu hạn');
      assert.strictEqual(state.metrics.cost_per_completed_task, 0.55, 'Ca 3: 0.55 / 1 task = 0.55');
      assert.strictEqual(state.metrics.tokens_per_completed_task, 1500, 'Ca 3: (1000 + 500) / 1 = 1500');

      const taskAfterSync = state.completed_tasks.find(t => t.task_id === 'T-METRIC-A');
      assert.ok(taskAfterSync, 'Ca 3: taskA phải tồn tại trong state.completed_tasks sau sync');
      assert.strictEqual(taskAfterSync.last_counted_run_id, 'run-2', 'Ca 3: last_counted_run_id phải sống sót qua syncCanonicalTaskState');

      transitionTaskState(taskAfterSync, state, 'done', {
        retries: 1,
        archiveTaskPath: path.join(tmpArchiveDir, 'T-METRIC-A.yaml')
      });
      assert.strictEqual(state.metrics.total_runs, 2, 'Ca 3: idempotent sau round-trip');

      const taskB = {
        task_id: 'T-METRIC-B',
        title: 'Second task',
        mode: 'quick',
        status: 'ready',
        run_id: 'run-B',
        steps: [{ step: '2.1', role: 'writer', cost_est_usd: 0.45, run_id: 'run-B' }]
      };
      transitionTaskState(taskB, state, 'done', {
        retries: 0,
        archiveTaskPath: path.join(tmpArchiveDir, 'T-METRIC-B.yaml')
      });
      const canonical3 = computeCanonicalQueueState({
        tasksActiveDir: tmpActiveDir,
        tasksArchiveDir: tmpArchiveDir,
        taskState: state
      });
      syncCanonicalTaskState(state, canonical3);

      const taskAAfterB = state.completed_tasks.find(t => t.task_id === 'T-METRIC-A');
      const taskBAfterB = state.completed_tasks.find(t => t.task_id === 'T-METRIC-B');
      assert.strictEqual(taskAAfterB?.last_counted_run_id, 'run-2', 'Ca 3: task A không bị task B ghi đè');
      assert.strictEqual(taskBAfterB?.last_counted_run_id, 'run-B', 'Ca 3: task B giữ đúng run-B');
      assert.strictEqual(state.metrics.total_runs, 3);
      assert.strictEqual(state.metrics.tasks_completed, 2);
      assert.strictEqual(state.metrics.total_cost_est_usd, 1.0, 'Ca 3: 0.55 + 0.45 = 1.0');
      assert.strictEqual(state.metrics.cost_per_completed_task, 0.5, 'Ca 3: 1.0 / 2 tasks = 0.5');

      // §5.4 & §5.5 Ca 4 — computeCanonicalQueueState 100% Read-Only (Động + Tĩnh)
      const blockedArchivePath = path.join(tmpArchiveDir, 'T-ARCHIVED-BLOCKED.yaml');
      fs.writeFileSync(blockedArchivePath, [
        'task_id: T-ARCHIVED-BLOCKED',
        'title: Manually archived blocked task',
        'mode: standard',
        'status: blocked',
        'block_reason: Manual move to archive',
        'retries: 2'
      ].join('\n') + '\n', 'utf8');

      const hashBefore = hashDirectoryTree(tmpTasksRoot);
      const canonicalRO = computeCanonicalQueueState({
        tasksActiveDir: tmpActiveDir,
        tasksArchiveDir: tmpArchiveDir,
        taskState: state
      });
      const tmpReportPath = path.join(specTmpRoot, 'morning-report.md');
      writeMorningReportFile(state, {
        tasksActiveDir: tmpActiveDir,
        tasksArchiveDir: tmpArchiveDir,
        reportFile: tmpReportPath
      });
      const hashAfter = hashDirectoryTree(tmpTasksRoot);

      assert.strictEqual(hashAfter, hashBefore, 'Ca 4 động: toàn bộ cây tasks/ phải bất biến byte-for-byte');
      const archivedEntry = canonicalRO.completed.find(t => t.task_id === 'T-ARCHIVED-BLOCKED');
      assert.ok(archivedEntry, 'Ca 4 động: T-ARCHIVED-BLOCKED phải nằm trong canonical.completed');
      assert.strictEqual(archivedEntry.status, 'done');
      assert.strictEqual(archivedEntry.archived_from_status, 'blocked');
      const reportContent = fs.readFileSync(tmpReportPath, 'utf8');
      assert.match(reportContent, /archived_from: `blocked`/);

      const writeTripwireRe = /\b(write|append|rename|unlink|copyFile|rm|rmdir|mkdir|truncate|symlink|open)\w*\s*\(/;
      // Mutation self-check: confirm tripwire regex catches fs.writeFileSync(
      assert.match('function fake() { fs.writeFileSync("x", "y"); }', writeTripwireRe, 'Ca 4 tĩnh (mutation check): tripwire regex must catch fs.writeFileSync(');
      const queueStateSrc = fs.readFileSync(path.resolve(__dirname, 'lib/queue-state.mjs'), 'utf8');
      for (const fnName of ['scanCanonicalTaskDir', 'computeCanonicalQueueState']) {
        const fnBody = extractTopLevelFunctionBody(queueStateSrc, fnName);
        assert.ok(fnBody && fnBody.length > 100, `Ca 4 tĩnh: phải trích được thân hàm ${fnName} (>100 chars)`);
        assert.doesNotMatch(
          fnBody,
          writeTripwireRe,
          `Ca 4 tĩnh (tripwire): ${fnName} must remain strictly read-only`
        );
      }
      console.log('✓ Spec v4.1 Ca 1..4 (idempotent metrics, PA A2, round-trip, read-only archive) verified.');
    } finally {
      fs.rmSync(specTmpRoot, { recursive: true, force: true });
    }

    console.log('\n=================================================');
    console.log('ALL STATE CONCURRENCY & REVISION TESTS PASSED!');
    console.log('=================================================');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('State concurrency test failed:', err);
  process.exit(1);
});
