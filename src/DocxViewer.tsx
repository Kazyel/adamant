import { useEffect, useState } from 'react';
import { renderAsync } from 'docx-preview';
import type { HElement } from 'docx-preview';
import PreviewFrame, { previewDocument } from './PreviewFrame';
import { errorMessage } from './document';

export default function DocxViewer({ bytes }: { bytes: Uint8Array }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // No browsing context: even intermediate, unsanitized nodes cannot load resources.
    const inert = document.implementation.createHTMLDocument('DOCX conversion');
    const container = inert.createElement('div');
    const createNode = (value: HElement | Node | string): Node => {
      if (typeof value === 'string') return inert.createTextNode(value);
      if (value instanceof Node) return value;
      const { ns, tagName, className, style, children, ...properties } = value;
      if (tagName === '#comment') return inert.createComment(String(children?.[0] ?? ''));
      let element: Element | DocumentFragment;
      if (tagName === '#fragment') element = inert.createDocumentFragment();
      else if (ns) element = inert.createElementNS(ns, tagName);
      else element = inert.createElement(tagName);
      if (element instanceof Element) {
        if (className) element.setAttribute('class', className);
        if (typeof style === 'string') element.setAttribute('style', style);
        else if (style) Object.assign((element as HTMLElement).style, style);
        for (const [key, property] of Object.entries(properties)) {
          if (['id', 'title', 'colSpan', 'rowSpan'].includes(key) && property !== undefined) {
            Reflect.set(element, key, property);
          }
        }
      }
      for (const child of children ?? []) element.appendChild(createNode(child));
      return element;
    };

    void renderAsync(bytes, container, undefined, {
      h: createNode,
      useBase64URL: true,
      renderAltChunks: false,
      renderComments: false,
      experimental: false,
      debug: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
    }).then(() => {
      if (!cancelled) {
        setContent(previewDocument(container.innerHTML, '.docx-wrapper{padding:24px!important;background:#e8edf3!important}.docx{box-shadow:none!important;margin-bottom:24px!important}', true));
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(errorMessage(reason));
    });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [bytes]);

  if (error) return <div className="viewer-message error" role="alert"><h3>DOCX preview could not be loaded</h3><p>{error}</p><p>Open the original in an external application to inspect it.</p></div>;
  if (!content) return <div className="viewer-message" role="status">Rendering DOCX. You can continue writing in the Markdown buffer.</div>;
  return <PreviewFrame content={content} title="Isolated DOCX preview" />;
}
