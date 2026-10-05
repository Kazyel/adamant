export const documentZoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Native non-passive listeners also work inside the isolated DOCX document.
export function listenForZoomWheel(
  target: EventTarget,
  initialZoom: number,
  onZoom: (zoom: number, event: WheelEvent) => void,
) {
  let zoom = initialZoom;
  const wheel = (event: Event) => {
    const wheelEvent = event as WheelEvent;
    const { ctrlKey, deltaY, deltaMode } = wheelEvent;
    if (!ctrlKey || !deltaY || !Number.isFinite(deltaY)) {
      return;
    }
    event.preventDefault();
    // Trackpad pixels stay proportional; line/page wheel units use the same bounded gesture.
    let pixels = deltaY;
    if (deltaMode === 1) {
      pixels *= 16;
    } else if (deltaMode === 2) {
      pixels *= 800;
    }
    const next = Math.min(
      2,
      Math.max(0.5, zoom * Math.exp(-Math.max(-160, Math.min(160, pixels)) * 0.002)),
    );
    if (next !== zoom) {
      zoom = next;
      onZoom(zoom, wheelEvent);
    }
  };
  target.addEventListener('wheel', wheel, { passive: false });
  return () => target.removeEventListener('wheel', wheel);
}

export function createZoomTransition(
  view: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> & {
    performance: Pick<Performance, 'now'>;
    matchMedia: (query: string) => Pick<MediaQueryList, 'matches'>;
  },
  initialZoom: number,
  onFrame: (zoom: number, event?: WheelEvent) => void,
) {
  let zoom = initialZoom;
  let target = initialZoom;
  let from = initialZoom;
  let started = 0;
  let frame: number | null = null;
  let anchor: WheelEvent | undefined;
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');

  const tick = (time: number) => {
    const progress = Math.min(1, Math.max(0, (time - started) / 100));
    zoom = progress === 1 ? target : from + (target - from) * (1 - (1 - progress) ** 3);
    onFrame(zoom, anchor);
    frame = progress < 1 ? view.requestAnimationFrame(tick) : null;
  };

  return {
    zoomTo(next: number, event?: WheelEvent) {
      if (next === target) {
        return;
      }
      from = zoom;
      target = next;
      anchor = event;
      started = view.performance.now();
      if (reducedMotion.matches) {
        if (frame !== null) {
          view.cancelAnimationFrame(frame);
          frame = null;
        }
        zoom = target;
        onFrame(zoom, anchor);
      } else if (frame === null) {
        frame = view.requestAnimationFrame(tick);
      }
    },
    dispose() {
      if (frame !== null) {
        view.cancelAnimationFrame(frame);
      }
    },
  };
}
