import { useEffect, type ReactNode } from 'react';
import { DEFAULT_ACCOUNT, type Capabilities, type ModeInfo, type ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { CopyButton } from '@/components/CopyButton';
import { Icon, MODE_ICON } from '@/icons';
import { baseName } from '@/lib/format';
import { homeAccountId } from '@/state/actions';
import { capsKey, ensureProviderCaps, useStore } from '@/state/store';
import { cx, PathLabel, Segmented } from '@/ui';

/** Building blocks shared by the settings sections. */

export function Card({ children, title, aside, className }: { children: ReactNode; title?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cx('set-group', className)}>
      {(title || aside) && (
        <header className="set-group-head">
          {title && <h3 className="set-group-title">{title}</h3>}
          {aside && <div className="set-group-aside">{aside}</div>}
        </header>
      )}
      <div className="card set-card" data-spot>
        {children}
      </div>
    </section>
  );
}

/** Label and one line of help on the left, the control on the right. */
export function Row({ label, help, children, htmlFor, align = 'center' }: { label: ReactNode; help?: ReactNode; children?: ReactNode; htmlFor?: string; align?: 'center' | 'start' }) {
  return (
    <div className="set-row" data-align={align}>
      <div className="set-row-text">
        {htmlFor ? (
          <label className="set-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="set-row-label">{label}</div>
        )}
        {help && <div className="set-row-help">{help}</div>}
      </div>
      {children && <div className="set-row-control">{children}</div>}
    </div>
  );
}

/** A file or folder rather than a command or key: "~/.sable", ".mcp.json", "CLAUDE.md", "src/app.ts", "C:/x". */
const looksLikePath = (t: string) =>
  !/\s/.test(t) && (/^~/.test(t) || /^\.[\w.-]+$/.test(t) || /^[\w.-]+\.[A-Za-z0-9]+$/.test(t) || (/[\\/]/.test(t) && !t.startsWith('/')));

/**
 * A path, command or config key in a small chip, with a copy button. Paths read as labels (the UI
 * font, the directory dim); commands and keys stay code (mono).
 */
export function CodeChip({ text, copy = true, label }: { text: string; copy?: boolean; label?: string }) {
  const path = looksLikePath(text);
  return (
    <span className="code-chip" data-path={path || undefined}>
      {path ? <PathLabel path={text} className="code-chip-path" /> : <code className="truncate">{text}</code>}
      {copy && <CopyButton text={text} label={label ?? `Copy ${text}`} size={13} className="code-chip-copy" />}
    </span>
  );
}

export function SearchField({ value, onChange, placeholder, count }: { value: string; onChange: (v: string) => void; placeholder: string; count?: number }) {
  return (
    <div className="set-search">
      <Icon name="search" size={15} />
      <input
        className="field"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        data-escape-scope={value ? '' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {count !== undefined && value && <span className="set-search-count num">{count}</span>}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="set-skel" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="set-skel-row">
          <span className="set-skel-tile skel" />
          <span className="col grow" style={{ gap: 7 }}>
            <span className="set-skel-bar skel" style={{ width: `${34 + ((i * 17) % 30)}%` }} />
            <span className="set-skel-bar skel faint" style={{ width: `${55 + ((i * 23) % 35)}%` }} />

          </span>
        </div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="set-empty">{children}</div>;
}

/** Installed providers in display order. */
export function useInstalled(): ProviderId[] {
  const providers = useStore((s) => s.providers);
  return (['claude', 'codex', 'nusacode', 'demo'] as ProviderId[]).filter((id) => providers[id]?.installed);
}

export function ProviderPicker({ value, onChange, id }: { value: ProviderId; onChange: (p: ProviderId) => void; id: string }) {
  const installed = useInstalled();
  if (installed.length < 2) return null;
  return (
    <Segmented
      id={id}
      value={value}
      onChange={onChange}
      options={installed.map((p) => ({ value: p, label: <ProviderLabel provider={p} /> }))}
    />
  );
}

export function ProviderLabel({ provider }: { provider: ProviderId }) {
  return (
    <span className="prov-label">
      <ProviderMark provider={provider} size={13} />
      {PROVIDER_NAME[provider]}
    </span>
  );
}

/**
 * Where a page's settings come from, at the right end of its toolbar: the agent (when the page has
 * no picker for it) and the project folder. One look on every page that has a scope.
 */
export function Scope({ provider, cwd }: { provider?: ProviderId; cwd?: string | null }) {
  if (!provider && !cwd) return null;
  return (
    <span className="set-scope">
      {provider && <ProviderLabel provider={provider} />}
      {cwd && (
        <span className="set-scope-dir" title={cwd}>
          <Icon name="folder" size={13} />
          <span className="truncate">{baseName(cwd)}</span>
        </span>
      )}
    </span>
  );
}

/** What the settings pages describe: the open session's provider and folder, else the home screen's choice. */
export function useContextTarget(): { provider: ProviderId; cwd: string | null; sessionId: string | null } {
  const sessionId = useStore((s) => (s.ui.activeSessionId && s.sessions[s.ui.activeSessionId] ? s.ui.activeSessionId : null));
  const provider = useStore((s) => (sessionId ? s.sessions[sessionId].provider : s.ui.homeProvider));
  const cwd = useStore((s) => (sessionId ? s.sessions[sessionId].cwd : s.ui.homeCwd));
  return { provider, cwd, sessionId };
}

/**
 * Capabilities for a provider in a folder, fetched on demand for the account in use: the
 * session's when it runs this provider, otherwise the one chosen on the home screen. With a
 * session, its own caps win.
 */
export function useProviderCaps(provider: ProviderId, cwd: string | null, sessionId?: string | null): Capabilities | undefined {
  const ready = useStore((s) => s.ready);
  const sessionCaps = useStore((s) => (sessionId ? s.data[sessionId]?.caps : undefined));
  const accountId = useStore((s) => {
    const session = sessionId ? s.sessions[sessionId] : undefined;
    return session?.provider === provider ? (session.accountId ?? DEFAULT_ACCOUNT) : homeAccountId(provider, s);
  });
  const caps = useStore((s) => s.providerCaps[capsKey(provider, cwd, accountId)] ?? s.providerCaps[capsKey(provider, cwd)]);
  useEffect(() => {
    if (ready && !sessionCaps) ensureProviderCaps(provider, cwd, accountId);
  }, [ready, provider, cwd, accountId, sessionCaps]);
  return sessionCaps ?? caps;
}

/** Selectable rows for permission modes: a quiet icon, the name, one line of description, a check on the chosen one. */
export function ModeList({ modes, value, onChange, label }: { modes: ModeInfo[]; value: string | undefined; onChange: (id: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="pick-list">
      {modes.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={m.id === value} className="pick pick-plain" onClick={() => onChange(m.id)}>
          <Icon name={MODE_ICON[m.tone] ?? 'shield'} size={17} className="pick-icon" />
          <span className="pick-text">
            <span className="pick-name">{m.name}</span>
            {m.description && <span className="pick-desc truncate">{m.description}</span>}
          </span>
          <Check on={m.id === value} />
        </button>
      ))}
    </div>
  );
}

export function Check({ on }: { on: boolean }) {
  return (
    <span className="pick-check" data-on={on || undefined} aria-hidden>
      <Icon name="check" size={12} />
    </span>
  );
}
