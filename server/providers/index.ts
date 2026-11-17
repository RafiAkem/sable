import type { Provider, ProviderContext } from './types';
import { ClaudeProvider } from './claude';
import { CodexProvider } from './codex';
import { DemoProvider } from './demo';
import { NusaCodeProvider } from './nusacode';

/** The Demo agent exists in development only (the Vite dev server sets SABLE_DEMO=1); builds never offer it. */
export const demoEnabled = () => process.env.SABLE_DEMO === '1';

export function defaultProviders(): ((ctx: ProviderContext) => Provider)[] {
  const list: ((ctx: ProviderContext) => Provider)[] = [(ctx) => new ClaudeProvider(ctx), (ctx) => new CodexProvider(ctx), (ctx) => new NusaCodeProvider(ctx)];
  if (demoEnabled()) list.push((ctx) => new DemoProvider(ctx));
  return list;
}
