import { useEffect, useRef, useState } from 'react';
import type { BackdropConfig, ProviderId, SessionStatus } from '@shared/protocol';
import { backdropCell, DIRECTIONAL } from '@shared/backdrop';
import { backdropImageBlob, selectBackdrop } from '@/state/actions';
import { useStore } from '@/state/store';
import { DitherField, type DitherPalette } from './DitherField';

/**
 * The backdrop as configured in Settings (`AppSettings.backdropConfig`, see `shared/backdrop.ts`),
 * for one surface. It maps the config onto a `DitherField`; changes reach the running field as
 * messages. Nothing is mounted (no canvas, no worker) when the source is off or the amount is 0.
 *
 * - home, onboarding: the full stage, with focus and reach.
 * - session: the band of light behind the composer, at `sessionAmount`, breathing with the agent.
 * - preview: the field inside Settings' miniature (`view` picks home or session); `config` overrides.
 * - swatch: a preset's tiny still frame.
 */

/** The home light per agent. */
const HOME_PALETTE: Record<ProviderId, DitherPalette> = { claude: 'ember', codex: 'iris', nusacode: 'mint', demo: 'forest' };
/** Inside a session Demo glows mint. */
const SESSION_PALETTE: Record<ProviderId, DitherPalette> = { claude: 'ember', codex: 'iris', nusacode: 'mint', demo: 'mint' };

/** The amount at which a surface looks as it did before the config existed. */
const REFERENCE_AMOUNT = 60;
const SESSION_REFERENCE = 30;

/**
 * Strength → the field's gain (input light) and opacity (output). Low amounts both fade and thin
 * out, so a subtle setting stays a sparse dither over dark ground instead of a faint wash of colour.
 */
function strength(a: number) {
  const k = a / REFERENCE_AMOUNT;
  return { gain: a <= REFERENCE_AMOUNT ? 0.45 + 0.55 * k : 1 + ((a - REFERENCE_AMOUNT) / 40) * 0.6, opacity: Math.min(1, 0.15 + 0.85 * k) };
}

// ── images: fetched and decoded once per id, shared by every field ──

const IMAGE_MAX_SIDE = 1600;
const bitmaps = new Map<string, Promise<ImageBitmap>>();

function loadBitmap(id: string) {
  let p = bitmaps.get(id);
  if (!p) {
    p = backdropImageBlob(id).then(async (blob) => {
      const probe = await createImageBitmap(blob);
      // Read the size before closing: a closed bitmap reports 0 x 0, and a resize to 0 throws.
      const { width, height } = probe;
      const k = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
      if (k === 1) return probe;
      probe.close();
      return createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(width * k)), resizeHeight: Math.max(1, Math.round(height * k)), resizeQuality: 'high' });
    });
    p.catch(() => bitmaps.delete(id));
    bitmaps.set(id, p);
  }
  return p;
}

/** The decoded image for an id (null while loading, or without one). */
export function useBackdropBitmap(id: string | null) {
  const [state, setState] = useState<{ id: string; bitmap: ImageBitmap } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    loadBitmap(id).then(
      (bitmap) => live && setState({ id, bitmap }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id]);
  return id && state?.id === id ? state.bitmap : null;
}

/**
 * True while `on`, and for `ms` after it turns off: the band holds its working light while the
 * turn's end plays (the gather closes in on the composer), then exhales.
 */
function useLinger(on: boolean, ms: number) {
  const [held, setHeld] = useState(on);
  const was = useRef(on);
  useEffect(() => {
    if (on) {
      was.current = true;
      setHeld(true);
      return;
    }
    if (!was.current) return;
    was.current = false;
    const t = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on || held;
}

// ── component ──

interface Props {
  surface: 'home' | 'session' | 'onboarding' | 'preview' | 'swatch';
  /** Preview: which surface the miniature shows. */
  view?: 'home' | 'session';
  /** Preview and swatch: draw this instead of the stored config. */
  config?: BackdropConfig;
  /** Session: whose light, and what the agent is doing. */
  provider?: ProviderId;
  status?: SessionStatus;
}

export function Backdrop({ surface, view = 'home', config, provider, status = 'idle' }: Props) {
  const stored = useStore(selectBackdrop);
  const homeProvider = useStore((s) => s.ui.homeProvider);
  // Any turn running anywhere: the home field drifts a little quicker and does not rest meanwhile.
  const anyWorking = useStore((s) => {
    for (const id in s.sessions) {
      const st = s.sessions[id].status;
      if (st === 'running' || st === 'starting') return true;
    }
    return false;
  });
  const cfg = config ?? stored;
  const session = surface === 'session' || (surface === 'preview' && view === 'session');
  const lit = useLinger(status === 'running' || status === 'starting', 620);
  // A swatch is tiny: it shows its preset a little louder so a spot or a low amount still reads.
  const amount = session ? cfg.sessionAmount : surface === 'swatch' ? Math.min(100, Math.max(cfg.amount * 1.5, cfg.amount + 12)) : cfg.amount;
  const wantsImage = cfg.source === 'image' && !session;
  const bitmap = useBackdropBitmap(wantsImage ? cfg.image : null);
  if (cfg.source === 'off' || amount <= 0) return null;
  // An image source draws nothing until its picture is decoded (a session's band stays a pattern).
  if (wantsImage && !bitmap) return null;

  const agent = provider ?? homeProvider;
  const custom = cfg.colour === 'custom';
  const swatch = surface === 'swatch';
  // The swatch is a miniature: cells shrink with it so it reads as the whole stage.
  const cell = swatch ? Math.max(2, Math.round(backdropCell(cfg.detail) * 0.5)) : backdropCell(cfg.detail);
  const still = swatch || cfg.speed === 0;
  const common = {
    texture: cfg.style,
    cell,
    still,
    react: cfg.react && !swatch,
    pointer: cfg.react && !swatch,
    hue: custom ? cfg.hue : undefined,
    sat: custom ? cfg.saturation / 100 : undefined,
  } as const;

  if (session) {
    // The preview shows a working session: idle, the band is nearly gone by design.
    if (surface === 'preview') status = 'running';
    const working = status === 'running' || status === 'starting';
    // Just finished: still lit while the end of the turn plays, then it settles to rest.
    const glowing = working || (lit && status !== 'awaiting');
    const awaiting = status === 'awaiting';
    const palette: DitherPalette = awaiting ? 'amber' : cfg.colour === 'mono' ? 'mono' : custom ? 'custom' : SESSION_PALETTE[agent];
    const k = amount / SESSION_REFERENCE;
    const base = glowing ? 0.9 : awaiting ? 0.82 : 0.72;
    // The horizon is a thin arc, not a floor of light: it holds a quiet presence at any amount
    // above zero (a line that cannot be seen is no horizon), and the amount adds to it.
    const rest = Math.min(0.7, 0.3 + 0.2 * k);
    const lit2 = Math.min(1, 0.52 + 0.3 * k);
    // Working: the band drifts quicker. Waiting on you: it turns amber and stills (the field eases
    // its speed to nothing and stops drawing), so the stillness itself says "your turn".
    return (
      <DitherField
        {...common}
        variant="streak"
        palette={palette}
        focus={[0.5, 1.15]}
        gain={base * (k <= 1 ? 1 : 1 + ((amount - SESSION_REFERENCE) / 70) * 0.6)}
        speed={(working ? 2.2 : awaiting ? 0 : glowing ? 1.1 : 0.35) * (cfg.speed / 30)}
        opacity={glowing || awaiting ? lit2 : rest}
        reactGain={0.85}
        awake={working && surface === 'session'}
      />
    );
  }

  const palette: DitherPalette =
    cfg.colour === 'mono' ? 'mono' : custom ? 'custom' : surface === 'onboarding' && cfg.colour === 'agent' ? 'mono' : HOME_PALETTE[agent];
  const { gain, opacity } = wantsImage ? imageStrength(amount) : strength(amount);
  const live = surface === 'home' || surface === 'onboarding';
  // An image is still unless an effect plays over it: drawn once, then the field rests until the
  // pointer or a beat moves it (beats and the pointer's light act on it like on a pattern).
  const effect = wantsImage && cfg.effect !== 'none' ? cfg.effect : null;
  const variant = wantsImage ? (effect ?? cfg.pattern) : cfg.pattern;
  const moving = !wantsImage || effect != null;
  return (
    <DitherField
      {...common}
      still={swatch || (cfg.speed === 0 && !wantsImage)}
      variant={variant}
      palette={palette}
      full
      gain={gain}
      opacity={opacity}
      // A dim stage lifts its beats, so a sent message still reads at a quiet strength.
      reactGain={Math.min(2.4, Math.max(1, 0.62 / opacity))}
      awake={live && anyWorking}
      speed={moving ? (cfg.speed / 50) * (live && anyWorking ? 1.45 : 1) : 0}
      spot={[cfg.focus.x, cfg.focus.y, cfg.reach / 100]}
      angle={DIRECTIONAL.includes(variant) ? cfg.angle : undefined}
      image={wantsImage ? bitmap : null}
      imageColour={wantsImage && cfg.colour === 'image'}
      overlay={effect ? cfg.effectAmount / 100 : 0}
    />
  );
}

/** An image's strength: it shows from the first step (a picture at a few percent is just a stain), up to as it is at 100. */
function imageStrength(a: number) {
  const k = a / 100;
  return { gain: 0.72 + 0.5 * k, opacity: Math.min(1, 0.42 + 0.58 * k) };
}
