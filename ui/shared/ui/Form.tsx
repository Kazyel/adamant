import { useId, useLayoutEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import WorkspaceIcon from './WorkspaceIcon';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
interface FieldError {
  field: Field;
  message: string;
}

function firstInvalid(form: HTMLFormElement) {
  return Array.from(form.elements).find(
    (field): field is Field =>
      (field instanceof HTMLInputElement ||
        field instanceof HTMLSelectElement ||
        field instanceof HTMLTextAreaElement) &&
      field.willValidate &&
      !field.validity.valid,
  );
}

function focusField(field: Field) {
  const trigger = field.closest('.select-field')?.querySelector<HTMLButtonElement>('button');
  (trigger ?? field).focus();
}

export default function Form({
  children,
  onInvalidCapture,
  onInputCapture,
  onChangeCapture,
  onSubmit,
  onReset,
  ...props
}: ComponentProps<'form'>) {
  const [error, setError] = useState<FieldError | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!error) {
      return;
    }
    const field = error.field;
    const invalid = field.getAttribute('aria-invalid');
    const describedBy = field.getAttribute('aria-describedby') ?? '';
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', `${describedBy} ${id}`.trim());
    const trigger = field.closest('.select-field')?.querySelector('button');
    const triggerInvalid = trigger?.getAttribute('aria-invalid') ?? null;
    trigger?.setAttribute('aria-invalid', 'true');
    const triggerDescription = trigger?.getAttribute('aria-describedby');
    trigger?.setAttribute('aria-describedby', `${triggerDescription ?? ''} ${id}`.trim());
    return () => {
      if (triggerInvalid === null) {
        trigger?.removeAttribute('aria-invalid');
      } else {
        trigger?.setAttribute('aria-invalid', triggerInvalid);
      }
      if (invalid === null) {
        field.removeAttribute('aria-invalid');
      } else {
        field.setAttribute('aria-invalid', invalid);
      }
      for (const element of [field, trigger]) {
        if (!element) {
          continue;
        }
        const remaining = (element.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .filter((value) => value !== id)
          .join(' ');
        if (remaining) {
          element.setAttribute('aria-describedby', remaining);
        } else {
          element.removeAttribute('aria-describedby');
        }
      }
    };
  }, [error, id]);

  function revalidate() {
    setError((current) =>
      current && current.field.isConnected && !current.field.validity.valid
        ? { field: current.field, message: current.field.validationMessage }
        : null,
    );
  }

  return (
    <form
      {...props}
      onInvalidCapture={(event) => {
        onInvalidCapture?.(event);
        event.preventDefault();
        const field = firstInvalid(event.currentTarget);
        if (field && field === event.target) {
          setError({ field, message: field.validationMessage });
          focusField(field);
        }
      }}
      onInputCapture={(event) => {
        onInputCapture?.(event);
        revalidate();
      }}
      onChangeCapture={(event) => {
        onChangeCapture?.(event);
        revalidate();
      }}
      onSubmit={(event) => {
        setError(null);
        onSubmit?.(event);
      }}
      onReset={(event) => {
        setError(null);
        onReset?.(event);
      }}
    >
      {error ? (
        <div className="field-validation" role="alert" id={id}>
          <WorkspaceIcon name="warning" />
          <span>{error.message}</span>
        </div>
      ) : null}
      {children}
    </form>
  );
}
