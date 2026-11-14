const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function getAuthUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const data = db.readDb();
  return data.users.find(u => u.token === token) || null;
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
    if (pathname.startsWith('/admin')) {
      filePath = path.join(__dirname, 'admin', pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.replace('/admin', ''));
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const { identifier, password } = await parseBody(req);
    const data = db.readDb();
    
    // Temporary: allow admin login with simple check
    if (identifier === 'admin@zbyte.com.ng' && password === 'admin123') {
      let user = data.users.find(u => u.email === 'admin@zbyte.com.ng');
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          name: 'MR BIG FSH',
          email: 'admin@zbyte.com.ng',
          isAdmin: true,
          token: generateToken(),
          taskWallet: 0,
          referralWallet: 0,
          tier: 'gold'
        };
        data.users.push(user);
      }
      user.token = generateToken();
      db.writeDb(data);
      return send(res, 200, { token: user.token });
    }

    const user = data.users.find(u => u.email === (identifier || '').toLowerCase() || u.phone === identifier);
    if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      return send(res, 401, { error: 'Invalid credentials' });
    }
    user.token = generateToken();
    db.writeDb(data);
    return send(res, 200, { token: user.token });
  }

  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const { passwordHash, passwordSalt, token, ...safe } = user;
    return send(res, 200, safe);
  }

  if (pathname === '/api/tasks' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const data = db.readDb();
    return send(res, 200, data.tasks || []);
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log('Server running on port', PORT));
