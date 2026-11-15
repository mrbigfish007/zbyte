const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  try {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
  } catch { return false; }
}

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateReferralCode() { return 'ZB' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

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
  try {
    const data = db.readDb();
    return data.users.find(u => u.token === token) || null;
  } catch { return null; }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
  } catch (e) {}
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

    // LOGIN
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const { identifier, password } = await parseBody(req);
      const data = db.readDb();

      if ((identifier === 'admin@zbyte.com.ng' || identifier === 'admin') && password === 'admin') {
        let user = data.users.find(u => u.email === 'admin@zbyte.com.ng' || u.isAdmin);
        if (!user) {
          const { hash, salt } = hashPassword('admin');
          user = {
            id: crypto.randomUUID(),
            name: 'MR BIG FSH',
            email: 'admin@zbyte.com.ng',
            passwordHash: hash,
            passwordSalt: salt,
            isAdmin: true,
            token: generateToken(),
            taskWallet: 0,
            referralWallet: 0,
            tier: 'gold',
            referralCode: 'ADMIN01',
            phone: '',
            bio: ''
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

    // REGISTER
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
        isAdmin: false,
        active: false,
        token: generateToken(),
        bio: ''
      };
      data.users.push(user);
      db.writeDb(data);

      if (!PAYSTACK_SECRET_KEY) {
        return send(res, 200, { message: 'Account created' });
      }

      const amount = tier === 'gold' ? 30000 : tier === 'silver' ? 20000 : 10000;
      const reference = 'ZB_' + Date.now();

      const payload = JSON.stringify({
        email: user.email,
        amount: amount * 100,
        reference,
        callback_url: `https://${req.headers.host}/pay.html`,
        metadata: { userId: user.id }
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
        let raw = '';
        paystackRes.on('data', chunk => raw += chunk);
        paystackRes.on('end', () => {
          try {
            const result = JSON.parse(raw);
            if (result.status && result.data.authorization_url) {
              send(res, 200, { paymentUrl: result.data.authorization_url });
            } else {
              send(res, 400, { error: result.message || 'Payment failed' });
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

    // GET USER
    if (pathname === '/api/user/me' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const { passwordHash, passwordSalt, token, ...safe } = user;
      return send(res, 200, safe);
    }

    // UPDATE USER
    if (pathname === '/api/user/update' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const data = db.readDb();
      const dbUser = data.users.find(u => u.id === user.id);
      if (!dbUser) return send(res, 404, { error: 'User not found' });

      if (body.name) dbUser.name = body.name.trim();
      if (body.phone !== undefined) dbUser.phone = body.phone.trim();
      if (body.bio !== undefined) dbUser.bio = body.bio;
      if (body.notifications) dbUser.notifications = body.notifications;

      if (body.password && body.currentPassword) {
        if (!verifyPassword(body.currentPassword, dbUser.passwordHash, dbUser.passwordSalt)) {
          return send(res, 400, { error: 'Current password is incorrect' });
        }
        const { hash, salt } = hashPassword(body.password);
        dbUser.passwordHash = hash;
        dbUser.passwordSalt = salt;
      }

      db.writeDb(data);
      return send(res, 200, { success: true });
    }

    // TASKS
    if (pathname === '/api/tasks' && req.method === 'GET') {
      ensureDefaultTasks();
      const data = db.readDb();
      return send(res, 200, data.tasks || []);
    }

    // WITHDRAWAL
    if (pathname === '/api/withdraw' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const body = await parseBody(req);
      const { walletType, amount, bankName, accountNumber, accountName } = body;

      if (!amount || !bankName || !accountNumber || !accountName) {
        return send(res, 400, { error: 'Missing withdrawal details' });
      }

      const data = db.readDb();
      if (!data.withdrawals) data.withdrawals = [];
      data.withdrawals.push({
        id: crypto.randomUUID(),
        userId: user.id,
        walletType,
        amount: Number(amount),
        bankName,
        accountNumber,
        accountName,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      db.writeDb(data);

      return send(res, 200, { success: true, message: 'Withdrawal request submitted' });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
  ensureDefaultTasks();
});
