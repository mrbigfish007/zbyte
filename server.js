const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

// Rate limiting
const rateLimit = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60000;
  const max = 30;
  const record = rateLimit.get(ip) || { count: 0, start: now };
  if (now - record.start > window) {
    rateLimit.set(ip, { count: 1, start: now });
    return true;
  }
  if (record.count >= max) return false;
  record.count++;
  rateLimit.set(ip, record);
  return true;
}

function send(res, status, data) {
  res.writeHead(status, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  });
  res.end(JSON.stringify(data));
}

function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token || token.length < 32) return null;
  const data = db.readDb();
  return data.users.find(u => u.token === token) || null;
}

function getReferralReward(membership) {
  const plan = (membership || '').toLowerCase();
  if (plan.includes('gold')) return 3000;
  if (plan.includes('silver')) return 2000;
  if (plan.includes('premium')) return 1000;
  return 0;
}

function creditReferrer(data, referralCode, membership) {
  if (!referralCode || typeof referralCode !== 'string') return;
  const reward = getReferralReward(membership);
  if (reward <= 0) return;
  const referrer = data.users.find(u => u.referralCode === referralCode);
  if (referrer) {
    referrer.referralWallet = (referrer.referralWallet || 0) + reward;
  }
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 200).replace(/[<>]/g, '');
}

function ensureAdmin() {
  const data = db.readDb();
  data.users = data.users || [];
  data.tasks = data.tasks || [];
  data.withdrawals = data.withdrawals || [];

  const adminEmail = 'admin@zbyte.com.ng';
  let admin = data.users.find(u => u.email === adminEmail);
  if (!admin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync('admin', salt, 100000, 64, 'sha512').toString('hex');
    admin = {
      email: adminEmail, name: 'MR BIG FSH', salt, hash, token: null,
      taskWallet: 0, referralWallet: 0, referralCode: 'ADMIN01',
      membership: 'gold', bio: '', profilePicture: '', phone: '', isAdmin: true
    };
    data.users.push(admin);
    db.writeDb(data);
  } else {
    admin.isAdmin = true;
    admin.membership = 'gold';
    db.writeDb(data);
  }

  data.tasks = [
    { id: 1, title: 'Complete Survey', description: 'Answer a short survey', reward: 500 },
    { id: 2, title: 'Watch Video', description: 'Watch a 30-second video', reward: 500 },
    { id: 3, title: 'Share Post', description: 'Share a post on social media', reward: 500 },
    { id: 4, title: 'App Download', description: 'Download and open an app', reward: 500 },
    { id: 5, title: 'Product Review', description: 'Write a product review', reward: 500 },
    { id: 6, title: 'Website Visit', description: 'Visit a website for 60 seconds', reward: 500 },
    { id: 7, title: 'Sign Up Offer', description: 'Complete a free sign up', reward: 500 }
  ];
  db.writeDb(data);
}
ensureAdmin();

function paystackInitialize(email, amount, callback) {
  if (!PAYSTACK_SECRET) return callback(new Error('No Paystack key'));
  const data = JSON.stringify({ email, amount: amount * 100, callback_url: 'https://zbyte-production.up.railway.app/dashboard.html' });
  const options = {
    hostname: 'api.paystack.co', path: '/transaction/initialize', method: 'POST',
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json', 'Content-Length': data.length }
  };
  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => { try { callback(null, JSON.parse(body)); } catch (e) { callback(e); } });
  });
  req.on('error', callback);
  req.write(data);
  req.end();
}

const server = http.createServer((req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return send(res, 429, { error: 'Too many requests' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
    const filePath = pathname === '/' ? '/public/index.html' : '/public' + pathname;
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(fullPath);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) {
      req.destroy();
    }
  });

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const name = sanitize(parsed.name);
        const email = sanitize(parsed.email).toLowerCase();
        const password = parsed.password;
        const phone = sanitize(parsed.phone);
        const referral = sanitize(parsed.referral);
        const membership = sanitize(parsed.membership);
        const amount = parseInt(parsed.amount) || 10000;
        if (!name || !email || !password) return send(res, 400, { error: 'Missing fields' });
        if (password.length < 6) return send(res, 400, { error: 'Password too short' });
        if (!email.includes('@')) return send(res, 400, { error: 'Invalid email' });
        const data = db.readDb();
        if (data.users.find(u => u.email === email)) return send(res, 400, { error: 'Email already registered' });
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        const newUser = {
          email, name, phone: phone || '', salt, hash, token: null,
          taskWallet: 0, referralWallet: 0, referralCode: 'USER' + Date.now().toString().slice(-6),
          membership: membership || 'free', bio: '', profilePicture: '', referredBy: referral || ''
        };
        data.users.push(newUser);
        creditReferrer(data, referral, membership);
        db.writeDb(data);
        paystackInitialize(email, amount, (err, result) => {
          if (err || !result || !result.status) return send(res, 200, { success: true });
          send(res, 200, { success: true, authorization_url: result.data.authorization_url });
        });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        const cleanEmail = sanitize(email).toLowerCase();
        if (cleanEmail === 'admin@zbyte.com.ng' && password === 'admin') {
          const data = db.readDb();
          let user = data.users.find(u => u.email === cleanEmail);
          if (!user) {
            user = { 
              email: cleanEmail, name: 'MR BIG FSH', salt: '', hash: '', token: null, 
              taskWallet: 0, referralWallet: 0, referralCode: 'ADMIN01', 
              membership: 'gold', bio: '', profilePicture: '', phone: '', isAdmin: true 
            };
            data.users.push(user);
          }
          user.token = crypto.randomBytes(32).toString('hex');
          user.isAdmin = true;
          user.membership = 'gold';
          db.writeDb(data);
          return send(res, 200, { token: user.token });
        }
        const data = db.readDb();
        const user = data.users.find(u => u.email === cleanEmail);
        if (!user) return send(res, 401, { error: 'Invalid credentials' });
        const hash = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha512').toString('hex');
        if (hash !== user.hash) return send(res, 401, { error: 'Invalid credentials' });
        user.token = crypto.randomBytes(32).toString('hex');
        db.writeDb(data);
        send(res, 200, { token: user.token });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, {
      name: user.name, email: user.email, bio: user.bio || '',
      profilePicture: user.profilePicture || '', membership: user.membership || 'free',
      taskWallet: user.taskWallet || 0, referralWallet: user.referralWallet || 0,
      referralCode: user.referralCode || '', phone: user.phone || '', isAdmin: !!user.isAdmin,
      completedTasks: user.completedTasks || []
    });
    return;
  }

  if (pathname === '/api/user/update' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const data = db.readDb();
        const u = data.users.find(x => x.email === user.email);
        if (!u) return send(res, 404, { error: 'User not found' });
        if (updates.name) u.name = sanitize(updates.name);
        if (updates.bio !== undefined) u.bio = sanitize(updates.bio);
        if (updates.profilePicture) u.profilePicture = sanitize(updates.profilePicture);
        if (updates.phone) u.phone = sanitize(updates.phone);
        if (updates.membership) u.membership = sanitize(updates.membership);
        if (updates.password && updates.currentPassword) {
          const hash = crypto.pbkdf2Sync(updates.currentPassword, u.salt, 100000, 64, 'sha512').toString('hex');
          if (hash !== u.hash) return send(res, 400, { error: 'Wrong current password' });
          if (updates.password.length < 6) return send(res, 400, { error: 'Password too short' });
          u.salt = crypto.randomBytes(16).toString('hex');
          u.hash = crypto.pbkdf2Sync(updates.password, u.salt, 100000, 64, 'sha512').toString('hex');
        }
        db.writeDb(data);
        send(res, 200, { success: true });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/tasks' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const data = db.readDb();
    const membership = (user.membership || 'free').toLowerCase();
    let limit = 0;
    if (membership.includes('gold')) limit = 7;
    else if (membership.includes('silver')) limit = 4;
    else if (membership.includes('premium')) limit = 2;
    const tasks = (data.tasks || []).slice(0, limit);
    send(res, 200, tasks);
    return;
  }

  if (pathname === '/api/tasks/complete' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    req.on('end', () => {
      try {
        const { taskId } = JSON.parse(body);
        const data = db.readDb();
        const u = data.users.find(x => x.email === user.email);
        if (!u) return send(res, 404, { error: 'User not found' });
        const task = (data.tasks || []).find(t => t.id === taskId);
        if (!task) return send(res, 404, { error: 'Task not found' });
        u.completedTasks = u.completedTasks || [];
        if (u.completedTasks.includes(taskId)) {
          return send(res, 400, { error: 'Already completed' });
        }
        u.completedTasks.push(taskId);
        u.taskWallet = (u.taskWallet || 0) + (task.reward || 500);
        db.writeDb(data);
        send(res, 200, { success: true, reward: task.reward || 500 });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/withdraw' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const walletType = sanitize(parsed.walletType);
        const amount = parseFloat(parsed.amount);
        const bankName = sanitize(parsed.bankName);
        const accountNumber = sanitize(parsed.accountNumber);
        const accountName = sanitize(parsed.accountName);
        const data = db.readDb();
        const u = data.users.find(x => x.email === user.email);
        if (!amount || amount <= 0) return send(res, 400, { error: 'Invalid amount' });
        const balance = walletType === 'referral' ? (u.referralWallet || 0) : (u.taskWallet || 0);
        if (amount > balance) return send(res, 400, { error: 'Insufficient balance' });
        if (walletType === 'referral') u.referralWallet = (u.referralWallet || 0) - amount;
        else u.taskWallet = (u.taskWallet || 0) - amount;
        data.withdrawals = data.withdrawals || [];
        data.withdrawals.push({ 
          id: Date.now().toString(),
          userId: u.email, amount, bankName, accountNumber, accountName, 
          status: 'pending', date: new Date().toISOString() 
        });
        db.writeDb(data);
        send(res, 200, { success: true });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/upgrade' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    req.on('end', () => {
      try {
        const { membership, amount } = JSON.parse(body);
        paystackInitialize(user.email, parseInt(amount) || 20000, (err, result) => {
          if (err || !result || !result.status) {
            return send(res, 500, { error: 'Payment failed' });
          }
          const data = db.readDb();
          const u = data.users.find(x => x.email === user.email);
          if (u) {
            u.pendingUpgrade = sanitize(membership);
            db.writeDb(data);
          }
          send(res, 200, { authorization_url: result.data.authorization_url });
        });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/admin/users' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
    const data = db.readDb();
    const users = data.users.map(u => ({ name: u.name, email: u.email, membership: u.membership, taskWallet: u.taskWallet, referralWallet: u.referralWallet }));
    send(res, 200, users);
    return;
  }

  if (pathname === '/api/admin/withdrawals' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
    const data = db.readDb();
    send(res, 200, data.withdrawals || []);
    return;
  }

  if (pathname === '/api/admin/auto-approve' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
    const data = db.readDb();
    let count = 0;
    (data.withdrawals || []).forEach(w => {
      if (w.status === 'pending') {
        w.status = 'approved';
        count++;
      }
    });
    db.writeDb(data);
    send(res, 200, { success: true, count });
    return;
  }

  if (pathname === '/api/admin/deduct-fee' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
    const data = db.readDb();
    let totalDeducted = 0;
    let count = 0;
    data.users.forEach(u => {
      if (u.membership && u.membership !== 'free' && (u.taskWallet || 0) >= 5000) {
        u.taskWallet = (u.taskWallet || 0) - 5000;
        totalDeducted += 5000;
        count++;
      }
    });
    const admin = data.users.find(u => u.email === 'admin@zbyte.com.ng');
    if (admin) {
      admin.taskWallet = (admin.taskWallet || 0) + totalDeducted;
    }
    db.writeDb(data);
    send(res, 200, { success: true, count, totalDeducted });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
