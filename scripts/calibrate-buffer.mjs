#!/usr/bin/env node
/**
 * Batch 169 Item 2 CLI: Per-session +2000 buffer calibration probe
 * Compares one tiny ~few-dozen-token request on ag/* (Gemini Flash) vs a non-ag/* provider via 9Router.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_9ROUTER_URL,
  readInstalled9RouterVersion,
  runSessionBufferCalibrationMatrix
} from '../runtime/provider-gateway.mjs';
import { loadMergedTeamConfig } from './lib/policy-loader.mjs';
import { resolveApiKey } from './lib/risk-policy.mjs';

const __filename = fileURLToPath(import.meta.url);

async function discoverNonAgModel(baseUrl, apiKey, configuredNonAg) {
  const candidates = [];
  if (configuredNonAg) candidates.push(configuredNonAg);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const json = await res.json();
      const ids = Array.isArray(json?.data) ? json.data.map(m => m.id).filter(Boolean) : [];
      const nonAg = ids.filter(id => !id.toLowerCase().startsWith('ag/'));
      const preferred = nonAg.filter(id => /deepseek|hive|glm|qwen|iflow/i.test(id));
      for (const id of [...preferred, ...nonAg]) {
        if (!candidates.includes(id)) candidates.push(id);
      }
      return { ids, candidates };
    }
  } catch {}
  return { ids: [], candidates };
}

function parseArgs(argv) {
  const args = { live: argv.includes('--live'), models: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) args.models.push(argv[++i]);
    else if (argv[i] === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.live) {
    console.error('Usage: node agent-team/scripts/calibrate-buffer.mjs --live [--model <id>] [--out file.json]');
    process.exit(2);
  }
  const teamCfg = loadMergedTeamConfig();
  const baseUrl = teamCfg.providers?.local_9router?.base_url || DEFAULT_9ROUTER_URL;
  const apiKey = resolveApiKey(teamCfg);
  const configuredWriter = teamCfg.roles?.writer?.model || teamCfg.roles?.writer?.default_model || null;
  const configuredNonAg = configuredWriter && !configuredWriter.toLowerCase().startsWith('ag/')
    ? configuredWriter
    : null;

  const { candidates } = await discoverNonAgModel(baseUrl, apiKey, configuredNonAg);
  const nonAgTarget = candidates[0] || 'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017';
  const modelsToRun = cli.models.length > 0
    ? cli.models
    : ['ag/gemini-3.8-flash-medium', nonAgTarget];

  // Budget print BEFORE running
  const estFreshPerProbe = 30;
  const estClaudeFreshTotal = modelsToRun.filter(m => m.toLowerCase().includes('claude')).length * estFreshPerProbe;
  console.log(`[Budget Plan] Calibration probes: ${modelsToRun.length} runs x ~${estFreshPerProbe} est. fresh tokens = ~${modelsToRun.length * estFreshPerProbe} total (Claude est=${estClaudeFreshTotal} / 60000 ceiling).`);

  const report = await runSessionBufferCalibrationMatrix({
    models: modelsToRun,
    baseUrl,
    apiKey,
    nineRouterVersion: readInstalled9RouterVersion().version
  });
  report.discovered_non_ag_candidates = candidates.slice(0, 15);

  if (cli.out) {
    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}
