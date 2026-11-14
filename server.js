const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return verify === hash;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateReferralCode() {
  return 'ZB' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const data = db.readDb();
  return data.users.find(u => u.token === token) || null;
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Static files
  if (req.method === 'GET' && !pathname.startsWith('/api')) {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (pathname.startsWith('/admin')) {
      filePath = path.join(__dirname, 'admin', (pathname === '/admin' || pathname === '/admin/') ? 'index.html' : pathname.replace('/admin', ''));
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // API routes
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, email, phone, password, tier, referralCode } = body;
    if (!name || !email || !password || !tier) return send(res, 400, { error: 'Missing fields' });

    const data = db.readDb();
    if (data.users.find(u => u.email === email.toLowerCase())) {
      return send(res, 400, { error: 'Email already registered' });
    }

    const { hash, salt } = hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      name,
      email: email.toLowerCase(),
      phone: phone || '',
      passwordHash: hash,
      passwordSalt: salt,
      tier: tier.toLowerCase(),
      referralCode: generateReferralCode(),
      referredBy: referralCode || null,
      taskWallet: 0,
      referralWallet: 0,
      tasksCompleted: 0,
      isAdmin: false,
      active: false,
      token: generateToken(),
      createdAt: new Date().toISOString()
    };
    data.users.push(user);
    db.writeDb(data);

    const amount = tier === 'gold' ? 30000 : tier === 'silver' ? 20000 : 10000;
    const reference = 'ZB_' + Date.now() + '_' + user.id.slice(0, 8);

    const payload = JSON.stringify({
      email: user.email,
      amount: amount * 100,
      reference,
      callback_url: `https://\( {req.headers.host}/pay.html?ref= \){reference}`,
      metadata: { userId: user.id, tier }
    });

    const options = {
      hostname: 'api.paystack.co',
      path: '/transaction/initialize',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const paystackReq = https.request(options, (paystackRes) => {
      let data = '';
      paystackRes.on('data', chunk => data += chunk);
      paystackRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.status && result.data.authorization_url) {
            send(res, 200, { paymentUrl: result.data.authorization_url, reference });
          } else {
            send(res, 400, { error: result.message || 'Payment initialization failed' });
          }
        } catch {
          send(res, 500, { error: 'Payment error' });
        }
      });
    });
    paystackReq.on('error', () => send(res, 500, { error: 'Payment connection error' }));
    paystackReq.write(payload);
    paystackReq.end();
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const { identifier, password } = body;
    if (!identifier || !password) return send(res, 400, { error: 'Missing credentials' });

    const data = db.readDb();
    const user = data.users.find(u => 
      u.email === identifier.toLowerCase() || u.phone === identifier
    );
    if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      return send(res, 401, { error: 'Invalid credentials' });
    }

    user.token = generateToken();
    db.writeDb(data);
    send(res, 200, { token: user.token, user: { name: user.name, email: user.email, isAdmin: user.isAdmin } });
    return;
  }

  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const { passwordHash, passwordSalt, ...safeUser } = user;
    send(res, 200, safeUser);
    return;
  }

  // NEW: Update user profile
  if (pathname === '/api/user/update' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });

    const body = await parseBody(req);
    const data = db.readDb();
    const dbUser = data.users.find(u => u.id === user.id);
    if (!dbUser) return send(res, 404, { error: 'User not found' });

    if (body.name) {
      dbUser.name = body.name.trim();
    }

    if (body.password && body.currentPassword) {
      if (!verifyPassword(body.currentPassword, dbUser.passwordHash, dbUser.passwordSalt)) {
        return send(res, 400, { error: 'Current password is incorrect' });
      }
      const { hash, salt } = hashPassword(body.password);
      dbUser.passwordHash = hash;
      dbUser.passwordSalt = salt;
    }

    db.writeDb(data);
    send(res, 200, { success: true, message: 'Profile updated' });
    return;
  }

  if (pathname === '/api/tasks' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const data = db.readDb();
    send(res, 200, data.tasks || []);
    return;
  }

  if (pathname === '/api/tasks/complete' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req);
    const data = db.readDb();
    const dbUser = data.users.find(u => u.id === user.id);
    const task = (data.tasks || []).find(t => t.id === body.taskId);
    if (!task) return send(res, 404, { error: 'Task not found' });

    dbUser.taskWallet = (dbUser.taskWallet || 0) + (task.reward || 500);
    dbUser.tasksCompleted = (dbUser.tasksCompleted || 0) + 1;
    db.writeDb(data);
    send(res, 200, { success: true, reward: task.reward || 500 });
    return;
  }

  if (pathname === '/api/withdraw' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req);
    const result = db.createWithdrawal(user.id, body);
    if (result.error) return send(res, 400, result);
    send(res, 200, result);
    return;
  }

  // Admin routes
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
    const data = db.readDb();
    const users = data.users.map(({ passwordHash, passwordSalt, token, ...u }) => u);
    send(res, 200, users);
    return;
  }

  if (pathname === '/api/admin/run-monthly-fees' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
    const result = db.runMonthlyFees();
    send(res, 200, result);
    return;
  }

  send(res, 404, { error: 'Not found' });
});

// Ensure admin exists
db.ensureAdmin();

server.listen(PORT, () => {
  console.log(`Zbyte server running on port ${PORT}`);
});
