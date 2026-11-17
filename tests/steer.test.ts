/**
 * Steering versus queueing, queue editing (reorder, attachments, take), ultracode, short answers,
 * plan names, the Demo agent being development-only and item times. Against the Demo agent and
 * pure helpers: no real agent turns.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONCISE_REPLIES_PROMPT, DEFAULT_SETTINGS, type AppSettings, type Attachment, type BridgeEvent, type TextItem, type TurnItem, type UserItem } from '@shared/protocol';
import { WIDGET_FENCE_HINT } from '../server/providers/widget-tool';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { transcript } from '../server/providers/codex-map';
import { DemoProvider } from '../server/providers/demo';
import { steerReply } from '../server/providers/demo-script';
import { defaultProviders } from '../server/providers/index';
import { claudePlan, codexPlan } from '../server/providers/plans';
import type { ProviderContext } from '../server/providers/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function until(pred: () => boolean, what: string, ms = 6000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const REFACTOR = 'Refactor the session expiry logic out of the auth middleware';
const QUESTION = 'Before you continue: what is 2+2? Answer in one short sentence, then carry on.';

async function setup(opts: { home?: string; mode?: string } = {}) {
  const home = opts.home ?? mkdtempSync(path.join(tmpdir(), 'sable-steer-'));
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(structuredClone(e)));
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: opts.mode ?? 'bypassPermissions' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await app.dispose();
  };
  cleanups.push(async () => {
    await dispose();
    if (!opts.home) rmSync(home, { recursive: true, force: true });
  });
  return {
    app,
    home,
    id,
    rt,
    events,
    dispose,
    send: (text: string, extra: { steer?: boolean; attachments?: Attachment[] } = {}) => app.call('session.send', { sessionId: id, text, ...extra }),
    users: () => rt.items.filter((i): i is UserItem => i.type === 'user'),
    texts: () => rt.items.filter((i): i is TextItem => i.type === 'text'),
    turns: () => rt.items.filter((i): i is TurnItem => i.type === 'turn'),
    idle: () => until(() => !rt.turnActive && rt.meta.status === 'idle', 'idle session'),
  };
}

const file = (name: string): Attachment => ({ id: name, kind: 'file', name, path: `C:/tmp/${name}` });

// ─────────────────────────────────── steering ───────────────────────────────────

describe('steering', () => {
  it('delivers a steered message into the running turn, where it was sent, and the reply follows it', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    expect(h.rt.turnActive).toBe(true);
    const before = h.rt.items.length;
    expect(await h.send(QUESTION, { steer: true })).toEqual({ ok: true });

    // In the timeline right away (not the bridge queue), at the end, flagged, waiting to be taken.
    expect(h.rt.queue).toEqual([]);
    const steered = h.users().find((u) => u.text === QUESTION)!;
    expect(steered).toMatchObject({ steered: true, state: 'queued' });
    expect(h.rt.items.indexOf(steered)).toBe(before);

    await h.idle();
    // One turn: the agent took it mid-turn rather than after.
    expect(h.turns()).toHaveLength(1);
    const after = h.rt.get<UserItem>(steered.id)!;
    expect(after.state).toBe('sent');
    // Still where it was sent (taken in place, not moved).
    expect(h.rt.items.indexOf(after)).toBe(before);
    // The answer is its own text item right after it, then the work carries on.
    const next = h.rt.items[before + 1];
    expect(next.type).toBe('text');
    expect((next as TextItem).text).toBe('2 + 2 = 4. Carrying on.');
    expect(h.rt.items.slice(before + 2).some((i) => i.type === 'tool')).toBe(true);
    // Moving it would have emitted item.removed for it.
    expect(h.events.some((e) => e.type === 'item.removed' && e.id === steered.id)).toBe(false);
  });

  it('without a running turn, steer is a normal send', async () => {
    const h = await setup();
    expect(await h.send('hi', { steer: true })).toEqual({ ok: true });
    const u = h.users()[0];
    expect(u.state).toBe('sent');
    expect(u.steered).toBeUndefined();
    await h.idle();
    expect(h.turns()).toHaveLength(1);
  });

  it('Enter while the agent works still queues; an agent that cannot steer queues a steer too', async () => {
    const h = await setup();
    await h.send(REFACTOR);
    expect(await h.send('later please')).toEqual({ ok: true, queued: true });
    expect(h.rt.queue.map((q) => q.text)).toEqual(['later please']);
    h.rt.caps = { ...h.rt.caps!, features: { ...h.rt.caps!.features, steer: false } };
    expect(await h.send('steer me', { steer: true })).toEqual({ ok: true, queued: true });
    expect(h.rt.queue.map((q) => q.text)).toEqual(['later please', 'steer me']);
    expect(h.users().map((u) => u.text)).toEqual([REFACTOR]);
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
  });

  it('a steered message the turn ended before taking goes out first in the next turn', async () => {
    const h = await setup();
    // "hi" is one short reply: the steer lands after its last step.
    await h.send('hi');
    await until(() => h.texts().some((t) => !t.streaming && t.text.length > 0), 'reply');
    if (h.rt.turnActive) await h.send('and one more thing', { steer: true });
    await h.idle();
    await until(() => !h.rt.turnActive && h.users().every((u) => u.state === 'sent'), 'every message taken');
    for (const u of h.users()) expect(u.state).toBe('sent');
  });

  it('send now steers a queued message into the running turn', async () => {
    const h = await setup({ mode: 'default' });
    await h.send(REFACTOR);
    await until(() => h.rt.snapshot().permissions.length === 1, 'permission');
    await h.send('queued first');
    const [q] = h.rt.queue;
    expect(await h.app.call('queue.sendNow', { sessionId: h.id, id: q.id })).toEqual({ ok: true });
    const u = h.users().find((x) => x.text === 'queued first')!;
    expect(u).toMatchObject({ steered: true, state: 'queued' });
    expect(h.rt.queue).toEqual([]);

    // Stopped before the agent took it: it goes back to the queue (out of the timeline), nothing is sent.
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.users().map((x) => x.text)).toEqual([REFACTOR]);
    expect(h.rt.queue).toMatchObject([{ id: u.id, text: 'queued first' }]);
    expect(h.turns()).toHaveLength(0);
  });

  it('demo replies to steered messages plainly', () => {
    expect(steerReply('what is 2+2?')).toBe('2 + 2 = 4. Carrying on.');
    expect(steerReply('and 6 x 7')).toBe('6 × 7 = 42. Carrying on.');
    expect(steerReply('use pnpm, not npm')).toMatch(/^Noted: use pnpm, not npm/);
  });
});

// ──────────────────────────────────── queue ─────────────────────────────────────

describe('queue editing', () => {
  async function withQueue(texts: string[]) {
    const h = await setup({ mode: 'default' });
    await h.send(REFACTOR);
    await until(() => h.rt.snapshot().permissions.length === 1, 'permission');
    for (const t of texts) await h.send(t);
    return h;
  }

  it('reorders, emits queue.updated and keeps the order across a restart', async () => {
    const h = await withQueue(['a', 'b', 'c']);
    const [a, b, c] = h.rt.queue;
    expect(await h.app.call('queue.reorder', { sessionId: h.id, ids: [c.id, a.id] })).toEqual({ ok: true });
    expect(h.rt.queue.map((q) => q.text)).toEqual(['c', 'a', 'b']);
    const last = h.events.filter((e) => e.type === 'queue.updated').at(-1);
    expect(last).toMatchObject({ queue: [{ id: c.id }, { id: a.id }, { id: b.id }] });
    // Unknown and repeated ids are ignored.
    await h.app.call('queue.reorder', { sessionId: h.id, ids: ['nope', b.id, b.id] });
    expect(h.rt.queue.map((q) => q.text)).toEqual(['b', 'c', 'a']);

    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
    await h.dispose();
    const app2 = new App({ home: h.home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    cleanups.push(() => app2.dispose());
    const snap = await app2.call('session.snapshot', { sessionId: h.id });
    expect(snap.queue.map((q) => q.text)).toEqual(['b', 'c', 'a']);
  });

  it('replaces attachments as well as text; empty text with attachments stays, fully empty goes', async () => {
    const h = await withQueue(['one']);
    const [q] = h.rt.queue;
    await h.app.call('queue.update', { sessionId: h.id, id: q.id, text: 'one, edited', attachments: [file('a.ts'), file('b.ts')] });
    expect(h.rt.queue[0]).toMatchObject({ text: 'one, edited', attachments: [{ name: 'a.ts' }, { name: 'b.ts' }] });
    // Text only: attachments stay.
    await h.app.call('queue.update', { sessionId: h.id, id: q.id, text: 'text only' });
    expect(h.rt.queue[0].attachments).toHaveLength(2);
    // No text, still a file: stays.
    await h.app.call('queue.update', { sessionId: h.id, id: q.id, text: '', attachments: [file('c.ts')] });
    expect(h.rt.queue[0]).toMatchObject({ text: '', attachments: [{ name: 'c.ts' }] });
    // Nothing left: removed.
    expect(await h.app.call('queue.update', { sessionId: h.id, id: q.id, text: ' ', attachments: [] })).toEqual({ ok: true });
    expect(h.rt.queue).toEqual([]);
    expect(await h.app.call('queue.update', { sessionId: h.id, id: q.id, text: 'gone' })).toEqual({ ok: false });
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
  });

  it('takes a message out atomically for editing', async () => {
    const h = await withQueue(['edit me', 'keep me']);
    const [a] = h.rt.queue;
    const r = await h.app.call('queue.take', { sessionId: h.id, id: a.id });
    expect(r.message).toMatchObject({ id: a.id, text: 'edit me' });
    expect(h.rt.queue.map((q) => q.text)).toEqual(['keep me']);
    expect(await h.app.call('queue.take', { sessionId: h.id, id: a.id })).toEqual({});
    await h.app.call('session.interrupt', { sessionId: h.id });
    await h.idle();
  });
});

// ─────────────────────────────────── ultracode ──────────────────────────────────

describe('ultracode', () => {
  it('is offered by the demo, set at creation and switched live, and persists', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-ultra-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    const events: BridgeEvent[] = [];
    app.subscribe((e) => events.push(e));
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'x'), ultracode: true });
    expect(snap.caps?.features.ultracode).toBe(true);
    expect(snap.session.ultracode).toBe(true);
    expect(await app.call('session.setUltracode', { sessionId: snap.session.id, on: false })).toEqual({ ok: true });
    // Off travels as false (an undefined field would vanish from the JSON patch).
    expect(events.find((e) => e.type === 'session.updated' && 'ultracode' in e.patch)).toMatchObject({ patch: { ultracode: false } });
    await app.call('session.setUltracode', { sessionId: snap.session.id, on: true });
    await app.dispose();
    const app2 = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    cleanups.push(() => app2.dispose());
    expect(app2.runtime(snap.session.id).meta.ultracode).toBe(true);
  });

  it('Claude Code starts with the setting and keeps it on when the effort changes', async () => {
    const p = new ClaudeProvider({ emit: () => {}, log: () => {} });
    const owner = {};
    const on = p.agentOptions({ cwd: tmpdir(), model: 'haiku', mode: 'default', ultracode: true }, owner);
    expect(on.settings).toEqual({ ultracode: true });
    expect(p.agentOptions({ cwd: tmpdir(), model: 'haiku', mode: 'default' }, owner).settings).toBeUndefined();
    expect(p.buildCaps({ models: [] }, []).features.ultracode).toBe(true);
    expect(p.buildCaps(undefined, []).features.ultracode).toBe(false);
  });
});

// ──────────────────────────────── short answers ─────────────────────────────────

describe('short answers', () => {
  const ctx = (settings: Partial<AppSettings>): ProviderContext => ({ emit: () => {}, log: () => {}, settings: () => ({ ...DEFAULT_SETTINGS, ...settings }) });

  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.conciseReplies).toBe(true);
  });

  it('Claude Code: appended to the preset system prompt, nothing replaced', () => {
    // Generative UI and the Browser tab add their own lines; this test is about short answers, so they are off here.
    const on = new ClaudeProvider(ctx({ generativeUi: false })).agentOptions({ cwd: tmpdir(), model: '', mode: 'default', options: { browserTab: false } }, {});
    expect(on.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: CONCISE_REPLIES_PROMPT });
    expect(on.settingSources).toEqual(['user', 'project', 'local']);
    const off = new ClaudeProvider(ctx({ conciseReplies: false, generativeUi: false })).agentOptions({ cwd: tmpdir(), model: '', mode: 'default', options: { browserTab: false } }, {});
    expect(off.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    // Both on (the default): the two instructions, short answers first.
    const both = new ClaudeProvider(ctx({})).agentOptions({ cwd: tmpdir(), model: '', mode: 'default', options: { browserTab: false } }, {});
    expect(both.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: `${CONCISE_REPLIES_PROMPT}\n\n${WIDGET_FENCE_HINT}` });
    const widgetsOnly = new ClaudeProvider(ctx({ conciseReplies: false })).agentOptions({ cwd: tmpdir(), model: '', mode: 'default', options: { browserTab: false } }, {});
    expect(widgetsOnly.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: WIDGET_FENCE_HINT });
  });

  it('Codex: developer instructions keep what the user configured and add the instruction', async () => {
    const fake = (own: string | null) => {
      const calls: { method: string; params: unknown }[] = [];
      const rpc = { request: async (method: string, params: unknown) => (calls.push({ method, params }), { config: { developer_instructions: own } }) };
      return { calls, rpc };
    };
    const mine = fake('Always answer in German.');
    // Generative UI adds its own line (tests/widget-provider.test.ts); this test is about short answers.
    const p = new CodexProvider(ctx({ generativeUi: false }));
    (p as unknown as { client: () => Promise<unknown> }).client = async () => mine.rpc;
    expect(await p.developerInstructions('C:/proj')).toBe(`Always answer in German.\n\n${CONCISE_REPLIES_PROMPT}`);
    expect(mine.calls).toEqual([{ method: 'config/read', params: { cwd: 'C:/proj' } }]);

    const none = fake(null);
    (p as unknown as { client: () => Promise<unknown> }).client = async () => none.rpc;
    expect(await p.developerInstructions('C:/proj')).toBe(CONCISE_REPLIES_PROMPT);

    const off = new CodexProvider(ctx({ conciseReplies: false, generativeUi: false }));
    (off as unknown as { client: () => Promise<unknown> }).client = async () => none.rpc;
    expect(await off.developerInstructions('C:/proj')).toBeUndefined();
  });

  it('the instruction stays short', () => {
    // Appended to every session's prompt: a few lines, never a page.
    expect(CONCISE_REPLIES_PROMPT.length).toBeLessThan(500);
    expect(CONCISE_REPLIES_PROMPT).toMatch(/http:\/\/localhost/);
  });

  it('asks for the outcome first and no recap of files or steps', () => {
    expect(CONCISE_REPLIES_PROMPT).toMatch(/^Finish with a short reply: the outcome in one or two sentences/);
    expect(CONCISE_REPLIES_PROMPT).toMatch(/do not list the files you changed or recap/);
    expect(CONCISE_REPLIES_PROMPT).toMatch(/no closing offers/);
  });

  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.conciseReplies).toBe(true);
  });
});

// ─────────────────────────────────── plan names ─────────────────────────────────

describe('plan names', () => {
  it('Claude Code: the CLI wording wins, then the subscription, then the sign-in method', () => {
    expect(claudePlan({ authMethod: 'claude.ai', subscriptionType: 'max' }, 'Login method: Claude Ultra account\nEmail: x')).toEqual({ plan: 'Ultra', planId: 'max' });
    expect(claudePlan({ authMethod: 'claude.ai', subscriptionType: 'max' })).toEqual({ plan: 'Max', planId: 'max' });
    expect(claudePlan({ authMethod: 'claude.ai', subscriptionType: 'pro' })).toEqual({ plan: 'Pro', planId: 'pro' });
    expect(claudePlan({ subscriptionType: 'team' })).toEqual({ plan: 'Team', planId: 'team' });
    expect(claudePlan({ subscriptionType: 'enterprise' })).toEqual({ plan: 'Enterprise', planId: 'enterprise' });
    expect(claudePlan({ subscriptionType: 'Claude Ultra' })).toEqual({ plan: 'Ultra', planId: 'Claude Ultra' });
    expect(claudePlan({ authMethod: 'api_key' })).toEqual({ plan: 'API key' });
    expect(claudePlan({ authMethod: 'console' })).toEqual({ plan: 'Console' });
    expect(claudePlan({ authMethod: 'api_key', apiProvider: 'bedrock' })).toEqual({ plan: 'Amazon Bedrock', planId: 'bedrock' });
    expect(claudePlan({})).toEqual({});
  });

  it('Codex: plan types and sign-in kinds', () => {
    expect(codexPlan({ type: 'chatgpt', planType: 'plus' })).toEqual({ plan: 'Plus', planId: 'plus' });
    expect(codexPlan({ type: 'chatgpt', planType: 'pro' })).toEqual({ plan: 'Pro', planId: 'pro' });
    expect(codexPlan({ type: 'chatgpt', planType: 'team' })).toEqual({ plan: 'Business', planId: 'team' });
    expect(codexPlan({ type: 'chatgpt', planType: 'self_serve_business_usage_based' }).plan).toBe('Business');
    expect(codexPlan({ type: 'chatgpt', planType: 'enterprise' }).plan).toBe('Enterprise');
    expect(codexPlan({ type: 'chatgpt', planType: 'unknown' })).toEqual({ planId: 'unknown' });
    expect(codexPlan({ type: 'apiKey' })).toEqual({ plan: 'API key' });
    expect(codexPlan(null, true)).toEqual({ plan: 'Custom provider' });
    expect(codexPlan(null)).toEqual({});
  });
});

// ─────────────────────────────── demo outside dev ───────────────────────────────

describe('the Demo agent is development-only', () => {
  it('is registered only with SABLE_DEMO=1', () => {
    const prev = process.env.SABLE_DEMO;
    try {
      delete process.env.SABLE_DEMO;
      expect(defaultProviders()).toHaveLength(3);
      process.env.SABLE_DEMO = '1';
      expect(defaultProviders()).toHaveLength(4);
    } finally {
      if (prev === undefined) delete process.env.SABLE_DEMO;
      else process.env.SABLE_DEMO = prev;
    }
  });

  it('hides Demo sessions when it is absent, without deleting them', async () => {
    const h = await setup();
    await h.send('hi');
    await h.idle();
    await h.dispose();
    const app2 = new App({ home: h.home, providers: [], quiet: true });
    cleanups.push(() => app2.dispose());
    expect((await app2.state()).sessions).toEqual([]);
    expect(() => app2.runtime(h.id)).toThrow();
    await expect(app2.call('session.create', { provider: 'demo', cwd: h.home })).rejects.toThrow(/not available/);
    // Saving the session list keeps the hidden one on disk.
    (app2 as unknown as { persistSessions: () => void }).persistSessions();
    await app2.store.flush();
    const saved = JSON.parse(readFileSync(path.join(h.home, 'state.json'), 'utf8')) as { sessions: { id: string }[] };
    expect(saved.sessions.map((s) => s.id)).toContain(h.id);
  });
});

// ───────────────────────────────────── times ────────────────────────────────────

describe('item times', () => {
  it('every live item has a creation time, in timeline order', async () => {
    const h = await setup();
    const t0 = Date.now();
    await h.send(REFACTOR);
    await h.send(QUESTION, { steer: true });
    await h.send('hi');
    await until(() => h.turns().length === 2, 'two turns', 10_000);
    await h.idle();
    const roots = h.rt.items.filter((i) => !i.parentId);
    for (const i of h.rt.items) expect(i.ts).toBeGreaterThanOrEqual(t0);
    for (let k = 1; k < roots.length; k++) expect(roots[k].ts, `${roots[k].type} after ${roots[k - 1].type}`).toBeGreaterThanOrEqual(roots[k - 1].ts);
    // A queued message is stamped when the agent took it, i.e. after the first turn ended.
    const hi = h.users().find((u) => u.text === 'hi')!;
    expect(hi.ts).toBeGreaterThanOrEqual(h.turns()[0].ts);
  });

  it('Codex history without stored times borrows the last known time, never "now"', () => {
    const items = transcript([
      { id: 't1', status: 'completed', startedAt: 1_700_000_000, completedAt: 1_700_000_010, items: [{ type: 'agentMessage', id: 'a', text: 'hi' }] },
      { id: 't2', status: 'completed', startedAt: null, completedAt: null, items: [{ type: 'agentMessage', id: 'b', text: 'again' }] },
    ] as never);
    const later = items.find((i) => i.id === 't2:b')!;
    expect(later.ts).toBe(1_700_000_000_000);
    expect(items.every((i) => i.ts < Date.now() - 1000)).toBe(true);
  });
});
