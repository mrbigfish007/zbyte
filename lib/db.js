const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initial = { users: [], tasks: [], withdrawals: [] };
      fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
      return initial;
    }
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { users: [], tasks: [], withdrawals: [] };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('DB write error:', e);
  }
}

module.exports = { readDb, writeDb };
