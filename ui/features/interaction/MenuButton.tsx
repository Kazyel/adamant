import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ContextMenu } from './ContextMenu';
import { OverlayPresence } from './OverlayPresence';
import type { UserAction } from './types';

export default function MenuButton({
  label,
  actions,
  children,
  disabled,
  className,
}: {
  label: string;
  actions: UserAction[];
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{
    x: number;
    y: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          setPosition(
            position ? null : { x: rect.right, y: rect.bottom + 8, trigger: trigger.current! },
          );
        }}
      >
        {children}
      </button>
      <OverlayPresence>
        {position && !disabled ? (
          <ContextMenu
            actions={actions}
            position={position}
            align="end"
            label={label}
            returnFocus={position.trigger}
            triggerTogglesMenu
            onClose={() => setPosition(null)}
          />
        ) : null}
      </OverlayPresence>
    </>
  );
}
