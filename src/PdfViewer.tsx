import { memo, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { errorMessage } from './document';

GlobalWorkerOptions.workerSrc = workerUrl;

function PdfPage({ document: pdf, number, scale }: { document: PDFDocumentProxy; number: number; scale: number }) {
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
    void pdf.getPage(number).then(async (loadedPage) => {
      page = loadedPage;
      if (cancelled) { page.cleanup(); return; }
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixels = viewport.width * viewport.height * ratio * ratio;
      if (pixels > 32_000_000) throw new Error('This page is too large at the selected zoom. Choose a smaller zoom or open the original externally.');
      const drawing = canvas.current!;
      drawing.width = Math.ceil(viewport.width * ratio);
      drawing.height = Math.ceil(viewport.height * ratio);
      drawing.style.width = `${viewport.width}px`;
      drawing.style.height = `${viewport.height}px`;
      surface.current!.style.width = `${viewport.width}px`;
      surface.current!.style.height = `${viewport.height}px`;
      text.current!.style.setProperty('--total-scale-factor', String(scale * viewport.userUnit));
      render = page.render({ canvas: drawing, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text.current!, viewport });
      void layer.render().catch((reason: unknown) => {
        if (!cancelled) setTextError(`Text selection unavailable: ${errorMessage(reason)}`);
      });
      await render.promise;
      if (!cancelled) setLoading(false);
    }).catch((reason: unknown) => {
      if (!cancelled) { setError(errorMessage(reason)); setLoading(false); }
    });
    return () => {
      cancelled = true;
      layer?.cancel();
      render?.cancel();
      if (render) void render.promise.then(() => page?.cleanup(), () => page?.cleanup());
      else page?.cleanup();
    };
  }, [pdf, number, scale]);

  return <>
    {loading ? <p className="pdf-page-status" role="status">Rendering page {number}…</p> : null}
    {error ? <p className="viewer-message error" role="alert">{error}</p> : null}
    {textError ? <p className="viewer-message error" role="status">{textError}</p> : null}
    <div className="pdf-page" ref={surface} style={{ visibility: loading || error ? 'hidden' : 'visible' }}>
      <canvas ref={canvas} aria-label={`PDF page ${number}`} />
      <div className="textLayer" ref={text} />
    </div>
  </>;
}

export default memo(function PdfViewer({ bytes }: { bytes: Uint8Array }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);

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
    void task.promise.then((loaded) => {
      if (!cancelled) setPdf(loaded);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });
    return () => {
      cancelled = true;
      void task.destroy().catch((reason: unknown) => console.error('PDF resource cleanup failed', reason));
    };
  }, [bytes]);

  if (error) return <div className="viewer-message error" role="alert"><h3>PDF could not be loaded</h3><p>{error}</p><p>For encrypted or unsupported PDFs, open the original in an external application.</p></div>;
  if (!pdf) return <div className="viewer-message" role="status">Loading PDF. You can continue writing in the Markdown buffer.</div>;
  return <div className="pdf-viewer">
    <div className="pdf-toolbar" aria-label="PDF controls">
      <button type="button" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
      <span aria-live="polite">Page {page} of {pdf.numPages}</span>
      <button type="button" disabled={page === pdf.numPages} onClick={() => setPage((value) => value + 1)}>Next</button>
      <label>Zoom <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
        <option value={0.5}>50%</option><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option>
      </select></label>
    </div>
    <div className="pdf-scroll" tabIndex={0} aria-label="PDF page; scroll to read">
      <PdfPage key={`${page}:${zoom}`} document={pdf} number={page} scale={zoom} />
    </div>
  </div>;
});
