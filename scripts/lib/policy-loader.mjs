#!/usr/bin/env node
/**
 * Shared Safe YAML & Fail-Closed Policy/Team Config Loader
 *
 * Guarantees:
 * 1. loadYamlSafe(filePath) returns null (never {}) for missing or invalid YAML.
 * 2. policy.yaml (base) + policy.local.yaml (local override) are deep-merged;
 *    local overrides base keys without erasing unrelated base guardrails.
 * 3. Fail-closed: if base policy.yaml is missing, unreadable, invalid YAML,
 *    or omits required project_id / scope_control.allowed_dirs, throws an Error
 *    instead of falling back to "my-workspace" or ["*"].
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config');

export function resolveConfigDir(explicitDir = null) {
  if (explicitDir && typeof explicitDir === 'string' && explicitDir.trim()) {
    return path.resolve(explicitDir.trim());
  }
  const envDir = process.env.AGENT_TEAM_CONFIG_DIR;
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim());
  }
  return DEFAULT_CONFIG_DIR;
}

export function loadYamlSafe(filePath) {
  if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = YAML.parse(raw);
    return parsed === undefined ? null : parsed;
  } catch {
    return null;
  }
}

export function loadYamlStrict(filePath, label = path.basename(filePath || 'config.yaml')) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`[PolicyLoader] Missing required ${label} at "${filePath}" (fail-closed)`);
  }
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw new Error(`[PolicyLoader] Unreadable ${label} at "${filePath}": ${err.message}`);
  }
  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`[PolicyLoader] Invalid YAML in ${label} (${filePath}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[PolicyLoader] ${label} (${filePath}) must parse to a non-empty YAML mapping`);
  }
  return parsed;
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function deepMergeObjects(baseObj = {}, overrideObj = {}) {
  const out = isPlainObject(baseObj) ? { ...baseObj } : {};
  if (!isPlainObject(overrideObj)) return out;
  for (const [key, val] of Object.entries(overrideObj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (val === undefined) continue;
    if (isPlainObject(val) && isPlainObject(out[key])) {
      out[key] = deepMergeObjects(out[key], val);
    } else if (Array.isArray(val)) {
      out[key] = [...val];
    } else if (isPlainObject(val)) {
      out[key] = deepMergeObjects({}, val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function deriveLocalSibling(basePath, explicitLocalPath = null) {
  if (explicitLocalPath) return path.resolve(explicitLocalPath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  return path.join(path.dirname(basePath), `${stem}.local${ext}`);
}

export function validateMergedPolicy(parsed, sourceDesc = 'policy.yaml') {
  const policy = parsed?.policy;
  if (!isPlainObject(policy)) {
    throw new Error(`[PolicyLoader] Missing top-level "policy:" mapping in ${sourceDesc} (fail-closed)`);
  }
  const projectId = typeof policy.project_id === 'string' ? policy.project_id.trim() : '';
  if (!projectId) {
    throw new Error(`[PolicyLoader] Missing required policy.project_id in ${sourceDesc} (fail-closed, no fallback)`);
  }
  const allowedDirs = policy.scope_control?.allowed_dirs;
  if (
    !Array.isArray(allowedDirs) ||
    allowedDirs.length === 0 ||
    !allowedDirs.every(d => typeof d === 'string' && d.trim().length > 0)
  ) {
    throw new Error(`[PolicyLoader] Missing or empty policy.scope_control.allowed_dirs in ${sourceDesc} (fail-closed, no fallback)`);
  }
  if (policy.cockpit !== undefined) {
    if (!isPlainObject(policy.cockpit)) {
      throw new Error(`[PolicyLoader] policy.cockpit in ${sourceDesc} must be a mapping`);
    }
    if (policy.cockpit.port !== undefined) {
      normalizeCockpitPort(policy.cockpit.port, 'policy.cockpit.port');
    }
  }
  return parsed;
}

export function normalizeCockpitPort(rawPort, source = 'cockpit.port') {
  if (rawPort === undefined || rawPort === null || rawPort === '') {
    return null;
  }
  if (typeof rawPort === 'boolean') {
    throw new Error(`[PolicyLoader] Invalid ${source}: expected integer port 0..65535`);
  }
  const parsed = typeof rawPort === 'number'
    ? rawPort
    : (/^\d+$/.test(String(rawPort).trim()) ? Number(String(rawPort).trim()) : NaN);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`[PolicyLoader] Invalid ${source} "${rawPort}": must be an integer between 0 and 65535`);
  }
  return parsed;
}

export function resolveCockpitConfig(options = {}) {
  const env = options.env || process.env;
  let policyObj = options.policyConfig || null;
  if (!policyObj) {
    const cfgDir = resolveConfigDir(options.configDir);
    const basePath = options.policyFile
      ? path.resolve(options.policyFile)
      : path.join(cfgDir, 'policy.yaml');
    if (fs.existsSync(basePath)) {
      policyObj = loadMergedPolicy({
        configDir: cfgDir,
        policyFile: options.policyFile,
        localPolicyFile: options.localPolicyFile
      });
    }
  }
  const cockpitPolicy = policyObj?.policy?.cockpit || policyObj?.cockpit || {};

  const rawHost = options.host ?? env.DASHBOARD_HOST ?? cockpitPolicy.host ?? '127.0.0.1';
  const host = String(rawHost || '').trim() || '127.0.0.1';

  let port = 4310;
  if (options.port !== undefined && options.port !== null && options.port !== '') {
    port = normalizeCockpitPort(options.port, 'options.port');
  } else if (env.DASHBOARD_PORT !== undefined && env.DASHBOARD_PORT !== '') {
    port = normalizeCockpitPort(env.DASHBOARD_PORT, 'DASHBOARD_PORT');
  } else if (cockpitPolicy.port !== undefined && cockpitPolicy.port !== null && cockpitPolicy.port !== '') {
    port = normalizeCockpitPort(cockpitPolicy.port, 'policy.cockpit.port');
  }

  return {
    host,
    port,
    url: `http://${host}:${port}`
  };
}

export function loadMergedPolicy(options = {}) {
  const cfgDir = resolveConfigDir(options.configDir);
  const basePath = options.policyFile
    ? path.resolve(options.policyFile)
    : path.join(cfgDir, 'policy.yaml');
  const localPath = deriveLocalSibling(basePath, options.localPolicyFile);

  const baseParsed = loadYamlStrict(basePath, 'policy.yaml');
  let merged = baseParsed;
  if (fs.existsSync(localPath)) {
    const localParsed = loadYamlStrict(localPath, 'policy.local.yaml');
    merged = deepMergeObjects(baseParsed, localParsed);
  }
  return validateMergedPolicy(merged, basePath);
}

export function loadMergedTeamConfig(options = {}) {
  const cfgDir = resolveConfigDir(options.configDir);
  const basePath = options.teamFile
    ? path.resolve(options.teamFile)
    : path.join(cfgDir, 'team.yaml');
  const localPath = deriveLocalSibling(basePath, options.localTeamFile);

  const baseParsed = loadYamlStrict(basePath, 'team.yaml');
  let merged = baseParsed;
  if (fs.existsSync(localPath)) {
    const localParsed = loadYamlStrict(localPath, 'team.local.yaml');
    merged = deepMergeObjects(baseParsed, localParsed);
  }

  const baseDir = path.dirname(basePath);
  const routingPath = options.routingFile
    ? path.resolve(options.routingFile)
    : path.join(baseDir, 'team.routing.yaml');
  const routingLocalPath = deriveLocalSibling(routingPath);

  const mergeRoutingPayload = (currentRouting, filePayload) => {
    if (!filePayload || typeof filePayload !== 'object') return currentRouting;
    const incoming = (filePayload.routing && typeof filePayload.routing === 'object')
      ? filePayload.routing
      : filePayload;
    const baseRules = Array.isArray(currentRouting?.rules) ? currentRouting.rules : [];
    const incomingRules = Array.isArray(incoming?.rules) ? incoming.rules : [];
    const combined = deepMergeObjects(currentRouting || {}, incoming);
    if (incomingRules.length > 0 || baseRules.length > 0) {
      combined.rules = [...incomingRules, ...baseRules];
    }
    return combined;
  };

  if (fs.existsSync(routingPath)) {
    const routingParsed = loadYamlStrict(routingPath, 'team.routing.yaml');
    merged = {
      ...merged,
      routing: mergeRoutingPayload(merged.routing, routingParsed)
    };
  }
  if (fs.existsSync(routingLocalPath)) {
    const routingLocalParsed = loadYamlStrict(routingLocalPath, 'team.routing.local.yaml');
    merged = {
      ...merged,
      routing: mergeRoutingPayload(merged.routing, routingLocalParsed)
    };
  }

  return merged;
}

export function loadMergedProjectConfig(options = {}) {
  const cfgDir = resolveConfigDir(options.configDir);
  const basePath = options.projectFile
    ? path.resolve(options.projectFile)
    : path.join(cfgDir, 'project.yaml');
  const localPath = deriveLocalSibling(basePath, options.localProjectFile);

  if (!fs.existsSync(basePath) && !fs.existsSync(localPath)) {
    return null;
  }
  const baseParsed = fs.existsSync(basePath) ? loadYamlStrict(basePath, 'project.yaml') : {};
  if (fs.existsSync(localPath)) {
    const localParsed = loadYamlStrict(localPath, 'project.local.yaml');
    return deepMergeObjects(baseParsed, localParsed);
  }
  return baseParsed;
}
