const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db.json');

function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { users: [], tasks: [], withdrawals: [] };
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { users: [], tasks: [], withdrawals: [] };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Write error:', e);
  }
}

function ensureAdmin() {
  const data = readDb();
  if (!data.users.find(u => u.isAdmin || u.email === 'admin@zbyte.com.ng')) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync('admin', salt, 10000, 64, 'sha512').toString('hex');
    data.users.push({
      id: crypto.randomUUID(),
      name: 'MR BIG FSH',
      email: 'admin@zbyte.com.ng',
      passwordHash: hash,
      passwordSalt: salt,
      isAdmin: true,
      token: crypto.randomBytes(32).toString('hex'),
      taskWallet: 0,
      referralWallet: 0,
      tier: 'gold',
      referralCode: 'ADMIN01',
      phone: '',
      bio: ''
    });
    writeDb(data);
  }
}

function createWithdrawal(userId, body) {
  const data = readDb();
  if (!data.withdrawals) data.withdrawals = [];
  const withdrawal = {
    id: crypto.randomUUID(),
    userId,
    walletType: body.walletType || 'task',
    amount: Number(body.amount) || 0,
    bankName: body.bankName || '',
    accountNumber: body.accountNumber || '',
    accountName: body.accountName || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  data.withdrawals.push(withdrawal);
  writeDb(data);
  return { success: true, withdrawal };
}

function runMonthlyFees() {
  return { success: true, message: 'Monthly fees processed' };
}

module.exports = { readDb, writeDb, ensureAdmin, createWithdrawal, runMonthlyFees };
