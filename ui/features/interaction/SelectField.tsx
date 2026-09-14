import { useRef, useState } from 'react';
import type { SelectHTMLAttributes } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { ContextMenu } from './ContextMenu';
import { OverlayPresence } from './OverlayPresence';
import type { UserAction } from './types';
import './select-field.css';

/** Keep native form values and validation, with the app's keyboard-accessible choice menu. */
export default function SelectField(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const select = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLButtonElement;
    actions: UserAction[];
  } | null>(null);
  const [display, setDisplay] = useState('');
  function open() {
    const field = select.current!;
    const bounds = trigger.current!.getBoundingClientRect();
    setMenu({
      x: bounds.left,
      y: bounds.bottom + 4,
      trigger: trigger.current!,
      actions: Array.from(field.options, (option, index) => ({
        id: String(index),
        label: option.label,
        selected: option.selected,
        disabled: option.disabled ? 'Unavailable' : undefined,
        run: () => {
          field.value = option.value;
          field.dispatchEvent(new Event('change', { bubbles: true }));
          setDisplay(option.label);
        },
      })),
    });
  }
  return (
    <span className="select-field">
      <button
        ref={trigger}
        type="button"
        disabled={props.disabled}
        className={props.className}
        id={props.id}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => (menu ? setMenu(null) : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            open();
          }
        }}
      >
        <span>{display}</span>
        <WorkspaceIcon name="chevron" />
      </button>
      <select
        {...props}
        id={undefined}
        ref={(element) => {
          select.current = element;
          if (element) {
            setDisplay(element.selectedOptions[0]?.label ?? 'Choose…');
          }
        }}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onInvalid={(event) => {
          if (event.defaultPrevented) {
            return;
          }
          event.preventDefault();
          trigger.current?.focus();
        }}
      />
      <OverlayPresence>
        {menu && !props.disabled ? (
          <ContextMenu
            actions={menu.actions}
            position={menu}
            label={props['aria-label'] ?? 'Choose an option'}
            returnFocus={menu.trigger}
            triggerTogglesMenu
            onClose={() => setMenu(null)}
          />
        ) : null}
      </OverlayPresence>
    </span>
  );
}
