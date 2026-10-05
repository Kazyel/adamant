import Form from '../../shared/ui/Form';
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '../../shared/ui/arc/button/button';
import NumberField from '../../shared/ui/NumberField';
import WorkspaceIcon, { type IconName } from '../../shared/ui/WorkspaceIcon';
import type { EditorPreferences } from './types';
import { Dialog } from './InteractionDialogs';
import { errorMessage } from '../../shared/errors';
import SelectField from './SelectField';
import { resolveFontFamily } from '../../shared/styles/fontFamilies';
import FontField from './FontField';

const viewLabels: Record<EditorPreferences['defaultView'], string> = {
  edit: 'Edit',
  read: 'Read',
  split: 'Split',
};

const sections = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'settings',
  },
  {
    id: 'editor',
    label: 'Markdown editor',
    icon: 'edit',
  },
  {
    id: 'reading',
    label: 'Markdown reading',
    icon: 'read',
  },
  {
    id: 'opening',
    label: 'Opening notes',
    icon: 'document',
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: IconName;
}>;

type Section = (typeof sections)[number]['id'];

export function PreferencesDialog({
  value,
  onClose,
  onSave,
}: {
  value: EditorPreferences;
  onClose: () => void;
  onSave: (value: EditorPreferences) => Promise<void>;
}) {
  const [section, setSection] = useState<Section>('appearance');
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
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
      className="interaction-preferences-dialog"
      open
      onClose={() => {
        if (!saving) {
          onClose();
        }
      }}
    >
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) {
            void save();
          }
        }}
        className="interaction-preferences"
        aria-busy={saving}
        onInvalidCapture={(event) => {
          const first = event.currentTarget.querySelector(
            'input:invalid, select:invalid, textarea:invalid',
          );
          if (event.target !== first) {
            return;
          }
          const invalidSection = sections.find(({ id: key }) =>
            first?.closest(`[data-preference-section="${key}"]`),
          );
          if (invalidSection) {
            // Reveal the invalid field before Form moves keyboard focus to it.
            flushSync(() => setSection(invalidSection.id));
          }
        }}
      >
        <div className="preferences-layout">
          <nav className="preferences-navigation" aria-label="Preference categories">
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? 'page' : undefined}
                aria-controls={`${id}-${item.id}-panel`}
                onClick={() => {
                  setSection(item.id);
                  content.current?.scrollTo({ top: 0 });
                }}
              >
                <WorkspaceIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="preferences-content" ref={content}>
            <fieldset
              className="interaction-preference-section"
              id={`${id}-appearance-panel`}
              data-preference-section="appearance"
              hidden={section !== 'appearance'}
              disabled={saving}
            >
              <legend>Appearance</legend>
              <p className="preferences-section-description">
                Choose your workspace theme and document layout.
              </p>
              <div className="interaction-theme-choices">
                {(['dark', 'light'] as const).map((theme) => (
                  <label key={theme} className="interaction-view-choice interaction-theme-choice">
                    <input
                      className="visually-hidden"
                      type="radio"
                      name={`${id}-theme`}
                      checked={(draft.theme ?? 'dark') === theme}
                      onChange={() => update('theme', theme)}
                    />
                    <span
                      className="interaction-theme-swatch"
                      data-theme={theme}
                      aria-hidden="true"
                    >
                      <span className="preferences-swatch-sidebar" />
                      <span className="preferences-swatch-document">
                        <span className="preferences-swatch-heading" />
                        <span />
                        <span />
                        <span />
                      </span>
                    </span>
                    <span className="preferences-choice-caption">
                      <span>{theme === 'dark' ? 'Dark graphite' : 'Cool white'}</span>
                      <WorkspaceIcon name="check" />
                    </span>
                  </label>
                ))}
              </div>
              <div className="interaction-setting-row">
                <div className="interaction-setting-label">
                  <label htmlFor={`${id}-interface-font`}>Interface font</label>
                  <p id={`${id}-interface-font-help`}>
                    Used for menus, tabs, dialogs, and workspace headings.
                  </p>
                </div>
                <FontField
                  id={`${id}-interface-font`}
                  label="Interface font"
                  describedBy={`${id}-interface-font-help`}
                  value={draft.interfaceFont}
                  allowDefault
                  disabled={saving}
                  onChange={(font) => update('interfaceFont', font)}
                />
              </div>
              <div
                className="preferences-interface-sample"
                style={{ fontFamily: resolveFontFamily(draft.interfaceFont ?? 'inter') }}
              >
                <strong>Workspace</strong>
                <span>Notes, documents, and project work.</span>
              </div>
              <div className="interaction-setting-row">
                <div className="interaction-setting-label">
                  <label htmlFor={`${id}-tabs`}>Show document tabs</label>
                  <p id={`${id}-tabs-help`}>
                    Hide the tab strip across the app. Your documents stay open.
                  </p>
                </div>
                <input
                  id={`${id}-tabs`}
                  aria-describedby={`${id}-tabs-help`}
                  type="checkbox"
                  checked={draft.showDocumentTabs ?? true}
                  onChange={(event) => update('showDocumentTabs', event.target.checked)}
                />
              </div>
            </fieldset>
            <fieldset
              className="interaction-preference-section"
              id={`${id}-editor-panel`}
              data-preference-section="editor"
              hidden={section !== 'editor'}
              disabled={saving}
            >
              <legend>Markdown editor</legend>
              <p className="preferences-section-description">
                Adjust your font, text size, and writing behavior.
              </p>
              <div className="preferences-type-layout">
                <div className="preferences-type-controls">
                  <div className="interaction-setting-row">
                    <div className="interaction-setting-label">
                      <label htmlFor={`${id}-editor-font`}>Font</label>
                      <p id={`${id}-editor-font-help`}>Used while editing Markdown.</p>
                    </div>
                    <FontField
                      id={`${id}-editor-font`}
                      label="Editor font"
                      describedBy={`${id}-editor-font-help`}
                      value={draft.editorFont ?? 'inter'}
                      disabled={saving}
                      onChange={(font) => update('editorFont', font)}
                    />
                  </div>
                  <div className="interaction-setting-row">
                    <div className="interaction-setting-label">
                      <label htmlFor={`${id}-font`}>Font size</label>
                      <p id={`${id}-font-help`}>Text size in the editor, from 8 to 48 px.</p>
                    </div>
                    <div className="interaction-setting-number">
                      <NumberField
                        label="font size"
                        id={`${id}-font`}
                        aria-describedby={`${id}-font-help`}
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
                      <p id={`${id}-indent-help`}>Spaces per indentation level.</p>
                    </div>
                    <SelectField
                      id={`${id}-indent`}
                      aria-label="Indent size"
                      aria-describedby={`${id}-indent-help`}
                      value={draft.indentSize}
                      disabled={saving}
                      onChange={(event) => update('indentSize', Number(event.target.value))}
                    >
                      {[2, 4, 8].map((size) => (
                        <option key={size} value={size}>
                          {size} spaces
                        </option>
                      ))}
                    </SelectField>
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
                </div>
                <div className="preferences-preview">
                  <div className="preferences-preview-toolbar">
                    <WorkspaceIcon name="document" />
                    <span>Notes.md</span>
                    <span>Editor preview</span>
                  </div>
                  <pre
                    className="preferences-editor-sample"
                    style={{
                      fontFamily: resolveFontFamily(draft.editorFont ?? 'inter'),
                      fontSize: Number.isFinite(draft.fontSize) ? draft.fontSize : 17,
                      whiteSpace: draft.wordWrap ? 'pre-wrap' : 'pre',
                      tabSize: draft.indentSize,
                    }}
                  >
                    {
                      '# A place to think\n\nKeep the notes behind your next idea.\n\n- Capture a thought\n\t- Connect it to what you know\n\n> Leave room for the next idea.'
                    }
                  </pre>
                </div>
              </div>
            </fieldset>
            <fieldset
              className="interaction-preference-section"
              id={`${id}-reading-panel`}
              data-preference-section="reading"
              hidden={section !== 'reading'}
              disabled={saving}
            >
              <legend>Markdown reading</legend>
              <p className="preferences-section-description">
                Set the font and text size for reading and split views.
              </p>
              <div className="preferences-type-layout">
                <div className="preferences-type-controls">
                  <div className="interaction-setting-row">
                    <div className="interaction-setting-label">
                      <label htmlFor={`${id}-reading-font`}>Font</label>
                      <p id={`${id}-reading-font-help`}>
                        Used for text and headings in reading and split views.
                      </p>
                    </div>
                    <FontField
                      id={`${id}-reading-font`}
                      label="Reading font"
                      describedBy={`${id}-reading-font-help`}
                      value={draft.readingFont ?? 'libron'}
                      disabled={saving}
                      onChange={(font) => update('readingFont', font)}
                    />
                  </div>
                  <div className="interaction-setting-row">
                    <div className="interaction-setting-label">
                      <label htmlFor={`${id}-reading-size`}>Font size</label>
                      <p id={`${id}-reading-size-help`}>
                        Text size in the preview, from 12 to 32 px.
                      </p>
                    </div>
                    <div className="interaction-setting-number">
                      <NumberField
                        label="reading font size"
                        id={`${id}-reading-size`}
                        aria-describedby={`${id}-reading-size-help`}
                        required
                        min={12}
                        max={32}
                        step={1}
                        value={
                          Number.isNaN(draft.readingFontSize) ? '' : (draft.readingFontSize ?? 17)
                        }
                        onChange={(event) => update('readingFontSize', event.target.valueAsNumber)}
                      />
                      <span aria-hidden="true">px</span>
                    </div>
                  </div>

                  <p className="interaction-setting-description">Code keeps its monospace font.</p>
                </div>
                <div className="preferences-preview">
                  <div className="preferences-preview-toolbar">
                    <WorkspaceIcon name="read" />
                    <span>Notes.md</span>
                    <span>Reading preview</span>
                  </div>
                  <div
                    className="preferences-reading-sample"
                    style={{
                      fontFamily: resolveFontFamily(draft.readingFont ?? 'libron'),
                      fontSize: Number.isFinite(draft.readingFontSize) ? draft.readingFontSize : 17,
                    }}
                  >
                    <h3>A place to think</h3>
                    <p>
                      Keep the notes behind your <strong>next idea</strong>. A quiet place to
                      collect what matters, connect your thoughts, and return to them.
                    </p>
                    <blockquote>Leave room for the next idea.</blockquote>
                    <p>
                      A few words, ready to <em>read</em>.
                    </p>
                  </div>
                </div>
              </div>
            </fieldset>
            <fieldset
              className="interaction-preference-section"
              id={`${id}-opening-panel`}
              data-preference-section="opening"
              hidden={section !== 'opening'}
              disabled={saving}
            >
              <legend>Opening notes</legend>
              <p className="preferences-section-description">
                Choose where you begin when opening a Note.
              </p>
              <p id={`${id}-view-help`} className="interaction-setting-description">
                Newly opened notes use this view. Open notes keep their current view.
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
                    <span className="preferences-view-preview" data-view={view} aria-hidden="true">
                      <span />
                      <span />
                    </span>
                    <span className="preferences-choice-caption">
                      <span>
                        <WorkspaceIcon name={view} />
                        {viewLabels[view]}
                      </span>
                      <WorkspaceIcon name="check" />
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </div>
        <footer className="preferences-footer">
          <div className="preferences-save-status">
            {error ? (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            ) : (
              <p>Changes apply when you save.</p>
            )}
          </div>
          <div className="dialog-actions">
            <Button variant="secondary" type="button" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving}>
              Save preferences
            </Button>
          </div>
        </footer>
      </Form>
    </Dialog>
  );
}
