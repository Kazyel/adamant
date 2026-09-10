import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { indexLabels, native } from './workspaceView';
import type { NavigationProps, WorkspaceProps } from './workspaceView';

function handleMenuNavigation(event: KeyboardEvent<HTMLDivElement>, closeMenu: () => void) {
  if (event.key === 'Tab') {
    closeMenu();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    return;
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
  );
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = items.length - 1;
  }

  items[next]?.focus();
  event.preventDefault();
}

function IndexMenu({ workspace, closeMenu }: WorkspaceProps & { closeMenu: () => void }) {
  const { indexing, indexAction, cancelIndex, reconcile } = workspace;
  if (!indexing || indexing.state === 'ready') {
    return null;
  }

  return (
    <>
      <div className="menu-index-description" role="presentation">
        {indexLabels[indexing.state]}
      </div>
      {indexing.state === 'indexing' || indexAction ? (
        <button
          role="menuitem"
          type="button"
          disabled={!native || indexAction === 'cancel'}
          onClick={() => {
            closeMenu();
            cancelIndex();
          }}
        >
          <WorkspaceIcon name="close" />
          Cancel indexing
        </button>
      ) : null}
      {indexing.state !== 'indexing' ? (
        <button
          role="menuitem"
          type="button"
          disabled={!native || indexAction !== null}
          onClick={() => {
            closeMenu();
            reconcile();
          }}
        >
          <WorkspaceIcon name="refresh" />
          Reconcile local index
        </button>
      ) : null}
      <div role="separator" aria-label="Index operations" />
    </>
  );
}

function AppMenu({ workspace, navigation }: NavigationProps) {
  const { vault, busy } = workspace;
  const { setSection } = navigation;
  const disabled = !native || !!busy;
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();

    function outside(event: PointerEvent) {
      if (
        !(event.target instanceof Node) ||
        menu.current?.contains(event.target) ||
        menuButton.current?.contains(event.target)
      ) {
        return;
      }

      closeMenu();
    }

    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    }

    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);

    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen, closeMenu]);

  return (
    <div className="app-menu">
      <button
        className="icon-button app-menu-trigger"
        type="button"
        ref={menuButton}
        title="Adamant menu"
        aria-label="Adamant menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="app-menu"
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        <WorkspaceIcon name="menu" />
      </button>
      {menuOpen ? (
        <div
          className="app-menu-panel"
          id="app-menu"
          ref={menu}
          role="menu"
          tabIndex={-1}
          aria-label="Adamant operations"
          onKeyDown={(event) => handleMenuNavigation(event, closeMenu)}
        >
          <button
            role="menuitem"
            type="button"
            disabled={disabled}
            onClick={() => {
              closeMenu();
              workspace.chooseVault('create');
            }}
          >
            <WorkspaceIcon name="new" />
            Create Vault…
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={disabled}
            onClick={() => {
              closeMenu();
              workspace.chooseVault('open');
            }}
          >
            <WorkspaceIcon name="folder" />
            Open Vault…
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={disabled || !vault}
            onClick={() => {
              closeMenu();
              workspace.closeVault();
            }}
          >
            <WorkspaceIcon name="close" />
            Close Vault
          </button>
          <div role="separator" aria-label="Vault operations" />
          <button
            role="menuitem"
            type="button"
            disabled={disabled || !vault}
            onClick={() => {
              closeMenu();
              setSection('workbench');
              workspace.newNote();
            }}
          >
            <WorkspaceIcon name="new" />
            New Note…
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={disabled || !vault}
            onClick={() => {
              closeMenu();
              setSection('workbench');
              workspace.importNote();
            }}
          >
            <WorkspaceIcon name="import" />
            Import Markdown…
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={disabled}
            onClick={() => {
              closeMenu();
              setSection('workbench');
              workspace.openDocument();
            }}
          >
            <WorkspaceIcon name="document" />
            Open standalone document…
          </button>
          <div role="separator" aria-label="Document operations" />
          <IndexMenu workspace={workspace} closeMenu={closeMenu} />
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              closeMenu();
              setSection('connections');
            }}
          >
            <WorkspaceIcon name="connections" />
            Connections
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function WorkspaceRibbon({ workspace, navigation }: NavigationProps) {
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
      <AppMenu workspace={workspace} navigation={navigation} />
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
      </div>
      <button
        className="icon-button ribbon-bottom"
        type="button"
        title="Connection checks"
        aria-label="Connection checks"
        aria-pressed={section === 'connections'}
        onClick={() => setSection('connections')}
      >
        <WorkspaceIcon name="connections" />
      </button>
    </nav>
  );
}
