const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const data = db.readDb();
  return data.users.find(u => u.token === token) || null;
}

// Ensure admin exists
function ensureAdmin() {
  const data = db.readDb();
  const adminEmail = 'admin@zbyte.com.ng';
  if (!data.users.find(u => u.email === adminEmail)) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync('admin', salt, 100000, 64, 'sha512').toString('hex');
    data.users.push({
      email: adminEmail,
      name: 'MR BIG FSH',
      salt,
      hash,
      token: null,
      taskWallet: 0,
      referralWallet: 0,
      referralCode: 'ADMIN01',
      membership: 'premium',
      bio: '',
      profilePicture: ''
    });
    db.writeDb(data);
  }
}
ensureAdmin();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end();
    return;
  }

  // Static files
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

  // Register
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, email, password, phone } = JSON.parse(body);
        if (!email || !password) return send(res, 400, { error: 'Email and password required' });
        const data = db.readDb();
        if (data.users.find(u => u.email === email)) return send(res, 400, { error: 'Email already registered' });
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        data.users.push({
          email,
          name: name || 'User',
          phone: phone || '',
          salt,
          hash,
          token: null,
          taskWallet: 0,
          referralWallet: 0,
          referralCode: 'USER' + Date.now().toString().slice(-6),
          membership: 'free',
          bio: '',
          profilePicture: ''
        });
        db.writeDb(data);
        send(res, 200, { success: true, message: 'Registered. Please pay to activate.' });
      } catch (e) {
        send(res, 500, { error: 'Server error' });
      }
    });
    return;
  }

  // Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        const data = db.readDb();
        const user = data.users.find(u => u.email === email);
        if (!user) return send(res, 401, { error: 'Invalid credentials' });
        const hash = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha512').toString('hex');
        if (hash !== user.hash) return send(res, 401, { error: 'Invalid credentials' });
        user.token = crypto.randomBytes(32).toString('hex');
        db.writeDb(data);
        send(res, 200, { token: user.token, user: { name: user.name, email: user.email } });
      } catch (e) {
        send(res, 500, { error: 'Server error' });
      }
    });
    return;
  }

  // Get current user
  if (pathname === '/api/user/me' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, {
      name: user.name,
      email: user.email,
      bio: user.bio || '',
      profilePicture: user.profilePicture || '',
      membership: user.membership || 'free',
      taskWallet: user.taskWallet || 0,
      referralWallet: user.referralWallet || 0,
      referralCode: user.referralCode || 'ADMIN01',
      phone: user.phone || ''
    });
    return;
  }

  // Update user
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
      } catch (e) {
        send(res, 500, { error: 'Server error' });
      }
    });
    return;
  }

  // Tasks
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const user = getAuthUser(req);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    const data = db.readDb();
    send(res, 200, data.tasks || []);
    return;
  }

  // Withdraw
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
        const balance = walletType === 'referral' ? (u.referralWallet || 0) : (u.taskWallet || 0);
        if (amt > balance) return send(res, 400, { error: 'Insufficient balance' });
        if (walletType === 'referral') u.referralWallet = (u.referralWallet || 0) - amt;
        else u.taskWallet = (u.taskWallet || 0) - amt;
        data.withdrawals = data.withdrawals || [];
        data.withdrawals.push({ userId: u.email, amount: amt, bankName, accountNumber, accountName, date: new Date().toISOString() });
        db.writeDb(data);
        send(res, 200, { success: true });
      } catch (e) {
        send(res, 500, { error: 'Server error' });
      }
    });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
