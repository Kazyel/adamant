import { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { errorMessage } from '../shared/errors';
import { getSaveStatus, native } from './workspaceView';
import type { DocumentProps, Workspace, WorkspaceProps } from './workspaceView';

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

  return 'Sanitized preview. Links are inactive; only embedded raster images are shown.';
}

export function EditorPane({ workspace, navigation, documentInfo }: DocumentProps) {
  const { buffer, dirty, busy } = workspace;
  const { view } = navigation;
  const { note, bufferName } = documentInfo;
  const validatedSource = note && !note.metadataError ? buffer.savedText : undefined;

  return (
    <section
      className="editor-pane"
      hidden={view === 'read'}
      aria-label="Markdown editor"
      inert={busy === 'navigate'}
    >
      {view === 'split' ? (
        <div className="pane-heading">
          <span>{bufferName}</span>
          <span className={dirty ? 'unsaved-label' : ''}>{getSaveStatus(workspace)}</span>
        </div>
      ) : null}
      <div className="editor-canvas">
        <ViewerBoundary key={buffer.editorKey}>
          <Suspense
            fallback={
              <div className="viewer-message" role="status">
                Loading Monaco editor…
              </div>
            }
          >
            <MarkdownEditor
              initialValue={buffer.text}
              validatedSource={validatedSource}
              onChange={workspace.changeText}
              readOnly={busy === 'navigate'}
            />
          </Suspense>
        </ViewerBoundary>
      </div>
      {!buffer.text ? (
        <div className="empty-editor-hint">
          <h1>A place to think.</h1>
          <p>
            Start typing Markdown above, or open a document from the explorer.
            {native
              ? ' Save it as a Note in a Vault.'
              : ' Desktop mode is required to open or save local files.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function OriginalPreview({ workspace }: WorkspaceProps) {
  const { selected, showOriginal } = workspace;
  if (!selected) {
    return null;
  }

  return (
    <div className="reading-content" hidden={!showOriginal}>
      <ViewerBoundary key={selected.revision}>
        <Suspense
          fallback={
            <div className="viewer-message" role="status">
              Loading {selected.kind.toUpperCase()} viewer…
            </div>
          }
        >
          {selected.kind === 'pdf' ? (
            <PdfViewer bytes={selected.bytes} />
          ) : (
            <DocxViewer bytes={selected.bytes} />
          )}
        </Suspense>
      </ViewerBoundary>
    </div>
  );
}

export function ReadingPane({ workspace, navigation, documentInfo }: DocumentProps) {
  const { buffer, showOriginal } = workspace;
  const { view } = navigation;
  const { note, readingDocument, activeName } = documentInfo;
  const validatedSource = note && !note.metadataError ? buffer.savedText : undefined;

  return (
    <section
      className="reading-pane"
      hidden={view === 'edit'}
      aria-label="Document reading surface"
    >
      {view === 'split' ? (
        <div className="pane-heading">
          <span>{activeName}</span>
          <span>{readingDocument ? 'Original preview' : 'Reading view'}</span>
        </div>
      ) : null}
      <div className="reading-content" hidden={showOriginal}>
        <ViewerBoundary>
          <Suspense
            fallback={
              <div className="viewer-message" role="status">
                Loading Markdown preview…
              </div>
            }
          >
            <MarkdownPreview value={buffer.text} validatedSource={validatedSource} />
          </Suspense>
        </ViewerBoundary>
      </div>
      <OriginalPreview workspace={workspace} />
      <div className="pane-footer">{getPreviewNote(readingDocument)}</div>
    </section>
  );
}
