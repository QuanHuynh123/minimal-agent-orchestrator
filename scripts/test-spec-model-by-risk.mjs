#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  resolveSquadRoster,
  resolveWriterHubWorkflow
} from './lib/risk-policy.mjs';
import { loadMergedTeamConfig } from './lib/policy-loader.mjs';

function runTests() {
  console.log('Testing Item 4: Risk-Based Spec Model Selection from Config (no Reviewer default, 0 hardcoded model IDs)...\n');

  // 1. Synthetic config with NO hardcoded real model names
  const syntheticTeam = {
    spec_models: {
      low: 'tier/cheap-spec',
      medium: 'tier/cheap-spec',
      high: 'tier/strong-spec',
      critical: 'tier/strong-spec'
    },
    roles: {
      router: { enabled: true, model: 'tier/cheap-spec' },
      writer: { enabled: true, model: 'tier/writer-primary' },
      designer: { enabled: true, model: 'tier/designer-mid' },
      reviewer: { enabled: true, model: 'tier/reviewer-top' }
    }
  };

  // Medium risk backend -> picks cheap spec model, role !== 'reviewer'
  const medTask = {
    task_id: 'T-MED-SPEC',
    title: 'Add validation helper',
    goal: 'Add helper in core/worker.py',
    mode: 'standard',
    risk_level: 'medium',
    scope: ['core/worker.py']
  };
  const medRoster = resolveSquadRoster(syntheticTeam, medTask);
  assert.equal(medRoster.techSpecModel, 'tier/cheap-spec', 'Medium risk must select cheap spec model from config');
  assert.notEqual(medRoster.techSpecRole, 'reviewer', 'Spec role must NOT default to reviewer');
  const medWf = resolveWriterHubWorkflow(medTask, syntheticTeam);
  assert.equal(medWf[0]?.action, 'draft_spec');
  assert.equal(medWf[0]?.model, 'tier/cheap-spec');
  assert.notEqual(medWf[0]?.role, 'reviewer');

  // High risk backend -> picks strongest spec model
  const highTask = { ...medTask, task_id: 'T-HIGH-SPEC', risk_level: 'high' };
  const highRoster = resolveSquadRoster(syntheticTeam, highTask);
  assert.equal(highRoster.techSpecModel, 'tier/strong-spec', 'High risk must select strongest spec model from config');
  const highWf = resolveWriterHubWorkflow(highTask, syntheticTeam);
  assert.equal(highWf[0]?.action, 'draft_spec');
  assert.equal(highWf[0]?.model, 'tier/strong-spec');

  // Critical risk also selects high/critical strongest tier
  const critRoster = resolveSquadRoster(syntheticTeam, { ...medTask, risk_level: 'critical' });
  assert.equal(critRoster.techSpecModel, 'tier/strong-spec');

  // 2. Without spec_models / architect / techlead: MUST NOT fall back to Reviewer for low/medium!
  const teamWithoutSpecMap = {
    roles: {
      router: { enabled: true, model: 'tier/cheap-router' },
      writer: { enabled: true, model: 'tier/writer-primary' },
      reviewer: { enabled: true, model: 'tier/reviewer-top' }
    }
  };
  const fallbackMed = resolveSquadRoster(teamWithoutSpecMap, medTask);
  assert.notEqual(fallbackMed.techSpecRole, 'reviewer', 'Medium risk without spec_models must NOT default to reviewer role');
  assert.equal(fallbackMed.techSpecModel, 'tier/cheap-router', 'Should use cheap router tier instead of reviewer on medium');

  // Even without router: low/medium must NOT steal reviewer
  const writerAndReviewerOnly = {
    roles: {
      writer: { enabled: true, model: 'tier/writer-primary' },
      reviewer: { enabled: true, model: 'tier/reviewer-top' }
    }
  };
  const noStealMed = resolveSquadRoster(writerAndReviewerOnly, medTask);
  assert.equal(noStealMed.techSpecModel, null, 'Medium risk must NOT use reviewer when no cheap spec/architect/router exists');

  // High risk may use reviewer if no explicit spec_models/architect/techlead
  const highAllowedReviewer = resolveSquadRoster(writerAndReviewerOnly, highTask);
  assert.equal(highAllowedReviewer.techSpecModel, 'tier/reviewer-top');
  assert.equal(highAllowedReviewer.techSpecRole, 'reviewer');

  // 3. Live team.yaml validation (read dynamically from config, zero hardcoded model IDs)
  const liveTeam = loadMergedTeamConfig();
  assert.ok(liveTeam.spec_models && typeof liveTeam.spec_models === 'object', 'team.yaml must configure spec_models by risk level');
  assert.ok(liveTeam.spec_models.medium && liveTeam.spec_models.high, 'team.yaml spec_models must define medium and high tiers');
  assert.notEqual(
    liveTeam.spec_models.medium,
    liveTeam.spec_models.high,
    'team.yaml must use a cheaper model for medium spec than high spec'
  );
  assert.notEqual(
    liveTeam.spec_models.medium,
    liveTeam.roles?.reviewer?.model,
    'Medium spec model in team.yaml must not match Reviewer model'
  );

  const liveMedWf = resolveWriterHubWorkflow(medTask, liveTeam);
  assert.equal(liveMedWf[0]?.model, liveTeam.spec_models.medium);
  assert.notEqual(liveMedWf[0]?.role, 'reviewer');

  const liveHighWf = resolveWriterHubWorkflow(highTask, liveTeam);
  assert.equal(liveHighWf[0]?.model, liveTeam.spec_models.high);

  console.log('✓ All Item 4 risk-based spec model selection tests passed.');
}

runTests();
