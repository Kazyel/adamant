import {
  emptyDocumentFilters,
  hasDocumentFilters,
  type DocumentFiltersState,
} from '../features/navigation/documentFilters';
import SearchFiltersPanel, { useSearchFilters } from '../features/navigation/SearchFiltersPanel';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { CommandPalette } from '../features/interaction/ActionCatalog';
import { Dialog, ShortcutReference } from '../features/interaction/InteractionDialogs';
import { PreferencesDialog } from '../features/interaction/PreferencesDialog';
import type { UserAction } from '../features/interaction/types';
import { QuickOpen, SearchResults, Favorites } from '../features/navigation/Navigation';
import type { SearchMode } from '../features/navigation/navigationTypes';
import type { Navigation } from './workspaceView';
import type { Workspace } from '../features/workspace/workspaceTypes';
import { isEmptyDraft, vaultTabPath } from '../features/workspace/session/useDocumentSession';
import { native } from './workspaceView';
import { OverlayPresence } from '../features/interaction/OverlayPresence';
import { adjacentTabId } from '../features/navigation/quickOpen';
import { isWorkbenchAction } from './workspaceActionScope';

type Panel = 'palette' | 'shortcuts' | 'preferences' | 'quick' | 'search' | 'favorites' | null;

function searchDisplayMode(query: string, filters: DocumentFiltersState, mode: SearchMode) {
  return !query.trim() && hasDocumentFilters(filters) ? 'path' : mode;
}

function shortcutMatches(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts.at(-1);
  return (
    event.key.toLowerCase() === key &&
    (event.ctrlKey || event.metaKey) === parts.includes('ctrl') &&
    event.shiftKey === parts.includes('shift') &&
    event.altKey === parts.includes('alt')
  );
}

function desktopDisabled(workspace: Workspace) {
  if (!native) {
    return 'Available in the desktop application.';
  }
  return workspace.busy ? 'Wait for the current operation.' : undefined;
}

function vaultActions(workspace: Workspace): UserAction[] {
  const disabled = desktopDisabled(workspace);
  const vaultDisabled = disabled ?? (!workspace.vault ? 'Open a Vault first.' : undefined);
  return [
    {
      id: 'vault-create',
      label: 'Create Vault…',
      icon: 'folder',
      disabled,
      run: () => workspace.chooseVault('create'),
    },
    {
      id: 'vault-open',
      label: 'Open Vault…',
      icon: 'folder',
      disabled,
      run: () => workspace.chooseVault('open'),
    },
    {
      id: 'note-create',
      label: 'Create Note…',
      icon: 'new',
      disabled: vaultDisabled,
      run: workspace.newNote,
    },
    {
      id: 'files-import',
      label: 'Import Markdown, PDF or DOCX…',
      icon: 'import',
      disabled: vaultDisabled,
      run: workspace.importFiles,
    },
    {
      id: 'index-reconcile',
      label: 'Reconcile local index',
      icon: 'refresh',
      group: 'Local index',
      disabled: vaultDisabled,
      run: workspace.reconcile,
    },
    {
      id: 'index-cancel',
      label: 'Cancel indexing',
      icon: 'close',
      group: 'Local index',
      disabled: workspace.indexing?.state === 'indexing' ? disabled : 'Indexing is not running.',
      run: workspace.cancelIndex,
    },
    {
      id: 'workspace-repair',
      label: 'Repair local workspace storage…',
      icon: 'warning',
      group: 'Workspace maintenance',
      disabled: vaultDisabled,
      run: workspace.repairLocalStorage,
    },
    {
      id: 'vault-close',
      label: 'Close Vault',
      icon: 'close',
      group: 'Close workspace',
      disabled: vaultDisabled,
      run: workspace.closeVault,
    },
  ];
}

function hasOriginal(workspace: Workspace) {
  if (workspace.documents.activeTab?.conflict?.removed) {
    return false;
  }
  if (workspace.documents.activeTab?.document) {
    return true;
  }
  const source = workspace.buffer.source;
  return source?.kind === 'vault' || (source?.kind === 'standalone' && !!source.path);
}

function noteActions(workspace: Workspace): UserAction[] {
  const disabled = desktopDisabled(workspace);
  const active = workspace.documents.activeTab;
  const note =
    !active?.conflict?.removed && workspace.buffer.source?.kind === 'vault'
      ? workspace.buffer.source.note
      : null;
  const markdownDisabled =
    active?.kind === 'markdown' ? disabled : 'Select an editable Markdown document.';
  const actions: UserAction[] = [
    {
      id: 'note-save',
      label: 'Save',
      icon: 'save',
      shortcut: 'Ctrl+S',
      disabled: markdownDisabled,
      run: workspace.save,
    },
    {
      id: 'notes-save-all',
      label: 'Save all',
      icon: 'save',
      shortcut: 'Ctrl+Shift+S',
      disabled,
      run: workspace.saveAll,
    },
    {
      id: 'note-save-copy',
      label: 'Save recovery copy…',
      icon: 'copy',
      disabled: markdownDisabled,
      run: workspace.saveCopy,
    },
    {
      id: 'note-reload',
      label: 'Reload Note from disk…',
      icon: 'refresh',
      disabled: note ? disabled : 'Open a saved Vault Note.',
      run: workspace.reloadDisk,
    },
    {
      id: 'note-adopt',
      label: 'Adopt Markdown as a Note',
      icon: 'document',
      disabled: note && !note.id ? disabled : 'Open Markdown without a Note identity.',
      run: workspace.adoptNote,
    },
    {
      id: 'document-open-external',
      label: 'Open source in default application',
      icon: 'external',
      disabled: hasOriginal(workspace) ? disabled : 'Open a saved document.',
      run: workspace.openOriginal,
    },
  ];
  return active?.kind === 'markdown'
    ? actions
    : actions.filter(
        (action) => action.id === 'document-open-external' || action.id === 'notes-save-all',
      );
}

function tabActions(workspace: Workspace, navigation: Navigation): UserAction[] {
  const disabled = desktopDisabled(workspace);
  return [
    ...([-1, 1] as const).map((direction): UserAction => ({
      id: direction === 1 ? 'tab-next' : 'tab-previous',
      label: direction === 1 ? 'Next document' : 'Previous document',
      icon: direction === 1 ? 'forward' : 'back',
      shortcut: direction === 1 ? 'Ctrl+Tab' : 'Ctrl+Shift+Tab',
      disabled:
        (workspace.busy ? 'Wait for the current operation.' : undefined) ??
        (workspace.documents.tabs.length < 2 ? 'Open another document first.' : undefined),
      run: () => {
        const id = adjacentTabId(workspace.documents.tabs, workspace.documents.activeId, direction);
        if (id) {
          navigation.setSection('workbench');
          workspace.documents.activate(id);
        }
      },
    })),
    {
      id: 'tab-new',
      label: 'New document',
      icon: 'new',
      shortcut: 'Ctrl+N',
      disabled:
        (workspace.busy ? disabled : undefined) ??
        (!workspace.documents.tabs.every(isEmptyDraft)
          ? 'Close open documents before starting a new document.'
          : undefined),
      run: () => {
        navigation.setSection('workbench');
        workspace.newTab();
      },
    },
    {
      id: 'tab-close',
      label: 'Close active tab',
      icon: 'close',
      shortcut: 'Ctrl+W',
      disabled: workspace.busy ? disabled : undefined,
      run: workspace.closeActiveTab,
    },
    {
      id: 'tab-reopen',
      label: 'Reopen closed tab',
      icon: 'restore',
      shortcut: 'Ctrl+Shift+T',
      disabled:
        (workspace.busy ? 'Wait for the current operation.' : undefined) ??
        (!workspace.documents.closedTabs.length ? 'No closed tabs.' : undefined),
      run: () => {
        navigation.setSection('workbench');
        workspace.reopenTab();
      },
    },
    {
      id: 'document-open',
      label: 'Open document…',
      icon: 'document',
      disabled,
      run: () => {
        navigation.setSection('workbench');
        workspace.openDocument();
      },
    },
  ];
}

function navigationActions(
  workspace: Workspace,
  navigation: Navigation,
  openPanel: (panel: Panel) => void,
): UserAction[] {
  const disabled = desktopDisabled(workspace);
  const vaultDisabled = disabled ?? (!workspace.vault ? 'Open a Vault first.' : undefined);
  const activeVaultPath = vaultTabPath(workspace.documents.activeTab);
  const targetDisabled =
    vaultDisabled ?? (!activeVaultPath ? 'Open a document from this Vault.' : undefined);
  const finder = workspace.finder;
  return [
    {
      id: 'document-quick-open',
      label: 'Quick open',
      icon: 'search',
      shortcut: 'Ctrl+P',
      disabled: workspace.busy ? 'Wait for the current operation.' : undefined,
      run: () => openPanel('quick'),
    },
    {
      id: 'vault-search',
      label: 'Search Vault',
      icon: 'search',
      shortcut: 'Ctrl+Shift+F',
      disabled: vaultDisabled,
      run: () => openPanel('search'),
    },
    {
      id: 'history-back',
      label: 'Back',
      icon: 'back',
      shortcut: 'Alt+ArrowLeft',
      disabled: finder.canBack ? disabled : 'No earlier document.',
      run: () => {
        navigation.setSection('workbench');
        workspace.navigateHistory(-1);
      },
    },
    {
      id: 'history-forward',
      label: 'Forward',
      icon: 'forward',
      shortcut: 'Alt+ArrowRight',
      disabled: finder.canForward ? disabled : 'No later document.',
      run: () => {
        navigation.setSection('workbench');
        workspace.navigateHistory(1);
      },
    },
    {
      id: 'document-reveal',
      label: 'Reveal active document in explorer',
      icon: 'folder',
      disabled: targetDisabled,
      run: () => {
        navigation.setSidebarOpen(true);
        workspace.revealActive();
      },
    },
    {
      id: 'document-link',
      label: 'Copy link to active document',
      icon: 'connections',
      disabled: targetDisabled,
      run: workspace.copyActiveLink,
    },
    {
      id: 'favorites-open',
      label: 'Favorites',
      icon: 'star',
      disabled: vaultDisabled,
      run: () => openPanel('favorites'),
    },
    {
      id: 'document-favorite',
      label: 'Toggle active document favorite',
      icon: 'star',
      disabled: targetDisabled,
      run: workspace.favoriteActive,
    },
  ];
}

function viewActions(workspace: Workspace, navigation: Navigation): UserAction[] {
  const active = workspace.documents.activeTab;
  if (active?.kind !== 'markdown') {
    return [];
  }
  return [
    {
      id: 'view-edit',
      label: 'Editing view',
      icon: 'edit',
      disabled: active?.kind === 'markdown' ? undefined : 'Only Markdown can be edited.',
      run: () => navigation.setView('edit'),
    },
    { id: 'view-read', label: 'Reading view', icon: 'read', run: () => navigation.setView('read') },
    {
      id: 'view-split',
      label: 'Split editor and preview',
      icon: 'split',
      disabled: active?.kind === 'markdown' ? undefined : 'Only Markdown has an editable source.',
      run: () => navigation.setView('split'),
    },
  ];
}

function panelActions(navigation: Navigation, openPanel: (panel: Panel) => void): UserAction[] {
  return [
    {
      id: 'graph-open',
      label: 'File graph',
      icon: 'graph',
      run: () => navigation.setSection('graph'),
    },
    {
      id: 'explorer-toggle',
      label: 'Toggle explorer',
      icon: 'sidebar',
      run: () => navigation.setSidebarOpen((value) => !value),
    },
    {
      id: 'preferences',
      label: 'Preferences',
      icon: 'settings',
      shortcut: 'Ctrl+,',
      run: () => openPanel('preferences'),
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: 'keyboard',
      run: () => openPanel('shortcuts'),
    },
    {
      id: 'palette',
      label: 'Command palette',
      icon: 'menu',
      shortcut: 'Ctrl+Shift+P',
      run: () => openPanel('palette'),
    },
    {
      id: 'work-context',
      label: 'Open project workspace',
      icon: 'board',
      run: () => navigation.setSection('work'),
    },
    {
      id: 'connections',
      label: 'Connections',
      icon: 'connections',
      run: () => navigation.setSection('connections'),
    },
  ];
}

export function useWorkspaceActions(workspace: Workspace, navigation: Navigation) {
  const [panel, setPanel] = useState<Panel>(null);
  const [paletteActions, setPaletteActions] = useState<UserAction[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('content');
  const [searchPending, setSearchPending] = useState(false);
  const searchRequest = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const disabled = desktopDisabled(workspace);
  const finder = workspace.finder;
  const { search, cancelSearch } = finder;
  const { scope: searchScope, filters, setFilters } = useSearchFilters(workspace.vault);
  const selectedFilters = panel === 'search' ? filters : emptyDocumentFilters;

  function closePanel() {
    setPanel(null);
  }
  function openPanel(next: Panel) {
    if (next === 'palette' || next === 'shortcuts') {
      setPaletteActions(workspace.getExplorerActions());
    }
    if (next === 'quick' || next === 'search') {
      setQuery('');
      setSearchPending(false);
    }
    setPanel(next);
  }

  function changeQuery(value: string) {
    setQuery(value);
    setSearchPending(!!workspace.vault && !!value.trim());
  }

  const groups: { label: string; actions: UserAction[] }[] = [
    { label: 'Tabs', actions: tabActions(workspace, navigation) },
    { label: 'Document', actions: noteActions(workspace) },
    { label: 'Vault', actions: vaultActions(workspace) },
    { label: 'Navigation', actions: navigationActions(workspace, navigation, openPanel) },
    { label: 'View', actions: viewActions(workspace, navigation) },
    { label: 'Application', actions: panelActions(navigation, openPanel) },
    {
      label: 'Recovery',
      actions: workspace.recoveries.map((draft) => ({
        id: `draft-review:${draft.id}`,
        label: `Review retained draft: ${draft.path || 'New document'}`,
        icon: 'restore',
        disabled,
        run: () => workspace.inspectRecovery(draft),
      })),
    },
  ];
  const actions: UserAction[] = groups.flatMap(({ label, actions }) =>
    actions.map((action) => ({
      ...action,
      group: action.group ?? label,
      disabled:
        navigation.section !== 'workbench' && isWorkbenchAction(action.id)
          ? 'Open the document workbench first.'
          : action.disabled,
    })),
  );

  const keydown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) {
      return;
    }
    const action = actions.find((item) => item.shortcut && shortcutMatches(event, item.shortcut));
    if (!action) {
      return;
    }
    // Modal forms own their keystrokes. Do not turn a dialog's Ctrl+W into tab deletion.
    if (document.querySelector('dialog[open], [aria-modal="true"]') || workspace.prompt) {
      return;
    }
    event.preventDefault();
    if (!action.disabled) {
      void action.run();
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => keydown(event);
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  useEffect(() => {
    if ((panel !== 'quick' && panel !== 'search') || !searchScope || !native) {
      return;
    }
    const request = ++searchRequest.current;
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void search(query, panel === 'quick' ? 'path' : mode, selectedFilters).finally(() => {
        if (searchRequest.current === request) {
          setSearchPending(false);
        }
      });
    }, 180);
    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
      }
      searchTimer.current = null;
      searchRequest.current += 1;
      cancelSearch();
    };
  }, [query, panel, mode, search, cancelSearch, searchScope, selectedFilters]);

  async function runSearch(operation: () => Promise<void>) {
    const request = ++searchRequest.current;
    setSearchPending(true);
    try {
      await operation();
    } finally {
      if (searchRequest.current === request) {
        setSearchPending(false);
      }
    }
  }

  const searchFeedback = {
    filtered: hasDocumentFilters(selectedFilters),
    pending: searchPending,
    status: finder.searchStatus,
    hasMore: finder.searchPage?.hasMore,
    coverageIncomplete: finder.searchPage?.canContinue && finder.results.length < 500,
    truncated: finder.searchPage?.truncated,
    onLoadMore: () => {
      void runSearch(finder.loadMoreSearch);
    },
    onContinue: () => {
      void runSearch(finder.continueSearch);
    },
    onRetry: () => {
      void runSearch(() => search(query, panel === 'quick' ? 'path' : mode, selectedFilters));
    },
    onCancel: () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
      }
      searchTimer.current = null;
      searchRequest.current += 1;
      cancelSearch();
      setSearchPending(false);
    },
  };

  const openPath = (path: string) => {
    closePanel();
    navigation.setSection('workbench');
    workspace.openPath(path);
  };
  const quickOpenPaths = workspace.vault
    ? { recent: finder.state.recent, items: finder.results.map((hit) => hit.path) }
    : { recent: [], items: [] };
  const overlays = (
    <>
      <OverlayPresence>
        {panel === 'palette' ? (
          <CommandPalette actions={[...actions, ...paletteActions]} onClose={closePanel} />
        ) : null}
      </OverlayPresence>
      <OverlayPresence>
        {panel === 'shortcuts' ? (
          <ShortcutReference actions={[...actions, ...paletteActions]} onClose={closePanel} />
        ) : null}
      </OverlayPresence>
      <OverlayPresence>
        {panel === 'preferences' ? (
          <PreferencesDialog
            value={workspace.preferences}
            onClose={closePanel}
            onSave={workspace.savePreferences}
          />
        ) : null}
      </OverlayPresence>
      <OverlayPresence>
        {panel === 'quick' ? (
          <Dialog
            title="Quick open"
            description="Switch between open documents or find a file in your Vault."
            className="navigation-dialog"
            open
            onClose={closePanel}
          >
            <QuickOpen
              query={query}
              onQuery={changeQuery}
              {...quickOpenPaths}
              openTabs={workspace.documents.tabs}
              activeId={workspace.documents.activeId}
              missing={finder.missing}
              onOpen={(item) => {
                if (item.kind === 'tab') {
                  closePanel();
                  navigation.setSection('workbench');
                  workspace.documents.activate(item.tabId);
                } else {
                  openPath(item.path);
                }
              }}
              {...(workspace.vault ? searchFeedback : {})}
            />
          </Dialog>
        ) : null}
      </OverlayPresence>
      <OverlayPresence>
        {panel === 'search' ? (
          <Dialog
            title="Search Vault"
            className="navigation-dialog navigation-search-dialog"
            open
            onClose={closePanel}
          >
            <SearchResults
              query={query}
              mode={searchDisplayMode(query, filters, mode)}
              filters={
                <SearchFiltersPanel
                  key={searchScope}
                  vaultKey={searchScope}
                  value={filters}
                  onChange={(value) => {
                    setFilters(value);
                    setSearchPending(true);
                  }}
                />
              }
              onQuery={changeQuery}
              onMode={(next) => {
                if (next !== mode) {
                  setMode(next);
                  setSearchPending(!!query.trim());
                }
              }}
              hits={finder.results}
              onOpen={(hit) => {
                closePanel();
                navigation.setSection('workbench');
                workspace.openSearchHit(hit);
              }}
              {...searchFeedback}
            />
          </Dialog>
        ) : null}
      </OverlayPresence>
      <OverlayPresence>
        {panel === 'favorites' ? (
          <Dialog
            title="Favorites"
            description="Documents and folders you keep close at hand."
            className="navigation-dialog"
            open
            onClose={closePanel}
            initialFocus={
              finder.state.favorites.some((path) => !finder.missing.has(path))
                ? 'control'
                : 'heading'
            }
          >
            <Favorites
              paths={finder.state.favorites}
              missing={finder.missing}
              onOpen={(path) => {
                closePanel();
                navigation.setSection('workbench');
                workspace.openPath(path, finder.state.favoriteIdentities[path] ?? null);
              }}
              onRemove={finder.toggleFavorite}
            />
          </Dialog>
        ) : null}
      </OverlayPresence>
    </>
  );

  return { actions, overlays, openPalette: () => openPanel('palette') };
}
