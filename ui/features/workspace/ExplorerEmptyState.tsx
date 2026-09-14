import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';

export default function ExplorerEmptyState({
  filtering,
  disabled,
  onCreate,
  onClear,
}: {
  filtering: boolean;
  disabled: boolean;
  onCreate: () => void;
  onClear: () => void;
}) {
  return (
    <div className="explorer-empty-state">
      <WorkspaceIcon name={filtering ? 'search' : 'document'} />
      <strong>{filtering ? 'No matching files' : 'A place for your notes'}</strong>
      <p>
        {filtering
          ? 'Try another name, or clear the search to see your files.'
          : 'Create a note or import Markdown, PDF or DOCX files to get started.'}
      </p>
      <button type="button" disabled={disabled} onClick={filtering ? onClear : onCreate}>
        <WorkspaceIcon name={filtering ? 'close' : 'new'} />
        {filtering ? 'Clear search' : 'New Note'}
      </button>
    </div>
  );
}
