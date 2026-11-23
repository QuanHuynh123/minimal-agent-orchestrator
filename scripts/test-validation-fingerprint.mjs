#!/usr/bin/env node
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('Testing Validation Environment Fingerprint...\n');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-val-fp-'));

  try {
    const validator = await import('./validator.mjs');
    const {
      collectEnvironmentFingerprint,
      compareEnvironmentFingerprints,
      buildValidationResult,
      validateFast,
      validateSuite
    } = validator;

    assert.strictEqual(typeof collectEnvironmentFingerprint, 'function', 'validator.mjs must export collectEnvironmentFingerprint');
    assert.strictEqual(typeof compareEnvironmentFingerprints, 'function', 'validator.mjs must export compareEnvironmentFingerprints');
    assert.strictEqual(typeof buildValidationResult, 'function', 'validator.mjs must export buildValidationResult');

    // 1. Collect fingerprint on temp repo with configured .venv python path
    const venvDir = path.join(tmpRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(venvDir, { recursive: true });
    const fakePyPath = path.join(venvDir, process.platform === 'win32' ? 'python.exe' : 'python');
    fs.writeFileSync(fakePyPath, '', 'utf8');

    const cfgWithVenv = {
      policy: {
        repo_root: tmpRoot,
        validation: {
          fast_checks: [{ name: 'venv_chk', run: '.\\.venv\\Scripts\\python.exe -V' }],
          suite_checks: []
        }
      }
    };
    const fpVenv = await collectEnvironmentFingerprint(cfgWithVenv);
    assert.strictEqual(path.resolve(fpVenv.python_path), path.resolve(fakePyPath), 'Must resolve configured repo python path');
    assert.strictEqual(typeof fpVenv.is_admin, 'boolean', 'is_admin must be boolean');
    assert.strictEqual(typeof fpVenv.loopback_bindable, 'boolean', 'loopback_bindable must be boolean');
    assert.strictEqual(fpVenv.loopback_bindable, true, 'Loopback bind should succeed in normal test runtime');
    assert.ok(fpVenv.checked_at && !Number.isNaN(Date.parse(fpVenv.checked_at)), 'checked_at must be valid ISO timestamp');

    // 2. Injection test for restricted environment (is_admin: true, loopback_bindable: false)
    const fpRestricted = await collectEnvironmentFingerprint(cfgWithVenv, {
      detectAdmin: () => true,
      checkLoopback: async () => false,
      detectPythonPath: () => 'C:\\Custom\\python.exe'
    });
    assert.deepStrictEqual(
      {
        python_path: fpRestricted.python_path,
        is_admin: fpRestricted.is_admin,
        loopback_bindable: fpRestricted.loopback_bindable
      },
      {
        python_path: 'C:\\Custom\\python.exe',
        is_admin: true,
        loopback_bindable: false
      }
    );
    console.log('✓ collectEnvironmentFingerprint resolves python_path, is_admin, and loopback_bindable.');

    // 3. validateFast & validateSuite embed env_fingerprint across skipped, pass, and fail paths
    const fastSkipped = await validateFast({ policy: { repo_root: tmpRoot, validation: { fast_checks: [] } } });
    assert.strictEqual(fastSkipped.ok, true);
    assert.strictEqual(fastSkipped.skipped, true);
    assert.ok(fastSkipped.env_fingerprint && typeof fastSkipped.env_fingerprint.is_admin === 'boolean', 'validateFast skipped must include env_fingerprint');
    assert.ok('python_path' in fastSkipped.env_fingerprint && 'loopback_bindable' in fastSkipped.env_fingerprint);

    const fastPass = await validateFast({
      policy: {
        repo_root: tmpRoot,
        validation: {
          fast_checks: [{ name: 'ok_node', run: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, timeout_sec: 10 }]
        }
      }
    });
    assert.strictEqual(fastPass.ok, true);
    assert.ok(fastPass.env_fingerprint && typeof fastPass.env_fingerprint.loopback_bindable === 'boolean', 'validateFast pass must include env_fingerprint');

    const fastFail = await validateFast({
      policy: {
        repo_root: tmpRoot,
        validation: {
          fast_checks: [{ name: 'fail_node', run: `${JSON.stringify(process.execPath)} -e "process.exit(2)"`, timeout_sec: 10 }]
        }
      }
    });
    assert.strictEqual(fastFail.ok, false);
    assert.ok(fastFail.env_fingerprint && 'python_path' in fastFail.env_fingerprint, 'validateFast failure must include env_fingerprint');

    const suiteSkipped = await validateSuite({ policy: { repo_root: tmpRoot, validation: { suite_checks: [] } } });
    assert.strictEqual(suiteSkipped.ok, true);
    assert.ok(suiteSkipped.env_fingerprint && typeof suiteSkipped.env_fingerprint.is_admin === 'boolean', 'validateSuite skipped must include env_fingerprint');
    console.log('✓ validateFast & validateSuite attach env_fingerprint on pass, skip, and failure.');

    // 4. buildValidationResult carries env_fingerprint into task.validation_result
    const builtPass = buildValidationResult({ fastVal: fastPass, suiteVal: suiteSkipped });
    assert.strictEqual(builtPass.status, 'passed');
    assert.strictEqual(builtPass.passed, true);
    assert.strictEqual(builtPass.skipped, false);
    assert.ok(builtPass.env_fingerprint && typeof builtPass.env_fingerprint.is_admin === 'boolean');
    assert.ok('python_path' in builtPass.env_fingerprint && 'loopback_bindable' in builtPass.env_fingerprint);

    const builtSkipped = buildValidationResult({ fastVal: fastSkipped, suiteVal: suiteSkipped });
    assert.strictEqual(builtSkipped.status, 'skipped');
    assert.strictEqual(builtSkipped.skipped, true);
    assert.ok(builtSkipped.env_fingerprint);

    const builtFail = buildValidationResult({ fastVal: fastFail });
    assert.strictEqual(builtFail.status, 'failed');
    assert.strictEqual(builtFail.passed, false);
    assert.strictEqual(builtFail.check_name, 'fail_node');
    assert.ok(builtFail.env_fingerprint);

    // 5. Expanded fingerprint: ONNX model existence/sha256, onnxruntime+providers, pip_freeze_hash & baseline mismatch
    const modelsDir = path.join(tmpRoot, 'onnx-models');
    fs.mkdirSync(modelsDir, { recursive: true });
    const dummyOnnxContent = Buffer.from('fake-lama-onnx-weights-v1');
    const expectedOnnxSha = crypto.createHash('sha256').update(dummyOnnxContent).digest('hex');
    fs.writeFileSync(path.join(modelsDir, 'lama_fp32.onnx'), dummyOnnxContent);

    const fpBaseline = await collectEnvironmentFingerprint(cfgWithVenv, {
      modelsDir,
      detectAdmin: () => false,
      checkLoopback: async () => true,
      detectPythonPath: () => 'C:\\Py\\python.exe',
      detectOnnxRuntime: () => ({
        installed: true,
        import_ok: true,
        version: '1.24.4',
        providers: ['DmlExecutionProvider', 'CPUExecutionProvider'],
        error: null
      }),
      detectPipFreeze: () => ({
        sha256: 'abc123pipfreeze',
        package_count: 67
      })
    });

    assert.ok(Array.isArray(fpBaseline.onnx_models), 'env_fingerprint must contain onnx_models array');
    const lamaEntry = fpBaseline.onnx_models.find(m => m.name === 'lama_fp32.onnx');
    const ocrEntry = fpBaseline.onnx_models.find(m => m.name === 'ch_PP-OCRv4_det.onnx');
    assert.ok(lamaEntry && lamaEntry.exists === true && lamaEntry.sha256 === expectedOnnxSha, 'Existing ONNX model must record exists=true and exact sha256');
    assert.ok(ocrEntry && ocrEntry.exists === false && ocrEntry.sha256 === null, 'Missing ONNX model must record exists=false and sha256=null');
    assert.deepStrictEqual(fpBaseline.onnxruntime, {
      installed: true,
      import_ok: true,
      version: '1.24.4',
      providers: ['DmlExecutionProvider', 'CPUExecutionProvider'],
      error: null
    });
    assert.strictEqual(fpBaseline.pip_freeze_hash, 'abc123pipfreeze');

    // Same environment ignoring checked_at -> matched=true, environment_mismatch=false
    const sameCmp = compareEnvironmentFingerprints(fpBaseline, { ...fpBaseline, checked_at: '2099-01-01T00:00:00.000Z' });
    assert.strictEqual(sameCmp.matched, true);
    assert.deepStrictEqual(sameCmp.mismatch_fields, []);
    const builtMatched = buildValidationResult({
      fastVal: { ok: true, skipped: false, env_fingerprint: { ...fpBaseline, checked_at: '2099-01-01T00:00:00.000Z' } },
      suiteVal: { ok: true, skipped: false, env_fingerprint: { ...fpBaseline, checked_at: '2099-01-01T00:00:00.000Z' } },
      baselineFingerprint: fpBaseline
    });
    assert.strictEqual(builtMatched.environment_mismatch, false, 'Identical baseline vs run fingerprint must set environment_mismatch=false');

    // Modified ONNX model + pip_freeze_hash + onnxruntime provider -> mismatch detected!
    fs.writeFileSync(path.join(modelsDir, 'lama_fp32.onnx'), Buffer.from('mutated-onnx-weights-v2'));
    const fpDrifted = await collectEnvironmentFingerprint(cfgWithVenv, {
      modelsDir,
      detectAdmin: () => false,
      checkLoopback: async () => true,
      detectPythonPath: () => 'C:\\Py\\python.exe',
      detectOnnxRuntime: () => ({
        installed: true,
        import_ok: true,
        version: '1.24.4',
        providers: ['CPUExecutionProvider'],
        error: null
      }),
      detectPipFreeze: () => ({
        sha256: 'def456changed',
        package_count: 68
      })
    });
    const driftCmp = compareEnvironmentFingerprints(fpBaseline, fpDrifted);
    assert.strictEqual(driftCmp.matched, false);
    assert.ok(driftCmp.mismatch_fields.includes('pip_freeze_hash'), `Expected pip_freeze_hash mismatch, got: ${driftCmp.mismatch_fields}`);
    assert.ok(driftCmp.mismatch_fields.includes('onnxruntime.providers'), `Expected onnxruntime.providers mismatch, got: ${driftCmp.mismatch_fields}`);
    assert.ok(driftCmp.mismatch_fields.some(f => f.includes('lama_fp32.onnx')), `Expected lama_fp32.onnx mismatch, got: ${driftCmp.mismatch_fields}`);

    // 5b. Verify ONNX model hash cache hits on identical (path, size, mtime) and misses on mtime/size change
    const cacheModelsDir = path.join(tmpRoot, 'onnx-cache-models');
    fs.mkdirSync(cacheModelsDir, { recursive: true });
    const cacheModelPath = path.join(cacheModelsDir, 'cache_probe_model.onnx');
    fs.writeFileSync(cacheModelPath, 'dummy-onnx-cache-payload-v1', 'utf8');

    let hashComputeCount = 0;
    const fpCache1 = await collectEnvironmentFingerprint(cfgWithVenv, {
      modelsDir: cacheModelsDir,
      detectAdmin: () => false,
      checkLoopback: async () => true,
      detectPythonPath: () => 'C:\\Py\\python.exe',
      detectOnnxRuntime: () => ({ installed: true, import_ok: true, version: '1.24.4', providers: ['CPUExecutionProvider'], error: null }),
      detectPipFreeze: () => ({ sha256: 'abc123pipfreeze', package_count: 67 }),
      onModelHashCompute: () => { hashComputeCount++; }
    });
    assert.strictEqual(hashComputeCount, 1, 'First fingerprint collection must compute ONNX model SHA-256 once');

    const fpCache2 = await collectEnvironmentFingerprint(cfgWithVenv, {
      modelsDir: cacheModelsDir,
      detectAdmin: () => false,
      checkLoopback: async () => true,
      detectPythonPath: () => 'C:\\Py\\python.exe',
      detectOnnxRuntime: () => ({ installed: true, import_ok: true, version: '1.24.4', providers: ['CPUExecutionProvider'], error: null }),
      detectPipFreeze: () => ({ sha256: 'abc123pipfreeze', package_count: 67 }),
      onModelHashCompute: () => { hashComputeCount++; }
    });
    assert.strictEqual(hashComputeCount, 1, 'Second collection with identical (path, size, mtime) MUST hit SHA-256 cache');
    assert.strictEqual(
      fpCache2.onnx_models.find(m => m.name === 'cache_probe_model.onnx').sha256,
      fpCache1.onnx_models.find(m => m.name === 'cache_probe_model.onnx').sha256
    );

    const newTime = new Date(Date.now() + 5000);
    fs.utimesSync(cacheModelPath, newTime, newTime);
    await collectEnvironmentFingerprint(cfgWithVenv, {
      modelsDir: cacheModelsDir,
      detectAdmin: () => false,
      checkLoopback: async () => true,
      detectPythonPath: () => 'C:\\Py\\python.exe',
      detectOnnxRuntime: () => ({ installed: true, import_ok: true, version: '1.24.4', providers: ['CPUExecutionProvider'], error: null }),
      detectPipFreeze: () => ({ sha256: 'abc123pipfreeze', package_count: 67 }),
      onModelHashCompute: () => { hashComputeCount++; }
    });
    assert.strictEqual(hashComputeCount, 2, 'Changing model mtime MUST invalidate cache and recompute SHA-256');

    fs.appendFileSync(cacheModelPath, '-extra', 'utf8');
    await collectEnvironmentFingerprint(cfgWithVenv, {
      modelsDir: cacheModelsDir,
      detectAdmin: () => false,
      checkLoopback: async () => true,
      detectPythonPath: () => 'C:\\Py\\python.exe',
      detectOnnxRuntime: () => ({ installed: true, import_ok: true, version: '1.24.4', providers: ['CPUExecutionProvider'], error: null }),
      detectPipFreeze: () => ({ sha256: 'abc123pipfreeze', package_count: 67 }),
      onModelHashCompute: () => { hashComputeCount++; }
    });
    assert.strictEqual(hashComputeCount, 3, 'Changing model file size MUST invalidate cache and recompute SHA-256');

    const builtMismatch = buildValidationResult({
      fastVal: { ok: true, skipped: false, env_fingerprint: fpDrifted },
      suiteVal: { ok: true, skipped: false, env_fingerprint: fpDrifted },
      baselineFingerprint: fpBaseline
    });
    assert.strictEqual(builtMismatch.environment_mismatch, true, 'Changed baseline vs task environment must attach environment_mismatch=true');
    assert.strictEqual(builtMismatch.passed, false, 'Validation result with environment_mismatch MUST NOT report passed=true');
    assert.strictEqual(builtMismatch.trusted, false, 'Validation result with environment_mismatch MUST report trusted=false');
    assert.strictEqual(builtMismatch.status, 'environment_mismatch');
    assert.ok(Array.isArray(builtMismatch.environment_mismatch_fields) && builtMismatch.environment_mismatch_fields.length >= 3);
    assert.ok(Array.isArray(builtMismatch.environment_diff) && builtMismatch.environment_diff.length >= 3);

    // Real local repo Python probe sanity (uses actual .venv if present in repo)
    const repoRealFp = await collectEnvironmentFingerprint({
      policy: {
        repo_root: path.resolve(__dirname, '../..'),
        validation: { fast_checks: [{ name: 't', run: '.\\.venv\\Scripts\\python.exe -V' }] }
      }
    }, { modelsDir });
    assert.ok('onnxruntime' in repoRealFp && typeof repoRealFp.onnxruntime.installed === 'boolean');
    assert.ok('pip_freeze_hash' in repoRealFp);

    // 6. Verify orchestrator.mjs rejects validation with environment_mismatch (fail-closed)
    const orchMod = await import('./orchestrator.mjs');
    assert.strictEqual(
      typeof orchMod.evaluateValidationTrust,
      'function',
      'orchestrator.mjs must export evaluateValidationTrust'
    );
    const untrustedGate = orchMod.evaluateValidationTrust({
      fastVal: { ok: true, skipped: false, env_fingerprint: fpDrifted },
      suiteVal: { ok: true, skipped: false, env_fingerprint: fpDrifted },
      baselineFingerprint: fpBaseline
    });
    assert.strictEqual(untrustedGate.ok, false, 'Orchestrator MUST refuse validation when environment_mismatch=true');
    assert.strictEqual(untrustedGate.trusted, false);
    assert.strictEqual(untrustedGate.blocked, true);
    assert.strictEqual(untrustedGate.reason, 'environment_mismatch');
    assert.strictEqual(untrustedGate.validationResult.passed, false);

    const trustedGate = orchMod.evaluateValidationTrust({
      fastVal: { ok: true, skipped: false, env_fingerprint: { ...fpBaseline, checked_at: '2035-05-05T00:00:00.000Z' } },
      suiteVal: { ok: true, skipped: false, env_fingerprint: { ...fpBaseline, checked_at: '2035-05-05T00:00:00.000Z' } },
      baselineFingerprint: fpBaseline
    });
    assert.strictEqual(trustedGate.ok, true, 'Matching fingerprint differing only in checked_at must be trusted');
    assert.strictEqual(trustedGate.trusted, true);
    assert.strictEqual(trustedGate.validationResult.environment_mismatch, false);
    assert.strictEqual(trustedGate.validationResult.passed, true);

    const orchSrc = fs.readFileSync(path.resolve(__dirname, 'orchestrator.mjs'), 'utf8');
    assert.ok(orchSrc.includes('buildValidationResult') || orchSrc.includes('evaluateValidationTrust'));
    assert.ok(orchSrc.includes('baselineFingerprint'), 'orchestrator.mjs must pass baselineFingerprint into validation evaluation');
    console.log('✓ ONNX models, onnxruntime/providers, pip_freeze_hash & environment_mismatch verified.');

    console.log('\n=================================================');
    console.log('ALL VALIDATION FINGERPRINT TESTS PASSED!');
    console.log('=================================================');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Validation fingerprint test failed:', err);
  process.exit(1);
});
