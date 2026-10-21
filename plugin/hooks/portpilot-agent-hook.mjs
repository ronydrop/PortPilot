#!/usr/bin/env node
/**
 * PortPilot's hook for Codex and Grok Build: the observe half of the Claude Code mod
 * (register.tsx) for agents with hooks of their own. PortPilot's settings install it
 * (src/main/agentHooks.js): Codex runs this file as a command from ~/.codex/hooks.json, and
 * Grok POSTs each event to the app, which answers with handle() (src/main/agentHookServer.js).
 * No call shares memory with the next, so a session's observe state lives in
 * <config dir>/agent-observe/<agent>-<session>.json.
 *
 * - PreToolUse on a shell call: a certain dev-server start in a directory no app owns is
 *   noted, with the ports listening now (noteStart).
 * - PostToolUse on any call: while a note is recent, the ports that appeared become a notice
 *   (checkNotices), handed to the agent with the tool result (additionalContext).
 * - Stop: a turn that ends right after a start waits up to SETTLE_MS for its port, then
 *   blocks the stop once with the notice, so the agent registers it (or not) before it
 *   finishes. Between hooks there is no clock to hold a notice for a later tool result, as
 *   the mod's 15 s tick does.
 *
 * Codex hides exec_command's workdir from hooks; the call in the session transcript has it.
 * Fails open: any error leaves the call alone and prints nothing. The process exits as soon as
 * it has answered, whatever still holds its stdin.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { parseListeners, parseStart, parseTasklistName } from './guard-core.mjs';
import { checkNotices, EMPTY, freshPorts, noteStart, observable, takeQueued } from './observe.mjs';

export const SETTLE_MS = 15_000;
const POLL_MS = 1_000;
// An agent reading files makes several calls a second; a scan this recent stands.
const RESCAN_MS = 3_000;
const STALE_MS = 24 * 60 * 60_000;
const TRANSCRIPT_TAIL = 512 * 1024;
const SHELL_TOOLS = new Set(['Bash', 'run_terminal_command']);

/** Grok's envelope carries camelCase keys next to Claude's snake_case ones; Codex sends snake_case only. */
export function agentOf(input) {
  return 'hookEventName' in input ? 'grok' : 'codex';
}

export function stateFile(configDir, agent, session) {
  return path.join(configDir, 'agent-observe', `${agent}-${String(session).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

/**
 * The directory Codex ran a shell call in, from the call in the transcript: its `workdir`
 * resolved against the turn cwd, null when it has none, undefined when the call is not there.
 */
export function codexWorkdir(transcript, callId, cwd) {
  const needle = `"call_id":"${callId}"`;
  for (const line of String(transcript || '').split('\n').reverse()) {
    if (!line.includes(needle) || !line.includes('"function_call"')) continue;
    try {
      const { payload } = JSON.parse(line);
      if (!payload || payload.type !== 'function_call' || payload.call_id !== callId) continue;
      const { workdir } = JSON.parse(payload.arguments || '{}');
      return typeof workdir === 'string' && workdir ? path.resolve(cwd, workdir) : null;
    } catch { /* the tail's first line is cut */ }
  }
  return undefined;
}

/** The transcript is written as the call is made; give it a moment before taking the turn cwd. */
async function workdirOf(input, io) {
  if (!input.transcript_path || !input.tool_use_id) return null;
  for (let i = 0; i < 5; i++) {
    const found = codexWorkdir(io.tail(input.transcript_path), input.tool_use_id, input.cwd);
    if (found !== undefined) return found;
    await io.sleep(100);
  }
  return null;
}

async function note(input, agent, file, io) {
  if (!SHELL_TOOLS.has(input.tool_name)) return;
  const command = input.tool_input && input.tool_input.command;
  const start = typeof command === 'string' ? parseStart(command) : null;
  if (!start) return;
  const config = io.read(path.join(io.configDir, 'portpilot-config.json'));
  const sessionCwd = (agent === 'codex' && await workdirOf(input, io)) || input.cwd;
  if (!sessionCwd) return;
  const c = { start, sessionCwd, config, home: io.home, windows: io.windows };
  const where = observable(c);
  if (!where) return;
  const listeners = await io.scan();
  if (!listeners) return;
  io.prune(path.dirname(file), STALE_MS);
  const pkg = io.read(path.join(where.cwd, 'package.json'));
  io.write(file, noteStart(io.read(file) || EMPTY, { ...c, listeners, now: io.now(), pkg }));
}

/** One new-port check, its notice queued, the new ports' holders named first. */
async function check(state, config, label, io) {
  const runtime = io.read(path.join(io.configDir, 'portpilot-runtime.json'));
  const listeners = await io.scan();
  if (listeners) for (const p of freshPorts(state, { config, runtime, listeners })) await io.nameHolder(listeners, p);
  const now = io.now();
  const r = checkNotices(state, { config, runtime, listeners }, now, label);
  const queue = [...r.state.queue, ...r.notices.map((text) => ({ text, at: now }))];
  return { ...r.state, checkedAt: now, queue, ...(r.notices.length ? { noticedAt: now } : {}) };
}

function save(file, state, io) {
  if (state.notes.length || state.queue.length) io.write(file, state);
  else io.remove(file);
}

/**
 * Answer one hook event.
 * @returns {object|null}  the JSON to print, or null for nothing
 */
export async function handle(input, io) {
  const event = input.hook_event_name;
  const session = input.session_id;
  if (!session) return null;
  const agent = agentOf(input);
  const file = stateFile(io.configDir, agent, session);
  if (event === 'PreToolUse') {
    await note(input, agent, file, io);
    return null;
  }
  if (event !== 'PostToolUse' && event !== 'Stop') return null;
  // Grok also runs Stop at session end (reason channel_closed or shutdown), with no turn to continue.
  if (event === 'Stop' && ((input.reason && input.reason !== 'end_turn') || input.stop_hook_active)) return null;
  if (!io.exists(file)) return null;

  const config = io.read(path.join(io.configDir, 'portpilot-config.json'));
  const label = `${agent}:${session}`;
  let state = io.read(file) || EMPTY;
  if (event === 'PostToolUse') {
    if (state.notes.length && io.now() - (state.checkedAt || 0) >= RESCAN_MS) state = await check(state, config, label, io);
  } else {
    for (;;) {
      if (state.notes.length) state = await check(state, config, label, io);
      const youngest = Math.max(0, ...state.notes.map((n) => n.at));
      // A start whose port was already reported has nothing left to wait for.
      if (state.queue.length || !state.notes.length || io.now() - youngest >= SETTLE_MS || (state.noticedAt || 0) >= youngest) break;
      await io.sleep(POLL_MS);
    }
  }
  const { state: after, notices } = takeQueued(state, config, io.now());
  save(file, after, io);
  if (!notices.length) return null;
  const text = notices.join('\n\n');
  return event === 'Stop'
    ? { decision: 'block', reason: text }
    : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
}

/** Mirrors computeDir() in src/core/configPath.js. */
function configDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'portpilot');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'portpilot');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'portpilot');
}

/** Scans run asynchronously: inside PortPilot this answers Grok on the app's main thread. */
export function realIo() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const execFileAsync = promisify(execFile);
  const run = async (cmd, args) => (await execFileAsync(cmd, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const names = new Map();
  return {
    configDir: configDir(),
    home: os.homedir(),
    windows: platform === 'win32',
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exists: (file) => fs.existsSync(file),
    read: (file) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    },
    write: (file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
    remove: (file) => {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
    prune: (dir, maxAge) => {
      try {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          if (Date.now() - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p);
        }
      } catch { /* nothing to prune */ }
    },
    scan: async () => {
      const tries = platform === 'win32' ? [['netstat', ['-ano']]]
        : platform === 'darwin' ? [['lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P']]]
        : [['ss', ['-tlnp']], ['netstat', ['-tlnp']]];
      for (const [cmd, args] of tries) {
        try { return parseListeners(platform, await run(cmd, args)); } catch { /* try the next */ }
      }
      return null;
    },
    // netstat -ano names no process: one tasklist per PID (Windows only, as in register.tsx).
    nameHolder: async (listeners, port) => {
      const holder = listeners.get(port);
      if (platform !== 'win32' || !holder || !holder.pid || holder.processName !== 'Unknown') return;
      if (!names.has(holder.pid)) {
        let name = null;
        try { name = parseTasklistName(await run('tasklist', ['/FI', `PID eq ${holder.pid}`, '/FO', 'CSV', '/NH'])) || null; } catch { /* stays Unknown */ }
        names.set(holder.pid, name);
      }
      const name = names.get(holder.pid);
      if (name) listeners.set(port, { ...holder, processName: name });
    },
    tail: (file) => {
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, TRANSCRIPT_TAIL);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8');
      } catch {
        return '';
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    },
  };
}

/**
 * The event, read up to the first point it parses: on Windows a command the agent backgrounded
 * can hold the pipe open, so EOF may never come.
 */
export function readEvent(stream) {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
      if (!chunk.includes('\n')) return;
      try { resolve(JSON.parse(text)); } catch { /* not whole yet */ }
    });
    stream.on('end', () => {
      try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
    });
    stream.on('error', reject);
  });
}

async function main() {
  try {
    const out = await handle(await readEvent(process.stdin), realIo());
    if (out) {
      process.stdout.write(JSON.stringify(out), () => process.exit(0));
      return;
    }
  } catch { /* fail open */ }
  process.exit(0);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) await main();
