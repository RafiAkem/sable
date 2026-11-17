import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog as RD } from 'radix-ui';
import { DEFAULT_ACCOUNT, type ProviderId, type SessionMeta } from '@shared/protocol';
import { accountName as nameOfAccount } from '@/state/hooks';
import { StatusMark, statusLabel, statusTone } from '@/features/sidebar/SessionRow';
import { Icon } from '@/icons';
import { timeAgo } from '@/lib/format';
import { fuzzy, wordPrefix } from '@/lib/fuzzy';
import { useNow } from '@/lib/useNow';
import { useStore } from '@/state/store';
import { Kbd, PathLabel, cx } from '@/ui';
import { Highlight } from './Highlight';
import { buildItems, loadRecent, pushRecent, type PaletteGroup, type PaletteItem } from './items';
import './palette.css';

interface Row {
  item: PaletteItem;
  group: PaletteGroup;
  indices?: number[];
}

const LIMITS: Record<PaletteGroup, number> = { Recent: 5, Sessions: 8, Projects: 5, Actions: 14, Commands: 10, Skills: 10 };
const EMPTY_LIMITS: Record<PaletteGroup, number> = { Recent: 5, Sessions: 6, Projects: 4, Actions: 40, Commands: 6, Skills: 6 };

/** The command palette (mod+k): sessions, projects, actions and the open session's commands. */
export function Palette() {
  const open = useStore((s) => s.ui.paletteOpen);
  const setUi = useStore((s) => s.setUi);
  const ran = useRef(false);
  // A fresh body (empty query, cursor at top) every time the palette opens.
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (open) setSession((n) => n + 1);
  }, [open]);

  return (
    <RD.Root open={open} onOpenChange={(o) => setUi({ paletteOpen: o })}>
      <RD.Portal>
        <RD.Overlay className="palette-overlay" />
        <RD.Content
          className="palette"
          data-spot=""
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            ran.current = false;
          }}
          onCloseAutoFocus={(e) => {
            // When an item ran, it decides where focus goes (composer, another dialog).
            if (ran.current) e.preventDefault();
          }}
        >
          <RD.Title className="sr-only">Search and commands</RD.Title>
          <PaletteBody
            key={session}
            onRun={(item) => {
              ran.current = true;
              pushRecent(item.id);
              setUi({ paletteOpen: false });
              window.setTimeout(item.run, 16);
            }}
          />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function PaletteBody({ onRun }: { onRun: (item: PaletteItem) => void }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recent = useMemo(loadRecent, []);

  const sessionsMap = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.ui.activeSessionId);
  const homeProvider = useStore((s) => s.ui.homeProvider);
  const providers = useStore((s) => s.providers);
  const caps = useStore((s) => (activeId ? s.data[activeId]?.caps : undefined));

  const items = useMemo(() => {
    const sessions = Object.values(sessionsMap).sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.updatedAt - a.updatedAt);
    const installed = (Object.values(providers).filter((p) => p?.installed).map((p) => p!.id) as ProviderId[]).sort(
      (a, b) => ['claude', 'codex', 'nusacode', 'demo'].indexOf(a) - ['claude', 'codex', 'nusacode', 'demo'].indexOf(b),
    );
    const projs = [...projects].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastOpened - a.lastOpened);
    const accountName = (s: SessionMeta) => {
      const accounts = providers[s.provider]?.accounts;
      return accounts && accounts.length > 1 ? nameOfAccount(accounts.find((a) => a.id === (s.accountId ?? DEFAULT_ACCOUNT))) : undefined;
    };
    return buildItems({ sessions, projects: projs, activeId, active: activeId ? sessionsMap[activeId] : undefined, installed, homeProvider, caps, accountName });
  }, [sessionsMap, projects, activeId, homeProvider, providers, caps]);

  // Scope prefixes: ">" actions only, "@" sessions only.
  const scope = query.startsWith('>') ? 'actions' : query.startsWith('@') ? 'sessions' : null;
  const q = scope ? query.slice(1).trim() : query.trim();

  const rows = useMemo<Row[]>(() => {
    const pool = items.filter((it) => (scope === 'actions' ? it.group === 'Actions' || it.group === 'Commands' || it.group === 'Skills' : scope === 'sessions' ? it.group === 'Sessions' : true));

    if (!q) {
      const out: Row[] = [];
      const used = new Set<string>();
      if (!scope) {
        const byId = new Map(pool.map((it) => [it.id, it]));
        for (const id of recent) {
          const it = byId.get(id);
          if (!it || it.group === 'Sessions' || it.group === 'Projects') continue;
          if (out.length >= EMPTY_LIMITS.Recent) break;
          out.push({ item: it, group: 'Recent' });
          used.add(id);
        }
      }
      const counts: Partial<Record<PaletteGroup, number>> = {};
      for (const it of pool) {
        if (used.has(it.id)) continue;
        if (it.group === 'Sessions' && it.session?.archived && !scope) continue;
        const n = counts[it.group] ?? 0;
        const max = scope ? 60 : EMPTY_LIMITS[it.group];
        if (n >= max) continue;
        counts[it.group] = n + 1;
        out.push({ item: it, group: it.group });
      }
      return order(out, scope ? undefined : ['Recent', 'Sessions', 'Projects', 'Actions', 'Commands', 'Skills']);
    }

    const scored: (Row & { score: number })[] = [];
    for (const it of pool) {
      const onTitle = fuzzy(q, it.title);
      let score: number;
      let indices: number[] | undefined;
      if (onTitle) {
        score = onTitle.score;
        indices = onTitle.indices;
      } else {
        const wide = wordPrefix(q, [it.title, it.sub, it.keywords].filter(Boolean).join(' '));
        if (wide === null) continue;
        score = wide * 0.6;
      }
      if (recent.includes(it.id)) score += 6 - recent.indexOf(it.id) * 0.4;
      if (it.session?.archived) score -= 8;
      scored.push({ item: it, group: it.group, indices, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const counts: Partial<Record<PaletteGroup, number>> = {};
    const best: Partial<Record<PaletteGroup, number>> = {};
    const kept = scored.filter((r) => {
      const n = counts[r.group] ?? 0;
      if (n >= LIMITS[r.group]) return false;
      counts[r.group] = n + 1;
      best[r.group] ??= r.score;
      return true;
    });
    // Groups ordered by their best match, so Enter always takes the strongest result.
    const groupOrder = (Object.keys(best) as PaletteGroup[]).sort((a, b) => best[b]! - best[a]!);
    return order(kept, groupOrder);
  }, [items, q, scope, recent]);

  useEffect(() => setCursor(0), [q, scope]);
  const safe = Math.min(cursor, Math.max(0, rows.length - 1));

  // Keep the cursor row in view, smoothly.
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-index="${safe}"]`);
    if (!list || !el) return;
    const pad = 8;
    const head = safe === 0 || rows[safe - 1]?.group !== rows[safe]?.group ? 30 : 0;
    const top = el.offsetTop - pad - head;
    const bottom = el.offsetTop + el.offsetHeight + pad;
    if (top < list.scrollTop) list.scrollTo({ top: safe === 0 ? 0 : top, behavior: 'smooth' });
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight, behavior: 'smooth' });
  }, [safe, rows]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    const move = (d: number) => {
      e.preventDefault();
      if (n) setCursor((c) => (Math.min(c, n - 1) + d + n) % n);
    };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) move(1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) move(-1);
    else if (e.key === 'PageDown') move(Math.min(8, n - 1 - safe) || 0);
    else if (e.key === 'PageUp') move(-Math.min(8, safe) || 0);
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[safe];
      if (row) onRun(row.item);
    } else if (e.key === 'Backspace' && scope && query.length === 1) {
      e.preventDefault();
      setQuery('');
    }
  };

  const placeholder = scope === 'actions' ? 'Run an action or command' : scope === 'sessions' ? 'Find a session' : 'Search sessions, projects and actions';

  return (
    <>
      <div className="palette-head">
        <Icon name="search" size={18} className="palette-search" />
        {scope && (
          <span className="palette-scope" aria-hidden>
            {scope === 'actions' ? 'Actions' : 'Sessions'}
          </span>
        )}
        <input
          ref={inputRef}
          className="palette-input"
          autoFocus
          value={scope ? query.slice(1).replace(/^\s/, '') : query}
          onChange={(e) => setQuery(scope ? (scope === 'actions' ? '>' : '@') + e.target.value : e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={rows[safe] ? `palette-opt-${safe}` : undefined}
        />
        <Kbd combo="esc" className="palette-esc" />
      </div>

      <div ref={listRef} id="palette-list" className="palette-list scroll" role="listbox" aria-label="Results">
        {rows.length === 0 ? (
          <div className="palette-empty">{q ? `Nothing matches “${q}”.` : 'Nothing here yet.'}</div>
        ) : (
          rows.map((row, i) => (
            <PaletteRowView key={`${row.group}:${row.item.id}`} row={row} index={i} active={i === safe} showHead={i === 0 || rows[i - 1].group !== row.group} onHover={setCursor} onRun={onRun} />
          ))
        )}
      </div>

      <div className="palette-foot">
        <span className="palette-hint">
          <Kbd combo="up" />
          <Kbd combo="down" />
          to move
        </span>
        <span className="palette-hint">
          <Kbd combo="enter" />
          to open
        </span>
        <span className="grow" />
        <span className="palette-hint">
          <kbd className="kbd">&gt;</kbd>
          actions
        </span>
        <span className="palette-hint">
          <kbd className="kbd">@</kbd>
          sessions
        </span>
      </div>
    </>
  );
}

function order(rows: Row[], groups?: PaletteGroup[]): Row[] {
  if (!groups) return rows;
  const out: Row[] = [];
  for (const g of groups) for (const r of rows) if (r.group === g) out.push(r);
  return out;
}

function PaletteRowView({
  row,
  index,
  active,
  showHead,
  onHover,
  onRun,
}: {
  row: Row;
  index: number;
  active: boolean;
  showHead: boolean;
  onHover: (i: number) => void;
  onRun: (item: PaletteItem) => void;
}) {
  const { item } = row;
  return (
    <>
      {showHead && (
        <div className="palette-group" role="presentation">
          {row.group}
        </div>
      )}
      <div
        id={`palette-opt-${index}`}
        role="option"
        aria-selected={active}
        data-index={index}
        data-active={active || undefined}
        className={cx('palette-row', active && 'dither-sel', item.session?.archived && 'is-archived')}
        onMouseMove={() => !active && onHover(index)}
        onClick={() => onRun(item)}
      >
        <span className="palette-lead">
          {item.session ? (
            <span className="palette-smark">
              {statusTone(item.session) === 'idle' ? <Icon name="chat" size={14} className="palette-idle" /> : <StatusMark session={item.session} />}
            </span>
          ) : (
            <Icon name={item.icon ?? 'command'} size={16} className="palette-icon" />
          )}
        </span>
        <span className="palette-text">
          <span className="palette-title truncate">
            <Highlight text={item.title} indices={row.indices} />
          </span>
          {item.sub && (item.group === 'Projects' ? <PathLabel path={item.sub} className="palette-sub" /> : <span className="palette-sub truncate">{item.sub}</span>)}

        </span>
        <span className="palette-end">{item.session ? <SessionEnd session={item.session} /> : item.keys ? <Kbd combo={item.keys} /> : null}</span>
        {active && (
          <span className="palette-enter" aria-hidden>
            <Icon name="enter" size={13} />
          </span>
        )}
      </div>
    </>
  );
}

function SessionEnd({ session }: { session: SessionMeta }) {
  const now = useNow();
  const label = statusLabel(session);
  if (session.status === 'running' || session.status === 'starting')
    return (
      <span className="palette-status">
        <span className="truncate shimmer">{label}</span>
      </span>
    );
  if (session.status === 'awaiting') return <span className="palette-status is-amber">Needs approval</span>;
  if (session.status === 'error') return <span className="palette-status is-red">Error</span>;
  return (
    <span className="palette-time num">
      {session.archived && <span className="palette-arch">Archived</span>}
      {timeAgo(session.updatedAt, now)}
    </span>
  );
}
