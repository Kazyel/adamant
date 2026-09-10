import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export default function DialogFrame({
  title,
  creating = false,
  pending = false,
  cancel,
  children,
}: {
  title: string;
  creating?: boolean;
  pending?: boolean;
  cancel: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current!;

    element.showModal();

    return () => element.close();
  }, []);

  return (
    <dialog
      className={`replace-dialog${creating ? ' create-vault-dialog' : ''}`}
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      aria-labelledby="workspace-dialog-title"
      aria-describedby="workspace-dialog-description"
      aria-busy={pending}
    >
      <h2 id="workspace-dialog-title">{title}</h2>
      {children}
    </dialog>
  );
}
