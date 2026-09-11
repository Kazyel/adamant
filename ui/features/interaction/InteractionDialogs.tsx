import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { UserAction } from './types';

export function Dialog({
  title,
  description,
  className,
  open,
  onClose,
  initialFocus = 'control',
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  open: boolean;
  onClose: () => void;
  initialFocus?: 'control' | 'heading';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) {
      return;
    }
    const trigger = document.activeElement;
    dialog.showModal();
    if (initialFocus === 'heading') {
      heading.current?.focus();
    } else {
      const control = dialog.querySelector<HTMLElement>(
        '.dialog-body input:not(:disabled), .dialog-body button:not(:disabled), .dialog-body select:not(:disabled), .dialog-body textarea:not(:disabled), .dialog-body [tabindex="0"]',
      );
      (control ?? heading.current)?.focus();
    }
    return () => {
      const ownedFocus =
        dialog.contains(document.activeElement) || document.activeElement === document.body;
      dialog.close();
      if (
        ownedFocus &&
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        (document.activeElement === document.body || document.activeElement === trigger)
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      className={`interaction-dialog${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <div>
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <button
          type="button"
          className="icon-button dialog-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <WorkspaceIcon name="close" />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}

export function ShortcutReference({
  actions,
  onClose,
}: {
  actions: UserAction[];
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      description="Keep your hands on the keyboard while moving through your workspace."
      open
      onClose={onClose}
      initialFocus="heading"
      className="interaction-shortcut-dialog"
    >
      <h3 className="interaction-section-heading">Workspace actions</h3>
      <dl className="interaction-shortcuts">
        {actions
          .filter((action) => action.shortcut)
          .map((action) => (
            <div key={action.id}>
              <dt>{action.label}</dt>
              <dd>
                <kbd>{action.shortcut}</kbd>
              </dd>
            </div>
          ))}
      </dl>
      <h3 className="interaction-section-heading">Explorer and editor</h3>
      <dl className="interaction-shortcuts">
        <div>
          <dt>Rename explorer selection</dt>
          <dd>
            <kbd>F2</kbd>
          </dd>
        </div>
        <div>
          <dt>Keyboard context menu</dt>
          <dd>
            <kbd>Shift+F10 / Menu</kbd>
          </dd>
        </div>
        <div>
          <dt>Navigate tree or menu</dt>
          <dd>
            <kbd>Arrow keys / Home / End</kbd>
          </dd>
        </div>
        <div>
          <dt>Extend explorer selection</dt>
          <dd>
            <kbd>Shift+Arrow / Shift+Click</kbd>
          </dd>
        </div>
        <div>
          <dt>Undo / redo editor change</dt>
          <dd>
            <kbd>Ctrl+Z / Ctrl+Shift+Z</kbd>
          </dd>
        </div>
        <div>
          <dt>Find in current Note</dt>
          <dd>
            <kbd>Ctrl+F</kbd>
          </dd>
        </div>
        <div>
          <dt>Close dialog</dt>
          <dd>
            <kbd>Esc</kbd>
          </dd>
        </div>
      </dl>
      <p className="interaction-shortcut-note">
        On macOS, use Command instead of Ctrl. Editor shortcuts apply to text; explorer clipboard
        actions apply to selected files.
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
