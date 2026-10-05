import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import pdfViewerStyles from 'pdfjs-dist/web/pdf_viewer.css?inline';
import { errorMessage } from '../../shared/errors';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';
import SelectField from '../interaction/SelectField';
import { createZoomTransition, documentZoomLevels, listenForZoomWheel } from './zoomWheel';

GlobalWorkerOptions.workerSrc = workerUrl;

const pageStyles = `@scope (.pdf-page) { ${pdfViewerStyles} }`;

function PdfPage({
  document: pdf,
  number,
  scale,
  scroll,
  onScaleChange,
}: {
  document: PDFDocumentProxy;
  number: number;
  scale: number;
  scroll: RefObject<HTMLDivElement | null>;
  onScaleChange: (zoom: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const extent = useRef<HTMLDivElement>(null);
  const transition = useRef<ReturnType<typeof createZoomTransition> | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [textError, setTextError] = useState('');
  const currentScale = useEffectEvent(() => scale);
  const changeScale = useEffectEvent(onScaleChange);

  useLayoutEffect(() => {
    const layout = extent.current;
    const content = surface.current;
    const viewport = scroll.current;
    if (!size || !layout || !content || !viewport) {
      return;
    }
    let zoom = currentScale();
    const apply = (next: number, event?: WheelEvent) => {
      const bounds = layout.getBoundingClientRect();
      const viewBounds = viewport.getBoundingClientRect();
      const x = event?.clientX ?? viewBounds.left + viewport.clientWidth / 2;
      const y = event?.clientY ?? viewBounds.top + viewport.clientHeight / 2;
      const anchorX = (x - bounds.left) / zoom;
      const anchorY = (y - bounds.top) / zoom;
      layout.style.width = `${size.width * next}px`;
      layout.style.height = `${size.height * next}px`;
      content.style.transform = `scale(${next})`;
      const nextBounds = layout.getBoundingClientRect();
      viewport.scrollLeft += nextBounds.left + anchorX * next - x;
      viewport.scrollTop += nextBounds.top + anchorY * next - y;
      zoom = next;
    };
    layout.style.width = `${size.width * zoom}px`;
    layout.style.height = `${size.height * zoom}px`;
    content.style.transform = `scale(${zoom})`;
    const animation = createZoomTransition(window, zoom, apply);
    transition.current = animation;
    return () => {
      animation.dispose();
      transition.current = null;
    };
  }, [size, scroll]);

  useLayoutEffect(() => {
    transition.current?.zoomTo(scale);
  }, [scale]);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!size || !viewport) {
      return;
    }
    return listenForZoomWheel(viewport, scale, (next, event) => {
      transition.current?.zoomTo(next, event);
      changeScale(next);
    });
  }, [size, scale, scroll]);

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
        const viewport = page.getViewport({ scale: 1 });
        // Rasterize once with enough detail for 200% zoom, within the existing pixel budget.
        const ratio = Math.min(
          Math.min(window.devicePixelRatio || 1, 2) * 2,
          Math.sqrt(32_000_000 / (viewport.width * viewport.height)),
        );
        if (ratio < 0.5) {
          throw new Error('This page is too large to preview. Open the original externally.');
        }
        const drawing = canvas.current!;
        drawing.width = Math.ceil(viewport.width * ratio);
        drawing.height = Math.ceil(viewport.height * ratio);
        drawing.style.width = `${viewport.width}px`;
        drawing.style.height = `${viewport.height}px`;
        surface.current!.style.width = `${viewport.width}px`;
        surface.current!.style.height = `${viewport.height}px`;
        setSize({ width: viewport.width, height: viewport.height });
        text.current!.style.setProperty('--total-scale-factor', String(viewport.userUnit));
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
  }, [pdf, number]);

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
        className="pdf-page-extent"
        ref={extent}
        style={{ visibility: loading || error ? 'hidden' : 'visible' }}
      >
        <div className="pdf-page" ref={surface}>
          <canvas ref={canvas} aria-label={`PDF page ${number}`} />
          <div className="textLayer" ref={text} />
        </div>
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
  const scroll = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const page = Math.max(1, Math.min(position.page, pdf?.numPages ?? position.page));
  const zoom = position.zoom;

  useLayoutEffect(() => {
    scroll.current?.scrollTo({ top: 0, left: 0 });
  }, [page]);

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
          <SelectField
            aria-label="PDF zoom"
            value={zoom}
            onChange={(event) => onPositionChange({ page, zoom: Number(event.target.value) })}
          >
            {!documentZoomLevels.includes(zoom) ? (
              <option value={zoom}>{Math.round(zoom * 100)}%</option>
            ) : null}
            {documentZoomLevels.map((level) => (
              <option key={level} value={level}>
                {level * 100}%
              </option>
            ))}
          </SelectField>
        </label>
      </div>
      <div
        ref={scroll}
        className="pdf-scroll"
        role="region"
        tabIndex={0}
        aria-label="PDF page; scroll to read"
      >
        <PdfPage
          key={page}
          document={pdf}
          number={page}
          scale={zoom}
          scroll={scroll}
          onScaleChange={(next) => onPositionChange({ page, zoom: next })}
        />
      </div>
    </div>
  );
});
