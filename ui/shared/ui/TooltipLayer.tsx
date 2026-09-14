import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type Tooltip = { trigger: Element; text: string };

function targetFor(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }
  const trigger = target.closest('[data-tooltip]');
  if (!trigger?.getAttribute('data-tooltip')?.trim() || trigger.closest('[inert]')) {
    return null;
  }
  const dialog = document.querySelector('dialog[open]');
  return dialog && !trigger.closest('dialog[open]') ? null : trigger;
}

function useTooltipEvents(setTooltip: (value: Tooltip | null) => void, visible: boolean) {
  const isVisible = useEffectEvent(() => visible);
  useEffect(() => {
    let timer: number | undefined;
    let closeTimer: number | undefined;
    let target: Element | null = null;
    function hide() {
      window.clearTimeout(timer);
      window.clearTimeout(closeTimer);
      target = null;
      setTooltip(null);
    }
    function show(trigger: Element, delay: number) {
      window.clearTimeout(timer);
      target = trigger;
      timer = window.setTimeout(() => {
        if (trigger.isConnected && !trigger.closest('[inert]')) {
          setTooltip({ trigger, text: trigger.getAttribute('data-tooltip') ?? '' });
        }
      }, delay);
    }
    function over(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest('.app-tooltip')) {
        window.clearTimeout(closeTimer);
        return;
      }
      if (event.pointerType === 'touch') {
        return;
      }
      const next = targetFor(event.target);
      if (next === target) {
        window.clearTimeout(closeTimer);
      }
      if (next && next !== target) {
        hide();
        show(next, 450);
      }
    }
    function out(event: PointerEvent) {
      const next = event.relatedTarget;
      if (next instanceof Element && (target?.contains(next) || next.closest('.app-tooltip'))) {
        return;
      }
      if (target?.contains(document.activeElement)) {
        return;
      }
      window.clearTimeout(timer);
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(hide, 150);
    }
    function focus(event: FocusEvent) {
      hide();
      const next = targetFor(event.target);
      if (next?.matches(':focus-visible')) {
        show(next, 0);
      }
    }
    function key(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      if (isVisible()) {
        event.preventDefault();
        event.stopPropagation();
      }
      hide();
    }
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(closeTimer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [setTooltip]);
}

export default function TooltipLayer() {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useTooltipEvents(setTooltip, tooltip !== null);
  const host = tooltip?.trigger.closest('dialog[open]') ?? document.body;
  useLayoutEffect(() => {
    if (!tooltip || !ref.current) {
      return;
    }
    const element = ref.current;
    const { trigger } = tooltip;
    const description = trigger.getAttribute('aria-describedby') ?? '';
    trigger.setAttribute('aria-describedby', `${description} ${id}`.trim());
    placeTooltip(element, trigger, host);
    const observer = new MutationObserver(() => {
      if (
        !trigger.isConnected ||
        trigger.closest('[inert]') ||
        (host instanceof HTMLDialogElement && !host.open)
      ) {
        setTooltip(null);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'inert'],
    });
    return () => {
      observer.disconnect();
      const remaining = (trigger.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((value) => value !== id)
        .join(' ');
      if (remaining) {
        trigger.setAttribute('aria-describedby', remaining);
      } else {
        trigger.removeAttribute('aria-describedby');
      }
    };
  }, [tooltip, host, id]);
  return tooltip
    ? createPortal(
        <div ref={ref} className="app-tooltip" role="tooltip" id={id}>
          {tooltip.text}
        </div>,
        host,
      )
    : null;
}

function placeTooltip(element: HTMLElement, trigger: Element, host: Element) {
  const modal = host instanceof HTMLDialogElement;
  const bounds = modal
    ? host.getBoundingClientRect()
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  element.style.position = modal ? 'absolute' : 'fixed';
  element.style.maxWidth = `${Math.max(80, Math.min(320, bounds.right - bounds.left - 24))}px`;
  const anchor = trigger.getBoundingClientRect();
  const size = element.getBoundingClientRect();
  const left = Math.max(
    bounds.left + 8,
    Math.min(anchor.left + (anchor.width - size.width) / 2, bounds.right - size.width - 8),
  );
  const below = anchor.bottom + 8;
  const top = Math.max(
    bounds.top + 8,
    below + size.height < bounds.bottom - 8 ? below : anchor.top - size.height - 8,
  );
  element.style.left = `${left - (modal ? bounds.left : 0)}px`;
  element.style.top = `${top - (modal ? bounds.top : 0)}px`;
  element.style.visibility = 'visible';
}
