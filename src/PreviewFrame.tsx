import DOMPurify from 'dompurify';
import { fontFaces } from './typography';

const previewPolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function previewDocument(html: string, styles = '', docx = false): string {
  // Keep DOCX's leading style elements inside the body during HTML parsing.
  const clean = DOMPurify.sanitize(docx ? `<div>${html}</div>` : html, {
    WHOLE_DOCUMENT: false,
    ADD_TAGS: docx ? ['style'] : [],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'link', 'meta', 'base'],
    FORBID_ATTR: ['href', 'xlink:href', 'srcset', 'target', 'action', 'formaction', ...(docx ? [] : ['style'])],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  // Only embedded raster images are rendered; filesystem and network URLs are not resolved.
  for (const image of clean.querySelectorAll('[src]')) {
    if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(image.getAttribute('src') ?? '')) {
      image.removeAttribute('src');
      image.setAttribute('alt', 'Image unavailable: only embedded raster images are allowed in M0.');
    }
  }
  const holder = document.createElement('template');
  holder.content.append(clean);
  const colorScheme = docx ? 'light' : 'dark';
  const surface = docx
    ? 'color:#223044;background:#fff;font-family:system-ui,sans-serif'
    : 'color:#e6e4ec;background:#101014;font-family:"Adamant Sans",sans-serif';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewPolicy}"><meta name="color-scheme" content="${colorScheme}"><style>${docx ? '' : fontFaces}html{color-scheme:${colorScheme}}body{margin:0;${surface}}${styles}</style></head><body>${holder.innerHTML}</body></html>`;
}

export default function PreviewFrame({ content, title }: { content: string; title: string }) {
  return <iframe className="preview-frame" title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={content} />;
}
