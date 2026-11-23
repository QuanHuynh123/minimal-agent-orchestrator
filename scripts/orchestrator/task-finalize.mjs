#!/usr/bin/env node
/**
 * Task Finalize Stage (Phase 2 — Step 2.1 of docs/ORCHESTRATOR_SPLIT_SPEC.md)
 * Encapsulates the 0-token atomic post-hook inside the per-task `finally` block:
 *   1. Token reconciliation & phase timing finalization
 *   2. Canonical task state transition (active/archive YAML + task-state.json queue)
 *   3. Conflict-recovered state persistence & morning report generation
 *   4. Live-status update, 1-line `[REPORT]` log, and session archiving
 *
 * INVARIANT: Never import from `../orchestrator.mjs` (to avoid module-load side effects
 * and circular dependencies). All orchestrator-scoped callbacks/paths are passed explicitly.
 */

import path from 'node:path';
import { archivePriorTaskSessions } from '../../runtime/index.mjs';
import { computeCanonicalQueueState, syncCanonicalTaskState } from '../lib/queue-state.mjs';
import {
  finalizePhaseTimings,
  mutateTaskStateAtomic as mutateTaskStateAtomicBase,
  reconcileTaskTokens,
  transitionTaskState
} from '../lib/task-persistence.mjs';

export function finalizeTaskExecution({
  task,
  tFile,
  taskPath,
  state,
  taskTokensUsed,
  stateTokensBeforeTask,
  isTaskDone,
  finalSuccessStatus,
  actualModifiedFiles,
  validationPassed,
  retries,
  blockReason,
  maxRetries,
  phaseTracker,
  taskRunId,
  paths: {
    activeTasksDir,
    archiveTasksDir,
    stateDir,
    stateFile
  },
  callbacks: {
    updateLiveStatusFn,
    persistTaskStateWithConflictRecoveryFn,
    saveStateAtomicFn,
    mergeTaskStateOnConflictFn,
    writeMorningReportFn
  }
}) {
  task.tokens_used = taskTokensUsed;
  const stateTokensAfterTask = (state.metrics?.total_input_tokens || 0) + (state.metrics?.total_output_tokens || 0);
  const stateDeltaTokens = stateTokensAfterTask - stateTokensBeforeTask;
  if (Array.isArray(task.steps) && task.steps.length > 0) {
    task.token_reconciliation = reconcileTaskTokens(task, stateDeltaTokens);
  }

  const finalStatus = isTaskDone ? finalSuccessStatus : (task.status === 'blocked' ? 'blocked' : 'failed');
  const archivePath = path.resolve(archiveTasksDir, tFile);
  finalizePhaseTimings(task, phaseTracker);
  transitionTaskState(task, state, finalStatus, {
    actualModifiedFiles,
    validationPassed,
    retries,
    blockReason,
    maxRetries,
    activeTaskPath: taskPath,
    archiveTaskPath: archivePath
  });

  const postQueue = computeCanonicalQueueState({
    tasksActiveDir: activeTasksDir,
    tasksArchiveDir: archiveTasksDir,
    taskState: state
  });
  persistTaskStateWithConflictRecoveryFn({
    state,
    saveFn: (s) => {
      syncCanonicalTaskState(s, postQueue);
      return saveStateAtomicFn(s);
    },
    mergeFn: (s) => mutateTaskStateAtomicBase(stateFile, (latestDiskState) => {
      const merged = mergeTaskStateOnConflictFn(latestDiskState, s);
      const resyncQueue = computeCanonicalQueueState({
        tasksActiveDir: activeTasksDir,
        tasksArchiveDir: archiveTasksDir,
        taskState: merged
      });
      syncCanonicalTaskState(merged, resyncQueue);
      return merged;
    })
  });
  writeMorningReportFn(state);

  updateLiveStatusFn({
    current_stage: isTaskDone ? finalSuccessStatus : (task.status === 'blocked' ? 'blocked' : 'failed'),
    task_completed_at: isTaskDone ? task.completed_at : new Date().toISOString(),
    task_final_status: finalStatus,
    recovered_on_retry: isTaskDone && retries > 0,
    last_error: isTaskDone ? null : (blockReason || task.last_error || null),
    queue_stats: postQueue.counts
  });

  // Print 1-line post-hook report to console
  const filesSummary = (task.last_report.modified_files || []).join(', ') || 'none';
  const outsideWin = task.last_report?.edit_lines_outside_window ?? 0;
  console.log(`[REPORT] ${task.task_id} | Mode: ${task.mode || 'quick'} | Status: ${finalStatus} | Files: ${filesSummary} | Validation: ${validationPassed} | Retries: ${retries} | OutsideWindow: ${outsideWin}`);

  archivePriorTaskSessions({
    taskId: task.task_id,
    currentRunId: null,
    onlyRunId: taskRunId,
    sessionsDir: path.resolve(stateDir, 'sessions'),
    runsDir: path.resolve(stateDir, 'runs')
  });

  return { finalStatus, postQueue };
}
