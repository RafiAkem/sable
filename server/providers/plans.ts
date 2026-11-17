/**
 * Display names for the plan an agent is signed in with ("Max", "Plus", "API key"…), from what
 * each CLI reports. Read-only: nothing here signs in or out.
 */

export interface PlanName {
  /** Display-ready, or undefined when the agent reported nothing useful. */
  plan?: string;
  /** The raw value the agent reported. */
  planId?: string;
}

const titleCase = (s: string) =>
  s
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const CLAUDE_PROVIDERS: Record<string, string> = {
  bedrock: 'Amazon Bedrock',
  anthropicAws: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  anthropicGoogleCloud: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  gateway: 'Enterprise gateway',
};

const CLAUDE_PLANS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  ultra: 'Ultra',
  team: 'Team',
  enterprise: 'Enterprise',
};

/**
 * Claude Code: `claude auth status --json` (authMethod, apiProvider, subscriptionType) plus the
 * first line of `claude auth status --text` ("Login method: Claude Max account"), whose wording is
 * the CLI's own name for the plan and wins when present.
 */
export function claudePlan(status: { authMethod?: unknown; apiProvider?: unknown; subscriptionType?: unknown }, text?: string): PlanName {
  const raw = typeof status.subscriptionType === 'string' && status.subscriptionType.trim() ? status.subscriptionType.trim() : undefined;
  const method = typeof status.authMethod === 'string' ? status.authMethod.toLowerCase() : '';
  const provider = typeof status.apiProvider === 'string' ? status.apiProvider : undefined;
  if (provider && provider !== 'firstParty') return { plan: CLAUDE_PROVIDERS[provider] ?? titleCase(provider), planId: raw ?? provider };
  const said = text?.match(/Login method:\s*Claude\s+([\w ]{1,24}?)\s+account/i)?.[1]?.trim();
  if (said && !/^(ai|\.ai)$/i.test(said)) return { plan: CLAUDE_PLANS[said.toLowerCase()] ?? titleCase(said), planId: raw ?? said };
  if (raw) {
    const key = raw.replace(/^claude\s+/i, '').toLowerCase();
    return { plan: CLAUDE_PLANS[key] ?? titleCase(key), planId: raw };
  }
  if (/api.?key/.test(method)) return { plan: 'API key' };
  if (/console/.test(method)) return { plan: 'Console' };
  if (/oauth.?token|token/.test(method)) return { plan: 'Token' };
  return {};
}

const CODEX_PLANS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  // ChatGPT Team is now called Business.
  team: 'Business',
  business: 'Business',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  enterprise: 'Enterprise',
  ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
  sci: 'Science',
  sci_plus: 'Science Plus',
};

/** Codex: the `account` from `account/read`. */
export function codexPlan(account: { type?: string; planType?: string | null } | null | undefined, customProvider = false): PlanName {
  if (!account) return customProvider ? { plan: 'Custom provider' } : {};
  switch (account.type) {
    case 'chatgpt': {
      const raw = account.planType ?? undefined;
      if (!raw || raw === 'unknown') return { planId: raw };
      return { plan: CODEX_PLANS[raw] ?? titleCase(raw), planId: raw };
    }
    case 'apiKey':
      return { plan: 'API key' };
    case 'amazonBedrock':
      return { plan: 'Amazon Bedrock' };
    case 'gcp':
      return { plan: 'Google Cloud' };
    default:
      return account.type ? { plan: titleCase(account.type) } : {};
  }
}

/** NusaCode: every sign-in is a NusaGate API key; a Coding Plan shows as a limit, not as the plan name. */
export const NUSAGATE_PLAN: PlanName = { plan: 'NusaGate' };
