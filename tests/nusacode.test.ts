import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { describePi, mapResult, transcript } from '../server/providers/nusacode';

const cwd = path.resolve('/work');

describe('NusaCode tool mapping', () => {
  it('names pi tools the way the timeline shows Claude Code tools', () => {
    expect(describePi('bash', { command: 'pnpm test' }, cwd)).toMatchObject({ kind: 'bash', title: 'pnpm test' });
    expect(describePi('read', { path: 'src/a.ts' }, cwd)).toMatchObject({ kind: 'read', title: 'Read a.ts', detail: { path: path.join(cwd, 'src/a.ts') } });
    expect(describePi('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, cwd)).toMatchObject({ kind: 'edit', detail: { oldText: 'x', newText: 'y' } });
  });

  it('turns an edit patch into a diff and a write into an added file', () => {
    const patch = 'Index: a.ts\n===\n--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n';
    const edit = mapResult('edit', { path: 'a.ts' }, { content: [{ type: 'text', text: 'ok' }], details: { patch } }, false, cwd);
    expect(edit.diff?.[0]).toMatchObject({ path: path.join(cwd, 'a.ts'), additions: 1, deletions: 1 });
    const write = mapResult('write', { path: 'b.ts', content: 'a\nb' }, { content: [] }, false, cwd);
    expect(write.diff?.[0]).toMatchObject({ status: 'added', additions: 2 });
  });

  it('rebuilds a stored conversation', () => {
    const items = transcript(
      [
        { role: 'user', content: 'hi', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'hello' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 2 },
        { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'a.ts' }], isError: false, timestamp: 3 },
      ],
      cwd,
    );
    expect(items.map((i) => i.type)).toEqual(['user', 'thinking', 'text', 'tool']);
    expect(items[3]).toMatchObject({ status: 'done', result: { text: 'a.ts' } });
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { vi } from 'vitest';
import { SessionRuntime } from '../server/core/runtime';
import { NusaCodeProvider, NusaCodeSession, saveApiKey, signInWithNusaGate } from '../server/providers/nusacode';
import type { SessionMeta, UserItem } from '../shared/protocol';

function fakeSession() {
  const meta: SessionMeta = { id: 's1', provider: 'nusacode', cwd, title: 't', titleSource: 'auto', model: '', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const sent: string[] = [];
  const rpc = {
    onRecord: (_r: unknown) => {},
    onExit: (_w: string) => {},
    write: () => {},
    close: () => {},
    request: async (type: string) => (sent.push(type), type === 'prompt' ? { disposition: 'started' } : {}),
  };
  const session = new NusaCodeSession(rt, rpc as never, { emit: () => {}, log: () => {} });
  const user = (text: string) => rt.add<UserItem>({ type: 'user', text, state: 'sent' });
  return { rt, rpc, session, sent, user };
}

describe('NusaCode stop', () => {
  it('ignores the stopped run settling after the next turn started', async () => {
    const { rt, rpc, session, user } = fakeSession();
    await session.send(user('first'));
    await session.send(user('second')); // queued behind the first
    await session.interrupt(); // ends the first turn and starts the queued one
    await Promise.resolve();
    expect(rt.meta.status).toBe('running');
    rpc.onRecord({ type: 'agent_settled', aborted: true }); // the first run, late
    expect(rt.meta.status).toBe('running');
    rpc.onRecord({ type: 'agent_settled', aborted: false }); // the second run
    expect(rt.meta.status).toBe('idle');
  });

  it('ends the turn on the settle when it comes before the stop returns', async () => {
    const { rt, rpc, session, user } = fakeSession();
    await session.send(user('first'));
    rpc.onRecord({ type: 'agent_settled', aborted: true });
    expect(rt.meta.status).toBe('idle');
    await session.interrupt();
    expect(rt.items.filter((i) => i.type === 'turn')).toHaveLength(1);
  });
});

describe('NusaGate sign-in', () => {
  it('refuses at once when already cancelled', async () => {
    const onUrl = vi.fn();
    await expect(signInWithNusaGate(onUrl, AbortSignal.abort())).rejects.toThrow('cancelled');
    expect(onUrl).not.toHaveBeenCalled();
  });

  it('never opens the browser when cancelled while starting, and leaves nothing unhandled', async () => {
    const onUrl = vi.fn();
    const ctrl = new AbortController();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const p = signInWithNusaGate(onUrl, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('cancelled');
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);
    expect(onUrl).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('saves the key as an api_key entry, keeps other entries, and leaves a broken file alone', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'nc-auth-'));
    writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ other: { type: 'api_key', key: 'x' } }));
    saveApiKey(home, 'nsk_test');
    expect(JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8'))).toEqual({ other: { type: 'api_key', key: 'x' }, nusagate: { type: 'api_key', key: 'nsk_test' } });
    writeFileSync(path.join(home, 'auth.json'), '{broken');
    expect(() => saveApiKey(home, 'nsk_test')).toThrow();
    expect(readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe('{broken');
  });
});

describe('NusaCode limits', () => {
  it('takes the Coding Plan window from the pass', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nc-acct-'));
    saveApiKey(dir, 'nsk_test');
    const startsAt = '2026-11-10T00:00:00.000Z';
    const endsAt = '2026-11-17T00:00:00.000Z';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ balance: 12345.6, pass: { startsAt, endsAt, valueTotalIdr: 100, valueRemainingIdr: 75 } })));
    try {
      const events: any[] = [];
      const limits = await new NusaCodeProvider({ emit: (e) => events.push(e), log: () => {}, account: { id: 'a', dir } }).limits();
      expect(limits).toEqual([{ id: 'nusagate:pass', label: 'Coding Plan', windowMins: 7 * 24 * 60, percent: 25, resetsAt: Date.parse(endsAt) }]);
      expect(events[0].meta.credits.balance).toBe('Rp12.345');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
