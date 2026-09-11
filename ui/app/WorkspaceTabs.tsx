import { useLayoutEffect, useMemo, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { sourceName } from '../features/workspace/buffer';
import type { SessionTab } from '../features/workspace/session';
import { isEmptyDraft } from '../features/workspace/session/useDocumentSession';
import { native } from './workspaceView';
import type { DocumentProps, WorkspaceProps } from './workspaceView';

function WindowControls({ workspace }: WorkspaceProps) {
  const desktopWindow = native ? getCurrentWindow() : null;
  async function controlWindow(action: 'minimize' | 'toggleMaximize') {
    if (!desktopWindow) {
      return;
    }
    try {
      await desktopWindow[action]();
    } catch (error) {
      workspace.fail(error);
    }
  }

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        className="icon-button"
        type="button"
        title="Minimize window"
        aria-label="Minimize window"
        disabled={!native}
        onClick={() => void controlWindow('minimize')}
      >
        <WorkspaceIcon name="minimize" />
      </button>
      <button
        className="icon-button"
        type="button"
        title="Maximize or restore window"
        aria-label="Maximize or restore window"
        disabled={!native}
        onClick={() => void controlWindow('toggleMaximize')}
      >
        <WorkspaceIcon name="maximize" />
      </button>
      <button
        className="icon-button window-close"
        type="button"
        title="Close window"
        aria-label="Close window"
        disabled={!native}
        onClick={workspace.closeWindow}
      >
        <WorkspaceIcon name="close" />
      </button>
    </div>
  );
}
function tabLabel(tab: SessionTab): string {
  if (tab.source?.kind === 'vault') {
    return tab.source.note.path.split(/[/\\]/).at(-1)!;
  }
  if (tab.source) {
    return sourceName(tab.source);
  }
  return tab.document?.name ?? (tab.restored ? tab.retained?.name : undefined) ?? sourceName(null);
}

function tabLoadLabel(tab: SessionTab): string {
  if (tab.hydration?.state === 'error') {
    return ', could not open';
  }
  if (tab.hydration?.state === 'loading') {
    return ', loading';
  }
  return tab.restored ? ', waiting to open' : '';
}

function tabPath(tab: SessionTab, vault: WorkspaceProps['workspace']['vault']): string {
  if (tab.document) {
    return tab.document.path;
  }
  if (tab.source?.kind === 'standalone') {
    return tab.source.path;
  }
  const retained = tab.retained;
  const path = tab.source ? tab.source.note.path : (retained?.sourcePath ?? retained?.path ?? '');
  const inVault = !!tab.source || retained?.sourceKind === 'vault';
  if (!path || !inVault || !vault) {
    return path;
  }
  const root = vault.root.replace(/[/\\]+$/, '');
  const content = vault.contentRoot === 'content' ? '/content' : '';
  return `${root}${content}/${path}`.replace(/\\/g, '/');
}

function tabDetails(tabs: SessionTab[], vault: WorkspaceProps['workspace']['vault']) {
  const details = tabs.map((tab) => ({
    label: tabLabel(tab),
    path: tabPath(tab, vault),
    context: '',
  }));
  const groups = new Map<string, typeof details>();
  for (const detail of details) {
    const group = groups.get(detail.label);
    if (group) {
      group.push(detail);
    } else {
      groups.set(detail.label, [detail]);
    }
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const parents = group.map(({ path }) => {
      if (!path) {
        return '';
      }
      const normalized = path.replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      return slash < 0 ? '.' : normalized.slice(0, slash) || '/';
    });
    const candidates = new Map<string, string[]>();
    const counts = new Map<string, number>();
    for (const parent of new Set(parents)) {
      if (!parent) {
        continue;
      }
      const parts = parent === '/' ? ['/'] : parent.split('/');
      const suffixes = parts.map((_, index) => parts.slice(parts.length - index - 1).join('/'));
      candidates.set(parent, suffixes);
      for (const suffix of suffixes) {
        counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
      }
    }
    group.forEach((detail, index) => {
      const parent = parents[index];
      detail.context = candidates.get(parent)?.find((suffix) => counts.get(suffix) === 1) ?? parent;
    });
  }
  return details;
}

export default function WorkspaceTabs({ workspace, navigation }: DocumentProps) {
  const { tabs, activeId, closedTabs, reopenClosed, activate, close } = workspace.documents;
  const { section, setSection } = navigation;
  const activeTab = useRef<HTMLDivElement>(null);
  const { vault } = workspace;
  const details = useMemo(() => tabDetails(tabs, vault), [tabs, vault]);
  const initialEmpty = tabs.length === 1 && isEmptyDraft(tabs[0]);

  useLayoutEffect(() => {
    activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length, section]);

  return (
    <header className="workspace-tabs" aria-label="Open workspace views" data-tauri-drag-region>
      <div className="workspace-tab-group">
        <div
          className="workspace-tab-list"
          role="tablist"
          aria-label="Documents"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (
              !(event.target instanceof HTMLButtonElement) ||
              event.target.getAttribute('role') !== 'tab' ||
              !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
            ) {
              return;
            }
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
            );
            const current = buttons.indexOf(event.target);
            let next = 0;
            if (event.key === 'End') {
              next = buttons.length - 1;
            } else if (event.key !== 'Home') {
              const direction = event.key === 'ArrowRight' ? 1 : -1;
              next = (current + direction + buttons.length) % buttons.length;
            }
            event.preventDefault();
            buttons[next]?.focus({ preventScroll: true });
            buttons[next]?.click();
          }}
        >
          {tabs.map((tab, index) => {
            const { label, path, context } = details[index];
            const accessibleLabel = context ? `${label}, ${context}` : label;
            const loadState = tab.hydration?.state;
            const attention = loadState === 'error' || !!tab.conflict;
            const loadLabel = tabLoadLabel(tab);
            return (
              <div
                className="workspace-tab-item"
                key={tab.id}
                ref={activeId === tab.id ? activeTab : undefined}
                data-active={section === 'workbench' && activeId === tab.id}
                data-context={!!context}
              >
                <button
                  className="workspace-tab"
                  type="button"
                  role="tab"
                  aria-selected={section === 'workbench' && activeId === tab.id}
                  tabIndex={activeId === tab.id ? 0 : -1}
                  aria-label={`${accessibleLabel}${tab.dirty ? ', unsaved changes' : ''}${loadLabel}${tab.conflict ? ', disk conflict' : ''}`}
                  aria-busy={loadState === 'loading'}
                  data-attention={attention}
                  title={path}
                  onClick={(event) => {
                    event.currentTarget.parentElement?.scrollIntoView({
                      block: 'nearest',
                      inline: 'nearest',
                    });
                    activate?.(tab.id);
                    setSection('workbench');
                  }}
                >
                  <WorkspaceIcon name={attention ? 'warning' : 'document'} />
                  <span className="workspace-tab-name">{label}</span>
                  {context ? <span className="workspace-tab-context">{context}</span> : null}
                  {tab.dirty ? <span className="buffer-dot" aria-hidden="true" /> : null}
                </button>
                {initialEmpty ? null : (
                  <button
                    className="workspace-tab-close icon-button"
                    type="button"
                    aria-label={`Close ${accessibleLabel}`}
                    title={`Close ${accessibleLabel}${tab.dirty ? ' (unsaved changes)' : ''}`}
                    onClick={() => close?.(tab.id)}
                  >
                    <WorkspaceIcon name="close" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {closedTabs.length ? (
          <button
            className="workspace-tab-reopen icon-button"
            type="button"
            title="Reopen last closed tab"
            aria-label="Reopen last closed tab"
            onClick={() => reopenClosed?.()}
          >
            <WorkspaceIcon name="restore" />
          </button>
        ) : null}
      </div>
      <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />
      <WindowControls workspace={workspace} />
    </header>
  );
}
