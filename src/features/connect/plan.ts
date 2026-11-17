import type { AccountInfo, AuthState, ProviderId, ProviderInfo } from '@shared/protocol';

/**
 * What an account is connected with, for display: the subscription ("Max plan", "Pro plan"), an
 * API key, or the kind of sign-in when the CLI does not name a plan. The agents report plans in
 * many spellings ("max", "claude_max", "Max 20x", "chatgptPlus", "pro"), so this normalises them.
 */
export function planLabel(auth: AuthState | undefined): string | undefined {
  if (!auth?.loggedIn) return undefined;
  const method = (auth.method ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (method === 'apikey' || method === 'console' || method === 'api') return 'API key';
  // An agent that runs on this computer has no subscription to name.
  if (method === 'local') return undefined;
  // NusaCode signs in with a NusaGate key: the brand is the label ("NusaGate plan" would read as a tier).
  if (method === 'nusagate') return 'NusaGate';
  const plan = formatPlan(auth.plan);
  if (plan) return plan;
  if (method === 'claude.ai' || method === 'claudeai' || method === 'oauth') return 'Claude subscription';
  if (method === 'chatgpt') return 'ChatGPT subscription';
  return undefined;
}

const NAMES: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  plus: 'Plus',
  max: 'Max',
  team: 'Team',
  teams: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  education: 'Edu',
};

function formatPlan(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  if (/api[\s_-]?key/i.test(s)) return 'API key';
  // Vendor prefixes and camelCase ("claude_max", "chatgptPlus", "default_claude_max_20x").
  s = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(default|claude|chatgpt|openai|subscription|tier)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;
  const hasPlan = /\bplan$/i.test(s);
  if (hasPlan) s = s.replace(/\s*\bplan$/i, '').trim();
  const words = s.split(' ').map((w) => {
    const lower = w.toLowerCase();
    if (NAMES[lower]) return NAMES[lower];
    if (/^\d+x$/i.test(w)) return lower; // "20x"
    if (/^max\d+x?$/i.test(w)) return `Max ${w.slice(3).replace(/x?$/i, 'x')}`; // "max20x", "max5"
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  const name = words.join(' ').trim();
  return name ? `${name} plan` : undefined;
}

/** The signed-in account to show for an agent: the default one if it is signed in, else any. */
export function signedInAccount(info: ProviderInfo | undefined): AccountInfo | undefined {
  if (!info) return undefined;
  const accounts = info.accounts ?? [];
  return accounts.find((a) => a.isDefault && a.auth.loggedIn) ?? accounts.find((a) => a.auth.loggedIn) ?? (info.auth.loggedIn ? { id: 'default', provider: info.id, label: 'Main', isDefault: true, auth: info.auth } : undefined);
}

export const isSignedIn = (info: ProviderInfo | undefined) => !!info?.installed && !!signedInAccount(info);

/** Agents that run on this computer without an account have nothing to connect. */
export const needsAccount = (info: ProviderInfo | undefined) => !!info && !(info.accounts?.length ? info.accounts : [{ auth: info.auth }]).every((a) => (a.auth.method ?? '') === 'local');

/** Every agent the bridge reports that has an account to connect: Claude Code and Codex first, then any others. */
export function connectableAgents(providers: Partial<Record<ProviderId, ProviderInfo>>): ProviderId[] {
  const known: ProviderId[] = ['claude', 'codex', 'nusacode'];
  const others = (Object.keys(providers) as ProviderId[]).filter((id) => !known.includes(id) && needsAccount(providers[id]));
  return [...known, ...others];
}

/** The command that installs an agent's CLI, when there is one. */
export const INSTALL: Partial<Record<ProviderId, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  nusacode: 'npm install -g nusacode',
};
