import { useId, useState } from 'react';
import type { VaultSnapshot } from '../workspace/types';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import DocumentFilters from './DocumentFilters';
import {
  emptyDocumentFilters,
  hasDocumentFilters,
  type DocumentFiltersState,
} from './documentFilters';
import { useTagCatalog } from './useTagCatalog';

export function useSearchFilters(vault: VaultSnapshot | null) {
  const vaultKey = vault ? `${vault.root}:${vault.id}` : null;
  const [state, setState] = useState({ scope: vaultKey, value: emptyDocumentFilters });
  return {
    scope: vaultKey,
    filters: state.scope === vaultKey ? state.value : emptyDocumentFilters,
    setFilters: (value: DocumentFiltersState) => setState({ scope: vaultKey, value }),
  };
}

export default function SearchFiltersPanel({
  vaultKey,
  value,
  onChange,
}: {
  vaultKey: string | null;
  value: DocumentFiltersState;
  onChange: (value: DocumentFiltersState) => void;
}) {
  const [tagQuery, setTagQuery] = useState('');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { snapshot = null, error = null } = useTagCatalog(vaultKey, tagQuery) ?? {};
  const count = value.tags.length + Number(!!value.directory) + Number(value.kinds.length > 0);
  return (
    <>
      <button
        type="button"
        className="navigation-filter-toggle icon-button"
        aria-label={`${open ? 'Hide' : 'Show'} search filters, ${count} active`}
        aria-expanded={open}
        aria-controls={panelId}
        data-tooltip={open ? 'Hide filters' : 'Show filters'}
        data-active={hasDocumentFilters(value)}
        onClick={() => setOpen((value) => !value)}
      >
        <WorkspaceIcon name="filter" />
        {count > 0 ? <span className="navigation-filter-count">{count}</span> : null}
      </button>
      <div id={panelId} className="navigation-filter-content" hidden={!open}>
        <DocumentFilters
          value={value}
          onChange={onChange}
          directories={snapshot?.folders ?? []}
          tags={snapshot?.suggestions ?? []}
          onTagQuery={setTagQuery}
        />
        <p role="status" hidden={!error}>
          {error}
        </p>
        {snapshot?.moreSuggestions || snapshot?.moreFolders ? (
          <p className="navigation-coverage">
            Suggestions are limited. Type a tag or folder to narrow your search.
          </p>
        ) : null}
      </div>
    </>
  );
}
