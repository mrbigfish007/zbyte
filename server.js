const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    return res.end();
  }

  // Static files
  if (req.method === 'GET' && !pathname.startsWith('/api')) {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // Simple login test
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    console.log('Login attempt:', body);

    // Temporary hard-coded admin login
    if (body.identifier === 'admin' && body.password === 'admin') {
      const token = crypto.randomBytes(16).toString('hex');
      return send(res, 200, { token, message: 'Login successful' });
    }

    return send(res, 401, { error: 'Invalid credentials', received: body });
  }

  if (pathname === '/api/user/me' && req.method === 'GET') {
    return send(res, 200, { name: 'Test User', email: 'admin@zbyte.com.ng' });
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log('Server running on port', PORT));
