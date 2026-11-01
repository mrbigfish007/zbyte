/**
 * Simple file-based database for Zbyte.
 * In production replace this entire file with Prisma + PostgreSQL
 * or Supabase. The API shape stays the same.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const defaultData = {
  users: [],
  tasks: [
    { id: 't1', title: 'Short Consumer Survey', type: 'survey', description: 'Answer 8 questions about online shopping habits in Nigeria.', reward: 500, active: true },
    { id: 't2', title: 'Share Zbyte on WhatsApp Status', type: 'share_post', description: 'Post the official Zbyte image + caption on your WhatsApp status for 24 hours and submit screenshot.', reward: 500, active: true },
    { id: 't3', title: 'Product Feedback Form', type: 'form', description: 'Complete a short form about mobile money usage.', reward: 500, active: true },
    { id: 't4', title: 'Social Media Awareness Post', type: 'share_post', description: 'Share the provided post on your Facebook or Instagram and submit proof.', reward: 500, active: true },
    { id: 't5', title: 'Financial Literacy Quiz', type: 'survey', description: 'Quick 6-question quiz on basic personal finance.', reward: 500, active: true },
    { id: 't6', title: 'App Feedback Form', type: 'form', description: 'Tell us what features you would like in the Zbyte mobile app.', reward: 500, active: true },
    { id: 't7', title: 'Refer & Share Story', type: 'share_post', description: 'Create a short story about Zbyte and share it on any social platform.', reward: 500, active: true },
  ],
  userTasks: [],
  referrals: [],
  transactions: [],
  withdrawals: [],
  monthlyFees: [],
  settings: {
    monthlyFee: 5000,
    taskReward: 500,
    withdrawalMinTask: 50000,
    withdrawalMinReferral: 10000,
    membershipPrices: { premium: 10000, silver: 20000, gold: 30000 },
    referralCommissions: { premium: 1000, silver: 2000, gold: 3000 },
    taskLimits: { premium: 2, silver: 4, gold: 7 }
  }
};

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
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

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'zbyte-salt-v1').digest('hex');
}

function generateReferralCode() {
  return 'ZB' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  read,
  write,
  uuid,
  hashPassword,
  generateReferralCode,
  defaultData
};
