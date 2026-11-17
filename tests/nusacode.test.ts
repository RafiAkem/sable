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
