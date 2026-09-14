import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';

type OverlayPhase = 'entering' | 'present' | 'exiting';

const OverlayPresenceContext = createContext<OverlayPhase>('present');

function reducedMotionSnapshot() {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function subscribeReducedMotion(notify: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}

type PresenceState = {
  child: ReactElement | null;
  open: boolean;
  phase: OverlayPhase;
  generation: number;
};

function openingPhase(state: PresenceState, child: ReactElement, reduced: boolean): OverlayPhase {
  if (reduced) {
    return 'present';
  }
  if (!state.open || state.child?.type !== child.type || state.child?.key !== child.key) {
    return 'entering';
  }
  return state.phase;
}

/**
 * Keeps a conditional overlay mounted long enough for its exit transition to run.
 * The overlay itself remains the owner of native modal semantics and focus cleanup.
 */
export function OverlayPresence({ children }: { children: ReactElement | null }) {
  const open = children !== null;
  const reduced = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotionSnapshot,
    reducedMotionSnapshot,
  );
  const [state, setState] = useState<PresenceState>(() => ({
    child: children,
    open,
    phase: open && !reduced ? 'entering' : 'present',
    generation: 0,
  }));
  let current = state;

  if (open) {
    const phase = openingPhase(state, children, reduced);
    if (!state.open || state.child !== children || state.phase !== phase) {
      current = {
        child: children,
        open: true,
        phase,
        generation: state.generation + Number(!state.open),
      };
      setState(current);
    }
  } else if (state.open || (reduced && state.child)) {
    current = {
      ...state,
      child: reduced ? null : state.child,
      open: false,
      phase: reduced ? 'present' : 'exiting',
    };
    setState(current);
  }

  useEffect(() => {
    if (open || reduced || current.phase !== 'exiting' || !current.child) {
      return;
    }
    const timer = window.setTimeout(() => {
      setState((previous) =>
        previous.open || previous.phase !== 'exiting'
          ? previous
          : { ...previous, child: null, open: false, phase: 'present' },
      );
    }, 110);
    return () => window.clearTimeout(timer);
  }, [open, reduced, current.child, current.phase]);

  useEffect(() => {
    if (!open || reduced || current.phase !== 'entering') {
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setState((previous) =>
          previous.open && previous.phase === 'entering'
            ? { ...previous, phase: 'present' }
            : previous,
        );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [open, reduced, current.phase]);

  if (!current.child) {
    return null;
  }
  return (
    <OverlayPresenceContext.Provider key={current.generation} value={current.phase}>
      {current.child}
    </OverlayPresenceContext.Provider>
  );
}

export function useOverlayPresence() {
  return useContext(OverlayPresenceContext);
}
