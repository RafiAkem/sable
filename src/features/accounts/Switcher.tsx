import { useEffect, useRef, useState } from 'react';
import { DropdownMenu as RM } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { AccountInfo, ProviderId } from '@shared/protocol';
import { ProviderMark, PROVIDER_NAME } from '@/art/Logo';
import { LimitDot, LimitsGlance } from '@/features/usage';
import { Icon } from '@/icons';
import { openSettings, setDefaultAccount } from '@/state/actions';
import { accountName, useFocusAccount } from '@/state/hooks';
import { useStore } from '@/state/store';
import { ManyAccounts, MANY_ACCOUNTS, RoomFigure } from './ManyAccounts';
import { accountAgents, accountsOf, openAddAccount, planWord } from './model';

/**
 * The sidebar footer's account switcher. The row names the account in focus by its plan (the label
 * follows when an agent has several); it opens every agent's accounts as rows with the plan and a
 * limit mark, the default checked. Pointing at a row (or moving to it with the keys) shows that
 * account's limits beside the menu. Picking one makes it the account new sessions use.
 */
export function AccountSwitcher() {
  const providers = useStore((s) => s.providers);
  const { provider: active, accountId } = useFocusAccount();
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<{ provider: ProviderId; accountId: string } | null>(null);
  const reduce = useReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);

  // As the menu opens, the account in use takes the focus (pointer or keys alike), so its limits
  // show beside the menu at once. After Radix's own focus on open, at the start of a frame (a focus
  // move forces a style pass, and the menu's styles were just invalidated).
  useEffect(() => {
    if (!open) return;
    let r = requestAnimationFrame(() => {
      r = requestAnimationFrame(() => {
        const pop = contentRef.current;
        if (!pop || pop.dataset.state === 'closed' || document.activeElement?.matches('.acs-row[data-in-use]')) return;
        const row = pop.querySelector<HTMLElement>('.acs-row[data-in-use]') ?? pop.querySelector<HTMLElement>('.acs-row');
        row?.focus({ preventScroll: true });
        // In a long list the account in use may sit below the fold of the list's own scroller.
        const scroller = row?.closest<HTMLElement>('.acs-list');
        if (row && scroller) scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 2);
      });
    });
    return () => cancelAnimationFrame(r);
  }, [open]);

  const agents = accountAgents(providers);
  const signedIn = agents.filter((id) => accountsOf(providers[id]).some((a) => a.auth.loggedIn));
  const focus: ProviderId = signedIn.includes(active) || agents.includes(active) ? active : (signedIn[0] ?? agents[0] ?? active);
  const list = accountsOf(providers[focus]);
  const current = (focus === active ? list.find((a) => a.id === accountId) : undefined) ?? list.find((a) => a.isDefault) ?? list[0];
  const plan = planWord(current);
  const several = list.length > 1;
  const many = agents.reduce((n, id) => n + accountsOf(providers[id]).length, 0) >= MANY_ACCOUNTS;

  const name = current ? accountName(current) : PROVIDER_NAME[focus];
  // A NusaGate key is not a tier: "NusaGate", not "NusaGate plan".
  const headline = current?.auth.loggedIn ? (plan ? (current.auth.method === 'nusagate' ? plan : `${plan} plan`) : PROVIDER_NAME[focus]) : 'Not signed in';
  const described = [PROVIDER_NAME[focus], several ? name : undefined, headline].filter(Boolean).join(', ');

  return (
    <RM.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPeek(null);
      }}
      modal={false}
    >
      <RM.Trigger asChild>
        <button type="button" className="account-main acs-trigger" aria-label={`${described}. Accounts`}>
          {/* The agent in focus only: the menu lists the others. One mark keeps the plan on the text column. */}
          <span className="account-mark" aria-hidden>
            <ProviderMark provider={focus} size={12} />
          </span>
          <span className="account-who">
            <span className="account-plan">{headline}</span>
            {several && current && <span className="acs-label truncate">{name}</span>}
          </span>
          <RoomFigure agents={agents} providers={providers} />
          {current && <LimitDot provider={focus} accountId={current.id} className="acs-dot" />}
          <Icon name="caret-updown" size={13} className="account-caret" />
        </button>
      </RM.Trigger>
      <RM.Portal>
        <RM.Content
          ref={contentRef}
          className="pop acs-pop"
          data-spot
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          style={{ width: 252 }}
          loop
        >
          {many && (
            <ManyAccounts
              agents={agents}
              providers={providers}
              inUse={{ provider: focus, accountId: current?.id }}
              onPeek={setPeek}
              onPick={(id, a) => {
                if (!a.auth.loggedIn) return openSettings('accounts');
                void setDefaultAccount(id, a.id);
                useStore.getState().setUi({ homeProvider: id });
                setOpen(false);
              }}
            />
          )}
          {!many && agents.map((id, i) => (
            <RM.Group key={id} className="acs-group">
              {i > 0 && <RM.Separator className="menu-sep" />}
              {accountsOf(providers[id]).map((a, _, all) => (
                <Row
                  key={a.id}
                  provider={id}
                  account={a}
                  single={all.length === 1}
                  inUse={id === focus && a.id === current?.id}
                  onPeek={() => setPeek({ provider: id, accountId: a.id })}
                  onSelect={() => {
                    if (!a.auth.loggedIn) return openSettings('accounts');
                    void setDefaultAccount(id, a.id);
                    useStore.getState().setUi({ homeProvider: id });
                  }}
                />
              ))}
            </RM.Group>
          ))}
          <RM.Separator className="menu-sep" />
          <RM.Item className="menu-item" onFocus={() => setPeek(null)} onSelect={() => openAddAccount(agents.length > 1 ? undefined : focus)}>
            <Icon name="plus" size={16} />
            <span className="grow">Add account</span>
          </RM.Item>
          <RM.Item className="menu-item" onFocus={() => setPeek(null)} onSelect={() => openSettings('accounts')}>
            <Icon name="settings" size={16} />
            <span className="grow">Manage accounts</span>
          </RM.Item>

          <AnimatePresence>
            {peek && (
              <motion.div
                key="peek"
                className="acs-peek"
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              >
                <Peek key={`${peek.provider}:${peek.accountId}`} provider={peek.provider} accountId={peek.accountId} onOpenUsage={() => setOpen(false)} />
              </motion.div>
            )}
          </AnimatePresence>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

function Row({ provider, account, single, inUse, onPeek, onSelect }: { provider: ProviderId; account: AccountInfo; single: boolean; inUse: boolean; onPeek: () => void; onSelect: () => void }) {
  const plan = account.auth.loggedIn ? planWord(account) : undefined;
  // An agent's only account goes by the agent's name, and there is no choice to check.
  const label = single ? PROVIDER_NAME[provider] : accountName(account);
  return (
    <RM.Item
      className="menu-item acs-row"
      data-current={account.isDefault || undefined}
      data-in-use={inUse || undefined}
      onFocus={onPeek}
      onSelect={onSelect}
      aria-label={`${PROVIDER_NAME[provider]}, ${label}${plan ? `, ${plan}` : ''}${account.auth.loggedIn ? '' : ', not signed in'}${account.isDefault ? ', default' : ''}`}
    >
      <ProviderMark provider={provider} size={14} className="acs-mark" />
      <span className="acs-name truncate">{label}</span>
      <span className="acs-plan">{account.auth.loggedIn ? plan : 'Sign in'}</span>
      <span className="acs-end">
        <LimitDot provider={provider} accountId={account.id} />
        {account.isDefault && !single && <Icon name="check" size={14} className="acs-check" />}
      </span>
    </RM.Item>
  );
}

/** The pointed-at account's limits, beside the menu. Kept mounted per account so it reads once. */
function Peek({ provider, accountId, onOpenUsage }: { provider: ProviderId; accountId: string; onOpenUsage: () => void }) {
  return (
    <div className="acs-peek-in">
      <LimitsGlance provider={provider} accountId={accountId} onOpenUsage={onOpenUsage} />
    </div>
  );
}
