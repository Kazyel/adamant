import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { useOverlayPresence } from './OverlayPresence';
import { dateValue, monthDays, readDate, shiftMonth } from './calendar';

export default function CalendarPicker({
  id,
  label,
  value,
  trigger,
  onClose,
  onSelect,
}: {
  id: string;
  label: string;
  value: string;
  trigger: HTMLButtonElement;
  onClose: () => void;
  onSelect: (value: string) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(() => readDate(value) ?? new Date());
  const phase = useOverlayPresence();
  const today = dateValue(new Date());
  function close() {
    trigger.focus({ preventScroll: true });
    onClose();
  }
  function choose(next: string) {
    onSelect(next);
    close();
  }
  useLayoutEffect(() => {
    const element = panel.current!;
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8));
      const below = anchor.bottom + 6;
      const top =
        below + bounds.height <= window.innerHeight - 8
          ? below
          : Math.max(8, anchor.top - bounds.height - 6);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [trigger]);
  useEffect(() => {
    panel.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${dateValue(focused)}"]`)
      ?.focus({ preventScroll: true });
  }, [focused]);
  useEffect(() => {
    const outside = (event: PointerEvent | FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.contains(event.target)
      ) {
        onClose();
      }
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [onClose, trigger]);
  function navigate(event: KeyboardEvent) {
    const offset: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const next = new Date(focused);
    if (event.key in offset) {
      next.setDate(next.getDate() + offset[event.key]);
    } else if (event.key === 'Home') {
      next.setDate(next.getDate() - ((next.getDay() + 6) % 7));
    } else if (event.key === 'End') {
      next.setDate(next.getDate() + 6 - ((next.getDay() + 6) % 7));
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      next.setTime(
        shiftMonth(next, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1)).getTime(),
      );
    } else {
      return;
    }
    event.preventDefault();
    setFocused(next);
  }
  const days = monthDays(focused);
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label={`Choose ${label.toLowerCase()}`}
      className="calendar-picker"
      data-overlay-presence={phase}
      inert={phase === 'exiting'}
      aria-hidden={phase === 'exiting'}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Tab') {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
          ).filter((button) => button.tabIndex >= 0);
          const boundary = event.shiftKey ? controls[0] : controls.at(-1);
          if (document.activeElement === boundary) {
            close();
          }
        }
      }}
    >
      <header>
        <button
          type="button"
          className="icon-button calendar-previous"
          aria-label="Previous month"
          onClick={() => setFocused(shiftMonth(focused, -1))}
        >
          <WorkspaceIcon name="chevron" />
        </button>
        <strong aria-live="polite">
          {focused.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Next month"
          onClick={() => setFocused(shiftMonth(focused, 1))}
        >
          <WorkspaceIcon name="chevron" />
        </button>
      </header>
      <div
        className="calendar-grid"
        role="grid"
        tabIndex={-1}
        aria-label="Days"
        onKeyDown={navigate}
      >
        <div role="rowgroup">
          <div role="row">
            {days.slice(0, 7).map((day) => (
              <div
                role="columnheader"
                key={day.getDay()}
                aria-label={day.toLocaleDateString(undefined, { weekday: 'long' })}
              >
                {day.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {Array.from({ length: 6 }, (_, week) => (
            <div role="row" key={week}>
              {days.slice(week * 7, week * 7 + 7).map((day) => {
                const date = dateValue(day);
                return (
                  <div role="gridcell" key={date} aria-selected={date === value}>
                    <button
                      type="button"
                      data-date={date}
                      data-outside={day.getMonth() !== focused.getMonth()}
                      aria-current={date === today ? 'date' : undefined}
                      aria-label={day.toLocaleDateString(undefined, { dateStyle: 'full' })}
                      tabIndex={date === dateValue(focused) ? 0 : -1}
                      onClick={() => choose(date)}
                    >
                      {day.getDate()}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <footer>
        <button type="button" onClick={() => choose(today)}>
          Today
        </button>
        <button type="button" onClick={() => choose('')} disabled={!value}>
          Clear date
        </button>
      </footer>
      <p className="visually-hidden">
        Arrow keys move by day or week. Page Up and Page Down change month. Hold Shift to change
        year. Escape closes the calendar.
      </p>
    </div>,
    trigger.closest('dialog') ?? document.body,
  );
}
