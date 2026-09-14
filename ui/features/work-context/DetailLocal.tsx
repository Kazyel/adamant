import Form from '../../shared/ui/Form';
import DateField from '../interaction/DateField';
import SelectField from '../interaction/SelectField';
import { useState } from 'react';
import type { ReactNode } from 'react';
import WorkspaceIcon from '../../shared/ui/WorkspaceIcon';
import type { Priority, WorkItem } from './types';
import { priorities } from './state';
import { externalUrl, portableNote } from './DetailShared';
import type { DetailItemUpdate, DetailOpenExternal } from './DetailShared';

type LocalProps = { item: WorkItem; updateItem: DetailItemUpdate };
type OrganizationProps = LocalProps & {
  pending: boolean;
  onOpenNote: (target: string) => void;
  onError: (message: string) => void;
  openExternal: DetailOpenExternal;
};

export function DetailLocalEditor({ item, updateItem }: LocalProps) {
  const [localTitle, setLocalTitle] = useState(item.title);
  function saveTitle() {
    const title = localTitle.trim();
    if (!title) {
      setLocalTitle(item.title);
      return;
    }
    if (title !== item.title) {
      updateItem((current) => ({ ...current, title }));
    }
  }
  return (
    <section className="work-detail-section work-local-editor" aria-label="Local task editor">
      <label className="work-detail-field work-local-title">
        <span className="visually-hidden">Task title</span>
        <textarea
          rows={2}
          value={localTitle}
          maxLength={500}
          onChange={(event) => {
            const title = event.target.value;
            setLocalTitle(title);
            if (title.trim()) {
              updateItem((current) => ({ ...current, title: title.trim() }));
            }
          }}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              saveTitle();
            }
          }}
        />
      </label>
      <DetailProperties item={item} updateItem={updateItem} />
      <label className="work-detail-field work-local-description">
        Description
        <textarea
          value={item.description}
          rows={5}
          placeholder="What needs to happen? Add context, decisions or the next step…"
          maxLength={100000}
          onChange={(event) =>
            updateItem((current) => ({ ...current, description: event.target.value }))
          }
        />
      </label>
    </section>
  );
}

function DetailChecklist({ item, updateItem }: LocalProps) {
  const [newCheck, setNewCheck] = useState('');
  const completed = item.checklist.filter((entry) => entry.done).length;
  return (
    <>
      <h4 className="work-local-section-heading">
        Checklist
        {!item.remote && item.checklist.length > 0 ? (
          <span>
            {completed} / {item.checklist.length}
          </span>
        ) : null}
      </h4>
      {!item.remote && item.checklist.length > 0 ? (
        <progress
          className="work-local-progress"
          aria-label="Checklist progress"
          value={completed}
          max={item.checklist.length}
        />
      ) : null}
      {item.checklist.length ? (
        <ul className="work-detail-checklist">
          {item.checklist.map((entry) => (
            <li key={entry.id} data-done={entry.done}>
              <input
                type="checkbox"
                aria-label={`Complete ${entry.text}`}
                checked={entry.done}
                onChange={(event) =>
                  updateItem((current) => ({
                    ...current,
                    checklist: current.checklist.map((check) =>
                      check.id === entry.id ? { ...check, done: event.target.checked } : check,
                    ),
                  }))
                }
              />
              <input
                aria-label={`Checklist text: ${entry.text}`}
                value={entry.text}
                maxLength={2000}
                onChange={(event) =>
                  updateItem((current) => ({
                    ...current,
                    checklist: current.checklist.map((check) =>
                      check.id === entry.id ? { ...check, text: event.target.value } : check,
                    ),
                  }))
                }
              />
              <button
                type="button"
                className={!item.remote ? 'icon-button' : undefined}
                aria-label={`Remove checklist item ${entry.text}`}
                onClick={() =>
                  updateItem((current) => ({
                    ...current,
                    checklist: current.checklist.filter((check) => check.id !== entry.id),
                  }))
                }
              >
                {item.remote ? 'Remove' : <WorkspaceIcon name="close" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="work-detail-muted">
          {item.remote ? 'No checklist items.' : 'Break this task into small steps.'}
        </p>
      )}
      <Form
        className="work-detail-row"
        onSubmit={(event) => {
          event.preventDefault();
          const text = newCheck.trim();
          if (!text) {
            return;
          }
          updateItem((current) => ({
            ...current,
            checklist: [...current.checklist, { id: crypto.randomUUID(), text, done: false }],
          }));
          setNewCheck('');
        }}
      >
        <input
          aria-label="New checklist item"
          placeholder="Add a checklist item"
          value={newCheck}
          maxLength={2000}
          onChange={(event) => setNewCheck(event.target.value)}
        />
        <button disabled={!newCheck.trim() || item.checklist.length >= 200}>Add</button>
      </Form>
    </>
  );
}

function LinkComposer({ local, children }: { local: boolean; children: ReactNode }) {
  return local ? (
    <details className="work-local-link-composer">
      <summary>
        <WorkspaceIcon name="plus" /> Add a note or link
      </summary>
      {children}
    </details>
  ) : (
    children
  );
}

function DetailLinks({
  item,
  updateItem,
  pending,
  onOpenNote,
  onError,
  openExternal,
}: OrganizationProps) {
  const [linkLabel, setLinkLabel] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [linkKind, setLinkKind] = useState<'note' | 'external'>('note');
  const [linkError, setLinkError] = useState('');
  return (
    <>
      <h4>Notes and links</h4>
      {!item.remote && !item.links.length ? (
        <p className="work-detail-muted">Keep supporting notes and references with this task.</p>
      ) : null}
      <ul className="work-detail-links">
        {item.links.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              className="work-detail-link"
              disabled={pending}
              onClick={() => {
                if (externalUrl(link.target)) {
                  void openExternal(link.target);
                } else if (portableNote(link.target)) {
                  onOpenNote(link.target);
                } else {
                  onError('This link is not a portable Vault note path or an HTTP(S) URL.');
                }
              }}
            >
              {link.label || link.target}
              <span>{link.target}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove link ${link.label || link.target}`}
              className={!item.remote ? 'icon-button' : undefined}
              onClick={() =>
                updateItem((current) => ({
                  ...current,
                  links: current.links.filter((entry) => entry.id !== link.id),
                }))
              }
            >
              {item.remote ? 'Remove' : <WorkspaceIcon name="close" />}
            </button>
          </li>
        ))}
      </ul>
      <LinkComposer local={!item.remote}>
        <Form
          className="work-detail-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = linkTarget.trim();
            if (linkKind === 'note' ? !portableNote(target) : !externalUrl(target)) {
              setLinkError(
                linkKind === 'note'
                  ? 'Use a Vault-relative path, such as notes/plan.md, without parent traversal.'
                  : 'Use an HTTP or HTTPS URL without embedded credentials.',
              );
              return;
            }
            updateItem((current) => ({
              ...current,
              links: [
                ...current.links,
                { id: crypto.randomUUID(), label: linkLabel.trim() || target, target },
              ],
            }));
            setLinkTarget('');
            setLinkLabel('');
            setLinkError('');
          }}
        >
          <label className="work-detail-field">
            Link type
            <SelectField
              value={linkKind}
              onChange={(event) => setLinkKind(event.target.value as 'note' | 'external')}
            >
              <option value="note">Portable Vault note</option>
              <option value="external">External item</option>
            </SelectField>
          </label>
          <label className="work-detail-field">
            Label
            <input
              value={linkLabel}
              maxLength={500}
              onChange={(event) => setLinkLabel(event.target.value)}
            />
          </label>
          <label className="work-detail-field work-detail-span">
            {linkKind === 'note' ? 'Vault-relative note path' : 'External URL'}
            <input
              value={linkTarget}
              maxLength={4096}
              placeholder={
                linkKind === 'note' ? 'notes/plan.md' : 'https://github.com/owner/repo/issues/1'
              }
              onChange={(event) => setLinkTarget(event.target.value)}
            />
          </label>
          {linkError ? (
            <p className="work-detail-error work-detail-span" role="alert">
              {linkError}
            </p>
          ) : null}
          <button
            className="work-detail-span"
            disabled={!linkTarget.trim() || item.links.length >= 100}
          >
            Add link
          </button>
        </Form>
      </LinkComposer>
    </>
  );
}

function DetailProperties({ item, updateItem }: LocalProps) {
  return (
    <>
      <div className="work-detail-columns">
        <label className="work-detail-field">
          {item.remote ? 'Local priority' : 'Priority'}
          <SelectField
            value={item.priority}
            onChange={(event) =>
              updateItem((current) => ({ ...current, priority: event.target.value as Priority }))
            }
          >
            {priorities.map((priority) => (
              <option key={priority} value={priority}>
                {priority[0].toUpperCase() + priority.slice(1)}
              </option>
            ))}
          </SelectField>
        </label>
        <label className="work-detail-field">
          Due date
          <DateField
            value={item.dueDate}
            onChange={(value) => updateItem((current) => ({ ...current, dueDate: value }))}
          />
        </label>
      </div>
    </>
  );
}

function DetailOrganizationFields(props: OrganizationProps) {
  return (
    <>
      {props.item.remote ? <DetailProperties {...props} /> : null}
      <DetailChecklist item={props.item} updateItem={props.updateItem} />
      <DetailLinks {...props} />
    </>
  );
}

export function DetailOrganization(props: OrganizationProps & { expanded?: boolean }) {
  if (props.item.remote && !props.expanded) {
    return (
      <details className="work-detail-section work-detail-local-organization">
        <summary>Local organization</summary>
        <DetailOrganizationFields {...props} />
      </details>
    );
  }
  return (
    <section className="work-detail-section" aria-label="Organization">
      {props.item.remote ? <h3>Local work</h3> : null}
      {props.item.remote ? (
        <p className="work-detail-muted">
          Priority, dates, checklist and links belong to this workspace. They do not change GitHub.
        </p>
      ) : null}
      <DetailOrganizationFields {...props} />
    </section>
  );
}
