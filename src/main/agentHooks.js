/**
 * Installs PortPilot's agent hook (plugin/hooks/portpilot-agent-hook.mjs) and skill into Codex and
 * Grok Build, so a dev server either agent starts in a folder no app owns reaches PortPilot as the
 * Claude Code plugin's do. Codex runs the hook as a command from ~/.codex/hooks.json, where
 * PortPilot's groups sit next to the user's, once the user trusts it in /hooks. Grok trusts every
 * file in ~/.grok/hooks, and its hook POSTs to this app (src/main/agentHookServer.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const hookServer = require('./agentHookServer');

const SCRIPT = 'portpilot-agent-hook.mjs';
const SKILL = 'portpilot';
const PRE = { event: 'PreToolUse', matcher: 'Bash', timeout: 15 };
// Waits up to 15 s for the port of a start the turn ended on.
const STOP = { event: 'Stop', timeout: 30 };

const AGENTS = {
  codex: {
    name: 'Codex',
    home: (ctx) => ctx.env.CODEX_HOME || path.join(ctx.home, '.codex'),
    hooksFile: (dir) => path.join(dir, 'hooks.json'),
    handler: (ctx) => ({ type: 'command', command: `"${ctx.nodePath}" "${ctx.scriptPath}"` }),
    needsNode: true,
    events: [PRE, { event: 'PostToolUse', matcher: '*', timeout: 30 }, STOP],
  },
  grok: {
    name: 'Grok Build',
    home: (ctx) => ctx.env.GROK_HOME || path.join(ctx.home, '.grok'),
    hooksFile: (dir) => path.join(dir, 'hooks', 'portpilot.json'),
    handler: (ctx) => ({ type: 'http', url: ctx.hookUrl }),
    served: true,
    // Every tool but run_terminal_command, which Grok also matches as Bash and Shell: on Windows,
    // a PostToolUse hook there makes Grok 1.0.62 hold a backgrounded command until it exits.
    // (Grok's regex has no lookahead.)
    events: [PRE, { event: 'PostToolUse', matcher: '^([^rBS]|r[^u])', timeout: 30 }, STOP],
  },
};

/** Node.js from PATH: Codex runs the hook under its own shell, not inside PortPilot. */
function findNode(env, platform = process.platform) {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  // A macOS app opened from Finder gets a PATH without Homebrew.
  const extra = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  const dirs = [...String(env.PATH || env.Path || '').split(path.delimiter), ...extra];
  for (const dir of dirs.filter(Boolean)) {
    const p = path.join(dir.replace(/^"(.*)"$/, '$1'), exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function defaultContext() {
  const { app } = require('electron');
  const base = app.isPackaged ? path.join(process.resourcesPath, 'agents') : path.join(__dirname, '..', '..', 'plugin');
  return {
    home: os.homedir(),
    env: process.env,
    nodePath: findNode(process.env),
    scriptPath: path.join(base, 'hooks', SCRIPT),
    skillPath: path.join(base, 'skills', SKILL, 'SKILL.md'),
    hookUrl: hookServer.url(),
    serverError: hookServer.error(),
  };
}

const isOurHandler = (h) => !!h && ((typeof h.command === 'string' && h.command.includes(SCRIPT))
  || (typeof h.url === 'string' && h.url.includes(hookServer.HOOK_PATH)));
const isOurs = (group) => Array.isArray(group && group.hooks) && group.hooks.some(isOurHandler);

function ourGroups(events, handler) {
  const hooks = {};
  for (const { event, matcher, timeout } of events) {
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ ...handler, timeout }] }];
  }
  return hooks;
}

/** The hooks document without PortPilot's groups; an event left with none is dropped. */
function withoutOurs(doc) {
  const hooks = {};
  for (const [event, groups] of Object.entries(doc.hooks || {})) {
    const kept = Array.isArray(groups) ? groups.filter((g) => !isOurs(g)) : groups;
    if (!Array.isArray(groups) || kept.length || !groups.length) hooks[event] = kept;
  }
  return { ...doc, hooks };
}

/** The hooks document with PortPilot's groups last, so the user's keep their /hooks trust keys. */
function withOurs(doc, events, handler) {
  const base = withoutOurs(doc);
  const hooks = { ...base.hooks };
  for (const [event, groups] of Object.entries(ourGroups(events, handler))) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups];
  }
  return { ...base, hooks };
}

function readDoc(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { hooks: {} };
    throw err;
  }
  let doc;
  try { doc = JSON.parse(text.trim()); } catch {
    throw new Error(`${file} is not valid JSON; fix it and try again`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc.hooks != null && (typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)))) {
    throw new Error(`${file} has no hooks object`);
  }
  return { ...doc, hooks: doc.hooks || {} };
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** PortPilot's groups per event, in the agent's event order whatever order the file has them in. */
function ourPart(doc, events) {
  const hooks = doc.hooks || {};
  const order = [...events.map((e) => e.event), ...Object.keys(hooks)];
  return Object.fromEntries([...new Set(order)]
    .map((event) => [event, Array.isArray(hooks[event]) ? hooks[event].filter(isOurs) : []])
    .filter(([, groups]) => groups.length));
}

function skillFile(dir) {
  return path.join(dir, 'skills', SKILL, 'SKILL.md');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function agentOf(id) {
  const agent = AGENTS[id];
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

/** Each agent: found on this machine, hook installed, and installed as this PortPilot would write it. */
function status(ctx = defaultContext()) {
  return Object.entries(AGENTS).map(([id, agent]) => {
    const dir = agent.home(ctx);
    const missingNode = !!agent.needsNode && !ctx.nodePath;
    let installed = false;
    let current = false;
    let error = null;
    try {
      const mine = ourPart(readDoc(agent.hooksFile(dir)), agent.events);
      installed = Object.keys(mine).length > 0;
      current = installed && !missingNode
        && JSON.stringify(mine) === JSON.stringify(ourGroups(agent.events, agent.handler(ctx)))
        && readText(skillFile(dir)) === readText(ctx.skillPath);
      if (installed && agent.served) error = ctx.serverError || null;
    } catch (err) {
      error = err.message;
    }
    return { id, name: agent.name, available: fs.existsSync(dir), installed, current, error, missingNode };
  });
}

function install(id, ctx = defaultContext()) {
  const agent = agentOf(id);
  if (agent.needsNode && !ctx.nodePath) throw new Error('Node.js was not found on PATH; the hook needs it to run');
  if (!fs.existsSync(ctx.scriptPath)) throw new Error(`Hook script missing: ${ctx.scriptPath}`);
  const dir = agent.home(ctx);
  const file = agent.hooksFile(dir);
  writeFile(file, `${JSON.stringify(withOurs(readDoc(file), agent.events, agent.handler(ctx)), null, 2)}\n`);
  writeFile(skillFile(dir), fs.readFileSync(ctx.skillPath, 'utf8'));
}

/** A SKILL.md PortPilot wrote declares `name: portpilot`; anything else there is the user's. */
const isOurSkill = (text) => /^\s*---\r?\nname: portpilot\r?\n/.test(text || '');

function uninstall(id, ctx = defaultContext()) {
  const agent = agentOf(id);
  const dir = agent.home(ctx);
  const file = agent.hooksFile(dir);
  if (fs.existsSync(file)) {
    const rest = withoutOurs(readDoc(file));
    if (id === 'grok' && !Object.keys(rest.hooks).length) fs.unlinkSync(file);
    else writeFile(file, `${JSON.stringify(rest, null, 2)}\n`);
  }
  const skill = skillFile(dir);
  if (isOurSkill(readText(skill))) {
    fs.unlinkSync(skill);
    try { fs.rmdirSync(path.dirname(skill)); } catch { /* holds other files */ }
  }
}

/** Rewrite installed hooks this PortPilot would write differently (a moved app, a new node, a newer skill). */
function sync(ctx = defaultContext()) {
  for (const s of status(ctx)) {
    if (!s.installed || s.current || s.error || s.missingNode) continue;
    try { install(s.id, ctx); } catch (err) { console.error(`Agent hook sync (${s.id}) failed:`, err.message); }
  }
}

/** Grok's hook reaches this app over HTTP: serve it while it is installed. */
async function serve(ctx = defaultContext()) {
  const grok = status(ctx).find((s) => s.id === 'grok');
  await hookServer.follow(grok.installed, ctx.scriptPath);
}

module.exports = { AGENTS, SCRIPT, findNode, defaultContext, ourGroups, withOurs, withoutOurs, status, install, uninstall, sync, serve };
