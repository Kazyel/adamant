import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import type { HElement } from 'docx-preview';
import { previewDocument } from '../../shared/ui/PreviewFrame';
import { errorMessage } from '../../shared/errors';
import { paginateDocx } from './paginateDocx';
import { createZoomTransition, listenForZoomWheel } from './zoomWheel';
import LoadingIndicator from '../../shared/ui/LoadingIndicator';

function applyElementProperties(element: Element, value: HElement) {
  const { className, style } = value;

  if (className) {
    element.setAttribute('class', className);
  }
  if (typeof style === 'string') {
    element.setAttribute('style', style);
  } else if (style) {
    Object.assign((element as HTMLElement).style, style);
  }

  for (const key of ['id', 'title', 'colSpan', 'rowSpan']) {
    const property: unknown = value[key];

    if (property !== undefined) {
      Reflect.set(element, key, property);
    }
  }
}

function createInertNode(inert: Document, value: HElement | Node | string): Node {
  if (typeof value === 'string') {
    return inert.createTextNode(value);
  }
  if (value instanceof Node) {
    return value;
  }

  const { ns, tagName, children } = value;

  if (tagName === '#comment') {
    const comment = children?.[0];

    return inert.createComment(typeof comment === 'string' ? comment : '');
  }

  let element: Element | DocumentFragment;

  if (tagName === '#fragment') {
    element = inert.createDocumentFragment();
  } else if (ns) {
    element = inert.createElementNS(ns, tagName);
  } else {
    element = inert.createElement(tagName);
  }

  if (element instanceof Element) {
    applyElementProperties(element, value);
  }

  for (const child of children ?? []) {
    element.appendChild(createInertNode(inert, child));
  }

  return element;
}

export default function DocxViewer({
  bytes,
  scrollTop = 0,
  onScrollTopChange,
}: {
  bytes: Uint8Array;
  scrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const restorePosition = useEffectEvent((surface: Element) => {
    surface.scrollTop = Number.isFinite(scrollTop)
      ? Math.max(0, Math.min(scrollTop, surface.scrollHeight - surface.clientHeight))
      : 0;
  });
  const reportPosition = useEffectEvent((surface: Element) => {
    onScrollTopChange?.(
      Math.max(0, Math.min(surface.scrollTop, surface.scrollHeight - surface.clientHeight)),
    );
  });

  useLayoutEffect(() => {
    const iframe = frame.current;
    if (!iframe || !content) {
      return;
    }
    let cancelled = false;
    let release: (() => void) | undefined;
    const loaded = () => {
      release?.();
      const document = iframe.contentDocument;
      const surface = document?.scrollingElement;
      const view = document?.defaultView;
      if (!document || !surface || !view) {
        return;
      }
      let restored = false;
      let ready = false;
      let zoom = 1;
      let targetZoom = 1;
      let width = 0;
      let height = 0;
      let left = 0;
      let releaseZoom: (() => void) | undefined;
      const canvas = document.createElement('div');
      const extent = document.createElement('div');
      Object.assign(canvas.style, {
        position: 'absolute',
        top: '0',
        transformOrigin: 'top left',
      });
      Object.assign(extent.style, { position: 'relative', overflow: 'hidden' });
      document.documentElement.style.overflowAnchor = 'none';
      const scale = () => {
        const scaledWidth = width * zoom;
        const viewportWidth = surface.clientWidth;
        left = Math.max(0, (viewportWidth - scaledWidth) / 2);
        extent.style.width = `${Math.max(viewportWidth, scaledWidth)}px`;
        extent.style.height = `${height * zoom}px`;
        canvas.style.left = `${left}px`;
        canvas.style.transform = `scale(${zoom})`;
      };
      const measure = () => {
        width = Math.max(
          surface.clientWidth,
          ...Array.from(
            document.querySelectorAll<HTMLElement>('section.docx'),
            (page) => page.offsetWidth + 48,
          ),
        );
        canvas.style.width = `${width}px`;
        height = canvas.scrollHeight;
        scale();
      };
      const restore = () => {
        if (cancelled || !ready || !iframe.clientHeight) {
          return;
        }
        if (restored) {
          measure();
          return;
        }
        paginateDocx(document);
        // Keep page layout and selectable text intact while zoom changes only their transform.
        canvas.append(...document.body.childNodes);
        extent.append(canvas);
        document.body.append(extent);
        measure();
        restorePosition(surface);
        restored = true;
        const transition = createZoomTransition(view, 1, (nextZoom, event) => {
          const x = event?.clientX ?? surface.clientWidth / 2;
          const y = event?.clientY ?? surface.clientHeight / 2;
          const anchorX = (surface.scrollLeft + x - left) / zoom;
          const anchorY = (surface.scrollTop + y) / zoom;
          zoom = nextZoom;
          scale();
          surface.scrollLeft = anchorX * zoom + left - x;
          surface.scrollTop = anchorY * zoom - y;
        });
        const stopZoom = listenForZoomWheel(document, 1, (next, event) => {
          targetZoom = next;
          transition.zoomTo(next, event);
        });
        releaseZoom = () => {
          stopZoom();
          transition.dispose();
        };
      };
      const report = () => {
        // Animation scroll events stay local; persist the settled position once.
        if (restored && iframe.clientHeight && zoom === targetZoom) {
          reportPosition(surface);
        }
      };
      // Hidden previews acquire a viewport only when the reading pane becomes visible.
      const observer = new ResizeObserver(restore);
      void Promise.all([
        document.fonts.ready,
        ...Array.from(document.images, (image) => image.decode().catch(() => {})),
      ]).then(() => {
        if (cancelled) {
          return;
        }
        ready = true;
        restore();
        observer.observe(iframe);
      });
      document.addEventListener('scroll', report, { passive: true });
      release = () => {
        observer.disconnect();
        releaseZoom?.();
        document.removeEventListener('scroll', report);
      };
    };
    iframe.addEventListener('load', loaded);
    return () => {
      cancelled = true;
      iframe.removeEventListener('load', loaded);
      release?.();
    };
  }, [content]);

  useEffect(() => {
    let cancelled = false;
    // No browsing context: even intermediate, unsanitized nodes cannot load resources.
    const inert = document.implementation.createHTMLDocument('DOCX conversion');
    const container = inert.createElement('div');

    void renderAsync(bytes, container, undefined, {
      h: (value) => createInertNode(inert, value),
      useBase64URL: true,
      renderAltChunks: false,
      renderComments: false,
      experimental: false,
      debug: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
    })
      .then(() => {
        if (!cancelled) {
          setContent(
            previewDocument(container.innerHTML, {
              styles:
                'body{background:hsl(212.727273 31.428571% 93.675294%)!important}.docx-wrapper{padding:24px!important;background:hsl(212.727273 31.428571% 93.675294%)!important}.docx{box-shadow:0 2px 8px #22304426!important;margin-bottom:24px!important}',
              docx: true,
            }),
          );
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [bytes]);

  if (error) {
    return (
      <div className="viewer-message error" role="alert">
        <h3>DOCX preview could not be loaded</h3>
        <p>{error}</p>
        <p>Open the original in an external application to inspect it.</p>
      </div>
    );
  }
  if (!content) {
    return (
      <div className="viewer-message">
        <LoadingIndicator label="Rendering DOCX" />
      </div>
    );
  }
  // Parent access handles pagination and scroll state; scripts remain forbidden by sandbox and CSP.
  return (
    <iframe
      ref={frame}
      className="preview-frame"
      title="Isolated DOCX preview"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={content}
    />
  );
}
