export function isWorkbenchAction(id: string): boolean {
  return (
    (id.startsWith('note-') && id !== 'note-create') ||
    id.startsWith('view-') ||
    id === 'notes-save-all' ||
    id === 'tab-close' ||
    id === 'document-open-external'
  );
}
