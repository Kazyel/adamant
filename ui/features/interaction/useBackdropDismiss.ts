import { useEffect, useEffectEvent } from 'react';
import type { RefObject } from 'react';

export default function useBackdropDismiss(
  dialog: RefObject<HTMLDialogElement | null>,
  onDismiss: () => void,
  enabled: boolean,
) {
  const dismiss = useEffectEvent(() => {
    if (enabled) {
      onDismiss();
    }
  });

  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    let outsidePointer: number | null = null;
    const isOutside = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      return (
        event.target === element &&
        (event.clientX < bounds.left ||
          event.clientX >= bounds.right ||
          event.clientY < bounds.top ||
          event.clientY >= bounds.bottom)
      );
    };
    const pointerDown = (event: PointerEvent) => {
      outsidePointer = event.button === 0 && isOutside(event) ? event.pointerId : null;
    };
    const pointerUp = (event: PointerEvent) => {
      const shouldDismiss = outsidePointer === event.pointerId && isOutside(event);
      outsidePointer = null;
      if (shouldDismiss) {
        dismiss();
      }
    };
    const pointerCancel = () => {
      outsidePointer = null;
    };
    element.addEventListener('pointerdown', pointerDown);
    element.addEventListener('pointerup', pointerUp);
    element.addEventListener('pointercancel', pointerCancel);
    return () => {
      element.removeEventListener('pointerdown', pointerDown);
      element.removeEventListener('pointerup', pointerUp);
      element.removeEventListener('pointercancel', pointerCancel);
    };
  }, [dialog]);
}
