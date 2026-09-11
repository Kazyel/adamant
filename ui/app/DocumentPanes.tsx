import { Component, Suspense, lazy, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { resolveMarkdownLink } from '../features/navigation/navigationTypes';
import { errorMessage } from '../shared/errors';
import LoadingIndicator from '../shared/ui/LoadingIndicator';
import WorkspaceIcon from '../shared/ui/WorkspaceIcon';
import { getSaveStatus, native } from './workspaceView';
import type { DocumentProps, WorkspaceProps } from './workspaceView';
import type { Workspace } from '../features/workspace/workspaceTypes';
import type { SessionTab } from '../features/workspace/session';

const MarkdownEditor = lazy(() => import('../features/markdown/MarkdownEditor'));
const MarkdownPreview = lazy(() => import('../features/markdown/MarkdownPreview'));
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

function getPreviewNote(readingDocument: Workspace['selected']) {
  if (readingDocument?.kind === 'pdf') {
    return 'One page rendered at a time. No PDF scripts, forms, or link actions.';
  }
  if (readingDocument?.kind === 'docx') {
    return 'Isolated preview; Word layout may differ. Embedded HTML and remote resources are blocked.';
  }

  return null;
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
  const name = tab.retained?.name ?? documentInfo.activeName;
  const path = documentInfo.activePath ?? tab.retained?.path;

  return (
    <section
      className="viewer-message session-restored-document"
      aria-label="Document opening status"
    >
      <WorkspaceIcon name={failure ? 'warning' : 'document'} />
      <div aria-busy={!failure} role={failure ? 'status' : undefined}>
        <h3>{failure ? `Could not open ${name}` : `Opening ${name}…`}</h3>
        {path ? <p className="session-dialog-path">{path}</p> : null}
        {failure ? <p className="error">{failure.message}</p> : null}
      </div>
      <p>The source file and any retained draft are unchanged.</p>
      {failure ? (
        <button
          type="button"
          className="session-retry-button"
          disabled={!!workspace.busy}
          onClick={() => workspace.documents.activate(tab.id)}
        >
          <WorkspaceIcon name="refresh" />
          Retry opening tab
        </button>
      ) : (
        <LoadingIndicator label={`Opening ${name}`} />
      )}
    </section>
  );
}

export function EditorPane({ workspace, navigation, documentInfo }: DocumentProps) {
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

  return (
    <section
      className="editor-pane"
      hidden={view === 'read'}
      aria-label="Markdown editor"
      inert={busy === 'navigate'}
    >
      {view === 'split' ? (
        <div className="pane-heading">
          <span title={bufferName}>{bufferName}</span>
          <span className={dirty ? 'unsaved-label' : ''} title={getSaveStatus(workspace)}>
            {getSaveStatus(workspace)}
          </span>
        </div>
      ) : null}
      <div className="editor-canvas">
        <ViewerBoundary key={buffer.editorKey}>
          <Suspense
            fallback={
              <div className="viewer-message">
                <LoadingIndicator label="Loading Markdown editor" />
              </div>
            }
          >
            <MarkdownEditor
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
          </Suspense>
        </ViewerBoundary>
      </div>
    </section>
  );
}

function OriginalPreview({ workspace }: WorkspaceProps) {
  const { selected, showOriginal } = workspace;
  const tab = workspace.documents.activeTab;
  if (!selected || !tab) {
    return null;
  }
  const updateViewerState = (viewerState: Partial<typeof tab.viewerState>) => {
    if (
      workspace.documents.activeIdRef.current === tab.id &&
      workspace.documents.tabsRef.current.find((item) => item.id === tab.id)?.document === selected
    ) {
      workspace.documents.updateTab(tab.id, (current) => ({
        ...current,
        viewerState: { ...current.viewerState, ...viewerState },
      }));
    }
  };

  return (
    <div className="reading-content" hidden={!showOriginal}>
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
  const previewNote = getPreviewNote(readingDocument);
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
          <span title={activeName}>{activeName}</span>
          <span>{readingDocument ? 'Original preview' : 'Reading view'}</span>
        </div>
      ) : null}
      <div className="reading-content" hidden={showOriginal}>
        <ViewerBoundary>
          <Suspense
            fallback={
              <div className="viewer-message">
                <LoadingIndicator label="Loading Markdown preview" />
              </div>
            }
          >
            <MarkdownPreview
              key={tab?.id}
              value={buffer.text}
              validatedSource={validatedSource}
              onOpenLink={(href) => void openPreviewLink(href)}
              anchor={linkIsActive ? linkTarget?.anchor : undefined}
              onAnchorApplied={() => setLinkTarget(null)}
            />
          </Suspense>
        </ViewerBoundary>
      </div>
      <OriginalPreview workspace={workspace} />
      {previewNote ? <div className="pane-footer">{previewNote}</div> : null}
    </section>
  );
}
