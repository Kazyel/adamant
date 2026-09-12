import { useEffect, useRef, useState } from 'react';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { ActionList } from '../features/interaction/ActionCatalog';
import type { UserAction } from '../features/interaction/types';
import type { NavigationProps } from './workspaceView';
import { native } from './workspaceView';

const menuGroups = {
  Document: ['tab-new', 'document-open', 'note-save'],
  Navigation: ['document-quick-open', 'vault-search'],
  Vault: ['vault-create', 'vault-open'],
  Application: ['preferences', 'palette'],
};

function AppMenu({ actions }: { actions: UserAction[] }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const visible = Object.entries(menuGroups).flatMap(([group, ids]) =>
    actions
      .filter((action) => ids.includes(action.id))
      .map((action) => ({
        ...action,
        group,
        label: action.id === 'palette' ? 'All commands…' : action.label,
      })),
  );

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    container.current
      ?.querySelector<HTMLButtonElement>(
        ':is([role="menuitem"], [role="menuitemradio"])[aria-disabled="false"]',
      )
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return (
    <div className="app-menu" ref={container}>
      <button
        ref={trigger}
        className="icon-button app-menu-trigger"
        type="button"
        title="Adamant menu"
        aria-label="Adamant menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="app-menu"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <WorkspaceIcon name="menu" />
      </button>
      {open ? (
        <div id="app-menu" className="app-menu-panel">
          <div className="app-menu-heading">Adamant</div>
          <ActionList
            actions={visible}
            onRun={close}
            onDismiss={close}
            label="Adamant menu"
            grouped="separators"
          />
        </div>
      ) : null}
    </div>
  );
}

export default function WorkspaceRibbon({
  workspace,
  navigation,
  actions,
}: NavigationProps & { actions: UserAction[] }) {
  const { section, setSection, sidebarOpen, setSidebarOpen } = navigation;
  const sidebarLabel = sidebarOpen ? 'Collapse explorer' : 'Expand explorer';
  return (
    <nav className="icon-ribbon" aria-label="Workspace">
      <button
        className="icon-button"
        type="button"
        title={sidebarLabel}
        aria-label={sidebarLabel}
        aria-expanded={sidebarOpen}
        aria-controls="explorer"
        onClick={() => setSidebarOpen((value) => !value)}
      >
        <WorkspaceIcon name="sidebar" />
      </button>
      <div className="ribbon-actions">
        <button
          className="icon-button"
          type="button"
          title="Document workbench"
          aria-label="Document workbench"
          aria-pressed={section === 'workbench'}
          onClick={() => setSection('workbench')}
        >
          <WorkspaceIcon name="document" />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Project workspace"
          aria-label="Project workspace"
          aria-pressed={section === 'work'}
          onClick={() => setSection('work')}
        >
          <WorkspaceIcon name="board" />
        </button>
      </div>
      <AppMenu actions={actions} />
      <button
        className="icon-button"
        type="button"
        title="Open Trash"
        aria-label="Open Trash"
        disabled={!native || !workspace.vault || !!workspace.busy || workspace.fileActions.busy}
        onClick={() => {
          const action = workspace
            .getExplorerActions()
            .find((item) => item.id === 'explorer.trash.manage');
          if (action && !action.disabled) {
            void action.run();
          }
        }}
      >
        <WorkspaceIcon name="trash" />
      </button>
      <button
        className="icon-button"
        type="button"
        title="Connections"
        aria-label="Connections"
        aria-pressed={section === 'connections'}
        onClick={() => setSection('connections')}
      >
        <WorkspaceIcon name="connections" />
      </button>
    </nav>
  );
}
