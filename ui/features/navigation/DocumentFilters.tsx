import { useId } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import TagInput from './TagInput';
import { emptyDocumentFilters, hasDocumentFilters } from './documentFilters';
import type { DocumentFiltersState, DocumentKind } from './documentFilters';

const kinds: { value: DocumentKind; label: string }[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'DOCX' },
];
export default function DocumentFilters({
  value,
  onChange,
  directories,
  tags,
  onTagQuery,
}: {
  value: DocumentFiltersState;
  onChange: (value: DocumentFiltersState) => void;
  directories: readonly string[];
  tags: readonly string[];
  onTagQuery?: (query: string) => void;
}) {
  const id = useId();
  return (
    <div className="document-filters">
      <div className="document-filter-heading">
        <span>Filter documents</span>
        {hasDocumentFilters(value) ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear document filters"
            data-tooltip="Clear filters"
            onClick={() => onChange(emptyDocumentFilters)}
          >
            <WorkspaceIcon name="close" />
          </button>
        ) : null}
      </div>
      <label htmlFor={id}>Folder</label>
      <input
        id={id}
        list={`${id}-folders`}
        placeholder="All folders"
        value={value.directory}
        onChange={(event) => onChange({ ...value, directory: event.target.value })}
        spellCheck={false}
        autoComplete="off"
      />
      <datalist id={`${id}-folders`}>
        {directories.filter(Boolean).map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </datalist>
      <div className="document-filter-kinds" role="group" aria-label="Document types">
        {kinds.map((kind) => (
          <label key={kind.value}>
            <input
              type="checkbox"
              checked={value.kinds.includes(kind.value)}
              onChange={(event) =>
                onChange({
                  ...value,
                  kinds: event.target.checked
                    ? [...value.kinds, kind.value]
                    : value.kinds.filter((item) => item !== kind.value),
                })
              }
            />
            {kind.label}
          </label>
        ))}
      </div>
      <TagInput
        tags={value.tags}
        suggestions={tags}
        onChange={(tags) => onChange({ ...value, tags })}
        label="Must have tags"
        onQuery={onTagQuery}
      />
    </div>
  );
}
