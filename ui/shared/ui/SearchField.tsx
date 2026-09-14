import { useImperativeHandle, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import WorkspaceIcon from './WorkspaceIcon';

export default function SearchField({
  ref,
  className = '',
  onChange,
  ...props
}: Omit<ComponentProps<'input'>, 'type'>) {
  const input = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(props.defaultValue ?? '');
  useImperativeHandle(ref, () => input.current!, []);
  const value = props.value ?? localValue;
  function clear() {
    const field = input.current;
    if (!field) {
      return;
    }
    // Bypass React's value tracker so clearing follows the same onChange path as typing.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, '');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
  }
  return (
    <span className={`input-field search-field ${className}`}>
      <WorkspaceIcon name="search" />
      <input
        {...props}
        type="search"
        ref={input}
        onChange={(event) => {
          setLocalValue(event.target.value);
          onChange?.(event);
        }}
      />
      {String(value).length ? (
        <button
          type="button"
          className="icon-button search-clear"
          aria-label={`Clear ${props['aria-label'] ?? 'search'}`}
          disabled={props.disabled || props.readOnly}
          onClick={clear}
        >
          <WorkspaceIcon name="close" />
        </button>
      ) : null}
    </span>
  );
}
