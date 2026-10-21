/**
 * The Codex / Grok Build hook (plugin/hooks/portpilot-agent-hook.mjs): handle() per event with
 * faked I/O, on payloads shaped like the ones both agents send.
 * Run: node tests/agent-hook.test.mjs   (part of npm run test:unit)
 */
import assert from 'node:assert';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { agentOf, codexWorkdir, handle, readEvent, SETTLE_MS, stateFile } from '../plugin/hooks/portpilot-agent-hook.mjs';

let passed = 0;
let failed = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

const WINDOWS = process.platform === 'win32';
const ROOT = path.resolve('/pp-agent-hook');
const CONFIG_DIR = path.join(ROOT, 'config');
const HOME = path.join(ROOT, 'home');
const SITE = path.join(ROOT, 'work', 'site');
const SHOP = path.join(ROOT, 'work', 'shop');
const T0 = Date.parse('2026-10-21T12:00:00Z');
const CONFIG = { apps: [{ id: 'shop', name: 'Shop', cwd: SHOP, command: 'npm run dev', preferredPort: 3000 }], settings: {} };

/** In-memory files, a clock that sleeps instantly, and ports that open at given times. */
function fakeIo({ config = CONFIG, opens = {}, transcript = '' } = {}) {
  const files = new Map([[path.join(CONFIG_DIR, 'portpilot-config.json'), config]]);
  let clock = T0;
  const io = {
    configDir: CONFIG_DIR,
    home: HOME,
    windows: WINDOWS,
    scans: 0,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    advance: (ms) => { clock += ms; },
    exists: (f) => files.has(f),
    read: (f) => (files.has(f) ? JSON.parse(JSON.stringify(files.get(f))) : null),
    write: (f, d) => { files.set(f, JSON.parse(JSON.stringify(d))); },
    remove: (f) => { files.delete(f); },
    prune: () => {},
    scan: () => {
      io.scans++;
      const open = Object.entries(opens).filter(([, at]) => clock >= at).map(([p]) => Number(p));
      return new Map([9229, ...open].map((p) => [p, { port: p, pid: 4000 + p, processName: 'Unknown', address: '127.0.0.1' }]));
    },
    nameHolder: (listeners, port) => { listeners.set(port, { ...listeners.get(port), processName: 'node.exe' }); },
    tail: () => transcript,
    files,
  };
  return io;
}

const codex = (event, extra = {}) => ({
  session_id: 'c1', transcript_path: path.join(ROOT, 'rollout.jsonl'), cwd: SITE, hook_event_name: event,
  model: 'gpt-5', permission_mode: 'default', ...extra,
});
const codexShell = (command, callId = 'call_1') => codex('PreToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: callId, tool_input: { command } });
const rolloutCall = (callId, args) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify(args), call_id: callId } });

const grok = (event, extra = {}) => ({
  hookEventName: event.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase()), hook_event_name: event,
  sessionId: 'g1', session_id: 'g1', cwd: SITE, workspaceRoot: SITE, ...extra,
});
const grokShell = (command) => grok('PreToolUse', { toolName: 'run_terminal_command', tool_name: 'run_terminal_command', toolInput: { command }, tool_input: { command } });

const state = (io, agent, session) => io.read(stateFile(CONFIG_DIR, agent, session));

t('the agent comes from the payload: Grok adds camelCase keys', () => {
  assert.equal(agentOf(codex('Stop')), 'codex');
  assert.equal(agentOf(grok('Stop')), 'grok');
});

t('codexWorkdir: the call\'s workdir against the turn cwd; null without one; undefined when not written yet', () => {
  const lines = ['{"cut line', rolloutCall('call_a', { cmd: 'npm run dev', workdir: 'apps/web' }), rolloutCall('call_b', { cmd: 'npm run dev' })].join('\n');
  assert.equal(codexWorkdir(lines, 'call_a', SITE), path.resolve(SITE, 'apps/web'));
  assert.equal(codexWorkdir(lines, 'call_a', SITE).startsWith(SITE), true);
  assert.equal(codexWorkdir(lines, 'call_b', SITE), null);
  assert.equal(codexWorkdir(lines, 'call_z', SITE), undefined);
  assert.equal(codexWorkdir(rolloutCall('call_c', { cmd: 'x', workdir: SHOP }), 'call_c', SITE), SHOP);
});

t('codex: a start is noted, and the port it opens reaches the next tool result with the session', async () => {
  const io = fakeIo({ opens: { 5173: T0 + 2_000 }, transcript: rolloutCall('call_1', { cmd: 'npm run dev' }) });
  assert.equal(await handle(codexShell('npm run dev'), io), null);
  const noted = state(io, 'codex', 'c1');
  assert.equal(noted.notes.length, 1);
  assert.ok(noted.notes[0].cwd.endsWith('/work/site'), noted.notes[0].cwd);
  assert.deepStrictEqual(noted.lastPorts, [9229]);
  io.advance(1_000);
  assert.equal(await handle(codex('PostToolUse', { tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm run dev' }, tool_response: '' }), io), null);
  io.advance(3_000);
  const out = await handle(codex('PostToolUse', { tool_name: 'Read', tool_input: {} }), io);
  const text = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(text.includes(':5173') && text.includes('node.exe'), text);
  assert.ok(text.endsWith('observedSession "codex:c1".'), text);
  assert.deepStrictEqual(state(io, 'codex', 'c1').queue, []);
});

t('codex: a workdir in the transcript decides the folder, not the turn cwd', async () => {
  const io = fakeIo({ transcript: rolloutCall('call_9', { cmd: 'npm run dev', workdir: SHOP }) });
  await handle(codexShell('npm run dev', 'call_9'), io);
  assert.equal(io.exists(stateFile(CONFIG_DIR, 'codex', 'c1')), false, 'Shop is registered: nothing to note');
  const other = fakeIo({ transcript: rolloutCall('call_9', { cmd: 'npm run dev', workdir: 'apps/web' }) });
  await handle(codexShell('npm run dev', 'call_9'), other);
  assert.ok(state(other, 'codex', 'c1').notes[0].cwd.endsWith('/work/site/apps/web'));
});

t('codex: a call not in the transcript yet falls back to the turn cwd after a few tries', async () => {
  const io = fakeIo();
  await handle(codexShell('npm run dev'), io);
  assert.ok(state(io, 'codex', 'c1').notes[0].cwd.endsWith('/work/site'));
  assert.equal(io.now(), T0 + 500);
});

t('only certain dev-server starts in unowned folders are noted', async () => {
  for (const command of ['npm run build', 'git status', String.raw`Set-Location $env:USERPROFILE\x; npm run dev`, 'npx vite build']) {
    const io = fakeIo();
    await handle(codexShell(command), io);
    assert.equal(io.exists(stateFile(CONFIG_DIR, 'codex', 'c1')), false, command);
  }
  const off = fakeIo({ config: { ...CONFIG, settings: { autoRegister: false } } });
  await handle(codexShell('npm run dev'), off);
  assert.equal(off.exists(stateFile(CONFIG_DIR, 'codex', 'c1')), false, 'opted out');
  const notShell = fakeIo();
  await handle(codex('PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'x', tool_input: { command: 'npm run dev' } }), notShell);
  assert.equal(notShell.scans, 0);
});

t('PostToolUse without a noted start costs no scan', async () => {
  const io = fakeIo();
  assert.equal(await handle(codex('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), io), null);
  assert.equal(io.scans, 0);
});

t('PostToolUse scans at most every 3 s', async () => {
  const io = fakeIo({ transcript: rolloutCall('call_1', { cmd: 'npm run dev' }) });
  await handle(codexShell('npm run dev'), io);
  const after = io.scans;
  await handle(codex('PostToolUse', { tool_name: 'Read' }), io);
  io.advance(500);
  await handle(codex('PostToolUse', { tool_name: 'Read' }), io);
  assert.equal(io.scans, after + 1);
  io.advance(3_000);
  await handle(codex('PostToolUse', { tool_name: 'Read' }), io);
  assert.equal(io.scans, after + 2);
});

t('grok Stop at end_turn waits for the port, then blocks once with the notice', async () => {
  const io = fakeIo({ opens: { 4789: T0 + 3_000 } });
  await handle(grokShell(String.raw`Set-Location -LiteralPath "${SITE}"; npm.cmd run dev`), io);
  assert.equal(state(io, 'grok', 'g1').notes[0].command, 'npm.cmd run dev');
  const out = await handle(grok('Stop', { reason: 'end_turn', stopHookActive: false, stop_hook_active: false }), io);
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.includes(':4789') && out.reason.endsWith('observedSession "grok:g1".'), out.reason);
  assert.ok(io.now() >= T0 + 3_000 && io.now() < T0 + SETTLE_MS);
  assert.equal(await handle(grok('Stop', { reason: 'end_turn', stop_hook_active: true }), io), null);
  const before = io.now();
  assert.equal(await handle(grok('Stop', { reason: 'end_turn', stop_hook_active: false }), io), null, 'already told');
  assert.equal(io.now(), before, 'a reported start is not waited for again');
});

t('Stop still waits for a start made after the last notice', async () => {
  const io = fakeIo({ opens: { 4789: T0 + 1_000, 5000: T0 + 8_000 } });
  await handle(grokShell('npm run dev'), io);
  io.advance(2_000);
  assert.ok(await handle(grok('PostToolUse', { tool_name: 'read_file' }), io));
  io.advance(1_000);
  await handle(grokShell('cd api && npm run dev'), io);
  const out = await handle(grok('Stop', { reason: 'end_turn', stop_hook_active: false }), io);
  assert.ok(out.reason.includes(':5000'), out.reason);
  assert.equal(io.now(), T0 + 8_000);
});

t('Stop gives up SETTLE_MS after the start when no port opens', async () => {
  const io = fakeIo();
  await handle(grokShell('npm run dev'), io);
  assert.equal(await handle(grok('Stop', { reason: 'end_turn', stop_hook_active: false }), io), null);
  assert.equal(io.now(), T0 + SETTLE_MS);
  assert.equal(state(io, 'grok', 'g1').notes.length, 1, 'still watched by the next turn');
});

t('Stop at session end, or while continuing from a block, does nothing', async () => {
  const io = fakeIo({ opens: { 4789: T0 } });
  await handle(grokShell('npm run dev'), io);
  const scans = io.scans;
  assert.equal(await handle(grok('Stop', { reason: 'shutdown', stop_hook_active: false }), io), null);
  assert.equal(await handle(grok('Stop', { reason: 'channel_closed', stop_hook_active: false }), io), null);
  assert.equal(await handle(codex('Stop', { turn_id: 't1', stop_hook_active: true, last_assistant_message: 'done' }), io), null);
  assert.equal(io.scans, scans);
});

t('codex Stop blocks with the notice like grok\'s', async () => {
  const io = fakeIo({ opens: { 3001: T0 + 1_000 }, transcript: rolloutCall('call_1', { cmd: '$env:PORT = 3001; npm run dev' }) });
  await handle(codexShell('$env:PORT = 3001; npm run dev'), io);
  const out = await handle(codex('Stop', { turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Started.' }), io);
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.includes(':3001') && out.reason.includes('codex:c1'), out.reason);
});

t('a session with nothing left watched drops its state file', async () => {
  const io = fakeIo();
  await handle(grokShell('npm run dev'), io);
  io.advance(2 * 60_000 + 1);
  await handle(grok('PostToolUse', { tool_name: 'read_file', toolName: 'read_file' }), io);
  assert.equal(io.exists(stateFile(CONFIG_DIR, 'grok', 'g1')), false);
});

t('readEvent: one JSON line is enough while stdin stays open; other shapes wait for the end', async () => {
  const open = new PassThrough();
  const first = readEvent(open);
  open.write('{"session_id":"g1","hook_event_name":"Pos');
  open.write('tToolUse"}\n');
  assert.deepStrictEqual(await first, { session_id: 'g1', hook_event_name: 'PostToolUse' });
  const pretty = new PassThrough();
  const second = readEvent(pretty);
  pretty.write('{\n  "session_id": "c1",\n');
  pretty.end('  "hook_event_name": "Stop"\n}');
  assert.deepStrictEqual(await second, { session_id: 'c1', hook_event_name: 'Stop' });
  const bad = new PassThrough();
  const third = readEvent(bad);
  bad.end('not json');
  await assert.rejects(third);
});

t('a session id becomes a safe file name', () => {
  assert.equal(path.basename(stateFile(CONFIG_DIR, 'grok', '../a b:c')), 'grok-.._a_b_c.json');
});

for (const [name, fn] of tests) {
  try { await fn(); console.log('✅', name); passed++; }
  catch (e) { console.log('❌', name, '-', e.message); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
