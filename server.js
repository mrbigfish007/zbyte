/**
 * Zbyte Full Backend Server
 * -------------------------
 * Pure Node.js (no extra packages required).
 * Run: node server.js
 * Then open http://localhost:3000
 *
 * Production upgrades:
 * - Replace lib/db.js with Prisma + PostgreSQL
 * - Add real Paystack secret key in env
 * - Put behind HTTPS + proper session/JWT library
 * - Add rate limiting, input sanitization, audit logs
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zbyte-dev-secret-change-me-in-production';

// ---------- Helpers ----------
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function createToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data.userId;
  } catch { return null; }
}

function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const userId = verifyToken(token);
  if (!userId) return null;
  const data = db.read();
  return data.users.find(u => u.id === userId) || null;
}

function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    send(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    send(res, 403, { error: 'Admin only' });
    return null;
  }
  return user;
}

// ---------- Static file server ----------
function serveStatic(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- API Routes ----------
async function handleApi(req, res, pathname) {
  const method = req.method;
  const data = db.read();

  // CORS preflight
  if (method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  // ---- Auth ----
  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await parseBody(req);
    const { fullName, email, phone, password, tier, referralCode } = body;
    if (!fullName || !email || !phone || !password || !tier) {
      return send(res, 400, { error: 'Missing required fields' });
    }
    if (!['premium', 'silver', 'gold'].includes(tier)) {
      return send(res, 400, { error: 'Invalid tier' });
    }
    if (data.users.find(u => u.email === email || u.phone === phone)) {
      return send(res, 409, { error: 'Email or phone already registered' });
    }

    const settings = data.settings;
    const price = settings.membershipPrices[tier];
    const userId = db.uuid();
    const myCode = db.generateReferralCode();

    // Find referrer
    let referredBy = null;
    if (referralCode) {
      const ref = data.users.find(u => u.referralCode === referralCode.toUpperCase());
      if (ref) referredBy = ref.id;
    }

    const user = {
      id: userId,
      fullName,
      email: email.toLowerCase(),
      phone,
      passwordHash: db.hashPassword(password),
      referralCode: myCode,
      referredBy,
      tier: null,                // set after successful payment
      membershipPaidAt: null,
      role: data.users.length === 0 ? 'admin' : 'user', // first user is admin
      taskBalance: 0,
      referralBalance: 0,
      tasksCompleted: 0,
      feePending: false,
      feeOwed: 0,
      kycStatus: 'none',
      isActive: true,
      createdAt: new Date().toISOString()
    };

    data.users.push(user);

    // Create pending membership payment transaction
    const txId = db.uuid();
    data.transactions.push({
      id: txId,
      userId,
      type: 'membership_payment',
      amount: price,
      status: 'pending',
      tier,
      reference: 'ZB-MEM-' + Date.now(),
      createdAt: new Date().toISOString()
    });

    db.write(data);

    // In production: call Paystack initialize here and return authorization_url
    // For now we return a mock payment URL that the frontend will "complete"
    return send(res, 201, {
      message: 'Account created. Complete payment to activate membership.',
      userId,
      payment: {
        amount: price,
        reference: 'ZB-MEM-' + Date.now(),
        // Real Paystack would return authorization_url
        mockPayUrl: `/pay.html?ref=${txId}&amount=${price}&tier=${tier}`
      },
      token: createToken(userId)
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await parseBody(req);
    const { identifier, password } = body;
    const user = data.users.find(u =>
      u.email === (identifier || '').toLowerCase() || u.phone === identifier
    );
    if (!user || user.passwordHash !== db.hashPassword(password || '')) {
      return send(res, 401, { error: 'Invalid credentials' });
    }
    return send(res, 200, {
      token: createToken(user.id),
      user: publicUser(user)
    });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    return send(res, 200, { user: publicUser(user) });
  }

  // ---- Payment (mock + Paystack-ready) ----
  if (pathname === '/api/payments/confirm' && method === 'POST') {
    // This endpoint is called after mock payment or after Paystack webhook
    const body = await parseBody(req);
    const { reference, userId } = body;
    const user = data.users.find(u => u.id === userId);
    if (!user) return send(res, 404, { error: 'User not found' });

    const tx = data.transactions.find(t => t.id === reference || t.reference === reference);
    if (!tx || tx.status === 'completed') {
      return send(res, 400, { error: 'Invalid or already completed payment' });
    }

    // Activate membership
    user.tier = tx.tier;
    user.membershipPaidAt = new Date().toISOString();
    tx.status = 'completed';
    tx.completedAt = new Date().toISOString();

    // Pay referral commission if any
    if (user.referredBy) {
      const referrer = data.users.find(u => u.id === user.referredBy);
      if (referrer) {
        const commission = data.settings.referralCommissions[tx.tier] || 0;
        referrer.referralBalance = (referrer.referralBalance || 0) + commission;
        data.referrals.push({
          id: db.uuid(),
          referrerId: referrer.id,
          referredUserId: user.id,
          tier: tx.tier,
          commission,
          status: 'paid',
          paidAt: new Date().toISOString(),
          createdAt: new Date().toISOString()
        });
        data.transactions.push({
          id: db.uuid(),
          userId: referrer.id,
          type: 'referral_commission',
          amount: commission,
          status: 'completed',
          description: `Commission for ${tx.tier} referral`,
          createdAt: new Date().toISOString()
        });
      }
    }

    db.write(data);
    return send(res, 200, { message: 'Payment confirmed. Membership activated.', user: publicUser(user) });
  }

  // ---- Dashboard data ----
  if (pathname === '/api/dashboard' && method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    const settings = data.settings;
    const limit = user.tier ? settings.taskLimits[user.tier] : 0;
    const myUserTasks = data.userTasks.filter(ut => ut.userId === user.id);
    const availableTasks = data.tasks.filter(t => t.active).slice(0, limit);

    return send(res, 200, {
      user: publicUser(user),
      settings: {
        monthlyFee: settings.monthlyFee,
        withdrawalMinTask: settings.withdrawalMinTask,
        withdrawalMinReferral: settings.withdrawalMinReferral
      },
      tasks: availableTasks.map(t => {
        const ut = myUserTasks.find(x => x.taskId === t.id);
        return { ...t, status: ut ? ut.status : 'available' };
      }),
      referralsCount: data.referrals.filter(r => r.referrerId === user.id).length
    });
  }

  // ---- Complete a task ----
  if (pathname === '/api/tasks/complete' && method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.feePending) return send(res, 403, { error: 'Account restricted: monthly fee pending' });
    if (!user.tier) return send(res, 403, { error: 'No active membership' });

    const body = await parseBody(req);
    const { taskId, proof } = body;
    const task = data.tasks.find(t => t.id === taskId && t.active);
    if (!task) return send(res, 404, { error: 'Task not found' });

    const limit = data.settings.taskLimits[user.tier];
    const completedCount = data.userTasks.filter(ut => ut.userId === user.id && ut.status === 'approved').length;
    if (completedCount >= limit) {
      return send(res, 400, { error: 'You have reached your task limit for this membership' });
    }
    if (data.userTasks.find(ut => ut.userId === user.id && ut.taskId === taskId && ut.status !== 'rejected')) {
      return send(res, 400, { error: 'Task already submitted' });
    }

    // Auto-approve for prototype speed (in production: status = 'submitted' and admin reviews)
    const ut = {
      id: db.uuid(),
      userId: user.id,
      taskId,
      status: 'approved',
      proof: proof || null,
      submittedAt: new Date().toISOString(),
      reviewedAt: new Date().toISOString()
    };
    data.userTasks.push(ut);

    user.taskBalance = (user.taskBalance || 0) + task.reward;
    user.tasksCompleted = (user.tasksCompleted || 0) + 1;

    data.transactions.push({
      id: db.uuid(),
      userId: user.id,
      type: 'task_reward',
      amount: task.reward,
      status: 'completed',
      description: `Reward for task: ${task.title}`,
      createdAt: new Date().toISOString()
    });

    db.write(data);
    return send(res, 200, { message: 'Task approved', reward: task.reward, newBalance: user.taskBalance });
  }

  // ---- Withdraw ----
  if (pathname === '/api/withdrawals' && method === 'POST') {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.feePending) return send(res, 403, { error: 'Withdrawals blocked while fee is pending' });

    const body = await parseBody(req);
    const { walletType, amount, bankName, accountNumber, accountName } = body;
    if (!['task', 'referral'].includes(walletType)) {
      return send(res, 400, { error: 'Invalid wallet type' });
    }
    const min = walletType === 'task' ? data.settings.withdrawalMinTask : data.settings.withdrawalMinReferral;
    const balance = walletType === 'task' ? user.taskBalance : user.referralBalance;
    const withdrawAmount = amount || balance;

    if (withdrawAmount < min) {
      return send(res, 400, { error: `Minimum withdrawal is ₦${min.toLocaleString()}` });
    }
    if (withdrawAmount > balance) {
      return send(res, 400, { error: 'Insufficient balance' });
    }
    if (!bankName || !accountNumber || !accountName) {
      return send(res, 400, { error: 'Bank details required' });
    }

    // Deduct immediately (in production you may hold until admin approves)
    if (walletType === 'task') user.taskBalance -= withdrawAmount;
    else user.referralBalance -= withdrawAmount;

    const w = {
      id: db.uuid(),
      userId: user.id,
      walletType,
      amount: withdrawAmount,
      bankName,
      accountNumber,
      accountName,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    data.withdrawals.push(w);
    data.transactions.push({
      id: db.uuid(),
      userId: user.id,
      type: 'withdrawal',
      amount: -withdrawAmount,
      status: 'pending',
      description: `Withdrawal from ${walletType} wallet`,
      createdAt: new Date().toISOString()
    });

    db.write(data);
    return send(res, 201, { message: 'Withdrawal request submitted', withdrawal: w });
  }

  // ---- Admin routes ----
  if (pathname === '/api/admin/stats' && method === 'GET') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    return send(res, 200, {
      totalUsers: data.users.length,
      activeMemberships: data.users.filter(u => u.tier).length,
      pendingWithdrawals: data.withdrawals.filter(w => w.status === 'pending').length,
      totalTaskPaid: data.transactions.filter(t => t.type === 'task_reward' && t.status === 'completed').reduce((s, t) => s + t.amount, 0),
      totalReferralPaid: data.transactions.filter(t => t.type === 'referral_commission' && t.status === 'completed').reduce((s, t) => s + t.amount, 0)
    });
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    return send(res, 200, { users: data.users.map(publicUser) });
  }

  if (pathname === '/api/admin/withdrawals' && method === 'GET') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    return send(res, 200, { withdrawals: data.withdrawals });
  }

  if (pathname.startsWith('/api/admin/withdrawals/') && method === 'PATCH') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const id = pathname.split('/').pop();
    const body = await parseBody(req);
    const w = data.withdrawals.find(x => x.id === id);
    if (!w) return send(res, 404, { error: 'Not found' });
    w.status = body.status || w.status;
    w.adminNote = body.adminNote || '';
    w.processedAt = new Date().toISOString();
    db.write(data);
    return send(res, 200, { withdrawal: w });
  }

  if (pathname === '/api/admin/run-monthly-fees' && method === 'POST') {
    // Manual trigger for demo (in production: cron job)
    const admin = requireAdmin(req, res);
    if (!admin) return;
    let charged = 0;
    data.users.forEach(u => {
      if (!u.tier || !u.isActive) return;
      const fee = data.settings.monthlyFee;
      const totalBal = (u.taskBalance || 0) + (u.referralBalance || 0);
      if (totalBal >= fee) {
        // Deduct from referral first, then task
        let remaining = fee;
        if (u.referralBalance >= remaining) {
          u.referralBalance -= remaining;
        } else {
          remaining -= u.referralBalance;
          u.referralBalance = 0;
          u.taskBalance = Math.max(0, (u.taskBalance || 0) - remaining);
        }
        u.feePending = false;
        u.feeOwed = 0;
        charged++;
        data.transactions.push({
          id: db.uuid(),
          userId: u.id,
          type: 'monthly_fee',
          amount: -fee,
          status: 'completed',
          createdAt: new Date().toISOString()
        });
      } else {
        u.feePending = true;
        u.feeOwed = fee - totalBal;
        // Zero out wallets
        u.taskBalance = 0;
        u.referralBalance = 0;
      }
    });
    db.write(data);
    return send(res, 200, { message: `Monthly fees processed. ${charged} users charged successfully.` });
  }

  // Fallback
  send(res, 404, { error: 'API route not found' });
}

function publicUser(u) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    referralCode: u.referralCode,
    tier: u.tier,
    membershipPaidAt: u.membershipPaidAt,
    role: u.role,
    taskBalance: u.taskBalance || 0,
    referralBalance: u.referralBalance || 0,
    tasksCompleted: u.tasksCompleted || 0,
    feePending: !!u.feePending,
    feeOwed: u.feeOwed || 0,
    kycStatus: u.kycStatus,
    isActive: u.isActive,
    createdAt: u.createdAt
  };
}

// ---------- Main server ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = parsed.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    // Static files
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin/index.html';

    const publicPath = path.join(__dirname, 'public', pathname);
    const adminPath = path.join(__dirname, 'admin', pathname.replace(/^\/admin/, '') || 'index.html');

    if (pathname.startsWith('/admin')) {
      serveStatic(req, res, path.join(__dirname, 'admin', pathname.slice(6) || 'index.html'));
    } else {
      serveStatic(req, res, publicPath);
    }
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Internal server error', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Zbyte server running at http://localhost:${PORT}`);
  console.log(`   Web app:   http://localhost:${PORT}`);
  console.log(`   Admin:     http://localhost:${PORT}/admin`);
  console.log(`   API base:  http://localhost:${PORT}/api\n`);
  console.log('First registered user automatically becomes admin.\n');
});
