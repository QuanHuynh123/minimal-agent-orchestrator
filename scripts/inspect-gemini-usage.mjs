import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedPolicy, loadMergedTeamConfig, resolveConfigDir } from './lib/policy-loader.mjs';
import { check9RouterHealth, readInstalled9RouterVersion } from './lib/client-9router.mjs';
import { measureControlledCacheSequence } from './lib/cache-benchmark.mjs';
import {
  analyzeGeminiPromptTokenVariance,
  inspectLocal9RouterRequestLogs
} from './lib/gemini-usage-diff.mjs';

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const live = process.argv.includes('--live');
  const logInspection = inspectLocal9RouterRequestLogs();
  const batch165Analysis = analyzeGeminiPromptTokenVariance([
    {
      prompt_tokens: 3794,
      completion_tokens: 2,
      total_tokens: 3796,
      completion_tokens_details: { reasoning_tokens: 24 }
    },
    {
      prompt_tokens: 3786,
      completion_tokens: 2,
      total_tokens: 3788,
      completion_tokens_details: { reasoning_tokens: 16 }
    }
  ]);

  let liveProbe = null;
  if (live) {
    const configDir = resolveConfigDir();
    const policyConfig = loadMergedPolicy({ configDir });
    const teamConfig = loadMergedTeamConfig({ configDir });
    const health = await check9RouterHealth(teamConfig, policyConfig);
    if (!health.ok) {
      console.error(`[GeminiUsageDiff] 9Router healthcheck failed: ${health.error}`);
      process.exit(1);
    }

    const baseNonce = `gemini-diff-${Date.now()}`;
    const nonStreamPass = await measureControlledCacheSequence('ag/gemini-3.8-flash-medium', {
      stream: false,
      sequence: ['A', 'A'],
      nonce: `${baseNonce}-nonstream`,
      teamConfig,
      policyConfig
    });
    const streamPass = await measureControlledCacheSequence('ag/gemini-3.8-flash-medium', {
      stream: true,
      sequence: ['A', 'A'],
      nonce: `${baseNonce}-stream`,
      teamConfig,
      policyConfig
    });

    liveProbe = {
      non_stream: {
        turns: nonStreamPass.turns,
        variance_analysis: analyzeGeminiPromptTokenVariance(nonStreamPass.turns)
      },
      stream: {
        turns: streamPass.turns,
        variance_analysis: analyzeGeminiPromptTokenVariance(streamPass.turns)
      }
    };
  }

  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    nine_router_version: readInstalled9RouterVersion().version,
    local_request_logs: logInspection,
    batch_165_analysis: batch165Analysis,
    live_probe: liveProbe
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(`[GeminiUsageDiff] Fatal: ${err.message}`);
    process.exit(1);
  });
}
