import { useId, useState } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { EditorPreferences } from './types';
import { Dialog } from './InteractionDialogs';
import { errorMessage } from '../../shared/errors';

const viewLabels: Record<EditorPreferences['defaultView'], string> = {
  edit: 'Edit',
  read: 'Read',
  split: 'Split',
};

export function PreferencesDialog({
  value,
  onClose,
  onSave,
}: {
  value: EditorPreferences;
  onClose: () => void;
  onSave: (value: EditorPreferences) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const update = <K extends keyof EditorPreferences>(key: K, next: EditorPreferences[K]) =>
    setDraft((current) => ({ ...current, [key]: next }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (failure) {
      setError(`Preferences were not saved. ${errorMessage(failure)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Preferences"
      description="Set up your Markdown editor and how Notes open."
      className="interaction-preferences-dialog"
      open
      onClose={() => {
        if (!saving) {
          onClose();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) {
            void save();
          }
        }}
        className="interaction-preferences"
        aria-busy={saving}
      >
        <fieldset className="interaction-preference-section" disabled={saving}>
          <legend>Markdown editor</legend>
          <div className="interaction-setting-row">
            <div className="interaction-setting-label">
              <label htmlFor={`${id}-font`}>Font size</label>
              <p id={`${id}-font-help`}>Text size in the editor, from 8 to 48 px.</p>
            </div>
            <div className="interaction-setting-number">
              <input
                id={`${id}-font`}
                aria-describedby={`${id}-font-help`}
                type="number"
                required
                min={8}
                max={48}
                step={1}
                value={Number.isNaN(draft.fontSize) ? '' : draft.fontSize}
                onChange={(event) => update('fontSize', event.target.valueAsNumber)}
              />
              <span aria-hidden="true">px</span>
            </div>
          </div>
          <div className="interaction-setting-row">
            <div className="interaction-setting-label">
              <label htmlFor={`${id}-indent`}>Indent size</label>
              <p id={`${id}-indent-help`}>Spaces per indentation level, from 1 to 8.</p>
            </div>
            <div className="interaction-setting-number">
              <input
                id={`${id}-indent`}
                aria-describedby={`${id}-indent-help`}
                type="number"
                required
                min={1}
                max={8}
                step={1}
                value={Number.isNaN(draft.indentSize) ? '' : draft.indentSize}
                onChange={(event) => update('indentSize', event.target.valueAsNumber)}
              />
              <span aria-hidden="true">spaces</span>
            </div>
          </div>
          <div className="interaction-setting-row">
            <div className="interaction-setting-label">
              <label htmlFor={`${id}-wrap`}>Word wrap</label>
              <p id={`${id}-wrap-help`}>Keep long lines within the editor width.</p>
            </div>
            <input
              id={`${id}-wrap`}
              aria-describedby={`${id}-wrap-help`}
              type="checkbox"
              checked={draft.wordWrap}
              onChange={(event) => update('wordWrap', event.target.checked)}
            />
          </div>
        </fieldset>
        <fieldset className="interaction-preference-section" disabled={saving}>
          <legend>Default Note view</legend>
          <p id={`${id}-view-help`} className="interaction-setting-description">
            Choose the view used when opening a Note.
          </p>
          <div className="interaction-view-choices" aria-describedby={`${id}-view-help`}>
            {(['edit', 'read', 'split'] as const).map((view) => (
              <label key={view} className="interaction-view-choice">
                <input
                  className="visually-hidden"
                  type="radio"
                  name={`${id}-view`}
                  value={view}
                  checked={draft.defaultView === view}
                  onChange={() => update('defaultView', view)}
                />
                <WorkspaceIcon name={view} />
                <span>{viewLabels[view]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={saving}>
            {saving ? 'Saving preferences…' : 'Save preferences'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
