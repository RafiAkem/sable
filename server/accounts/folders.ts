import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { AccountFolder, AuthState, ProviderId, RateLimit } from '../../shared/protocol';

/**
 * Finding config folders people already keep for an agent ("~/.claude-work",
 * "~/.claude-accounts/studio"), choosing which account to continue with at a limit, and naming a new
 * account after its sign-in. Folders are judged by the names in their listing only: no file in
 * them is ever opened (some hold sign-ins). Whether one is signed in is asked of the agent's CLI.
 */

const MARKERS: Partial<Record<ProviderId, string[]>> = {
  claude: ['projects', 'settings.json', '.claude.json', 'plugins', 'todos', 'statsig', 'history.jsonl', 'shell-snapshots', 'ide'],
  codex: ['config.toml', 'sessions', 'history.jsonl', 'log', 'version.json'],
  nusacode: ['sessions', 'settings.json', 'models.json', 'nusagate-models.json', 'usage.jsonl'],
};

const PREFIX: Partial<Record<ProviderId, string>> = { claude: 'claude', codex: 'codex', nusacode: 'nusacode' };

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function looksLike(provider: ProviderId, dir: string): boolean {
  const markers = MARKERS[provider];
  if (!markers) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => markers.includes(n));
}

/**
 * Config folders of `provider` under `home`: `.claude-*` / `.claude_*` / `.claude.*` folders and the
 * folders inside `.claude-accounts` (the same for Codex), minus the agent's own (`.claude`) and
 * folders in `exclude` (accounts already registered).
 */
export function findAccountFolders(provider: ProviderId, home: string, exclude: string[] = []): AccountFolder[] {
  const prefix = PREFIX[provider];
  if (!prefix) return [];
  const skip = new Set(exclude.map(norm));
  skip.add(norm(path.join(home, `.${prefix}`)));
  const out: AccountFolder[] = [];
  const consider = (dir: string, name: string) => {
    if (skip.has(norm(dir)) || out.some((f) => norm(f.dir) === norm(dir))) return;
    if (looksLike(provider, dir)) out.push({ dir, name });
  };
  const group = `.${prefix}-accounts`;
  for (const name of listDirs(home)) {
    if (name === group) {
      for (const inner of listDirs(path.join(home, name))) consider(path.join(home, name, inner), inner);
    } else if (new RegExp(`^\\.${prefix}[-_.].+`).test(name)) {
      consider(path.join(home, name), name.slice(1));
    }
  }
  return out.slice(0, 12);
}

/** A label for a registered folder: ".claude-work" → "Work", "studio" → "Studio". */
export function folderLabel(provider: ProviderId, dir: string): string {
  const prefix = PREFIX[provider] ?? '';
  const base = path.basename(path.resolve(dir)).replace(/^\./, '');
  const bare = base.replace(new RegExp(`^${prefix}[-_.]?`, 'i'), '') || base;
  return capital(bare.replace(/[-_]+/g, ' ').trim()).slice(0, 60) || 'Folder';
}

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * What a new account is called once it signs in: the name part of its email ("ada" from
 * ada@example.com), or the whole email when another account already has that name, or the
 * organisation when there is no email. Undefined when the sign-in says nothing usable.
 */
export function labelFromAuth(auth: AuthState, taken: string[]): string | undefined {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const email = auth.email?.trim();
  if (email) {
    const local = email.split('@')[0];
    const name = /^[a-z]+$/i.test(local) ? capital(local.toLowerCase()) : local;
    if (name && !used.has(name.toLowerCase())) return name.slice(0, 60);
    if (!used.has(email.toLowerCase())) return email.slice(0, 60);
  }
  const org = auth.org?.trim();
  if (org && !/'s organi[sz]ation$/i.test(org) && !used.has(org.toLowerCase())) return org.slice(0, 60);
  return undefined;
}

export interface NextCandidate {
  id: string;
  signedIn: boolean;
  isDefault?: boolean;
  limits?: RateLimit[];
  /** False when the account has no plan limits (an API key): always has room. */
  planLimits?: boolean;
}

/** A window that is used up and has not reset yet. */
export function atCap(limits: RateLimit[] | undefined, now = Date.now()): boolean {
  return (limits ?? []).some((l) => l.percent >= 100 && !(l.resetsAt && l.resetsAt <= now));
}

/**
 * The account to continue with when `current` is at a limit: another signed-in account that is not
 * at a limit itself, the one with the most room first (unknown limits count as half used), the
 * default account winning a tie. Undefined when none has room.
 */
export function pickNextAccount(current: string, accounts: NextCandidate[], now = Date.now()): string | undefined {
  const used = (a: NextCandidate) => {
    if (a.planLimits === false) return 0;
    const live = (a.limits ?? []).filter((l) => !(l.resetsAt && l.resetsAt <= now));
    return live.length ? Math.max(...live.map((l) => l.percent)) : 50;
  };
  const ok = accounts.filter((a) => a.id !== current && a.signedIn && !atCap(a.limits, now));
  ok.sort((a, b) => used(a) - used(b) || Number(!!b.isDefault) - Number(!!a.isDefault));
  return ok[0]?.id;
}
