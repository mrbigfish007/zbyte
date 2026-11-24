const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

function send(res, status, data) {
  res.writeHead(status, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function getAuthUser(req) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7);
    if (!token || token.length < 20) return null;
    const data = db.readDb();
    return (data.users || []).find(u => u.token === token) || null;
  } catch (e) { return null; }
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 200).replace(/[<>]/g, '');
}

function getReferralReward(membership) {
  const plan = (membership || '').toLowerCase();
  if (plan.includes('gold')) return 3000;
  if (plan.includes('silver')) return 2000;
  if (plan.includes('premium')) return 1000;
  return 0;
}

function creditReferrer(data, referralCode, membership) {
  if (!referralCode) return;
  const reward = getReferralReward(membership);
  if (reward <= 0) return;
  const referrer = data.users.find(u => u.referralCode === referralCode);
  if (referrer) referrer.referralWallet = (referrer.referralWallet || 0) + reward;
}

function ensureAdmin() {
  try {
    const data = db.readDb() || {};
    data.users = data.users || [];
    data.tasks = data.tasks || [];
    data.withdrawals = data.withdrawals || [];
    const adminEmail = 'admin@zbyte.com.ng';
    let admin = data.users.find(u => u.email === adminEmail);
    if (!admin) {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync('admin', salt, 100000, 64, 'sha512').toString('hex');
      admin = { email: adminEmail, name: 'MR BIG FSH', salt, hash, token: null, taskWallet: 0, referralWallet: 0, referralCode: 'ADMIN01', membership: 'gold', bio: '', profilePicture: '', phone: '', isAdmin: true, paid: true };
      data.users.push(admin);
    } else {
      admin.isAdmin = true;
      admin.membership = 'gold';
      admin.paid = true;
    }
    if (!data.tasks.length) {
      data.tasks = [
        { id: 1, title: 'Complete Survey', description: 'Answer a short survey', reward: 500 },
        { id: 2, title: 'Watch Video', description: 'Watch a 30-second video', reward: 500 },
        { id: 3, title: 'Share Post', description: 'Share a post on social media', reward: 500 },
        { id: 4, title: 'App Download', description: 'Download and open an app', reward: 500 },
        { id: 5, title: 'Product Review', description: 'Write a product review', reward: 500 },
        { id: 6, title: 'Website Visit', description: 'Visit a website for 60 seconds', reward: 500 },
        { id: 7, title: 'Sign Up Offer', description: 'Complete a free sign up', reward: 500 }
      ];
    }
    db.writeDb(data);
  } catch (e) { console.error(e); }
}
ensureAdmin();

function paystackInitialize(email, amount, callback) {
  if (!PAYSTACK_SECRET) return callback(new Error('No key'));
  const postData = JSON.stringify({ email, amount: Math.round(amount * 100), callback_url: 'https://zbyte-production.up.railway.app/dashboard.html' });
  const options = {
    hostname: 'api.paystack.co', path: '/transaction/initialize', method: 'POST',
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
  };
  const r = https.request(options, (res) => {
    let b = '';
    res.on('data', c => b += c);
    res.on('end', () => { try { callback(null, JSON.parse(b)); } catch (e) { callback(e); } });
  });
  r.on('error', callback);
  r.write(postData);
  r.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
    return res.end();
  }

  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/' || pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
    const fullPath = path.join(__dirname, pathname === '/' ? '/public/index.html' : '/public' + pathname);
    if (fs.existsSync(fullPath)) {
      const ext = path.extname(fullPath);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      return fs.createReadStream(fullPath).pipe(res);
    }
  }

  try {
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const p = await getBody(req);
      const name = sanitize(p.name), email = sanitize(p.email).toLowerCase(), password = p.password;
      if (!name || !email || !password) return send(res, 400, { error: 'Missing fields' });
      const data = db.readDb();
      if (data.users.find(u => u.email === email)) return send(res, 400, { error: 'Email already registered' });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      data.users.push({
        email, name, phone: sanitize(p.phone), salt, hash, token: null,
        taskWallet: 0, referralWallet: 0, referralCode: 'USER' + Date.now().toString().slice(-6),
        membership: sanitize(p.membership) || 'free', bio: '', profilePicture: '', referredBy: sanitize(p.referral), paid: false
      });
      db.writeDb(data);
      const amount = parseInt(p.amount) || 10000;
      return paystackInitialize(email, amount, (err, result) => {
        if (err || !result || !result.status) return send(res, 200, { success: true });
        send(res, 200, { success: true, authorization_url: result.data.authorization_url });
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const p = await getBody(req);
      const email = sanitize(p.email).toLowerCase(), password = p.password;
      if (email === 'admin@zbyte.com.ng' && password === 'admin') {
        const data = db.readDb();
        let user = data.users.find(u => u.email === email);
        if (!user) {
          user = { email, name: 'MR BIG FSH', salt: '', hash: '', token: null, taskWallet: 0, referralWallet: 0, referralCode: 'ADMIN01', membership: 'gold', bio: '', profilePicture: '', phone: '', isAdmin: true, paid: true };
          data.users.push(user);
        }
        user.token = crypto.randomBytes(32).toString('hex');
        user.isAdmin = true;
        user.paid = true;
        db.writeDb(data);
        return send(res, 200, { token: user.token });
      }
      const data = db.readDb();
      const user = data.users.find(u => u.email === email);
      if (!user || !user.paid) return send(res, 401, { error: 'Invalid credentials or payment required' });
      const hash = crypto.pbkdf2Sync(password, user.salt || '', 100000, 64, 'sha512').toString('hex');
      if (hash !== user.hash) return send(res, 401, { error: 'Invalid credentials' });
      user.token = crypto.randomBytes(32).toString('hex');
      db.writeDb(data);
      return send(res, 200, { token: user.token });
    }

    if (pathname === '/api/user/me' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      return send(res, 200, {
        name: user.name, email: user.email, bio: user.bio || '', profilePicture: user.profilePicture || '',
        membership: user.membership || 'free', taskWallet: user.taskWallet || 0, referralWallet: user.referralWallet || 0,
        referralCode: user.referralCode || '', phone: user.phone || '', isAdmin: !!user.isAdmin, paid: !!user.paid
      });
    }

    if (pathname === '/api/user/update' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const updates = await getBody(req);
      const data = db.readDb();
      const u = data.users.find(x => x.email === user.email);
      if (!u) return send(res, 404, { error: 'Not found' });
      if (updates.name) u.name = sanitize(updates.name);
      if (updates.bio !== undefined) u.bio = sanitize(updates.bio);
      if (updates.profilePicture) u.profilePicture = sanitize(updates.profilePicture);
      if (updates.phone) u.phone = sanitize(updates.phone);
      if (updates.password && updates.currentPassword) {
        const hash = crypto.pbkdf2Sync(updates.currentPassword, u.salt, 100000, 64, 'sha512').toString('hex');
        if (hash !== u.hash) return send(res, 400, { error: 'Wrong password' });
        u.salt = crypto.randomBytes(16).toString('hex');
        u.hash = crypto.pbkdf2Sync(updates.password, u.salt, 100000, 64, 'sha512').toString('hex');
      }
      db.writeDb(data);
      return send(res, 200, { success: true });
    }

    if (pathname === '/api/tasks' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const data = db.readDb();
      const m = (user.membership || '').toLowerCase();
      const limit = m.includes('gold') ? 7 : m.includes('silver') ? 4 : m.includes('premium') ? 2 : 0;
      return send(res, 200, (data.tasks || []).slice(0, limit));
    }

    if (pathname === '/api/tasks/complete' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const p = await getBody(req);
      const data = db.readDb();
      const u = data.users.find(x => x.email === user.email);
      const task = (data.tasks || []).find(t => t.id === p.taskId);
      if (!u || !task) return send(res, 404, { error: 'Not found' });
      u.completedTasks = u.completedTasks || [];
      if (u.completedTasks.includes(p.taskId)) return send(res, 400, { error: 'Already done' });
      u.completedTasks.push(p.taskId);
      u.taskWallet = (u.taskWallet || 0) + (task.reward || 500);
      db.writeDb(data);
      return send(res, 200, { success: true });
    }

    if (pathname === '/api/withdraw' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const p = await getBody(req);
      const data = db.readDb();
      const u = data.users.find(x => x.email === user.email);
      const amount = parseFloat(p.amount);
      if (!u || !amount) return send(res, 400, { error: 'Invalid' });
      const bal = p.walletType === 'referral' ? (u.referralWallet || 0) : (u.taskWallet || 0);
      if (amount > bal) return send(res, 400, { error: 'Insufficient' });
      if (p.walletType === 'referral') u.referralWallet -= amount; else u.taskWallet -= amount;
      data.withdrawals = data.withdrawals || [];
      data.withdrawals.push({ id: Date.now().toString(), userId: u.email, amount, bankName: sanitize(p.bankName), accountNumber: sanitize(p.accountNumber), accountName: sanitize(p.accountName), status: 'pending', date: new Date().toISOString() });
      db.writeDb(data);
      return send(res, 200, { success: true });
    }

    if (pathname === '/api/upgrade' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user) return send(res, 401, { error: 'Unauthorized' });
      const p = await getBody(req);
      return paystackInitialize(user.email, parseInt(p.amount) || 20000, (err, result) => {
        if (err || !result || !result.status) return send(res, 500, { error: 'Failed' });
        const data = db.readDb();
        const u = data.users.find(x => x.email === user.email);
        if (u) { u.pendingUpgrade = sanitize(p.membership); db.writeDb(data); }
        send(res, 200, { authorization_url: result.data.authorization_url });
      });
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
      const data = db.readDb();
      return send(res, 200, (data.users || []).map(u => ({
        name: u.name, email: u.email, phone: u.phone || '', membership: u.membership,
        taskWallet: u.taskWallet || 0, referralWallet: u.referralWallet || 0, paid: !!u.paid, isAdmin: !!u.isAdmin
      })));
    }

    if (pathname === '/api/admin/withdrawals' && req.method === 'GET') {
      const user = getAuthUser(req);
      if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
      const data = db.readDb();
      return send(res, 200, data.withdrawals || []);
    }

    if (pathname === '/api/admin/auto-approve' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
      const data = db.readDb();
      let count = 0;
      (data.withdrawals || []).forEach(w => { if (w.status === 'pending') { w.status = 'approved'; count++; } });
      db.writeDb(data);
      return send(res, 200, { success: true, count });
    }

    if (pathname === '/api/admin/deduct-fee' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
      const data = db.readDb();
      let total = 0, count = 0;
      data.users.forEach(u => {
        if (u.membership && u.membership !== 'free' && (u.taskWallet || 0) >= 5000) {
          u.taskWallet -= 5000; total += 5000; count++;
        }
      });
      const admin = data.users.find(u => u.email === 'admin@zbyte.com.ng');
      if (admin) admin.taskWallet = (admin.taskWallet || 0) + total;
      db.writeDb(data);
      return send(res, 200, { success: true, count, total });
    }

    if (pathname === '/api/admin/delete-user' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
      const p = await getBody(req);
      const data = db.readDb();
      data.users = data.users.filter(u => u.email !== p.email || u.isAdmin);
      db.writeDb(data);
      return send(res, 200, { success: true });
    }

    if (pathname === '/api/admin/activate' && req.method === 'POST') {
      const user = getAuthUser(req);
      if (!user || !user.isAdmin) return send(res, 403, { error: 'Forbidden' });
      const p = await getBody(req);
      const data = db.readDb();
      const u = data.users.find(x => x.email === p.email);
      if (u) {
        u.paid = true;
        if (u.referredBy) creditReferrer(data, u.referredBy, u.membership);
        db.writeDb(data);
        return send(res, 200, { success: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => console.log('Server running on port ' + PORT));
