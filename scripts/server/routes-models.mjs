import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { verifyCsrfAndOrigin, parseJsonBody } from './security.mjs';
import { loadYamlSafe } from './state-reader.mjs';

export async function handleModelsRoutes(req, res, url, options = {}) {
  const teamConfigFile = options.TEAM_CONFIG_FILE || path.resolve('agent-team/config/team.yaml');

  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const start = Date.now();
      let models = [];
      let source = '9router';
      try {
        const fetchRes = await fetch('http://127.0.0.1:20128/v1/models', {
          method: 'GET',
          headers: { Authorization: 'Bearer sk-default' },
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

      const start = Date.now();
      try {
        const pingRes = await fetch('http://127.0.0.1:20128/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-default'
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
      if (!rolesInput || typeof rolesInput !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid roles object' }));
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
      for (const [roleKey, roleSpec] of Object.entries(rolesInput)) {
        if (!roleSpec || typeof roleSpec !== 'object') continue;
        const newModel = String(roleSpec.model || '').trim();
        if (!newModel) continue;

        if (teamData.roles[roleKey]) {
          teamData.roles[roleKey].model = newModel;
          if (roleSpec.display_name) {
            teamData.roles[roleKey].display_name = roleSpec.display_name;
          }
        } else {
          teamData.roles[roleKey] = {
            enabled: true,
            provider: 'local_9router',
            display_name: roleSpec.display_name || (roleKey.charAt(0).toUpperCase() + roleKey.slice(1)),
            model: newModel,
            fallback_model: null,
            temperature: 0.1
          };
        }
        updatedCount++;
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

  return false;
}
