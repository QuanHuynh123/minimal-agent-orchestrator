import fs from 'node:fs';
import path from 'node:path';

export function renderIndexHtml(uiFile, uiDir) {
  if (!fs.existsSync(uiFile)) return null;
  const raw = fs.readFileSync(uiFile, 'utf8');
  return raw.replace(/<!--\s*@include\s+([a-zA-Z0-9_\-\.\/]+)\s*-->/g, (match, relPath) => {
    const target = path.resolve(uiDir, relPath);
    if (target.startsWith(uiDir) && fs.existsSync(target)) {
      try {
        return fs.readFileSync(target, 'utf8');
      } catch (e) {
        return `<!-- Include Error: ${e.message} -->`;
      }
    }
    return match;
  });
}

export function handleStaticRequest(req, res, url, uiDir, uiFile) {
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const rendered = renderIndexHtml(uiFile, uiDir);
    if (!rendered) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('UI index.html not found. Please ensure agent-team/ui/index.html is created.');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(rendered);
    return true;
  }

  // Serve static assets in ui/ (css, js, svg, png)
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const safeRel = path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, '').replace(/^[/\\]+/, '');
    const targetFile = path.resolve(uiDir, safeRel);
    if (targetFile.startsWith(uiDir) && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
      const ext = path.extname(targetFile).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png'
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(targetFile).pipe(res);
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return true;
  }

  return false;
}
