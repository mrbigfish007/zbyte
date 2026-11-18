const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;

function send(res, status, data) {
  res.writeHead(status, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Static files
  if (pathname === '/' || pathname.endsWith('.html')) {
    const filePath = pathname === '/' ? '/public/index.html' : '/public' + pathname;
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
  }

  // Simple login test
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        if (email === 'admin@zbyte.com.ng' && password === 'admin') {
          const token = crypto.randomBytes(32).toString('hex');
          send(res, 200, { token });
        } else {
          send(res, 401, { error: 'Invalid credentials' });
        }
      } catch (e) {
        send(res, 500, { error: 'Server error' });
      }
    });
    return;
  }

  // Get user (for dashboard)
  if (pathname === '/api/user/me' && req.method === 'GET') {
    send(res, 200, {
      name: 'MR BIG FSH',
      email: 'admin@zbyte.com.ng',
      bio: '',
      profilePicture: '',
      membership: 'premium',
      taskWallet: 0,
      referralWallet: 0,
      referralCode: 'ADMIN01'
    });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log('Server running'));
