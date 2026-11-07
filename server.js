/**
 * Zbyte Full Backend Server - Paystack Integrated
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const https = require('https');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zbyte-secret-key-change-me';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'zbyte-salt-v1').digest('hex');
}

function createToken(user) {
  const payload = JSON.stringify({
    id: user.id,
    email: user.email,
    isAdmin: user.isAdmin || false,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return Buffer.from(payload).toString('base64');
}

function verifyToken(token) {
  try {
    const data = JSON.parse(Buffer.from(token, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function getAuthUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const data = verifyToken(token);
  if (!data) return null;
  return db.getUserById(data.id);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function paystackRequest(method, apiPath, data) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path: apiPath,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + PAYSTACK_SECRET_KEY,
        'Content-Type': 'application/json'
      }
    };
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 200, {});
  }

  // Static files
  if (req.method === 'GET' && !pathname.startsWith('/api')) {
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (pathname.startsWith('/admin')) {
      filePath = path.join(__dirname, 'admin', pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.replace('/admin', ''));
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  }

  // ========== AUTH ==========
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const { name, email, phone, password, tier, referralCode } = body;
    if (!name || !email || !password || !tier) return send(res, 400, { error: 'Missing fields' });

    if (db.getUserByEmail(email)) return send(res, 400, { error: 'Email already registered' });

    const tiers = { premium: 10000, silver: 20000, gold: 30000 };
    const amount = tiers[tier.toLowerCase()];
    if (!amount) return send(res, 400, { error: 'Invalid tier' });

    const user = db.createUser({
      name,
      email,
      phone: phone || '',
      password: hashPassword(password),
      tier: tier.toLowerCase(),
      isAdmin: false,
      membershipActive: false,
      taskWallet: 0,
      referralWallet: 0,
      tasksCompleted: 0,
      referralCode: Math.random().toString(36).substring(2, 8).toUpperCase()
    });

    // Handle referral
    if (referralCode) {
      const referrer = db.getUserByReferralCode(referralCode);
      if (referrer) {
        db.addReferral(referrer.id, user.id);
      }
    }

    // Initialize Paystack payment
    try {
      const paystackRes = await paystackRequest('POST', '/transaction/initialize', {
        email: email,
        amount: amount * 100, // Paystack uses kobo
        callback_url: `https://zbyte-production.up.railway.app/api/payment/callback?userId=\( {user.id}&tier= \){tier}`,
        metadata: {
          userId: user.id,
          tier: tier,
          name: name
        }
      });

      if (paystackRes.status && paystackRes.data) {
        return send(res, 200, {
          success: true,
          user: { id: user.id, name: user.name, email: user.email },
          paymentUrl: paystackRes.data.authorization_url,
          reference: paystackRes.data.reference
        });
      } else {
        return send(res, 400, { error: 'Could not initialize payment', details: paystackRes.message });
      }
    } catch (err) {
      return send(res, 500, { error: 'Payment initialization failed', details: err.message });
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const user = db.getUserByEmail(body.email);
    if (!user || user.password !== hashPassword(body.password)) {
      return send(res, 401, { error: 'Invalid email or password' });
    }
    const token = createToken(user);
    return send(res, 200, {
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        isAdmin: user.isAdmin,
        membershipActive: user.membershipActive,
        taskWallet: user.taskWallet,
        referralWallet: user.referralWallet,
        tasksCompleted: user.tasksCompleted,
        referralCode: user.referralCode
      }
    });
  }

  // ========== PAYMENT CALLBACK ==========
  if (pathname === '/api/payment/callback' && req.method === 'GET') {
    const { reference, userId, tier } = parsed.query;
    if (!reference) return send(res, 400, { error: 'No reference' });

    try {
      const verify = await paystackRequest('GET', `/transaction/verify/${reference}`);
      if (verify.status && verify.data.status === 'success') {
        const user = db.getUserById(userId);
        if (user) {
          db.updateUser(userId, {
            membershipActive: true,
            tier: (tier || user.tier).toLowerCase()
          });

          // Credit referrer if any
          const referral = db.getReferralByNewUser(userId);
          if (referral) {
            const bonuses = { premium: 1000, silver: 2000, gold: 3000 };
            const bonus = bonuses[user.tier] || 1000;
            db.addToWallet(referral.referrerId, 'referral', bonus);
          }
        }
        // Redirect to dashboard
        res.writeHead(302, { Location: '/dashboard.html?paid=1' });
        return res.end();
      }
    } catch (e) {}
    res.writeHead(302, { Location: '/pay.html?error=1' });
    return res.end();
  }

  // ========== USER ==========
  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    return send(res, 200, {
      id: user.id,
      name: user.name,
      email: user.email,
      tier: user.tier,
      isAdmin: user.isAdmin,
      membershipActive: user.membershipActive,
      taskWallet: user.taskWallet,
      referralWallet: user.referralWallet,
      tasksCompleted: user.tasksCompleted,
      referralCode: user.referralCode
    });
  }

  // ========== TASKS ==========
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const tasks = db.getTasks();
    return send(res, 200, tasks);
  }

  if (pathname === '/api/tasks/complete' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    if (!user.membershipActive) return send(res, 403, { error: 'Membership not active' });

    const body = await parseBody(req);
    const result = db.completeTask(user.id, body.taskId);
    if (!result.success) return send(res, 400, { error: result.message });
    return send(res, 200, result);
  }

  // ========== ADMIN ==========
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Admin only' });
    const users = db.getAllUsers();
    return send(res, 200, users);
  }

  if (pathname === '/api/admin/stats' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Admin only' });
    return send(res, 200, db.getStats());
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log('Zbyte server running on port ' + PORT);
  // Seed default admin if not exists
  if (!db.getUserByEmail('admin@zbyte.com.ng')) {
    db.createUser({
      name: 'MR BIG FSH',
      email: 'admin@zbyte.com.ng',
      phone: '',
      password: hashPassword('admin'),
      tier: 'gold',
      isAdmin: true,
      membershipActive: true,
      taskWallet: 0,
      referralWallet: 0,
      tasksCompleted: 0,
      referralCode: 'ADMIN01'
    });
    console.log('Default admin created: admin@zbyte.com.ng / admin');
  }
});
