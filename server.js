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

function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const data = db.readDb();
  return data.users.find(u => u.token === token) || null;
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

  if (data.tasks.length === 0) {
    data.tasks = [
      { id: 1, title: 'Complete Survey', description: 'Answer a short survey', reward: 500 },
      { id: 2, title: 'Watch Video', description: 'Watch a 30-second video', reward: 500 },
      { id: 3, title: 'Share Post', description: 'Share a post on social media', reward: 500 }
    ];
    db.writeDb(data);
  }
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
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, email, password, phone, referral, membership, amount } = JSON.parse(body);
        if (!name || !email || !password) return send(res, 400, { error: 'Missing fields' });
        const data = db.readDb();
        if (data.users.find(u => u.email === email)) return send(res, 400, { error: 'Email already registered' });
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        data.users.push({
          email, name, phone: phone || '', salt, hash, token: null,
          taskWallet: 0, referralWallet: 0, referralCode: 'USER' + Date.now().toString().slice(-6),
          membership: membership || 'free', bio: '', profilePicture: '', referredBy: referral || ''
        });
        db.writeDb(data);
        paystackInitialize(email, parseInt(amount) || 10000, (err, result) => {
          if (err || !result || !result.status) return send(res, 200, { success: true });
          send(res, 200, { success: true, authorization_url: result.data.authorization_url });
        });
      } catch (e) { send(res, 500, { error: 'Server error' }); }
    });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        if (email === 'admin@zbyte.com.ng' && password === 'admin') {
          const data = db.readDb();
          let user = data.users.find(u => u.email === email);
          if (!user) {
            user = { 
              email, name: 'MR BIG FSH', salt: '', hash: '', token: null, 
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
        const user = data.users.find(u => u.email === email);
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
      referralCode: user.referralCode || '', phone: user.phone || '', isAdmin: !!user.isAdmin
    });
    return;
  }

  if (pathname === '/api/user/update' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const data = db.readDb();
        const u = data.users.find(x => x.email === user.email);
        if (!u) return send(res, 404, { error: 'User not found' });
        if (updates.name) u.name = updates.name;
        if (updates.bio !== undefined) u.bio = updates.bio;
        if (updates.profilePicture) u.profilePicture = updates.profilePicture;
        if (updates.phone) u.phone = updates.phone;
        if (updates.membership) u.membership = updates.membership;
        if (updates.password && updates.currentPassword) {
          const hash = crypto.pbkdf2Sync(updates.currentPassword, u.salt, 100000, 64, 'sha512').toString('hex');
          if (hash !== u.hash) return send(res, 400, { error: 'Wrong current password' });
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
    send(res, 200, data.tasks || []);
    return;
  }

  if (pathname === '/api/tasks/complete' && req.method === 'POST') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    let body = '';
    req.on('data', chunk => body += chunk);
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { walletType, amount, bankName, accountNumber, accountName } = JSON.parse(body);
        const data = db.readDb();
        const u = data.users.find(x => x.email === user.email);
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) return send(res, 400, { error: 'Invalid amount' });
        const balance = walletType === 'referral' ? (u.referralWallet || 0) : (u.taskWallet || 0);
        if (amt > balance) return send(res, 400, { error: 'Insufficient balance' });
        if (walletType === 'referral') u.referralWallet = (u.referralWallet || 0) - amt;
        else u.taskWallet = (u.taskWallet || 0) - amt;
        data.withdrawals = data.withdrawals || [];
        data.withdrawals.push({ 
          id: Date.now().toString(),
          userId: u.email, amount: amt, bankName, accountNumber, accountName, 
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
    let body = '';
    req.on('data', chunk => body += chunk);
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
            u.pendingUpgrade = membership;
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
