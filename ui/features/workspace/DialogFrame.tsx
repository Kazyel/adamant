import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';

export default function DialogFrame({
  title,
  creating = false,
  pending = false,
  className = 'replace-dialog',
  cancel,
  children,
}: {
  title: string;
  creating?: boolean;
  pending?: boolean;
  className?: string;
  cancel: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement;

    element.showModal();
    const control = element.querySelector<HTMLElement>(
      '.dialog-body input:not(:disabled), .dialog-body button:not(:disabled), .dialog-body select:not(:disabled), .dialog-body textarea:not(:disabled), .dialog-body [tabindex="0"]',
    );
    (control ?? element.querySelector<HTMLElement>('h2'))?.focus();

    return () => {
      const ownedFocus =
        element.contains(document.activeElement) || document.activeElement === document.body;
      element.close();
      if (
        ownedFocus &&
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        (document.activeElement === document.body || document.activeElement === trigger)
      ) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <dialog
      className={`dialog-frame ${className}${creating ? ' create-vault-dialog' : ''}`}
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      aria-labelledby={titleId}
      aria-busy={pending}
    >
      <header className="dialog-header">
        <h2 id={titleId} tabIndex={-1}>
          {title}
        </h2>
        <button
          type="button"
          className="icon-button dialog-close"
          aria-label="Close dialog"
          disabled={pending}
          onClick={cancel}
        >
          <WorkspaceIcon name="close" />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
