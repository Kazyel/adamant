import { useEffect, useId, useRef, useState } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import { tagError } from './documentFilters';

export default function TagInput({
  tags,
  suggestions,
  onChange,
  disabled = false,
  label = 'Add a tag',
  onQuery,
  focusWhenReady = false,
}: {
  tags: readonly string[];
  suggestions: readonly string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  label?: string;
  onQuery?: (query: string) => void;
  focusWhenReady?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const field = input.current;
    // Async dialogs start on their heading; respect focus if the user already moved it.
    if (
      focusWhenReady &&
      field?.closest('dialog')?.querySelector('h2') === document.activeElement
    ) {
      field?.focus();
    }
  }, [focusWhenReady]);
  function add() {
    const tag = value.trim();
    const problem = tagError(tag, tags);
    setError(problem);
    if (problem) {
      return;
    }
    if (!tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setValue('');
    onQuery?.('');
  }
  return (
    <div className="document-tag-input">
      {tags.length ? (
        <ul className="document-tags" aria-label="Selected tags">
          {tags.map((tag) => (
            <li key={tag}>
              <span>{tag}</span>
              <button
                type="button"
                className="icon-button"
                disabled={disabled}
                aria-label={`Remove tag ${tag}`}
                data-tooltip={`Remove ${tag}`}
                onClick={() => {
                  input.current?.focus();
                  onChange(tags.filter((item) => item !== tag));
                }}
              >
                <WorkspaceIcon name="close" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor={id}>{label}</label>
      <div className="document-tag-entry">
        <input
          ref={input}
          id={id}
          list={`${id}-suggestions`}
          value={value}
          disabled={disabled}
          autoComplete="off"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
            onQuery?.(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              add();
            }
          }}
        />
        <button
          type="button"
          className="icon-button"
          disabled={disabled || !value.trim()}
          aria-label="Add tag"
          data-tooltip="Add tag"
          onClick={add}
        >
          <WorkspaceIcon name="plus" />
        </button>
      </div>
      <datalist id={`${id}-suggestions`}>
        {suggestions
          .filter((tag) => !tags.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
      </datalist>
      {error ? (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
