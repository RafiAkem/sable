import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { ProviderId } from '@shared/protocol';
import { loadSessionView } from '@/app/views';
import { Backdrop } from '@/art/Backdrop';
import type { DitherPalette } from '@/art/DitherField';
import { fieldBeat } from '@/art/events';
import { launchArrival, resolveGlyphs } from '@/art/LaunchLayer';
import { buildMark, LogoMark, markEcho } from '@/art/Logo';
import { Composer } from '@/features/composer/Composer';
import { ConnectBanner } from '@/features/connect/Connect';
import { dissolve } from '@/lib/dissolve';
import { EASE_OUT, play, reducedMotion } from '@/lib/motion';
import { usePrewarm } from '@/state/hooks';
import { useStore } from '@/state/store';
import { handoffPhase, subscribeHandoff } from './handoff';
import './home.css';

export const PROVIDER_PALETTE: Record<ProviderId, DitherPalette> = { claude: 'ember', codex: 'iris', nusacode: 'mint', demo: 'forest' };

/** The composer rises in after the mark: a short rise and fade, opacity and transform only. */
function rise(el: Element | null, delay: number) {
  play(el, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0px)' }], { duration: 520, delay, easing: EASE_OUT, fill: 'backwards' });
}

const TITLE = 'What are we building?';

/**
 * The arrival, one composed movement each time the home screen appears:
 * - at launch the piece is the launch's (art/LaunchLayer.tsx): its mark recedes from the middle of the
 *   window onto the home mark while the wave opens the ink, the headline resolves glyph by glyph
 *   and the composer rises. It stages all of that itself;
 * - otherwise (coming back from a session, after the welcome) the short form of the same idea, in
 *   about half a second: the mark builds in dither order a little large and settles to its size,
 *   a soft ring leaves it through the field, the headline resolves and the composer rises.
 * Under reduced motion everything is simply there.
 */
function useArrival(mark: RefObject<HTMLDivElement | null>, title: RefObject<HTMLElement | null>, composer: RefObject<HTMLDivElement | null>) {
  // Once per mount (a development double run would start it twice).
  const ran = useRef(false);
  useLayoutEffect(() => {
    if (ran.current || reducedMotion()) return;
    ran.current = true;
    const m = mark.current;
    if (launchArrival({ mark: m, title: title.current, composer: composer.current })) return;
    // After the welcome its own mark travels onto ours (Onboarding.tsx measures and reveals it):
    // ours stays as it is, and the rest arrives as that one lands.
    const welcome = !!document.querySelector('.onb');
    const at = welcome ? 160 : 0;
    if (!welcome) {
      buildMark(m, 40);
      play(m, [{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], { duration: 480, delay: 40, easing: EASE_OUT, fill: 'backwards' });
    }
    resolveGlyphs(title.current, at + 120, 9);
    play(title.current, [{ transform: 'translateY(8px)' }, { transform: 'translateY(0px)' }], { duration: 460, delay: at + 120, easing: EASE_OUT, fill: 'backwards' });
    rise(composer.current, at + 190);
    // One timer, gone in a moment: the ring leaves the mark as it becomes whole.
    window.setTimeout(() => fieldBeat('pulse', m, 0.55), welcome ? 420 : 180);
  }, [mark, title, composer]);
}

/** The empty stage: the mark, one question, one composer, light across the whole stage. */
export function Home() {
  // Latched: once the first message has left, the home screen stays emptied while it fades out
  // (the flight lands before the view has gone, and its headline must not come back meanwhile).
  const flying = useSyncExternalStore(subscribeHandoff, handoffPhase, handoffPhase) === 'flying';
  const [left, setLeft] = useState(false);
  // A send that started no session (cancelled flight) brings the home screen back.
  const opened = useStore((s) => s.ui.activeSessionId != null);
  if (flying && !left) setLeft(true);
  else if (!flying && left && !opened) setLeft(false);
  const leaving = flying || left;
  const mark = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  usePrewarm('.home-composer');
  useArrival(mark, title, composer);

  // Sending the first message: the headline and mark break up and drift upward as the composer leaves.
  useEffect(() => {
    if (!leaving) return;
    dissolve(mark.current);
    dissolve(title.current);
  }, [leaving]);

  // The mark listens: each keystroke in the composer glints one of its missing corner cells.
  useEffect(() => {
    const host = composer.current;
    if (!host) return;
    const onInput = (e: Event) => {
      if ((e.target as HTMLElement).tagName !== 'TEXTAREA') return;
      markEcho(mark.current);
      // A send is coming: the session view must be loaded before it asks for it.
      void loadSessionView().catch(() => {});
    };
    host.addEventListener('input', onInput);
    return () => host.removeEventListener('input', onInput);
  }, []);

  return (
    <div className="home" data-leaving={leaving || undefined}>
      <Backdrop surface="home" />
      <div className="home-veil" />
      <div className="home-col scroll">
        <div className="home-center">
          <div ref={mark} className="home-mark">
            <LogoMark size={36} cells />
          </div>
          {/* One span per glyph, so the headline can resolve glyph by glyph (opacity only: the line is set as one). */}
          <h1 className="display home-title" aria-label={TITLE}>
            <span ref={title} className="home-title-in" aria-hidden>
              {Array.from(TITLE, (ch, i) => (ch === ' ' ? ' ' : <span key={i} data-g>{ch}</span>))}
            </span>
          </h1>
          <div ref={composer} className="home-composer">
            <Composer sessionId={null} variant="home" autoFocus />
          </div>
          <ConnectBanner />
        </div>
      </div>
    </div>
  );
}
