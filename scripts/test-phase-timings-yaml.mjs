#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import * as taskPersistence from './lib/task-persistence.mjs';
import { computeCanonicalQueueState } from './lib/queue-state.mjs';
import { loadMergedPolicy } from './lib/policy-loader.mjs';

assert.equal(
  typeof taskPersistence.createPhaseTimingsTracker,
  'function',
  'task-persistence.mjs must export createPhaseTimingsTracker()'
);
assert.equal(
  typeof taskPersistence.finalizePhaseTimings,
  'function',
  'task-persistence.mjs must export finalizePhaseTimings()'
);

const { createPhaseTimingsTracker, finalizePhaseTimings, transitionTaskState } = taskPersistence;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-phase-timings-'));
try {
  const activeDir = path.join(tmpDir, 'tasks', 'active');
  const archiveDir = path.join(tmpDir, 'tasks', 'archive');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const activePath = path.join(activeDir, 'T-TIMING-1.yaml');
  const archivePath = path.join(archiveDir, 'T-TIMING-1.yaml');

  const task = {
    task_id: 'T-TIMING-1',
    title: 'Phase timing YAML test',
    mode: 'quick',
    kind: 'remove',
    scope: ['ui_web/index.html'],
    steps: []
  };
  fs.writeFileSync(activePath, YAML.stringify(task), 'utf8');

  const tracker = createPhaseTimingsTracker({ preflight_ms: 13200 });
  tracker.setBaselineMs(37500);
  tracker.addWriterBucketMs({ bucket: 1, attempt: 1, role: 'coder_fe', duration_ms: 109430 });
  tracker.addWriterBucketMs({ bucket: 2, attempt: 1, role: 'writer', duration_ms: 52487 });
  tracker.addValidateMs(32100);
  tracker.addCommitMs(1300);

  finalizePhaseTimings(task, tracker);

  const state = { active_tasks: [task], completed_tasks: [], blocked_tasks: [] };
  transitionTaskState(task, state, 'done', {
    actualModifiedFiles: ['ui_web/index.html'],
    validationPassed: true,
    retries: 0,
    maxRetries: 3,
    activeTaskPath: activePath,
    archiveTaskPath: archivePath
  });

  assert.equal(fs.existsSync(archivePath), true, 'Task YAML must be written to archive path');
  const parsedYaml = YAML.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.ok(parsedYaml && typeof parsedYaml.phase_timings === 'object', 'YAML must contain phase_timings object');
  assert.equal(parsedYaml.phase_timings.preflight_ms, 13200);
  assert.equal(parsedYaml.phase_timings.baseline_ms, 37500);
  assert.equal(parsedYaml.phase_timings.validate_ms, 32100);
  assert.equal(parsedYaml.phase_timings.commit_ms, 1300);
  assert.ok(Array.isArray(parsedYaml.phase_timings.writer_ms), 'writer_ms must be an array by bucket');
  assert.equal(parsedYaml.phase_timings.writer_ms.length, 2);
  assert.equal(parsedYaml.phase_timings.writer_ms[0].bucket, 1);
  assert.equal(parsedYaml.phase_timings.writer_ms[0].duration_ms, 109430);
  assert.equal(parsedYaml.phase_timings.writer_ms[1].bucket, 2);
  assert.equal(parsedYaml.phase_timings.writer_ms[1].duration_ms, 52487);

  // Verify queue-state preserves phase_timings from archived YAML
  const canonical = computeCanonicalQueueState({
    tasksActiveDir: activeDir,
    tasksArchiveDir: archiveDir,
    taskState: state
  });
  assert.equal(canonical.completed.length, 1);
  assert.deepEqual(canonical.completed[0].phase_timings, parsedYaml.phase_timings);

  // Verify orchestrator wires all phase timing hooks and policy quick.max_runtime_sec stays 180
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const orchSrc = fs.readFileSync(path.join(scriptsDir, 'orchestrator.mjs'), 'utf8');
  assert.match(orchSrc, /createPhaseTimingsTracker/);
  assert.match(orchSrc, /addWriterBucketMs/);
  assert.match(orchSrc, /addValidateMs/);
  assert.match(orchSrc, /addCommitMs/);
  assert.match(orchSrc, /finalizePhaseTimings/);

  const mergedPolicy = loadMergedPolicy({ configDir: path.resolve(scriptsDir, '..', 'config') });
  assert.equal(mergedPolicy.policy?.task_modes?.quick?.max_runtime_sec, 900, 'policy.yaml quick.max_runtime_sec must be 900');
  assert.equal(mergedPolicy.policy?.task_modes?.standard?.max_runtime_sec, 1800, 'policy.yaml standard.max_runtime_sec must be 1800');

  console.log('test-phase-timings-yaml.mjs: ALL PASSED');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
