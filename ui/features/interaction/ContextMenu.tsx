import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ActionList } from './ActionCatalog';
import type { UserAction } from './types';

export function ContextMenu({
  actions,
  position,
  label,
  title,
  onClose,
  returnFocus,
  triggerTogglesMenu = false,
}: {
  actions: UserAction[];
  position: { x: number; y: number };
  label: string;
  title?: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  /** Let a menu button handle its own toggle instead of dismissing it on pointerdown. */
  triggerTogglesMenu?: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef(returnFocus ?? document.activeElement);
  const restore = useRef(true);
  const closing = useRef(false);
  const focusFrame = useRef<number | null>(null);

  function close(restoreFocus: boolean) {
    if (closing.current) {
      return;
    }
    closing.current = true;
    restore.current = restoreFocus;
    const target = trigger.current;
    if (
      restoreFocus &&
      target instanceof HTMLElement &&
      target.isConnected &&
      !target.matches(':disabled') &&
      !target.closest('[inert]') &&
      menu.current?.contains(document.activeElement)
    ) {
      // Return before running an action so its dialog captures the original trigger.
      target.focus({ preventScroll: true });
    }
    onClose();
  }

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) {
      return;
    }
    function clamp() {
      if (!element) {
        return;
      }
      const bounds = element.getBoundingClientRect();
      const inset = 8;
      const x = Math.max(inset, Math.min(position.x, window.innerWidth - bounds.width - inset));
      const y = Math.max(inset, Math.min(position.y, window.innerHeight - bounds.height - inset));
      element.style.setProperty('--interaction-menu-x', `${x}px`);
      element.style.setProperty('--interaction-menu-y', `${y}px`);
    }
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(element);
    window.addEventListener('resize', clamp);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', clamp);
    };
  }, [position.x, position.y]);

  useEffect(() => {
    const element = menu.current;
    const target = trigger.current;
    if (!element) {
      return;
    }
    if (focusFrame.current !== null) {
      cancelAnimationFrame(focusFrame.current);
    }
    const first =
      element.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"][aria-disabled="false"]',
      ) ??
      element.querySelector<HTMLElement>(
        ':is([role="menuitem"], [role="menuitemradio"])[aria-disabled="false"]',
      ) ??
      element.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ??
      element.querySelector<HTMLElement>('[role="menu"]');
    first?.focus({ preventScroll: true });
    return () => {
      focusFrame.current = requestAnimationFrame(() => {
        const active = document.activeElement;
        // A newly opened dialog/input or an outside-click destination owns its focus.
        if (
          restore.current &&
          target instanceof HTMLElement &&
          target.isConnected &&
          !target.matches(':disabled') &&
          !target.closest('[inert]') &&
          !document.querySelector('dialog[open]') &&
          (active === document.body || (active instanceof Node && element.contains(active)))
        ) {
          target.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  useEffect(() => {
    const outside = (event: PointerEvent | FocusEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !(triggerTogglesMenu && trigger.current?.contains(event.target))
      ) {
        if (!closing.current) {
          closing.current = true;
          restore.current = false;
          onClose();
        }
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [onClose, triggerTogglesMenu]);

  return createPortal(
    <div
      ref={menu}
      className="interaction-context-menu"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        } else if (event.key === 'Tab') {
          // Native Tab now continues from the original trigger, not the body portal.
          close(true);
        }
      }}
    >
      {title ? (
        <p className="interaction-context-menu-title" title={title}>
          {title}
        </p>
      ) : null}
      <ActionList actions={actions} label={label} grouped="separators" onRun={() => close(true)} />
      {!actions.length ? (
        <p className="interaction-context-menu-empty">No actions available here.</p>
      ) : null}
    </div>,
    document.body,
  );
}
