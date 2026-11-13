/**
 * Simple file-based database for Zbyte (with Withdrawals + Monthly Fee)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const defaultData = {
      users: [],
      tasks: [
        { id: 't1', title: 'Short Consumer Survey', type: 'survey', description: 'Answer 8 questions about online shopping habits in Nigeria.', reward: 500, active: true },
        { id: 't2', title: 'Share Zbyte on WhatsApp Status', type: 'share_post', description: 'Post the official Zbyte image + caption on your WhatsApp status for 24 hours and submit screenshot.', reward: 500, active: true },
        { id: 't3', title: 'Product Feedback Form', type: 'form', description: 'Complete a short form about mobile money usage.', reward: 500, active: true },
        { id: 't4', title: 'Social Media Awareness Post', type: 'share_post', description: 'Share the provided post on your Facebook or Instagram and submit proof.', reward: 500, active: true },
        { id: 't5', title: 'Financial Literacy Quiz', type: 'survey', description: 'Quick 6-question quiz on basic personal finance.', reward: 500, active: true },
        { id: 't6', title: 'App Feedback Form', type: 'form', description: 'Tell us what features you would like in the Zbyte mobile app.', reward: 500, active: true },
        { id: 't7', title: 'Refer & Share Story', type: 'share_post', description: 'Create a short story about Zbyte and share it on any social platform.', reward: 500, active: true }
      ],
      userTasks: [],
      referrals: [],
      transactions: [],
      withdrawals: [],
      monthlyFees: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
  }
}

function read() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function write(data) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function uuid() {
  return crypto.randomUUID();
}

function getUserByEmail(email) {
  const data = read();
  return data.users.find(u => u.email === email) || null;
}

function getUserById(id) {
  const data = read();
  return data.users.find(u => u.id === id) || null;
}

function getUserByReferralCode(code) {
  const data = read();
  return data.users.find(u => u.referralCode === code) || null;
}

function createUser(userData) {
  const data = read();
  const user = {
    id: uuid(),
    name: userData.name || userData.fullName || '',
    email: userData.email,
    phone: userData.phone || '',
    password: userData.password,
    tier: userData.tier || 'premium',
    isAdmin: userData.isAdmin || false,
    membershipActive: userData.membershipActive || false,
    taskWallet: userData.taskWallet || 0,
    referralWallet: userData.referralWallet || 0,
    tasksCompleted: userData.tasksCompleted || 0,
    referralCode: userData.referralCode || ('ZB' + crypto.randomBytes(3).toString('hex').toUpperCase()),
    feePending: false,
    feeOwed: 0,
    createdAt: new Date().toISOString()
  };
  data.users.push(user);
  write(data);
  return user;
}

function updateUser(id, updates) {
  const data = read();
  const index = data.users.findIndex(u => u.id === id);
  if (index === -1) return null;
  data.users[index] = { ...data.users[index], ...updates };
  write(data);
  return data.users[index];
}

function addReferral(referrerId, newUserId) {
  const data = read();
  data.referrals.push({
    id: uuid(),
    referrerId,
    newUserId,
    createdAt: new Date().toISOString()
  });
  write(data);
}

function getReferralByNewUser(newUserId) {
  const data = read();
  return data.referrals.find(r => r.newUserId === newUserId) || null;
}

function addToWallet(userId, walletType, amount) {
  const data = read();
  const user = data.users.find(u => u.id === userId);
  if (!user) return;
  if (walletType === 'task') user.taskWallet = (user.taskWallet || 0) + amount;
  if (walletType === 'referral') user.referralWallet = (user.referralWallet || 0) + amount;
  write(data);
}

function getTasks() {
  const data = read();
  return data.tasks.filter(t => t.active);
}

function completeTask(userId, taskId) {
  const data = read();
  const user = data.users.find(u => u.id === userId);
  const task = data.tasks.find(t => t.id === taskId);
  if (!user || !task) return { success: false, message: 'Invalid user or task' };

  const already = data.userTasks.find(ut => ut.userId === userId && ut.taskId === taskId);
  if (already) return { success: false, message: 'Task already completed' };

  data.userTasks.push({
    id: uuid(),
    userId,
    taskId,
    completedAt: new Date().toISOString()
  });

  user.taskWallet = (user.taskWallet || 0) + task.reward;
  user.tasksCompleted = (user.tasksCompleted || 0) + 1;
  write(data);

  return { success: true, reward: task.reward, newBalance: user.taskWallet };
}

function getAllUsers() {
  const data = read();
  return data.users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    tier: u.tier,
    membershipActive: u.membershipActive,
    taskWallet: u.taskWallet,
    referralWallet: u.referralWallet,
    tasksCompleted: u.tasksCompleted,
    referralCode: u.referralCode,
    feePending: u.feePending || false,
    feeOwed: u.feeOwed || 0,
    createdAt: u.createdAt
  }));
}

function getStats() {
  const data = read();
  return {
    totalMembers: data.users.length,
    activatedMemberships: data.users.filter(u => u.membershipActive).length,
    pendingWithdrawals: data.withdrawals.filter(w => w.status === 'pending').length,
    taskRewardsPaid: data.users.reduce((sum, u) => sum + (u.taskWallet || 0), 0)
  };
}

function createWithdrawal(userId, walletType, amount, bankDetails) {
  const data = read();
  const user = data.users.find(u => u.id === userId);
  if (!user) return { success: false, message: 'User not found' };

  const balance = walletType === 'task' ? user.taskWallet : user.referralWallet;
  const min = walletType === 'task' ? 50000 : 10000;
  if (balance < min) return { success: false, message: `Minimum is ₦${min.toLocaleString()}` };
  if (amount > balance) return { success: false, message: 'Insufficient balance' };

  const withdrawal = {
    id: uuid(),
    userId,
    walletType,
    amount,
    status: 'pending',
    bankName: bankDetails.bankName || '',
    accountNumber: bankDetails.accountNumber || '',
    accountName: bankDetails.accountName || '',
    createdAt: new Date().toISOString()
  };
  data.withdrawals.push(withdrawal);
  write(data);
  return { success: true, withdrawal };
}

function getWithdrawals(status) {
  const data = read();
  if (status) return data.withdrawals.filter(w => w.status === status);
  return data.withdrawals;
}

function updateWithdrawal(id, status) {
  const data = read();
  const index = data.withdrawals.findIndex(w => w.id === id);
  if (index === -1) return null;
  data.withdrawals[index].status = status;
  data.withdrawals[index].processedAt = new Date().toISOString();

  if (status === 'approved') {
    const w = data.withdrawals[index];
    const user = data.users.find(u => u.id === w.userId);
    if (user) {
      if (w.walletType === 'task') user.taskWallet = Math.max(0, (user.taskWallet || 0) - w.amount);
      if (w.walletType === 'referral') user.referralWallet = Math.max(0, (user.referralWallet || 0) - w.amount);
    }
  }
  write(data);
  return data.withdrawals[index];
}

// ========== MONTHLY FEE ==========
function runMonthlyFees() {
  const data = read();
  const fee = 5000;
  let processed = 0;
  let pending = 0;

  data.users.forEach(user => {
    if (!user.membershipActive || user.isAdmin) return;

    if ((user.taskWallet || 0) >= fee) {
      user.taskWallet -= fee;
      user.feePending = false;
      user.feeOwed = 0;
      processed++;
    } else {
      user.feePending = true;
      user.feeOwed = (user.feeOwed || 0) + fee;
      pending++;
    }
  });

  data.monthlyFees.push({
    id: uuid(),
    date: new Date().toISOString(),
    processed,
    pending,
    feeAmount: fee
  });

  write(data);
  return { processed, pending };
}

module.exports = {
  read, write, uuid,
  getUserByEmail, getUserById, getUserByReferralCode,
  createUser, updateUser, addReferral, getReferralByNewUser,
  addToWallet, getTasks, completeTask, getAllUsers, getStats,
  createWithdrawal, getWithdrawals, updateWithdrawal,
  runMonthlyFees
};
