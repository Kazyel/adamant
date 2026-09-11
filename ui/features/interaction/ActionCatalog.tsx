import { Fragment, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { UserAction } from './types';
import { Dialog } from './InteractionDialogs';

function startsSection(action: UserAction, previous: UserAction | undefined, grouped: boolean) {
  if (!previous) {
    return false;
  }
  return (
    (grouped && action.group !== previous.group) ||
    (action.tone === 'danger' && previous.tone !== 'danger')
  );
}

export function ActionList({
  actions,
  onRun,
  onDismiss,
  label = 'Actions',
  grouped,
}: {
  actions: UserAction[];
  onRun?: () => void;
  onDismiss?: () => void;
  label?: string;
  grouped?: 'headings' | 'separators';
}) {
  const descriptionId = useId();
  const [active, setActive] = useState<string | null>(null);
  const typeahead = useRef({ text: '', time: 0 });
  const activeReason = actions.find((action) => action.id === active)?.disabled;

  function typeaheadIndex(event: KeyboardEvent<HTMLDivElement>, current: number) {
    if (
      event.key.length !== 1 ||
      event.key === ' ' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return -1;
    }
    const now = performance.now();
    typeahead.current.text =
      now - typeahead.current.time < 600
        ? typeahead.current.text + event.key.toLocaleLowerCase()
        : event.key.toLocaleLowerCase();
    typeahead.current.time = now;
    const text = typeahead.current.text;
    const prefix = /^(.)\1*$/u.test(text) ? text.charAt(0) : text;
    const offset = actions.findIndex((_, index) => {
      const candidate = (current + index + 1) % actions.length;
      return actions[candidate].label.toLocaleLowerCase().startsWith(prefix);
    });
    return offset < 0 ? -1 : (current + offset + 1) % actions.length;
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.key === 'Escape' || event.key === 'Tab') && onDismiss) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      onDismiss();
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="menuitemradio"]',
      ),
    );
    if (!items.length) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'ArrowDown':
        next = (current + 1) % items.length;
        break;
      case 'ArrowUp':
        next = (Math.max(0, current) - 1 + items.length) % items.length;
        break;
      default:
        next = typeaheadIndex(event, current);
    }
    if (next < 0) {
      return;
    }
    items[next]?.focus();
    items[next]?.scrollIntoView({ block: 'nearest' });
    event.preventDefault();
  }

  return (
    <div
      className="interaction-action-list"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={navigate}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setActive(null);
        }
      }}
    >
      {actions.map((action, index) => (
        <Fragment key={action.id}>
          {startsSection(action, actions[index - 1], grouped === 'separators') ? (
            <div
              className="interaction-action-divider"
              role="separator"
              aria-label={action.tone === 'danger' ? 'Destructive actions' : action.group}
            />
          ) : null}
          {grouped === 'headings' && action.group && action.group !== actions[index - 1]?.group ? (
            <div className="interaction-action-heading" role="presentation">
              {action.group}
            </div>
          ) : null}
          <button
            type="button"
            role={action.selected === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={action.selected}
            className={action.tone === 'danger' ? 'interaction-action-danger' : undefined}
            tabIndex={index === 0 ? 0 : -1}
            aria-disabled={!!action.disabled}
            aria-describedby={action.disabled ? `${descriptionId}-${action.id}` : undefined}
            title={action.disabled}
            onFocus={() => setActive(action.id)}
            onMouseEnter={() => setActive(action.id)}
            onClick={() => {
              if (action.disabled) {
                return;
              }
              onRun?.();
              void action.run();
            }}
          >
            <span className="interaction-action-label">
              {action.selected !== undefined ? (
                <span className="interaction-action-check">
                  <WorkspaceIcon name="check" />
                </span>
              ) : null}
              {action.icon ? <WorkspaceIcon name={action.icon} /> : null}
              <span>{action.label}</span>
            </span>
            {action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
            {action.disabled ? (
              <span id={`${descriptionId}-${action.id}`} className="visually-hidden">
                {action.disabled}
              </span>
            ) : null}
          </button>
        </Fragment>
      ))}
      {activeReason && grouped !== 'separators' ? (
        <p className="interaction-action-help" role="status">
          {activeReason}
        </p>
      ) : null}
    </div>
  );
}

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: UserAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const countId = useId();
  const needle = query.trim().toLocaleLowerCase();
  const visible = actions.filter((action) =>
    `${action.label} ${action.group ?? ''} ${action.id}`.toLocaleLowerCase().includes(needle),
  );

  return (
    <Dialog title="Command palette" open onClose={onClose} className="interaction-command-palette">
      <div className="interaction-command-search">
        <WorkspaceIcon name="search" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commands"
          aria-label="Search commands"
          aria-describedby={countId}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              const items = list.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"], [role="menuitemradio"]',
              );
              const index = event.key === 'ArrowUp' ? (items?.length ?? 1) - 1 : 0;
              items?.[index]?.focus();
              items?.[index]?.scrollIntoView({ block: 'nearest' });
              event.preventDefault();
            }
            if (event.key === 'Enter') {
              const action = visible.find((item) => !item.disabled);
              if (action) {
                onClose();
                void action.run();
              }
              event.preventDefault();
            }
          }}
        />
      </div>
      <p id={countId} className="interaction-result-count" role="status">
        {visible.length} command{visible.length === 1 ? '' : 's'}
      </p>
      <div ref={list} className="interaction-command-results">
        <ActionList
          actions={visible}
          onRun={onClose}
          label="Matching commands"
          grouped="headings"
        />
      </div>
      {!visible.length ? (
        <p className="interaction-empty">No matching commands. Try “Save” or “Move”.</p>
      ) : null}
      <div className="dialog-actions interaction-command-footer">
        <span>
          <kbd>↑ ↓</kbd> Navigate <kbd>Enter</kbd> Run
        </span>
        <button type="button" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </div>
    </Dialog>
  );
}
