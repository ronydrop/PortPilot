/**
 * Installing PortPilot's hook and skill into Codex and Grok Build (src/main/agentHooks.js),
 * against a temporary home: the user's own hooks survive install, update and removal.
 * Run: node tests/agent-hooks-install.test.cjs   (part of npm run test:unit)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentHooks = require('../src/main/agentHooks');

let passed = 0;
let failed = 0;
function t(name, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-agent-hooks-'));
  try { fn(tmp); console.log('✅', name); passed++; }
  catch (e) { console.log('❌', name, '-', e.message); failed++; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const PLUGIN = path.join(__dirname, '..', 'plugin');
const ctxIn = (tmp, extra = {}) => ({
  home: path.join(tmp, 'home'),
  env: {},
  nodePath: path.join(tmp, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  scriptPath: path.join(PLUGIN, 'hooks', agentHooks.SCRIPT),
  skillPath: path.join(PLUGIN, 'skills', 'portpilot', 'SKILL.md'),
  hookUrl: 'http://127.0.0.1:7318/portpilot/agent-hook',
  serverError: null,
  ...extra,
});
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const codexFile = (ctx) => path.join(ctx.home, '.codex', 'hooks.json');
const grokFile = (ctx) => path.join(ctx.home, '.grok', 'hooks', 'portpilot.json');
const byId = (ctx) => Object.fromEntries(agentHooks.status(ctx).map((s) => [s.id, s]));
const USER = {
  model: 'kept',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'notify.exe', timeout: 5 }] }],
    PreToolUse: [{ matcher: 'apply_patch', hooks: [{ type: 'command', command: 'lint.cmd' }] }],
    SessionStart: [],
  },
};

t('codex: PortPilot\'s groups go after the user\'s, and the skill is copied', (tmp) => {
  const ctx = ctxIn(tmp);
  fs.mkdirSync(path.dirname(codexFile(ctx)), { recursive: true });
  fs.writeFileSync(codexFile(ctx), JSON.stringify(USER));
  assert.deepStrictEqual(byId(ctx).codex, { id: 'codex', name: 'Codex', available: true, installed: false, current: false, error: null, missingNode: false });
  agentHooks.install('codex', ctx);
  const doc = read(codexFile(ctx));
  assert.equal(doc.model, 'kept');
  assert.deepStrictEqual(doc.hooks.SessionStart, []);
  assert.deepStrictEqual(doc.hooks.Stop[0], USER.hooks.Stop[0]);
  assert.deepStrictEqual(doc.hooks.PreToolUse[0], USER.hooks.PreToolUse[0]);
  const command = `"${ctx.nodePath}" "${ctx.scriptPath}"`;
  assert.deepStrictEqual(doc.hooks.PreToolUse[1], { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 15 }] });
  assert.deepStrictEqual(doc.hooks.PostToolUse, [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] }]);
  assert.deepStrictEqual(doc.hooks.Stop[1], { hooks: [{ type: 'command', command, timeout: 30 }] });
  assert.equal(fs.readFileSync(path.join(ctx.home, '.codex', 'skills', 'portpilot', 'SKILL.md'), 'utf8'), fs.readFileSync(ctx.skillPath, 'utf8'));
  const s = byId(ctx).codex;
  assert.equal(s.installed && s.current, true);
});

t('installing again changes nothing; a moved app is rewritten by sync, in place', (tmp) => {
  const ctx = ctxIn(tmp);
  agentHooks.install('codex', ctx);
  agentHooks.install('codex', ctx);
  const once = fs.readFileSync(codexFile(ctx), 'utf8');
  assert.equal(read(codexFile(ctx)).hooks.Stop.length, 1);
  const moved = { ...ctx, nodePath: path.join(tmp, 'other', 'node.exe') };
  assert.equal(byId(moved).codex.current, false);
  agentHooks.sync(moved);
  assert.equal(byId(moved).codex.current, true);
  const doc = read(codexFile(moved));
  assert.equal(doc.hooks.Stop.length, 1);
  assert.ok(doc.hooks.Stop[0].hooks[0].command.includes(path.join('other', 'node.exe')));
  assert.notEqual(fs.readFileSync(codexFile(moved), 'utf8'), once);
});

t('sync leaves an agent the user never installed alone', (tmp) => {
  const ctx = ctxIn(tmp);
  fs.mkdirSync(path.join(ctx.home, '.codex'), { recursive: true });
  agentHooks.sync(ctx);
  assert.equal(fs.existsSync(codexFile(ctx)), false);
  assert.equal(fs.existsSync(grokFile(ctx)), false);
});

t('codex: removing keeps the user\'s hooks and drops only events PortPilot emptied', (tmp) => {
  const ctx = ctxIn(tmp);
  fs.mkdirSync(path.dirname(codexFile(ctx)), { recursive: true });
  fs.writeFileSync(codexFile(ctx), JSON.stringify(USER));
  agentHooks.install('codex', ctx);
  agentHooks.uninstall('codex', ctx);
  assert.deepStrictEqual(read(codexFile(ctx)), USER);
  assert.equal(fs.existsSync(path.join(ctx.home, '.codex', 'skills', 'portpilot')), false);
  assert.equal(byId(ctx).codex.installed, false);
});

t('codex: an invalid hooks.json is reported and left untouched', (tmp) => {
  const ctx = ctxIn(tmp);
  fs.mkdirSync(path.dirname(codexFile(ctx)), { recursive: true });
  fs.writeFileSync(codexFile(ctx), '{ "hooks": ');
  assert.throws(() => agentHooks.install('codex', ctx), /not valid JSON/);
  assert.equal(fs.readFileSync(codexFile(ctx), 'utf8'), '{ "hooks": ');
  assert.match(byId(ctx).codex.error, /not valid JSON/);
  fs.writeFileSync(codexFile(ctx), '{ "hooks": [] }');
  assert.throws(() => agentHooks.install('codex', ctx), /no hooks object/);
});

t('codex: a hooks.json saved with a byte order mark is read', (tmp) => {
  const ctx = ctxIn(tmp);
  fs.mkdirSync(path.dirname(codexFile(ctx)), { recursive: true });
  fs.writeFileSync(codexFile(ctx), String.fromCharCode(0xfeff) + JSON.stringify(USER));
  agentHooks.install('codex', ctx);
  assert.equal(read(codexFile(ctx)).model, 'kept');
});

t('grok: its own hook file and skill, both removed on uninstall; a user skill stays', (tmp) => {
  const ctx = ctxIn(tmp, { env: { GROK_HOME: path.join(tmp, 'grok-home') } });
  agentHooks.install('grok', ctx);
  const file = path.join(tmp, 'grok-home', 'hooks', 'portpilot.json');
  assert.deepStrictEqual(Object.keys(read(file).hooks), ['PreToolUse', 'PostToolUse', 'Stop']);
  assert.deepStrictEqual(read(file).hooks.PreToolUse[0], { matcher: 'Bash', hooks: [{ type: 'http', url: ctx.hookUrl, timeout: 15 }] });
  const post = new RegExp(read(file).hooks.PostToolUse[0].matcher);
  assert.deepStrictEqual(['run_terminal_command', 'Bash', 'Shell'].filter((n) => post.test(n)), []);
  assert.deepStrictEqual(['read_file', 'Read', 'edit_file', 'grep', 'portpilot__add_app'].filter((n) => !post.test(n)), []);
  assert.equal(byId(ctx).grok.current, true);
  assert.equal(byId({ ...ctx, serverError: 'Port 7318 is in use' }).grok.error, 'Port 7318 is in use');
  agentHooks.uninstall('grok', ctx);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(tmp, 'grok-home', 'skills', 'portpilot')), false);

  const mine = path.join(tmp, 'grok-home', 'skills', 'portpilot', 'SKILL.md');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, '---\nname: my-portpilot\n---\n');
  agentHooks.uninstall('grok', ctx);
  assert.equal(fs.readFileSync(mine, 'utf8'), '---\nname: my-portpilot\n---\n');
});

t('without Node.js on PATH Codex is not installed; Grok, which needs none, is', (tmp) => {
  const ctx = ctxIn(tmp, { nodePath: null });
  assert.throws(() => agentHooks.install('codex', ctx), /Node\.js was not found on PATH/);
  assert.equal(fs.existsSync(codexFile(ctx)), false);
  assert.equal(byId(ctx).codex.missingNode, true);
  agentHooks.install('grok', ctx);
  assert.equal(byId(ctx).grok.current, true);
  assert.throws(() => agentHooks.install('cursor', ctx), /Unknown agent/);
});

t('findNode: the first PATH entry holding node', (tmp) => {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.mkdirSync(path.join(tmp, 'b'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'b', exe), '');
  const PATH = [path.join(tmp, 'a'), `"${path.join(tmp, 'b')}"`, ''].join(path.delimiter);
  assert.equal(agentHooks.findNode({ PATH }), path.join(tmp, 'b', exe));
  assert.equal(agentHooks.findNode({ PATH: path.join(tmp, 'a') }, 'linux'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
