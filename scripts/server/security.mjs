import crypto from 'node:crypto';

// Zero-Trust Localhost CSRF Token generated fresh on dashboard startup
export const DASHBOARD_CSRF_TOKEN = crypto.randomUUID();

export function verifyCsrfAndOrigin(req) {
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.hostname !== '127.0.0.1' && parsedOrigin.hostname !== 'localhost') {
        return { ok: false, status: 403, error: 'Forbidden: Cross-Origin Request Blocked' };
      }
    } catch {
      return { ok: false, status: 403, error: 'Forbidden: Invalid Request Origin' };
    }
  }

  const token = req.headers['x-dashboard-token'];
  if (!token || token !== DASHBOARD_CSRF_TOKEN) {
    return { ok: false, status: 403, error: 'Forbidden: Missing or Invalid X-Dashboard-Token' };
  }

  return { ok: true };
}

export function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Payload exceeds maximum limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}
