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
  res.writeHead(status, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*' 
  });
  res.end(JSON.stringify(data));
}

function ensureDefaultTasks() {
  try {
    const data = db.readDb();
    if (!data.tasks || data.tasks.length === 0) {
      data.tasks = [
        { id: '1', title: 'Complete a Survey', description: 'Answer a short survey', reward: 500 },
        { id: '2', title: 'Share a Post', description: 'Share our post on social media', reward: 500 },
        { id: '3', title: 'Fill a Form', description: 'Complete a simple form', reward: 500 }
      ];
      db.writeDb(data);
    }
  } catch (e) {
    console.error('Error ensuring tasks:', e);
  }
}

const server = http.createServer(async (req, res) => {
  try {
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

    // Login
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const id = (body.identifier || body.email || '').toLowerCase();
      const pass = body.password || '';

      if ((id === 'admin@zbyte.com.ng' || id === 'admin') && pass === 'admin') {
        const token = crypto.randomBytes(16).toString('hex');
        return send(res, 200, { token });
      }
      return send(res, 401, { error: 'Invalid credentials' });
    }

    // User info
    if (pathname === '/api/user/me' && req.method === 'GET') {
      return send(res, 200, {
        name: 'MR BIG FSH',
        email: 'admin@zbyte.com.ng',
        tier: 'gold',
        taskWallet: 0,
        referralWallet: 0,
        referralCode: 'ADMIN01'
      });
    }

    // Tasks
    if (pathname === '/api/tasks' && req.method === 'GET') {
      ensureDefaultTasks();
      const data = db.readDb();
      return send(res, 200, data.tasks || []);
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Error:', err);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
  ensureDefaultTasks();
});
