import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedPolicy, loadMergedTeamConfig, resolveConfigDir } from './lib/policy-loader.mjs';
import { check9RouterHealth } from './lib/client-9router.mjs';
import {
  DEFAULT_CACHE_BENCHMARK_MODELS,
  measureMinimalTokenRequest,
  runCacheBenchmark,
  runControlledCacheExperiment,
  runRepeatedRouterCacheExperiment
} from './lib/cache-benchmark.mjs';

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const shortProbe = process.argv.includes('--short-probe');
  const modelIdx = process.argv.indexOf('--model');
  const requestedModel = (modelIdx !== -1 && process.argv[modelIdx + 1])
    ? process.argv[modelIdx + 1]
    : 'ag/claude-sonnet-5-5';
  const controlled = process.argv.includes('--controlled');
  const routerRepeated = process.argv.includes('--router-repeated');
  const repsIdx = process.argv.indexOf('--reps');
  const repetitions = repsIdx !== -1 && Number(process.argv[repsIdx + 1]) > 0
    ? Number(process.argv[repsIdx + 1])
    : 3;

  const configDir = resolveConfigDir();
  const policyConfig = loadMergedPolicy({ configDir });
  const teamConfig = loadMergedTeamConfig({ configDir });

  const health = await check9RouterHealth(teamConfig, policyConfig);
  if (!health.ok) {
    console.error(`[CacheBenchmark] 9Router healthcheck failed: ${health.error}`);
    process.exit(1);
  }

  const nonce = `live-${Date.now()}`;
  const report = shortProbe
    ? await measureMinimalTokenRequest(requestedModel, {
        teamConfig,
        policyConfig
      })
    : routerRepeated
    ? await runRepeatedRouterCacheExperiment({
        models: DEFAULT_CACHE_BENCHMARK_MODELS,
        repetitions,
        teamConfig,
        policyConfig,
        nonce
      })
    : controlled
    ? await runControlledCacheExperiment({
        models: DEFAULT_CACHE_BENCHMARK_MODELS,
        teamConfig,
        policyConfig,
        nonce
      })
    : await runCacheBenchmark({
        models: DEFAULT_CACHE_BENCHMARK_MODELS,
        teamConfig,
        policyConfig,
        nonce
      });

  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(`[CacheBenchmark] Fatal: ${err.message}`);
    process.exit(1);
  });
}
