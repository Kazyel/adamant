import { Component, Suspense, lazy, useState } from 'react';
import type { ReactNode } from 'react';
import MarkdownEditor from '../features/markdown/MarkdownEditor';
import MarkdownPreview from '../features/markdown/MarkdownPreview';
import { invoke } from '@tauri-apps/api/core';
import { resolveMarkdownLink } from '../features/navigation/navigationTypes';
import { errorMessage } from '../shared/errors';
import LoadingIndicator from '../shared/ui/LoadingIndicator';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { getSaveStatus, native, noteLinkSource } from './workspaceView';
import type { DocumentProps, WorkspaceProps } from './workspaceView';
import type { SessionTab } from '../features/workspace/session';
import { isEmptyDraft } from '../features/workspace/session/useDocumentSession';
import Atmosphere from './Atmosphere';

const PdfViewer = lazy(() => import('../features/documents/PdfViewer'));
const DocxViewer = lazy(() => import('../features/documents/DocxViewer'));

class ViewerBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: errorMessage(error) };
  }

  render() {
    return this.state.error ? (
      <div className="viewer-message error" role="alert">
        <h3>Component could not start</h3>
        <p>{this.state.error}</p>
        <p>Check the desktop runtime and bundled resources before continuing.</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

function RestoredDocument({
  workspace,
  documentInfo,
  tab,
  slot,
  view,
}: WorkspaceProps & {
  documentInfo: DocumentProps['documentInfo'];
  tab: SessionTab;
  slot: 'edit' | 'read';
  view: DocumentProps['navigation']['view'];
}) {
  const editorSlot = tab.kind === 'markdown' && view !== 'read';
  if (editorSlot !== (slot === 'edit')) {
    return null;
  }
  const failure = tab.hydration?.state === 'error' ? tab.hydration : null;
  if (tab.kind === 'markdown' && !failure) {
    return (
      <section
        className={slot === 'edit' ? 'editor-pane' : 'reading-pane'}
        aria-label={slot === 'edit' ? 'Markdown editor' : 'Document reading surface'}
        aria-busy="true"
      />
    );
  }
  const name = tab.retained?.name ?? documentInfo.activeName;
  const path = documentInfo.activePath ?? tab.retained?.path;

  if (!failure) {
    return (
      <section
        className="viewer-message session-restored-document"
        aria-label="Document opening status"
        aria-busy="true"
      >
        <LoadingIndicator label={`Opening ${name}`} />
      </section>
    );
  }
  return (
    <section
      className="viewer-message session-restored-document"
      aria-label="Document opening status"
    >
      <WorkspaceIcon name="warning" />
      <div role="status">
        <h3>Could not open {name}</h3>
        {path ? <p className="session-dialog-path">{path}</p> : null}
        <p className="error">{failure.message}</p>
      </div>
      <p>The source file and any retained draft are unchanged.</p>
      <button
        type="button"
        className="session-retry-button"
        disabled={!!workspace.busy}
        onClick={() => workspace.documents.activate(tab.id)}
      >
        <WorkspaceIcon name="refresh" />
        Retry opening tab
      </button>
    </section>
  );
}

export function EditorPane({
  workspace,
  navigation,
  documentInfo,
  focusOnOpen = false,
}: DocumentProps & { focusOnOpen?: boolean }) {
  const { buffer, dirty, busy } = workspace;
  const { view } = navigation;
  const { note, bufferName } = documentInfo;
  const validatedSource = note && !note.metadataError ? buffer.savedText : undefined;
  const tab = workspace.documents.activeTab;
  if (tab?.kind !== 'markdown') {
    return null;
  }
  if (tab.restored) {
    return (
      <RestoredDocument
        key={tab.id}
        workspace={workspace}
        documentInfo={documentInfo}
        tab={tab}
        slot="edit"
        view={view}
      />
    );
  }
  const editorIsCurrent = () =>
    workspace.documents.activeIdRef.current === tab.id &&
    workspace.documents.tabsRef.current.find((item) => item.id === tab.id)?.editorKey ===
      tab.editorKey;
  const welcome = workspace.documents.tabs.length === 1 && isEmptyDraft(tab);

  return (
    <section
      className="editor-pane"
      hidden={view === 'read'}
      aria-label="Markdown editor"
      inert={busy === 'navigate'}
    >
      {view === 'split' ? (
        <div className="pane-heading">
          <span data-tooltip={bufferName}>{bufferName}</span>
          <span className={dirty ? 'unsaved-label' : ''} data-tooltip={getSaveStatus(workspace)}>
            {getSaveStatus(workspace)}
          </span>
        </div>
      ) : null}
      <div className={`editor-canvas${welcome ? ' editor-welcome' : ''}`}>
        {welcome && view !== 'read' ? <Atmosphere /> : null}
        <ViewerBoundary key={buffer.editorKey}>
          <MarkdownEditor
            noteLinkSource={noteLinkSource(workspace)}
            focusOnOpen={focusOnOpen}
            initialValue={buffer.text}
            validatedSource={validatedSource}
            onChange={(text) => {
              if (editorIsCurrent()) {
                workspace.changeText(text);
              }
            }}
            editorState={tab.editorState}
            onStateChange={(state) =>
              workspace.documents.setEditorState(tab.id, state, tab.editorKey)
            }
            location={{ line: tab.line, column: tab.column }}
            onLocationChange={(line, column) => {
              if (editorIsCurrent()) {
                workspace.documents.updateTab(tab.id, { line, column });
              }
            }}
            preferences={workspace.preferences}
            readOnly={busy === 'navigate'}
          />
        </ViewerBoundary>
      </div>
    </section>
  );
}

export function OriginalPreview({
  workspace,
  tab = workspace.documents.activeTab,
  shown = workspace.showOriginal,
}: WorkspaceProps & { tab?: SessionTab | null; shown?: boolean }) {
  const selected = tab?.document;
  if (!selected || !tab) {
    return null;
  }
  const updateViewerState = (viewerState: Partial<typeof tab.viewerState>) => {
    if (
      workspace.documents.tabsRef.current.find((item) => item.id === tab.id)?.document === selected
    ) {
      workspace.documents.updateTab(tab.id, (current) => ({
        ...current,
        viewerState: { ...current.viewerState, ...viewerState },
      }));
    }
  };

  return (
    <div className="reading-content" hidden={!shown}>
      <ViewerBoundary key={`${tab.id}:${selected.revision}`}>
        <Suspense
          fallback={
            <div className="viewer-message">
              <LoadingIndicator label={`Loading ${selected.kind.toUpperCase()} viewer`} />
            </div>
          }
        >
          {selected.kind === 'pdf' ? (
            <PdfViewer
              bytes={selected.bytes}
              position={tab.viewerState}
              onPositionChange={updateViewerState}
            />
          ) : (
            <DocxViewer
              bytes={selected.bytes}
              scrollTop={tab.viewerState.scrollTop}
              onScrollTopChange={(scrollTop) => updateViewerState({ scrollTop })}
            />
          )}
        </Suspense>
      </ViewerBoundary>
    </div>
  );
}

export function ReadingPane({ workspace, navigation, documentInfo }: DocumentProps) {
  const [linkTarget, setLinkTarget] = useState<{
    vaultId: string;
    path: string;
    anchor: string;
  } | null>(null);
  const { buffer, showOriginal } = workspace;
  const { view } = navigation;
  const { note, readingDocument, activeName } = documentInfo;
  const validatedSource = note && !note.metadataError ? buffer.savedText : undefined;
  const tab = workspace.documents.activeTab;
  const linkIsActive =
    !!linkTarget &&
    linkTarget.vaultId === workspace.vault?.id &&
    linkTarget.path === documentInfo.activeVaultPath;

  async function openPreviewLink(href: string) {
    try {
      const url = href.startsWith('//') ? `https:${href}` : href;
      if (/^(?:https?:|mailto:)/i.test(url)) {
        const destination = new URL(url).href;
        if (native) {
          await invoke('open_link', { url: destination });
        } else {
          window.open(destination, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      if (!workspace.vault || (buffer.source?.kind === 'standalone' && !href.startsWith('/'))) {
        throw new Error('Open this document in a Vault to follow relative document links.');
      }
      const target = resolveMarkdownLink(note?.path ?? null, href);
      if (!target.path) {
        setLinkTarget(null);
        navigation.setSidebarOpen(true);
        await workspace.revealPath('');
        return;
      }
      setLinkTarget(target.anchor ? { ...target, vaultId: workspace.vault.id } : null);
      workspace.openPath(target.path, undefined, view);
    } catch (error) {
      workspace.fail(error);
    }
  }

  if (tab?.restored) {
    return (
      <RestoredDocument
        key={tab.id}
        workspace={workspace}
        documentInfo={documentInfo}
        tab={tab}
        slot="read"
        view={view}
      />
    );
  }

  return (
    <section
      className="reading-pane"
      hidden={view === 'edit'}
      aria-label="Document reading surface"
    >
      {view === 'split' ? (
        <div className="pane-heading">
          <span data-tooltip={activeName}>{activeName}</span>
          <span>{readingDocument ? 'Original preview' : 'Reading view'}</span>
        </div>
      ) : null}
      <div className="reading-content" hidden={showOriginal}>
        <ViewerBoundary>
          <MarkdownPreview
            preferences={workspace.preferences}
            key={tab?.id}
            value={buffer.text}
            validatedSource={validatedSource}
            onOpenLink={(href) => void openPreviewLink(href)}
            anchor={linkIsActive ? linkTarget?.anchor : undefined}
            onAnchorApplied={() => setLinkTarget(null)}
          />
        </ViewerBoundary>
      </div>
      <OriginalPreview workspace={workspace} />
    </section>
  );
}
