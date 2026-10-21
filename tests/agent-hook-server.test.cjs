/**
 * The loopback server Grok Build's hook POSTs to (src/main/agentHookServer.js): it answers with the
 * handler's reply, refuses browsers and other hosts, and fails open.
 * Run: node tests/agent-hook-server.test.cjs   (part of npm run test:unit)
 */
const assert = require('assert');
const http = require('http');
const { createHookServer, HOOK_PATH } = require('../src/main/agentHookServer');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('✅', name); passed++; } catch (e) { console.log('❌', name, '-', e.message); failed++; }
}

function post(port, body, headers = {}, urlPath = HOOK_PATH) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const seen = [];
  const server = createHookServer(async (event) => {
    seen.push(event);
    if (event.boom) throw new Error('boom');
    return event.hook_event_name === 'Stop' ? { decision: 'block', reason: 'notice' } : null;
  }, 0);
  const port = await server.start();

  await t('the handler\'s reply is the answer; no reply is {}', async () => {
    assert.deepStrictEqual(await post(port, JSON.stringify({ hook_event_name: 'Stop' })), { status: 200, body: { decision: 'block', reason: 'notice' } });
    assert.deepStrictEqual(await post(port, JSON.stringify({ hook_event_name: 'PreToolUse' })), { status: 200, body: {} });
    assert.equal(seen.length, 2);
  });

  await t('a browser (Origin) or another Host is refused before the handler runs', async () => {
    assert.equal((await post(port, '{}', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(port, '{}', { Host: `attacker.example:${port}` })).status, 403);
    assert.equal((await post(port, '{}', {}, '/other')).status, 404);
    assert.equal(seen.length, 2);
  });

  await t('a handler error or a body that is not JSON fails open', async () => {
    assert.deepStrictEqual(await post(port, JSON.stringify({ boom: true })), { status: 200, body: {} });
    assert.deepStrictEqual(await post(port, 'not json'), { status: 200, body: {} });
  });

  await server.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
