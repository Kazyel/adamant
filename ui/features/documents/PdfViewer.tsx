import { memo, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import pdfViewerStyles from 'pdfjs-dist/web/pdf_viewer.css?inline';
import { errorMessage } from '../../shared/errors';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';

GlobalWorkerOptions.workerSrc = workerUrl;

const pageStyles = `@scope (.pdf-page) { ${pdfViewerStyles} }`;

function PdfPage({
  document: pdf,
  number,
  scale,
}: {
  document: PDFDocumentProxy;
  number: number;
  scale: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [textError, setTextError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let page: PDFPageProxy | undefined;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    void pdf
      .getPage(number)
      .then(async (loadedPage) => {
        page = loadedPage;
        if (cancelled) {
          page.cleanup();
          return;
        }
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const pixels = viewport.width * viewport.height * ratio * ratio;
        if (pixels > 32_000_000) {
          throw new Error(
            'This page is too large at the selected zoom. Choose a smaller zoom or open the original externally.',
          );
        }
        const drawing = canvas.current!;
        drawing.width = Math.ceil(viewport.width * ratio);
        drawing.height = Math.ceil(viewport.height * ratio);
        drawing.style.width = `${viewport.width}px`;
        drawing.style.height = `${viewport.height}px`;
        surface.current!.style.width = `${viewport.width}px`;
        surface.current!.style.height = `${viewport.height}px`;
        text.current!.style.setProperty('--total-scale-factor', String(scale * viewport.userUnit));
        render = page.render({
          canvas: drawing,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        layer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: text.current!,
          viewport,
        });
        void layer.render().catch((reason: unknown) => {
          if (!cancelled) {
            setTextError(`Text selection unavailable: ${errorMessage(reason)}`);
          }
        });
        await render.promise;
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      layer?.cancel();
      render?.cancel();
      if (render) {
        void render.promise.then(
          () => page?.cleanup(),
          () => page?.cleanup(),
        );
      } else {
        page?.cleanup();
      }
    };
  }, [pdf, number, scale]);

  return (
    <>
      {loading ? (
        <div className="pdf-page-status">
          <LoadingIndicator label={`Rendering PDF page ${number}`} />
        </div>
      ) : null}
      {error ? (
        <p className="viewer-message error" role="alert">
          {error}
        </p>
      ) : null}
      {textError ? (
        <p className="viewer-message error" role="status">
          {textError}
        </p>
      ) : null}
      <div
        className="pdf-page"
        ref={surface}
        style={{ visibility: loading || error ? 'hidden' : 'visible' }}
      >
        <canvas ref={canvas} aria-label={`PDF page ${number}`} />
        <div className="textLayer" ref={text} />
      </div>
    </>
  );
}

export default memo(function PdfViewer({
  bytes,
  position,
  onPositionChange,
}: {
  bytes: Uint8Array;
  position: { page: number; zoom: number };
  onPositionChange: (position: { page: number; zoom: number }) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const page = Math.max(1, Math.min(position.page, pdf?.numPages ?? position.page));
  const zoom = position.zoom;

  useEffect(() => {
    let cancelled = false;
    const base = new URL('pdfjs/', document.baseURI).href;
    const task = getDocument({
      data: bytes.slice(),
      cMapUrl: `${base}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`,
      wasmUrl: `${base}wasm/`,
      iccUrl: `${base}iccs/`,
      useWorkerFetch: true,
      enableXfa: false,
      stopAtErrors: true,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
    });
    void task.promise
      .then((loaded) => {
        if (!cancelled) {
          setPdf(loaded);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorMessage(reason));
        }
      });
    return () => {
      cancelled = true;
      void task
        .destroy()
        .catch((reason: unknown) => console.error('PDF resource cleanup failed', reason));
    };
  }, [bytes]);

  if (error) {
    return (
      <div className="viewer-message error" role="alert">
        <h3>PDF could not be loaded</h3>
        <p>{error}</p>
        <p>For encrypted or unsupported PDFs, open the original in an external application.</p>
      </div>
    );
  }
  if (!pdf) {
    return (
      <div className="viewer-message">
        <LoadingIndicator label="Loading PDF" />
      </div>
    );
  }
  return (
    <div className="pdf-viewer">
      <style>{pageStyles}</style>
      <div className="pdf-toolbar" aria-label="PDF controls">
        <button
          type="button"
          disabled={page === 1}
          onClick={() => onPositionChange({ page: page - 1, zoom })}
        >
          Previous
        </button>
        <span aria-live="polite">
          Page {page} of {pdf.numPages}
        </span>
        <button
          type="button"
          disabled={page === pdf.numPages}
          onClick={() => onPositionChange({ page: page + 1, zoom })}
        >
          Next
        </button>
        <label>
          Zoom{' '}
          <select
            value={zoom}
            onChange={(event) => onPositionChange({ page, zoom: Number(event.target.value) })}
          >
            <option value={0.5}>50%</option>
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
            <option value={1.5}>150%</option>
            <option value={2}>200%</option>
          </select>
        </label>
      </div>
      <div className="pdf-scroll" role="region" tabIndex={0} aria-label="PDF page; scroll to read">
        <PdfPage key={`${page}:${zoom}`} document={pdf} number={page} scale={zoom} />
      </div>
    </div>
  );
});
