import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import YAML from 'yaml';
import { verifyCsrfAndOrigin, parseJsonBody } from './security.mjs';
import { loadYamlSafe } from './state-reader.mjs';

export async function handleModelsRoutes(req, res, url, options = {}) {
  const teamConfigFile = options.TEAM_CONFIG_FILE
    || (fs.existsSync(path.resolve('agent-team/config/team.yaml'))
        ? path.resolve('agent-team/config/team.yaml')
        : path.resolve('config/team.yaml'));
  const policyConfigFile = options.POLICY_CONFIG_FILE
    || (fs.existsSync(path.resolve('agent-team/config/policy.yaml'))
        ? path.resolve('agent-team/config/policy.yaml')
        : path.resolve('config/policy.yaml'));
  const repoRoot = options.REPO_ROOT
    || (fs.existsSync(path.resolve('agent-team'))
        ? path.resolve('.')
        : path.resolve('..'));

  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const start = Date.now();
      let models = [];
      let source = '9router';
      const teamData = loadYamlSafe(teamConfigFile) || {};
      const providerCfg = teamData.team?.providers?.local_9router || {};
      const targetBaseUrl = url.searchParams.get('url') || providerCfg.base_url || 'http://127.0.0.1:20128/v1';
      const targetKey = url.searchParams.get('key') || providerCfg.default_key || 'sk-default';
      const modelsEndpoint = targetBaseUrl.endsWith('/') ? `${targetBaseUrl}models` : `${targetBaseUrl}/models`;

      try {
        const fetchRes = await fetch(modelsEndpoint, {
          method: 'GET',
          headers: { Authorization: `Bearer ${targetKey}` },
          signal: AbortSignal.timeout(3000)
        });
        if (fetchRes.ok) {
          const raw = await fetchRes.json();
          if (Array.isArray(raw.data)) {
            models = raw.data.map(m => {
              const caps = m.capabilities || {};
              return {
                id: m.id,
                name: m.id.split('/').pop() || m.id,
                owned_by: m.owned_by || '',
                capabilities: {
                  vision: Boolean(caps.vision),
                  tools: Boolean(caps.tools),
                  reasoning: Boolean(caps.reasoning || caps.thinking || caps.thinkingFormat)
                }
              };
            });
          }
        }
      } catch (fetchErr) {
        source = 'fallback_team_yaml';
      }

      // Fallback if 9router is not reachable or returned 0 models
      if (models.length === 0) {
        const teamData = loadYamlSafe(teamConfigFile);
        const roles = teamData?.roles || {};
        const fallbackSet = new Set();
        for (const r of Object.values(roles)) {
          if (r?.model) fallbackSet.add(r.model);
        }
        fallbackSet.add('kr/claude-sonnet-4.5-thinking');
        fallbackSet.add('Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017');
        fallbackSet.add('ag/claude-opus-5-5-high');
        fallbackSet.add('ag/gemini-3.8-flash-medium');

        models = Array.from(fallbackSet).map(id => ({
          id,
          name: id.split('/').pop() || id,
          owned_by: id.startsWith('kr/') ? 'kr' : (id.startsWith('ag/') ? 'ag' : 'local'),
          capabilities: {
            vision: id.includes('gemini') || id.includes('claude'),
            tools: true,
            reasoning: id.includes('thinking') || id.includes('opus') || id.includes('sonnet')
          }
        }));
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        ok: true,
        source,
        latency_ms: Date.now() - start,
        count: models.length,
        models
      }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-model') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const body = await parseJsonBody(req);
      const model = String(body.model || '').trim();
      if (!model) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Model identifier cannot be empty' }));
        return true;
      }

      const teamData = loadYamlSafe(teamConfigFile) || {};
      const providerCfg = teamData.team?.providers?.local_9router || {};
      const targetBaseUrl = body.url || providerCfg.base_url || 'http://127.0.0.1:20128/v1';
      const targetKey = body.key || providerCfg.default_key || 'sk-default';
      const chatEndpoint = targetBaseUrl.endsWith('/') ? `${targetBaseUrl}chat/completions` : `${targetBaseUrl}/chat/completions`;

      const start = Date.now();
      try {
        const pingRes = await fetch(chatEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${targetKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false
          }),
          signal: AbortSignal.timeout(7000)
        });

        const latency = Date.now() - start;
        const resJson = await pingRes.json().catch(() => null);

        if (pingRes.ok && resJson && !resJson.error) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            latency_ms: latency,
            model,
            status: 'online',
            reply_preview: resJson.choices?.[0]?.message?.content?.slice(0, 50) || 'OK'
          }));
        } else {
          const errMsg = resJson?.error?.message || `HTTP ${pingRes.status}`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: false,
            latency_ms: latency,
            model,
            status: 'error',
            error: errMsg
          }));
        }
      } catch (pingErr) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          latency_ms: Date.now() - start,
          model,
          status: 'error',
          error: pingErr.name === 'TimeoutError' ? 'Timeout (7.0s)' : pingErr.message
        }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/save-team-config') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const body = await parseJsonBody(req);
      const rolesInput = body.roles;
      if (!rolesInput || typeof rolesInput !== 'object' || Object.keys(rolesInput).length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          error: 'Đội ngũ AI không được để trống! Cần tối thiểu 1 vai trò (khuyên dùng Writer) để hệ thống hoạt động.'
        }));
        return true;
      }

      if (!fs.existsSync(teamConfigFile)) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'team.yaml not found' }));
        return true;
      }

      const teamData = loadYamlSafe(teamConfigFile) || { team: { name: 'hybrid-agent-squad' }, roles: {} };
      if (!teamData.roles) teamData.roles = {};

      let updatedCount = 0;

      // 1. Đồng bộ và cập nhật các vai trò có trong danh sách gửi lên
      for (const [roleKey, roleSpec] of Object.entries(rolesInput)) {
        if (!roleSpec || typeof roleSpec !== 'object') continue;
        const newModel = String(roleSpec.model || '').trim();
        const modelsArray = Array.isArray(roleSpec.models)
          ? roleSpec.models.filter(Boolean)
          : (newModel ? [newModel] : []);

        if (modelsArray.length === 0 && !newModel) continue;
        const primaryModel = modelsArray[0] || newModel;
        const fallbackModel = modelsArray.length > 1 ? modelsArray[1] : null;

        if (teamData.roles[roleKey]) {
          teamData.roles[roleKey].enabled = true;
          teamData.roles[roleKey].model = primaryModel;
          teamData.roles[roleKey].default_model = primaryModel;
          teamData.roles[roleKey].models = modelsArray;
          teamData.roles[roleKey].fallback_model = fallbackModel;
          if (roleSpec.display_name) {
            teamData.roles[roleKey].display_name = roleSpec.display_name;
          }
        } else {
          teamData.roles[roleKey] = {
            enabled: true,
            provider: 'local_9router',
            display_name: roleSpec.display_name || (roleKey.charAt(0).toUpperCase() + roleKey.slice(1)),
            model: primaryModel,
            default_model: primaryModel,
            models: modelsArray,
            fallback_model: fallbackModel,
            temperature: 0.1
          };
        }
        updatedCount++;
      }

      // 2. Xóa bỏ hoàn toàn các vai trò đã bị gỡ khỏi đội ngũ (không còn trong rolesInput)
      for (const existingRole of Object.keys(teamData.roles)) {
        if (!rolesInput[existingRole]) {
          delete teamData.roles[existingRole];
        }
      }

      // Save 9Router Provider Base URL & Key if provided
      if (body.provider && typeof body.provider === 'object') {
        if (!teamData.providers) teamData.providers = {};
        if (!teamData.providers.local_9router) {
          teamData.providers.local_9router = { type: 'openai_compatible' };
        }
        if (body.provider.base_url) {
          teamData.providers.local_9router.base_url = String(body.provider.base_url).trim();
        }
        if (body.provider.default_key) {
          teamData.providers.local_9router.default_key = String(body.provider.default_key).trim();
        }
        if (teamData.team?.providers) {
          delete teamData.team.providers;
        }
      }

      fs.writeFileSync(teamConfigFile, YAML.stringify(teamData), 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        updated_count: updatedCount,
        message: `Đã cập nhật ${updatedCount} vai trò vào config/team.yaml thành công!`
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/save-policy-config') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const body = await parseJsonBody(req);
      const policyInput = body.policy;
      if (!policyInput || typeof policyInput !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid policy object' }));
        return true;
      }

      if (!fs.existsSync(policyConfigFile)) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'policy.yaml not found' }));
        return true;
      }

      const rawYaml = fs.readFileSync(policyConfigFile, 'utf8');
      const doc = YAML.parseDocument(rawYaml);
      if (!doc.has('policy')) {
        doc.set('policy', {});
      }
      const policyNode = doc.get('policy');

      // 1. Validation checks
      if (policyInput.validation && typeof policyInput.validation === 'object') {
        if (Array.isArray(policyInput.validation.fast_checks)) {
          policyNode.setIn(['validation', 'fast_checks'], policyInput.validation.fast_checks);
        }
        if (Array.isArray(policyInput.validation.suite_checks)) {
          policyNode.setIn(['validation', 'suite_checks'], policyInput.validation.suite_checks);
        }
      }

      // 2. Scope control
      if (policyInput.scope_control && typeof policyInput.scope_control === 'object') {
        const sc = policyInput.scope_control;
        if (typeof sc.max_files_per_task === 'number') policyNode.setIn(['scope_control', 'max_files_per_task'], sc.max_files_per_task);
        if (typeof sc.max_scope_increase === 'number') policyNode.setIn(['scope_control', 'max_scope_increase'], sc.max_scope_increase);
        if (typeof sc.allow_new_files === 'boolean') policyNode.setIn(['scope_control', 'allow_new_files'], sc.allow_new_files);
        if (typeof sc.strict_scope_enforcement === 'boolean') policyNode.setIn(['scope_control', 'strict_scope_enforcement'], sc.strict_scope_enforcement);
      }

      // 3. Git hygiene
      if (policyInput.git_hygiene && typeof policyInput.git_hygiene === 'object') {
        const gh = policyInput.git_hygiene;
        if (typeof gh.rollback_on_validation_fail === 'boolean') policyNode.setIn(['git_hygiene', 'rollback_on_validation_fail'], gh.rollback_on_validation_fail);
        if (typeof gh.auto_commit_on_done === 'boolean') policyNode.setIn(['git_hygiene', 'auto_commit_on_done'], gh.auto_commit_on_done);
      }

      // 4. Execution guardrails
      if (policyInput.execution_guardrails && typeof policyInput.execution_guardrails === 'object') {
        const eg = policyInput.execution_guardrails;
        if (typeof eg.enforce_command_timeouts === 'boolean') policyNode.setIn(['execution_guardrails', 'enforce_command_timeouts'], eg.enforce_command_timeouts);
        if (typeof eg.default_cli_timeout_sec === 'number') policyNode.setIn(['execution_guardrails', 'default_cli_timeout_sec'], eg.default_cli_timeout_sec);
        if (typeof eg.block_powershell_curl_alias === 'boolean') policyNode.setIn(['execution_guardrails', 'block_powershell_curl_alias'], eg.block_powershell_curl_alias);
      }

      // 5. Retry and escalation
      if (policyInput.retry_and_escalation && typeof policyInput.retry_and_escalation === 'object') {
        const re = policyInput.retry_and_escalation;
        if (typeof re.max_retries_per_task === 'number') policyNode.setIn(['retry_and_escalation', 'max_retries_per_task'], re.max_retries_per_task);
        if (typeof re.token_budget_per_task === 'number') policyNode.setIn(['retry_and_escalation', 'token_budget_per_task'], re.token_budget_per_task);
      }

      fs.writeFileSync(policyConfigFile, doc.toString(), 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        message: 'Đã cập nhật chính sách kiểm thử (policy.yaml) thành công!'
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/run-validation-check') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return true;
    }

    try {
      const body = await parseJsonBody(req);
      const checkType = body.check_type || 'fast';
      const policyData = loadYamlSafe(policyConfigFile) || {};
      const validation = policyData.policy?.validation || {};
      const checks = checkType === 'suite' ? validation.suite_checks : validation.fast_checks;

      // Allow command override from request body if user changed it in textbox
      let cmd = String(body.cmd || '').trim();
      let timeoutSec = Number(body.timeout_sec);

      if (!cmd) {
        if (Array.isArray(checks) && checks.length > 0) {
          cmd = String(checks[0].run || '').trim();
          if (!timeoutSec) timeoutSec = Number(checks[0].timeout_sec);
        }
      }

      if (!cmd) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: `Không tìm thấy lệnh kiểm thử ${checkType} nào trong policy.yaml` }));
        return true;
      }

      timeoutSec = Math.max(5, Math.min(300, timeoutSec || 30));

      const start = Date.now();
      exec(cmd, { cwd: repoRoot, timeout: timeoutSec * 1000 }, (error, stdout, stderr) => {
        const duration = Date.now() - start;
        if (error) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: false,
            exit_code: error.code || 1,
            duration_ms: duration,
            output: (stderr || stdout || error.message).trim()
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            exit_code: 0,
            duration_ms: duration,
            output: (stdout || 'OK').trim()
          }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  return false;
}
