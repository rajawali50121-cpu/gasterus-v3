import http from 'node:http';

const BASE = 'http://localhost:8080';

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(options.path, 'http://localhost');
    const reqOptions = {
      hostname: 'localhost',
      port: 8080,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: json });
        } catch {
          resolve({ statusCode: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(name, fn, expected = null) {
  try {
    const result = await fn();
    const pass = expected !== null
      ? result.statusCode === expected
      : result.statusCode >= 200 && result.statusCode < 300;
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${result.statusCode}`);
    if (result.body && typeof result.body === 'object' && result.body.error) {
      console.log(`      ${result.body.error.code || result.body.error.message || JSON.stringify(result.body).slice(0, 150)}`);
    }
    return pass;
  } catch (e) {
    console.log(`FAIL | ${name} | ${e.message}`);
    return false;
  }
}

console.log('=== START API VERIFICATION ===\n');

const results = [];

results.push(await test('HEALTH', () => request({ path: '/health' })));
results.push(await test('READY', () => request({ path: '/ready' })));
results.push(await test('PUBLIC_MARKETS', () => request({ path: '/api/public/markets' })));
results.push(await test('REGISTER_CAPTCHA', () => request({ path: '/api/member/register/captcha' })));
results.push(await test('REGISTER_NO_CAPTCHA (should 400)', () =>
  request({ path: '/api/member/register', method: 'POST', body: { username: 'test_x', email: 't@t.com', password: 'Test1234' } }), 400
));
results.push(await test('LOGIN_WRONG_CRED (should 401)', () =>
  request({ path: '/api/member/login', method: 'POST', body: { username: 'noone', password: 'wrong' } }), 401
));
results.push(await test('ME_NO_AUTH (should 401)', () => request({ path: '/api/member/me' }), 401));
results.push(await test('ME_INVALID_TOKEN (should 401)', () =>
  request({ path: '/api/member/me', headers: { Authorization: 'invalid-test-token' } }), 401
));

const passed = results.filter(Boolean).length;
console.log(`\n=== RESULTS: ${passed}/${results.length} passed ===`);
