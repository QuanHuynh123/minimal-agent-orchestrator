// ==============================================================================
// 🌐 COCKPIT API CLIENT (agent-team/ui/js/api.js)
// ==============================================================================
// MỤC ĐÍCH:
// - Đóng gói toàn bộ các cuộc gọi API mạng giữa Frontend Cockpit và Backend Server.
// - Tự động quản lý CSRF Token injection, Content-Type headers và chuẩn hóa lỗi HTTP.
// - Giúp app.js thuần túy làm nhiệm vụ render DOM, quản lý state và tương tác người dùng.
// ==============================================================================

(function (window) {
  'use strict';

  let currentCsrfToken = '';

  function setCsrfToken(token) {
    if (typeof token === 'string' && token.trim()) {
      currentCsrfToken = token.trim();
    }
  }

  function getCsrfToken() {
    return currentCsrfToken;
  }

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (currentCsrfToken) {
      if (!headers['X-Dashboard-Token']) headers['X-Dashboard-Token'] = currentCsrfToken;
      if (!headers['X-CSRF-Token']) headers['X-CSRF-Token'] = currentCsrfToken;
    }
    const res = await fetch(url, { ...options, headers });
    return res;
  }

  const CockpitApi = {
    setCsrfToken,
    getCsrfToken,

    async fetchSnapshot() {
      const res = await request('/api/snapshot');
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch snapshot`);
      const data = await res.json();
      if (data?.csrf_token) {
        setCsrfToken(data.csrf_token);
      }
      return data;
    },

    async fetchModels() {
      const res = await request('/api/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}: Không thể lấy danh sách models`);
      return res.json();
    },

    async testModel(model) {
      try {
        const res = await request('/api/test-model', {
          method: 'POST',
          body: JSON.stringify({ model })
        });
        if (!res.ok) {
          let errData;
          try { errData = await res.json(); } catch {}
          return { ok: false, error: errData?.error || `HTTP ${res.status}` };
        }
        return await res.json();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async saveTeamConfig(payload) {
      const res = await request('/api/save-team-config', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        let errData;
        try { errData = await res.json(); } catch {}
        throw new Error(errData?.error || `HTTP ${res.status}: Failed to save team config`);
      }
      return res.json();
    },

    async decomposeGoal(goal, options = {}) {
      const res = await request('/api/decompose', {
        method: 'POST',
        body: JSON.stringify({ goal, ...options })
      });
      if (!res.ok) {
        let errData;
        try { errData = await res.json(); } catch {}
        throw new Error(errData?.error || `HTTP ${res.status}: Failed to decompose goal`);
      }
      return res.json();
    },

    async approveRun(taskIds = null) {
      const payload = (Array.isArray(taskIds) && taskIds.length > 0) ? { task_ids: taskIds } : {};
      const res = await request('/api/approve-run', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        let errData;
        try { errData = await res.json(); } catch {}
        throw new Error(errData?.error || `HTTP ${res.status}: Failed to approve and start tasks`);
      }
      return res.json();
    },

    async stopOrchestrator() {
      const res = await request('/api/stop', {
        method: 'POST',
        body: JSON.stringify({})
      });
      if (!res.ok) {
        let errData;
        try { errData = await res.json(); } catch {}
        throw new Error(errData?.error || `HTTP ${res.status}: Failed to stop orchestrator`);
      }
      return res.json();
    },

    async fetchSession(sessionId) {
      const res = await request(`/api/session?id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch session`);
      return res.json();
    }
  };

  window.CockpitApi = CockpitApi;
})(window);
