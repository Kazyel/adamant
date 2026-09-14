import { useRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import WorkspaceIcon from './WorkspaceIcon';

export default function NumberField({
  label,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string }) {
  const input = useRef<HTMLInputElement>(null);
  function step(direction: number) {
    const field = input.current;
    if (!field || field.disabled || field.readOnly) {
      return;
    }
    if (direction > 0) {
      field.stepUp();
    } else {
      field.stepDown();
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const disabled = props.disabled || props.readOnly || props.step === 'any';
  return (
    <span className="number-field">
      <input {...props} type="number" ref={input} />
      <span className="number-field-controls">
        <button
          type="button"
          disabled={disabled}
          aria-label={`Increase ${label}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(1)}
        >
          <WorkspaceIcon name="plus" />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => step(-1)}
        >
          <WorkspaceIcon name="minimize" />
        </button>
      </span>
    </span>
  );
}
