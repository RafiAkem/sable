/**
 * NusaCode (https://www.npmjs.com/package/nusacode): NusaGate's terminal coding agent, built on pi.
 * Each session runs `nusacode --mode rpc` and speaks pi's JSONL protocol (commands on stdin,
 * responses and events on stdout; see pi's docs/rpc.md). Sign-in is NusaGate's PKCE flow, the same
 * one NusaCode's `/login` runs (pack/lib/login.ts), since pi has no login command over RPC: the
 * resulting API key goes to the agent folder's `auth.json`, where NusaCode reads it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type {
  Attachment,
  AuthState,
  Capabilities,
  CommandInfo,
  Effort,
  HistoryEntry,
  ModelInfo,
  NoticeItem,
  ProviderInfo,
  Question,
  RateLimit,
  TextItem,
  ThinkingItem,
  TimelineItem,
  ToolItem,
  ToolResult,
  TurnItem,
  UserItem,
} from '../../shared/protocol';
import { makeFileDiff, parseUnifiedDiff } from '../../shared/diff';
import type { SessionRuntime } from '../core/runtime';
import { describeTool, type ToolView } from './claude-tools';
import { NUSAGATE_PLAN } from './plans';
import type { Provider, ProviderContext, ProviderSession } from './types';

type Obj = Record<string, any>;

const SITE_URL = (process.env.NUSACODE_SITE_URL ?? 'https://nusagate.com').replace(/\/+$/, '');
const API_URL = (process.env.NUSAGATE_API_URL ?? 'https://api.nusagate.com').replace(/\/+$/, '');
/** The name the NusaGate dashboard shows on the key ("Sable (login)"); the same in the URL and the exchange. */
const APP_NAME = 'Sable';
/** pi's thinking levels Sable can show; "off" has no Effort and reads as minimal. */
const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** shortcut: only the npm global install (Sable is Windows-only) or NUSACODE_BIN; add pnpm/bun paths if someone needs them. */
export function nusacodeCli(): string | undefined {
  const candidates = [process.env.NUSACODE_BIN, process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'nusacode', 'bin', 'nusacode.js')];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ─────────────────────────────── the RPC pipe ───────────────────────────────

/** One `nusacode --mode rpc` process: correlates responses by id, hands everything else to `onRecord`. */
export class PiRpc {
  private proc: ChildProcess;
  private buf = '';
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = '';
  exited = false;
  onRecord: (r: Obj) => void = () => {};
  onExit: (why: string) => void = () => {};

  constructor(cli: string, cwd: string, home: string | undefined, args: string[] = []) {
    // In the desktop app execPath is Sable.exe, not Node: use the Node that installed NusaCode.
    this.proc = spawn(process.versions.electron ? 'node' : process.execPath, [cli, '--mode', 'rpc', ...args], {
      cwd,
      env: { ...process.env, ...(home ? { NUSACODE_HOME: home } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout!.setEncoding('utf8');
    // Split on LF only: readline would also split on U+2028/U+2029, which are valid inside JSON strings.
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.handle(line);
      }
    });
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.on('error', (err) => this.finish(err.message));
    this.proc.on('exit', (code, signal) => this.finish(`NusaCode exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    this.proc.stdin!.on('error', () => {});
  }

  private handle(line: string) {
    let r: Obj;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (r.type === 'response' && typeof r.id === 'string' && this.pending.has(r.id)) {
      const p = this.pending.get(r.id)!;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.success) p.resolve(r.data);
      else p.reject(new Error(r.error ?? `${r.command} failed`));
      return;
    }
    this.onRecord(r);
  }

  private finish(why: string) {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    this.onExit(why);
  }

  write(record: Obj) {
    if (!this.exited) this.proc.stdin!.write(JSON.stringify(record) + '\n');
  }

  request<T = any>(type: string, params: Obj = {}, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error('NusaCode is not running'));
    const id = `s${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`NusaCode did not answer ${type} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, type, ...params });
    });
  }

  /** Closing stdin asks pi to shut down in order; a process that lingers is killed. */
  close() {
    if (this.exited) return;
    this.proc.stdin!.end();
    setTimeout(() => this.proc.kill(), 3000).unref();
  }
}

// ──────────────────────────────── mapping ────────────────────────────────

export const modelKey = (m: Obj): string => `${m.provider}/${m.id}`;

export function mapModel(m: Obj, current?: string): ModelInfo {
  return {
    id: modelKey(m),
    name: String(m.name ?? m.id).replace(/\s*\(vision\)$/i, ''),
    efforts: m.reasoning ? EFFORTS.slice(0, 5) : undefined,
    defaultEffort: m.reasoning ? 'medium' : undefined,
    isDefault: current ? modelKey(m) === current : undefined,
  };
}

const toEffort = (level: unknown): Effort | undefined => (level === 'off' ? 'minimal' : EFFORTS.includes(level as Effort) ? (level as Effort) : undefined);

/** pi's tools under Claude Code's names, so `describeTool` titles and details them. */
export function describePi(name: string, args: Obj = {}, cwd = ''): ToolView {
  const abs = (p: unknown) => (typeof p === 'string' && p ? path.resolve(cwd, p) : undefined);
  switch (name) {
    case 'bash':
    case 'powershell':
      return describeTool('Bash', { command: args.command });
    case 'read':
      return describeTool('Read', { file_path: abs(args.path), offset: args.offset, limit: args.limit });
    case 'edit':
      return describeTool('MultiEdit', {
        file_path: abs(args.path),
        edits: Array.isArray(args.edits) ? args.edits.map((e: Obj) => ({ old_string: e?.oldText, new_string: e?.newText })) : [],
      });
    case 'write':
      return describeTool('Write', { file_path: abs(args.path), content: args.content });
    case 'grep':
      return describeTool('Grep', { pattern: args.pattern, path: abs(args.path), glob: args.glob });
    case 'find':
      return describeTool('Glob', { pattern: args.pattern, path: abs(args.path) });
    case 'ls':
      return { kind: 'glob', title: `List ${path.basename(abs(args.path) ?? cwd) || 'folder'}`, detail: { path: abs(args.path) ?? cwd } };
    case 'task':
      return describeTool('Task', { description: args.description ?? args.task, prompt: args.prompt ?? args.task, subagent_type: args.agent });
    case 'ask':
      return describeTool('AskUserQuestion', { questions: args.questions });
    default:
      return describeTool(name, args);
  }
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text)
          .join('')
      : '';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

export function mapResult(name: string, args: Obj, result: Obj | undefined, isError: boolean, cwd = ''): ToolResult {
  const text = stripAnsi(textOf(result?.content));
  const images = Array.isArray(result?.content) ? result!.content.filter((c: Obj) => c?.type === 'image').map((c: Obj) => `data:${c.mimeType};base64,${c.data}`) : [];
  const out: ToolResult = { text, isError: isError || undefined, ...(images.length ? { images } : {}) };
  if (isError) return out;
  const abs = typeof args.path === 'string' ? path.resolve(cwd, args.path) : undefined;
  if (name === 'edit' && typeof result?.details?.patch === 'string') {
    const diff = parseUnifiedDiff(result.details.patch).map((d) => ({ ...d, path: abs ?? d.path }));
    if (diff.length) out.diff = diff;
  } else if (name === 'write' && abs && typeof args.content === 'string') {
    out.diff = [makeFileDiff(abs, null, args.content)];
  } else if (name === 'read' && abs) {
    out.file = { path: abs, content: text };
  }
  return out;
}

/** A finished conversation (`get_messages`) as timeline items. */
export function transcript(messages: Obj[], cwd: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, ToolItem>();
  for (const m of messages) {
    const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) items.push({ id: randomUUID(), ts, type: 'user', text, state: 'sent' } satisfies UserItem);
    } else if (m.role === 'assistant') {
      for (const c of m.content ?? []) {
        if (c.type === 'text' && c.text) items.push({ id: randomUUID(), ts, type: 'text', text: c.text, streaming: false } satisfies TextItem);
        else if (c.type === 'thinking' && c.thinking) items.push({ id: randomUUID(), ts, type: 'thinking', text: c.thinking, streaming: false, endedAt: ts } satisfies ThinkingItem);
        else if (c.type === 'toolCall') {
          const v = describePi(c.name, c.arguments, cwd);
          const t: ToolItem = { id: randomUUID(), ts, type: 'tool', name: c.name, ...v, status: 'done', input: c.arguments, endedAt: ts };
          tools.set(c.id, t);
          items.push(t);
        }
      }
      if (m.stopReason === 'error' && m.errorMessage) items.push({ id: randomUUID(), ts, type: 'notice', variant: 'error', text: m.errorMessage } satisfies NoticeItem);
    } else if (m.role === 'toolResult') {
      const t = tools.get(m.toolCallId);
      if (t) {
        t.result = mapResult(m.toolName, (t.input as Obj) ?? {}, m, !!m.isError, cwd);
        t.status = m.isError ? 'error' : 'done';
        t.endedAt = ts;
      }
    }
  }
  return items;
}

// ──────────────────────────────── sign-in ────────────────────────────────

/** NusaGate's PKCE sign-in, as in NusaCode's pack/lib/login.ts: resolves with an API key. */
export async function signInWithNusaGate(onUrl: (url: string) => void, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('Sign-in cancelled');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const servers: Server[] = [];
  try {
    const landed = new Promise<URL>((resolve, reject) => {
      const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') return void res.writeHead(404).end();
        const ok = url.searchParams.has('code');
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Sable</title><body style="font:16px system-ui;padding:48px"><h1 style="font-size:22px">${ok ? 'Signed in to NusaGate' : 'Sign-in did not finish'}</h1><p>You can close this tab and go back to Sable.</p>`);
        resolve(url);
      };
      servers.push(createServer(handler), createServer(handler));
      signal.addEventListener('abort', () => reject(new Error('Sign-in cancelled')), { once: true });
    });
    // A cancel while the listeners start rejects before anything awaits: keep it from going unhandled.
    landed.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      servers[0].once('error', reject);
      servers[0].listen(0, '127.0.0.1', resolve);
    });
    const { port } = servers[0].address() as AddressInfo;
    // The site may send the browser back to localhost, which can resolve to ::1: listen there too.
    await new Promise<void>((resolve) => {
      servers[1].once('error', () => resolve());
      servers[1].listen(port, '::1', resolve);
    });
    if (signal.aborted) throw new Error('Sign-in cancelled'); // never open a browser for a cancelled sign-in
    const connect = new URL('/dashboard/connect', SITE_URL);
    connect.search = new URLSearchParams({ callback_url: `http://127.0.0.1:${port}/callback`, code_challenge: challenge, code_challenge_method: 'S256', app: APP_NAME, state }).toString();
    onUrl(connect.toString());
    const back = await landed;
    if (back.searchParams.get('error')) throw new Error(back.searchParams.get('error') === 'access_denied' ? 'Sign-in was cancelled' : `Sign-in failed: ${back.searchParams.get('error')}`);
    if (back.searchParams.get('state') !== state) throw new Error('The sign-in answer did not match this request');
    const res = await fetch(`${SITE_URL}/api/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: back.searchParams.get('code'), code_verifier: verifier, app: APP_NAME }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { apiKey?: unknown; message?: unknown };
    if (!res.ok || typeof body.apiKey !== 'string') throw new Error(typeof body.message === 'string' ? body.message : `NusaGate refused the sign-in (${res.status})`);
    return body.apiKey;
  } finally {
    for (const s of servers) s.close();
  }
}

/**
 * Saves a NusaGate key into an agent folder's auth.json the way NusaCode's /setup does (`saveApiKey` in
 * pack/extensions/setup.ts): an `api_key` entry every NusaCode version reads, written atomically and
 * private. An auth.json that does not parse is left alone rather than replaced.
 */
export function saveApiKey(home: string, key: string) {
  const target = path.join(home, 'auth.json');
  let auth: Obj = {};
  if (existsSync(target)) {
    try {
      auth = JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      throw new Error(`${target} could not be read; fix or remove it, then sign in again`);
    }
  }
  mkdirSync(home, { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...auth, nusagate: { type: 'api_key', key } }, null, 2)}
`, { mode: 0o600 });
  renameSync(temp, target);
}

/** Opens a link in the default browser (rundll32 takes the URL as one argument, unlike `start`). */
function openBrowser(url: string) {
  try {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the sign-in card shows the link too */
  }
}

// ──────────────────────────────── provider ────────────────────────────────

export class NusaCodeProvider implements Provider {
  readonly id = 'nusacode' as const;
  readonly name = 'NusaCode';
  private caps0?: Promise<Capabilities>;
  private loginAbort?: AbortController;
  private lastLimits: RateLimit[] = [];

  constructor(private ctx: ProviderContext) {}

  /** NusaCode's home folder: an extra account's own, else NUSACODE_HOME or ~/.nusacode. */
  configHome(): string {
    return this.ctx.account?.dir ?? process.env.NUSACODE_HOME ?? path.join(os.homedir(), '.nusacode');
  }

  /** Extra accounts point NusaCode at their own folder; the default one runs as the terminal does. */
  private homeEnv(): string | undefined {
    return this.ctx.account?.dir;
  }

  private authFile() {
    return path.join(this.configHome(), 'auth.json');
  }

  private readAuth(): Obj {
    try {
      return JSON.parse(readFileSync(this.authFile(), 'utf8'));
    } catch {
      return {};
    }
  }

  /** The NusaGate API key NusaCode would use: its saved sign-in, else NUSAGATE_API_KEY (default account only). */
  private apiKey(): string | undefined {
    const c = this.readAuth().nusagate;
    const key = c?.type === 'oauth' ? c.access : c?.key;
    if (typeof key === 'string' && key) return key;
    return this.ctx.account ? undefined : process.env.NUSAGATE_API_KEY || undefined;
  }

  async info(): Promise<ProviderInfo> {
    const cli = nusacodeCli();
    const base = { id: this.id, name: this.name };
    if (!cli) return { ...base, installed: false, auth: { loggedIn: false }, problem: 'NusaCode is not installed. Run npm install -g nusacode.' };
    let version: string | undefined;
    try {
      version = JSON.parse(readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8')).version;
    } catch {
      /* unknown */
    }
    const auth: AuthState = this.apiKey() ? { loggedIn: true, method: 'nusagate', ...NUSAGATE_PLAN } : { loggedIn: false };
    return { ...base, installed: true, version, auth };
  }

  async login(): Promise<void> {
    await this.cancelLogin();
    const ctrl = new AbortController();
    this.loginAbort = ctrl;
    try {
      const key = await signInWithNusaGate((url) => {
        this.ctx.emit({ type: 'auth.progress', provider: this.id, state: 'url', url });
        openBrowser(url);
      }, ctrl.signal);
      saveApiKey(this.configHome(), key);
      this.caps0 = undefined;
    } finally {
      if (this.loginAbort === ctrl) this.loginAbort = undefined;
    }
  }

  async cancelLogin() {
    this.loginAbort?.abort();
    this.loginAbort = undefined;
  }

  async logout() {
    const all = this.readAuth();
    if (!all.nusagate) return;
    delete all.nusagate;
    writeFileSync(this.authFile(), JSON.stringify(all, null, 2));
  }

  /** Models and commands from a short-lived RPC process (no prompt, so nothing is billed), kept for later. */
  caps(cwd?: string): Promise<Capabilities> {
    this.caps0 ??= this.readCaps(cwd ?? os.homedir()).catch((err) => {
      this.caps0 = undefined;
      throw err;
    });
    return this.caps0;
  }

  private async readCaps(cwd: string, rpc?: PiRpc): Promise<Capabilities> {
    const cli = nusacodeCli();
    if (!cli) return capabilities([], []);
    const own = !rpc;
    rpc ??= new PiRpc(cli, cwd, this.homeEnv(), ['--no-session']);
    try {
      const [state, models, commands] = await Promise.all([rpc.request('get_state'), rpc.request('get_available_models'), rpc.request('get_commands')]);
      const current = state?.model ? modelKey(state.model) : undefined;
      return capabilities((models?.models ?? []).map((m: Obj) => mapModel(m, current)), commands?.commands ?? []);
    } finally {
      if (own) rpc.close();
    }
  }

  /** Balance and Coding Plan quota from `GET /v1/balance`: the plan shows as a limit, the wallet as credits. */
  async limits(): Promise<RateLimit[]> {
    const key = this.apiKey();
    if (!key) return [];
    try {
      const res = await fetch(`${API_URL}/v1/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return this.lastLimits;
      const body = (await res.json()) as Obj;
      const limits: RateLimit[] = [];
      const pass = body.pass;
      if (pass && typeof pass.valueTotalIdr === 'number' && pass.valueTotalIdr > 0 && typeof pass.valueRemainingIdr === 'number') {
        const ends = Date.parse(pass.endsAt);
        const mins = Math.round((ends - Date.parse(pass.startsAt)) / 60_000);
        limits.push({
          id: 'nusagate:pass',
          label: 'Coding Plan',
          // A week or a month plan: its length from the pass itself.
          ...(mins > 0 ? { windowMins: mins } : {}),
          percent: Math.max(0, Math.min(100, Math.round((1 - pass.valueRemainingIdr / pass.valueTotalIdr) * 100))),
          ...(Number.isFinite(ends) ? { resetsAt: ends } : {}),
        });
      }
      const balance = typeof body.balance === 'number' ? `Rp${Math.floor(body.balance).toLocaleString('id-ID')}` : undefined;
      this.lastLimits = limits;
      this.ctx.emit({ type: 'limits.updated', provider: this.id, limits, meta: { planLimits: limits.length > 0, ...(balance ? { credits: { balance } } : {}) } });
      return limits;
    } catch {
      return this.lastLimits;
    }
  }

  /** Saved NusaCode sessions (`<home>/sessions/*.jsonl`), newest first. */
  async history(cwd?: string, limit = 50): Promise<HistoryEntry[]> {
    const dir = path.join(this.configHome(), 'sessions');
    let files: { file: string; mtime: number }[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ file: path.join(dir, f), mtime: statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
    const out: HistoryEntry[] = [];
    for (const { file, mtime } of files) {
      if (out.length >= limit) break;
      const e = readSessionHead(file);
      if (!e?.id || !e.prompt) continue;
      if (cwd && (!e.cwd || path.resolve(e.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase())) continue;
      out.push({ provider: this.id, providerSessionId: e.id, title: e.name ?? firstLine(e.prompt), cwd: e.cwd, updatedAt: mtime, preview: e.prompt.slice(0, 200) });
    }
    return out;
  }

  async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const cli = nusacodeCli();
    if (!cli) throw new Error('NusaCode is not installed. Run npm install -g nusacode.');
    const resume = rt.meta.providerSessionId;
    const rpc = new PiRpc(cli, rt.meta.cwd, this.homeEnv(), resume ? ['--session', resume] : []);
    const session = new NusaCodeSession(rt, rpc, this.ctx);
    try {
      const caps = await this.readCaps(rt.meta.cwd, rpc);
      rt.setCaps(caps);
      const [model, effort] = [rt.meta.model, rt.meta.effort];
      if (model) await session.setModel(model, true).catch(() => {});
      if (effort) await session.setEffort(effort).catch(() => {});
      const state = await rpc.request('get_state');
      rt.update({
        providerSessionId: state.sessionId,
        model: state.model ? modelKey(state.model) : model,
        effort: toEffort(state.thinkingLevel) ?? effort,
        mode: rt.meta.mode || 'default',
        usage: { ...rt.meta.usage, contextWindow: state.model?.contextWindow ?? rt.meta.usage.contextWindow },
      });
      if (resume && opts.loadTranscript) {
        const r = await rpc.request('get_messages');
        rt.reset(transcript(r?.messages ?? [], rt.meta.cwd));
      }
    } catch (err) {
      rpc.close();
      throw err;
    }
    void this.limits();
    return session;
  }

  async dispose() {
    await this.cancelLogin();
  }
}

function capabilities(models: ModelInfo[], commands: Obj[]): Capabilities {
  return {
    models,
    modes: [{ id: 'default', name: 'Default', description: 'NusaCode runs tools without asking, as in the terminal.', tone: 'auto' }],
    commands: commands
      .filter((c) => c.source !== 'skill')
      .map((c): CommandInfo => ({ name: c.name, description: c.description ?? '', kind: c.source === 'prompt' ? 'command' : 'builtin', source: c.sourceInfo?.scope })),
    skills: commands.filter((c) => c.source === 'skill').map((c) => ({ name: String(c.name).replace(/^skill:/, ''), description: c.description ?? '', path: c.sourceInfo?.path })),
    agents: [],
    mcpServers: [],
    tools: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'],
    skillTrigger: '/',
    features: { images: models.length > 0, thinking: true, rewind: false, steer: true, compact: true, fast: false },
  };
}

function firstLine(text: string, max = 80) {
  const one = text.trim().split('\n')[0] ?? '';
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** The header, name and first prompt of a session file, from its first 256 KB. */
export function readSessionHead(file: string): { id?: string; cwd?: string; name?: string; prompt?: string } | undefined {
  let text: string;
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    text = buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  }
  const out: { id?: string; cwd?: string; name?: string; prompt?: string } = {};
  for (const line of text.split('\n')) {
    let r: Obj;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === 'session') [out.id, out.cwd] = [r.id, r.cwd];
    else if (r.type === 'session_info' && typeof r.name === 'string') out.name = r.name;
    else if (r.type === 'message' && r.message?.role === 'user' && !out.prompt) out.prompt = textOf(r.message.content);
    if (out.id && out.prompt && out.name) break;
  }
  return out;
}

// ──────────────────────────────── session ────────────────────────────────

export class NusaCodeSession implements ProviderSession {
  private running = false;
  /**
   * Runs pi still owes an `agent_settled` for, counted from when the prompt is sent. A stopped run
   * can settle after Sable has already ended its turn and started the next one: while a newer run
   * is still owed, that late settle belongs to the old run and is ignored.
   */
  private owed = 0;
  private queue: UserItem[] = [];
  /** Steered messages pi has queued, by text, until it takes them. */
  private steers: UserItem[] = [];
  /** contentIndex → item id, for the assistant message streaming now. */
  private blocks = new Map<number, string>();
  /** pi toolCall id → tool item id. */
  private tools = new Map<string, string>();
  private turnStart = 0;
  private turnTokens = { input: 0, output: 0 };
  private lastError?: string;
  /** Set while a stop is under way: what pi then reports as failures is the stop itself. */
  private stopping = false;

  constructor(
    private rt: SessionRuntime,
    private rpc: PiRpc,
    private ctx: ProviderContext,
  ) {
    rpc.onRecord = (r) => {
      try {
        this.onRecord(r);
      } catch (err) {
        ctx.log('nusacode event failed', r?.type, err);
      }
    };
    rpc.onExit = (why) => {
      this.owed = 0;
      if (!this.running) return;
      this.rt.settle('error');
      this.rt.notice('error', 'NusaCode stopped', why);
      this.finish(why);
    };
  }

  async send(item: UserItem): Promise<void> {
    if (this.running && item.steered) {
      this.steers.push(item);
      await this.rpc.request('steer', payload(item)).catch((err) => this.rt.notice('error', 'Could not steer', errMsg(err)));
      return;
    }
    if (this.running) {
      this.queue.push(item);
      if (item.state !== 'queued') this.rt.patch<UserItem>(item.id, { state: 'queued' });
      return;
    }
    await this.start(item);
  }

  private async start(item: UserItem) {
    this.running = true;
    this.turnStart = Date.now();
    this.turnTokens = { input: 0, output: 0 };
    this.lastError = undefined;
    this.stopping = false;
    if (item.state === 'queued') this.rt.taken(item.id);
    this.rt.beginTurn('Thinking');
    this.owed++;
    try {
      const r = await this.rpc.request('prompt', payload(item));
      // An extension command (/usage, /budget…) answers by itself: no run follows.
      if (r?.disposition === 'handled') {
        this.owed--;
        this.finish();
      }
    } catch (err) {
      this.owed--;
      this.rt.notice('error', 'NusaCode refused the message', errMsg(err));
      this.finish(errMsg(err));
    }
  }

  private finish(error?: string) {
    if (!this.running) return;
    this.running = false;
    this.blocks.clear();
    this.rt.add<TurnItem>({ type: 'turn', durationMs: Date.now() - this.turnStart, inputTokens: this.turnTokens.input, outputTokens: this.turnTokens.output, error });
    this.rt.update({ usage: { ...this.rt.meta.usage, turns: this.rt.meta.usage.turns + 1 } });
    // Steers pi never took go first in the next turn.
    this.queue.unshift(...this.steers.map((s) => ({ ...s, steered: false })));
    this.steers = [];
    this.rt.endTurn(error);
    const next = this.queue.shift();
    if (next) void this.start(next);
  }

  private onRecord(r: Obj) {
    const rt = this.rt;
    switch (r.type) {
      case 'message_start': {
        const m = r.message;
        if (m?.role === 'assistant') this.blocks.clear();
        else if (m?.role === 'user') {
          const text = textOf(m.content);
          const at = this.steers.findIndex((s) => s.text === text || text.includes(s.text));
          if (at >= 0) rt.taken(this.steers.splice(at, 1)[0].id);
        }
        return;
      }
      case 'message_update':
        return this.onStream(r.assistantMessageEvent ?? {});
      case 'message_end': {
        const m = r.message;
        if (m?.role !== 'assistant') return;
        for (const id of this.blocks.values()) {
          const it = rt.get(id);
          if ((it?.type === 'text' || it?.type === 'thinking') && it.streaming) rt.patch(id, { streaming: false, ...(it.type === 'thinking' ? { endedAt: Date.now() } : {}) } as Partial<TimelineItem>);
        }
        const u = m.usage ?? {};
        const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        this.turnTokens.input += input;
        this.turnTokens.output += u.output ?? 0;
        const usage = rt.meta.usage;
        rt.update({
          usage: { ...usage, inputTokens: usage.inputTokens + (u.input ?? 0), outputTokens: usage.outputTokens + (u.output ?? 0), cacheReadTokens: (usage.cacheReadTokens ?? 0) + (u.cacheRead ?? 0), contextTokens: input + (u.output ?? 0) || usage.contextTokens },
        });
        if (m.stopReason === 'error' && m.errorMessage && !this.stopping) {
          this.lastError = m.errorMessage;
          rt.notice('error', m.errorMessage);
        }
        return;
      }
      case 'tool_execution_start': {
        const id = this.toolItem(r.toolCallId, r.toolName, r.args);
        rt.patch<ToolItem>(id, { status: 'running', input: r.args, ...describePi(r.toolName, r.args, rt.meta.cwd) });
        rt.update({ activity: rt.get<ToolItem>(id)?.title });
        return;
      }
      case 'tool_execution_update': {
        const id = this.tools.get(r.toolCallId);
        const text = textOf(r.partialResult?.content);
        if (id && text) rt.patch<ToolItem>(id, { output: stripAnsi(text) });
        return;
      }
      case 'tool_execution_end': {
        const id = this.toolItem(r.toolCallId, r.toolName, r.args);
        const input = (rt.get<ToolItem>(id)?.input as Obj) ?? r.args ?? {};
        rt.patch<ToolItem>(id, { status: r.isError ? (this.stopping ? 'cancelled' : 'error') : 'done', result: mapResult(r.toolName, input, r.result, !!r.isError, rt.meta.cwd), output: undefined, endedAt: Date.now() });
        rt.update({ activity: 'Thinking' });
        return;
      }
      case 'agent_settled':
        this.owed = Math.max(0, this.owed - 1);
        if (this.owed > 0) return; // a stopped run settling late: the current turn is still going
        // Anything still running at the end was cut off: by the stop, or by a failure.
        rt.settle(r.aborted ? 'cancelled' : 'error');
        return this.finish(r.aborted ? undefined : this.lastError);
      case 'auto_retry_start':
        rt.notice('retry', `Retrying (${r.attempt} of ${r.maxAttempts})`, r.errorMessage);
        return;
      case 'compaction_start':
        rt.notice('compact', 'Compacting the conversation');
        return;
      case 'compaction_end':
        if (r.errorMessage) rt.notice('error', 'Compaction failed', r.errorMessage);
        return;
      case 'extension_ui_request':
        return void this.onUi(r);
      case 'extension_error':
        this.ctx.log('nusacode extension error', r.extensionPath, r.error);
        return;
    }
  }

  private onStream(e: Obj) {
    const rt = this.rt;
    const at = e.contentIndex as number;
    switch (e.type) {
      case 'text_start':
      case 'thinking_start':
        this.block(at, e.type === 'text_start' ? 'text' : 'thinking');
        return;
      case 'text_delta':
      case 'thinking_delta':
        rt.delta(this.block(at, e.type === 'text_delta' ? 'text' : 'thinking'), 'text', e.delta ?? '');
        return;
      case 'text_end':
      case 'thinking_end': {
        const id = this.blocks.get(at);
        if (id && typeof e.content === 'string') rt.patch(id, { text: e.content, streaming: false, ...(e.type === 'thinking_end' ? { endedAt: Date.now() } : {}) } as Partial<TimelineItem>);
        return;
      }
      case 'toolcall_start': {
        const id = this.toolItem(e.id, e.toolName, {});
        this.blocks.set(at, id);
        return;
      }
      case 'toolcall_delta': {
        const id = this.blocks.get(at);
        if (id) rt.delta(id, 'inputText', e.delta ?? '');
        return;
      }
      case 'toolcall_end': {
        const c = e.toolCall ?? {};
        const id = this.toolItem(c.id, c.name, c.arguments);
        rt.patch<ToolItem>(id, { input: c.arguments, inputText: undefined, ...describePi(c.name, c.arguments, rt.meta.cwd) });
        return;
      }
    }
  }

  /** The streaming text or thinking item for a content block, added on first sight. */
  private block(at: number, type: 'text' | 'thinking'): string {
    let id = this.blocks.get(at);
    if (!id) {
      id = type === 'text' ? this.rt.add<TextItem>({ type, text: '', streaming: true }).id : this.rt.add<ThinkingItem>({ type, text: '', streaming: true }).id;
      this.blocks.set(at, id);
      if (type === 'text') this.rt.update({ activity: 'Writing' });
    }
    return id;
  }

  /** The tool item for a pi tool call, added on first sight. */
  private toolItem(callId: string, name: string, args: Obj = {}): string {
    let id = this.tools.get(callId);
    if (!id) {
      id = this.rt.add<ToolItem>({ type: 'tool', name, ...describePi(name, args, this.rt.meta.cwd), status: 'pending', input: args }).id;
      this.tools.set(callId, id);
    }
    return id;
  }

  /** Extension dialogs (select, confirm, input, editor) become question cards; the rest is shown or ignored. */
  private async onUi(r: Obj) {
    const reply = (answer: Obj) => this.rpc.write({ type: 'extension_ui_response', id: r.id, ...answer });
    switch (r.method) {
      case 'notify':
        if (r.message) this.rt.notice(r.notifyType === 'error' ? 'error' : 'info', String(r.message));
        return;
      case 'select':
      case 'confirm':
      case 'input':
      case 'editor': {
        const header = r.method === 'confirm' ? 'Confirm' : 'NusaCode';
        const options = r.method === 'select' ? (r.options ?? []).map((o: unknown) => ({ label: String(o) })) : r.method === 'confirm' ? [{ label: 'Yes' }, { label: 'No' }] : [];
        const q: Question = { question: [r.title, r.message].filter(Boolean).join('\n\n') || 'NusaCode asks', header, options };
        const ans = await this.rt.ask([q]);
        const picked = ans ? Object.values(ans)[0]?.[0] : undefined;
        if (picked === undefined) return reply({ cancelled: true });
        if (r.method === 'confirm') return reply({ confirmed: picked === 'Yes' });
        return reply({ value: picked });
      }
      default:
        // setStatus, setWidget, setTitle, set_editor_text: terminal chrome with no place in Sable.
        return;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.rt.notice('interrupted', 'Interrupted');
    await this.rpc.request('clear_queue').catch(() => {});
    await this.rpc.request('abort', {}, 60_000).catch(() => {});
    // pi ends an aborted run with agent_settled; make sure the turn ends even if it did not.
    this.rt.settle('cancelled');
    this.finish();
  }

  async setModel(model: string, quiet = false): Promise<void> {
    const at = model.indexOf('/');
    if (at < 0) return;
    const prev = this.rt.meta.model;
    const m = await this.rpc.request('set_model', { provider: model.slice(0, at), modelId: model.slice(at + 1) });
    if (!quiet && prev && prev !== model && this.rt.items.length) this.rt.notice('model', `Switched to ${String(m?.name ?? model).replace(/\s*\(vision\)$/i, '')}`);
    if (m?.contextWindow) this.rt.update({ usage: { ...this.rt.meta.usage, contextWindow: m.contextWindow } });
  }

  async setEffort(effort: Effort): Promise<void> {
    await this.rpc.request('set_thinking_level', { level: effort });
  }

  async setMode(): Promise<void> {}

  async close(): Promise<void> {
    this.queue = [];
    this.running = false;
    this.rpc.close();
  }
}

/** A message for pi: the text, pasted images inline, other attachments as paths it can read. */
function payload(item: UserItem): Obj {
  const images: Obj[] = [];
  const refs: string[] = [];
  for (const a of item.attachments ?? ([] as Attachment[])) {
    const m = a.dataUrl?.match(/^data:([^;]+);base64,(.*)$/);
    if (a.kind === 'image' && m) images.push({ type: 'image', mimeType: m[1], data: m[2] });
    else if (a.kind === 'text' && a.text) refs.push(`<file name="${a.name}">\n${a.text}\n</file>`);
    else if (a.path) refs.push(a.path);
  }
  const message = refs.length ? `${item.text}\n\n${refs.join('\n')}` : item.text;
  return { message, ...(images.length ? { images } : {}) };
}
