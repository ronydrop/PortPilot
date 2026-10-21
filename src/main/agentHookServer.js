/**
 * Grok Build's way into PortPilot's agent hook. On Windows, Grok 1.0.62 holds every command hook
 * it starts while a command it backgrounded still runs, which a dev server always does, so
 * Grok's hooks POST each event here (type "http") and the app answers with the handler Codex
 * runs as a command (plugin/hooks/portpilot-agent-hook.mjs). Loopback only, and only while
 * Grok's hook is installed; a request from a browser (it carries an Origin) or for another Host
 * is refused.
 */
const http = require('http');
const { pathToFileURL } = require('url');

const HOST = '127.0.0.1';
const PORT = 7318;
const HOOK_PATH = '/portpilot/agent-hook';
// Grok sends a tool's whole result with PostToolUse.
const MAX_BODY = 16 * 1024 * 1024;

const url = (port = PORT) => `http://${HOST}:${port}${HOOK_PATH}`;

/**
 * @param {(event: object) => Promise<object|null>} handle  the reply to an event, or null for none
 */
function createHookServer(handle, port = PORT) {
  const server = http.createServer((req, res) => {
    const answer = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const own = server.address().port;
    const host = (req.headers.host || '').toLowerCase();
    if (req.method !== 'POST' || req.url !== HOOK_PATH) return answer(404, {});
    if (req.headers.origin || (host !== `${HOST}:${own}` && host !== `localhost:${own}`)) return answer(403, {});
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      let out = null;
      try { out = await handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { console.error('Agent hook failed:', err.message); }
      answer(200, out || {});
    });
  });
  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.removeListener('error', reject);
        resolve(server.address().port);
      });
    }),
    stop: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

let running = null;
let lastError = null;

/** Run the server while Grok's hook is installed, answering with the hook script's handle(). */
async function follow(installed, scriptPath) {
  if (!installed) {
    lastError = null;
    if (running) {
      const server = running;
      running = null;
      await server.stop();
    }
    return;
  }
  if (running) return;
  let mod = null;
  const server = createHookServer(async (event) => {
    mod = mod || await import(pathToFileURL(scriptPath).href);
    return mod.handle(event, mod.realIo());
  });
  try {
    await server.start();
    running = server;
    lastError = null;
  } catch (err) {
    lastError = err.code === 'EADDRINUSE' ? `Port ${PORT} is in use; Grok's hook cannot reach PortPilot` : err.message;
    console.error('Agent hook server failed:', lastError);
  }
}

module.exports = { PORT, HOOK_PATH, url, createHookServer, follow, error: () => lastError };
