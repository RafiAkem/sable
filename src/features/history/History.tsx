import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULT_ACCOUNT, type HistoryEntry, type ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { Highlight } from '@/features/palette/Highlight';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { baseName, dayBucket, plural, timeAgo } from '@/lib/format';
import { fuzzy, wordPrefix } from '@/lib/fuzzy';
import { homeAccountId, resumeFromHistory } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSep, MenuTrigger, Modal, Segmented, cx } from '@/ui';
import './history.css';

/** Browse and resume conversations the providers keep on disk. */
export function History() {
  const open = useStore((s) => s.ui.historyOpen);
  const setUi = useStore((s) => s.setUi);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (open) setNonce((n) => n + 1);
  }, [open]);

  return (
    <Modal open={open} onOpenChange={(o) => setUi({ historyOpen: o })} title="History" bare className="history">
      <HistoryBody key={nonce} onClose={() => setUi({ historyOpen: false })} />
    </Modal>
  );
}

const ORDER: ProviderId[] = ['claude', 'codex', 'nusacode', 'demo'];
const pathKey = (p?: string) => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Listings are cached for the app's lifetime so switching back is instant; a refresh runs behind. */
const cache = new Map<string, HistoryEntry[]>();

interface Row {
  entry: HistoryEntry;
  indices?: number[];
}

function HistoryBody({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const activeCwd = useStore((s) => (s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId]?.cwd : undefined));
  const homeCwd = useStore((s) => s.ui.homeCwd);
  const activeProvider = useStore((s) => (s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId]?.provider : s.ui.homeProvider));

  const installed = useMemo(() => ORDER.filter((id) => providers[id]?.installed), [providers]);
  const [provider, setProvider] = useState<ProviderId>(() => (installed.includes(activeProvider) ? activeProvider : (installed[0] ?? 'demo')));
  // History lives per account: the open session's account for its agent, otherwise the home choice.
  const accountId = useStore((s) => {
    const open = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
    return open?.provider === provider ? (open.accountId ?? DEFAULT_ACCOUNT) : homeAccountId(provider, s);
  });
  const [cwd, setCwd] = useState<string | null>(() => activeCwd ?? homeCwd ?? null);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [resuming, setResuming] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load (cache first, then refresh).
  useEffect(() => {
    const key = `${provider}\u0000${accountId}\u0000${pathKey(cwd ?? '')}`;
    const cached = cache.get(key);
    setEntries(cached ?? null);
    setError(null);
    setSlow(false);
    let live = true;
    const slowTimer = window.setTimeout(() => live && !cached && setSlow(true), 1600);
    bridge
      .call('history.list', { provider, cwd: cwd ?? undefined, limit: 80, accountId: accountId === DEFAULT_ACCOUNT ? undefined : accountId })
      .then((list) => {
        if (!live) return;
        const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
        cache.set(key, sorted);
        setEntries(sorted);
      })
      .catch((err) => {
        if (!live) return;
        if (!cached) setError((err as Error)?.message ?? String(err));
      })
      .finally(() => {
        window.clearTimeout(slowTimer);
        if (live) setSlow(false);
      });
    return () => {
      live = false;
      window.clearTimeout(slowTimer);
    };
  }, [provider, cwd]);

  const openIds = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of Object.values(sessions)) if (s.providerSessionId) m.set(`${s.provider}:${s.providerSessionId}`, s.id);
    return m;
  }, [sessions]);

  const rows = useMemo<Row[]>(() => {
    const list = entries ?? [];
    const q = query.trim();
    if (!q) return list.map((entry) => ({ entry }));
    const out: (Row & { score: number })[] = [];
    for (const entry of list) {
      const m = fuzzy(q, entry.title);
      if (m) {
        out.push({ entry, indices: m.indices, score: m.score });
        continue;
      }
      const w = wordPrefix(q, [entry.preview, entry.branch, baseName(entry.cwd)].filter(Boolean).join(' '));
      if (w !== null) out.push({ entry, score: w * 0.6 });
    }
    return out.sort((a, b) => b.score - a.score);
  }, [entries, query]);

  // Group by day only while browsing; a search ranks by relevance instead.
  const grouped = !query.trim();

  useEffect(() => setCursor(0), [query, provider, cwd]);
  const safe = Math.min(cursor, Math.max(0, rows.length - 1));
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${safe}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [safe]);

  const resume = async (entry: HistoryEntry) => {
    if (resuming) return;
    // The conversation's own folder wins: providers key stored sessions by the folder they ran in.
    const target = entry.cwd ?? cwd;
    if (!target) {
      useStore.getState().toast('This conversation has no folder to resume in.', 'error');
      return;
    }
    setResuming(entry.providerSessionId);
    const s = await resumeFromHistory(entry.provider, entry.providerSessionId, target, entry.title, accountId);
    setResuming(null);
    if (s) onClose();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setCursor((c) => Math.min(n - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[safe];
      if (r) void resume(r.entry);
    }
  };

  const recentProjects = useMemo(() => [...projects].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 12), [projects]);
  const projectName = cwd ? (projects.find((p) => pathKey(p.path) === pathKey(cwd))?.name ?? baseName(cwd)) : 'All projects';

  return (
    <div className="history-body">
      <div className="history-head">
        <h2 className="dialog-title">History</h2>
        {installed.length > 1 && (
          <Segmented
            id="history-provider"
            value={provider}
            onChange={(v) => {
              setProvider(v);
              inputRef.current?.focus();
            }}
            options={installed.map((id) => ({ value: id, label: <ProviderLabel id={id} /> }))}
          />
        )}
        <span className="grow" />
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>

      <div className="history-tools">
        <div className="history-search">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            autoFocus
            className="history-input"
            value={query}
            placeholder={`Search ${PROVIDER_NAME[provider]} conversations`}
            spellCheck={false}
            aria-label="Search conversations"
            aria-controls="history-list"
            aria-activedescendant={rows[safe] ? `history-opt-${safe}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <Menu>
          <MenuTrigger className="chip history-project" aria-label="Project">
            <Icon name={cwd ? 'folder' : 'stack'} size={14} />
            <span className="truncate">{projectName}</span>
            <Icon name="caret-down" size={10} className="caret" />
          </MenuTrigger>
          <MenuContent align="end" width={260}>
            <MenuItem icon="stack" checked={!cwd} onSelect={() => setCwd(null)}>
              All projects
            </MenuItem>
            {recentProjects.length > 0 && (
              <>
                <MenuSep />
                <MenuLabel>Recent projects</MenuLabel>
                {recentProjects.map((p) => (
                  <MenuItem key={p.path} icon="folder" checked={pathKey(p.path) === pathKey(cwd ?? '')} onSelect={() => setCwd(p.path)}>
                    {p.name || baseName(p.path)}
                  </MenuItem>
                ))}
              </>
            )}
          </MenuContent>
        </Menu>
      </div>

      <div ref={listRef} id="history-list" className="history-list scroll" role="listbox" aria-label="Conversations" aria-busy={entries === null}>
        {error ? (
          <div className="history-note is-error">
            <Icon name="error" size={15} />
            <span>Could not read {PROVIDER_NAME[provider]} history: {error}</span>
          </div>
        ) : entries === null ? (
          <Skeleton slow={slow} provider={provider} />
        ) : rows.length === 0 ? (
          <div className="history-note">
            {query.trim() ? `No conversation matches “${query.trim()}”.` : cwd ? `No ${PROVIDER_NAME[provider]} conversations in ${projectName} yet.` : `No ${PROVIDER_NAME[provider]} conversations yet.`}
          </div>
        ) : (
          rows.map((r, i) => {
            const bucket = grouped ? dayBucket(r.entry.updatedAt) : null;
            const head = grouped && (i === 0 || dayBucket(rows[i - 1].entry.updatedAt) !== bucket);
            const openId = openIds.get(`${r.entry.provider}:${r.entry.providerSessionId}`);
            return (
              <HistoryRowView
                key={r.entry.providerSessionId}
                row={r}
                index={i}
                head={head ? bucket : null}
                active={i === safe}
                isOpen={!!openId}
                showProject={!cwd}
                busy={resuming === r.entry.providerSessionId}
                onHover={setCursor}
                onResume={resume}
              />
            );
          })
        )}
      </div>

      <div className="history-foot">
        <span className="history-hint">
          <kbd className="kbd">↑</kbd>
          <kbd className="kbd">↓</kbd>
          to move
        </span>
        <span className="history-hint">
          <kbd className="kbd">↵</kbd>
          to resume
        </span>
        <span className="grow" />
        {entries && <span className="history-count num">{rows.length === entries.length ? plural(entries.length, "conversation") : `${rows.length} of ${entries.length}`}</span>}
      </div>
    </div>
  );
}

function ProviderLabel({ id }: { id: ProviderId }) {
  return (
    <span className="history-prov">
      <ProviderMark provider={id} size={13} />
      {PROVIDER_NAME[id]}
    </span>
  );
}

function HistoryRowView({
  row,
  index,
  head,
  active,
  isOpen,
  showProject,
  busy,
  onHover,
  onResume,
}: {
  row: Row;
  index: number;
  head: string | null;
  active: boolean;
  isOpen: boolean;
  showProject: boolean;
  busy: boolean;
  onHover: (i: number) => void;
  onResume: (e: HistoryEntry) => void;
}) {
  const { entry } = row;
  // Skip a preview that only repeats the title (providers often title by the first prompt).
  const lead = entry.title.replace(/(\.{3}|…)$/, '').trim().toLowerCase().slice(0, 40);
  const preview = entry.preview && !entry.preview.trim().toLowerCase().startsWith(lead) ? entry.preview : undefined;
  return (
    <>
      {head && <div className="history-day">{head}</div>}
      <div
        id={`history-opt-${index}`}
        role="option"
        aria-selected={active}
        data-index={index}
        data-active={active || undefined}
        className={cx('hrow', active && 'dither-sel', busy && 'is-busy')}
        onMouseMove={() => !active && onHover(index)}
        onClick={() => onResume(entry)}
      >
        <div className="hrow-main">
          <div className="hrow-top">
            <span className="hrow-title truncate">
              <Highlight text={entry.title} indices={row.indices} />
            </span>
            {isOpen && <span className="hrow-open">Open</span>}
          </div>
          {(preview || showProject) && (
            <div className="hrow-sub truncate">
              {showProject && entry.cwd && (
                <span className="hrow-proj">
                  <Icon name="folder" size={12} />
                  {baseName(entry.cwd)}
                </span>
              )}
              {preview && <span className="truncate">{preview}</span>}
            </div>
          )}
        </div>
        <div className="hrow-meta">
          {entry.branch && (
            <span className="hrow-branch truncate">
              <Icon name="branch" size={12} />
              <span className="truncate">{entry.branch}</span>
            </span>
          )}
          <span className="hrow-time num">{busy ? 'Opening' : timeAgo(entry.updatedAt)}</span>
        </div>
      </div>
    </>
  );
}

function Skeleton({ slow, provider }: { slow: boolean; provider: ProviderId }) {
  return (
    <div className="history-skel" aria-label="Loading">
      <div className="history-day">
        <span className="skel-bar skel" style={{ width: 54 }} />
      </div>
      {[72, 54, 64, 46, 58].map((w, i) => (
        <div key={i} className="hrow is-skel">
          <div className="hrow-main">
            <span className="skel-bar skel" style={{ width: `${w}%` }} />
            <span className="skel-bar skel skel-sub" style={{ width: `${w - 18}%` }} />
          </div>
          <span className="skel-bar skel" style={{ width: 28 }} />

        </div>
      ))}
      {slow && <div className="history-slow shimmer">Reading {PROVIDER_NAME[provider]} history. Large histories take a moment.</div>}
    </div>
  );
}
