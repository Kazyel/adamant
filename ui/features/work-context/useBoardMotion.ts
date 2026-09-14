import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import type { DragEvent } from 'react';

export default function useBoardMotion(manualOrder: boolean) {
  const board = useRef<HTMLElement>(null);
  const source = useRef<HTMLElement | null>(null);
  const target = useRef<HTMLElement | null>(null);
  const frame = useRef(0);

  const clearTarget = useCallback(() => {
    target.current?.removeAttribute('data-drop-target');
    target.current = null;
  }, []);
  const finish = useEffectEvent(() => {
    cancelAnimationFrame(frame.current);
    source.current?.removeAttribute('data-dragging');
    source.current = null;
    clearTarget();
  });

  useEffect(() => {
    const element = board.current!;
    const start = (event: globalThis.DragEvent) => {
      finish();
      if (!(event.target instanceof Element)) {
        return;
      }
      const card = event.target.closest<HTMLElement>('.work-card');
      if (!card) {
        return;
      }
      source.current = card;
      // Let the browser capture the full card before dimming its original position.
      const rect = card.getBoundingClientRect();
      event.dataTransfer?.setDragImage(card, event.clientX - rect.left, event.clientY - rect.top);
      frame.current = requestAnimationFrame(() => card.setAttribute('data-dragging', 'true'));
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) {
        clearTarget();
      }
    };
    element.addEventListener('dragstart', start);
    element.addEventListener('dragend', finish, true);
    element.addEventListener('drop', finish, true);
    element.addEventListener('dragleave', leave);
    return () => {
      finish();
      element.removeEventListener('dragstart', start);
      element.removeEventListener('dragend', finish, true);
      element.removeEventListener('drop', finish, true);
      element.removeEventListener('dragleave', leave);
    };
  }, [clearTarget]);

  return {
    boardRef: board,
    over: (event: DragEvent) => {
      if (!source.current || !event.defaultPrevented) {
        return;
      }
      const element = event.currentTarget as HTMLElement;
      const destination = manualOrder ? element : element.closest<HTMLElement>('.work-column');
      if (destination === target.current) {
        return;
      }
      clearTarget();
      if (destination && destination !== source.current) {
        destination.dataset.dropTarget = 'true';
        target.current = destination;
      }
    },
  };
}
