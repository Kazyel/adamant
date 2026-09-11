import DOMPurify from 'dompurify';
import { useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react';
import { fontFaces } from '../styles/typography';

const previewPolicy =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function isSafeLink(href: string): boolean {
  if (!href || hasControlCharacter(href)) {
    return false;
  }
  try {
    return /^(?:https?|mailto):$/.test(new URL(href, 'https://preview.invalid/').protocol);
  } catch {
    return false;
  }
}

function prepareMarkdownLinks(clean: DocumentFragment) {
  for (const link of clean.querySelectorAll('[href]')) {
    const href = link.getAttribute('href')?.trim() ?? '';
    if (
      link.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      link.localName === 'a' &&
      isSafeLink(href)
    ) {
      link.setAttribute('href', href);
    } else {
      link.removeAttribute('href');
    }
  }
}

function assignHeadingIds(clean: DocumentFragment) {
  const ids = new Map<string, number>();
  const assignId = (element: Element, base: string) => {
    let id = base;
    let suffix = ids.get(base) ?? 1;
    while (ids.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    element.id = id;
    ids.set(base, suffix);
    ids.set(id, 1);
  };
  // Reserve explicit IDs before generating slugs, including IDs later in the document.
  const explicitIds = clean.querySelectorAll('[id]');
  for (const element of explicitIds) {
    if (!element.id || /\s/u.test(element.id) || hasControlCharacter(element.id)) {
      element.removeAttribute('id');
    } else {
      ids.set(element.id, 1);
    }
  }
  const assigned = new Set<string>();
  for (const element of explicitIds) {
    if (element.id) {
      if (assigned.has(element.id)) {
        assignId(element, element.id);
      }
      assigned.add(element.id);
    }
  }
  for (const heading of clean.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (!heading.id) {
      const slug = (heading.textContent ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
        .replace(/\s+/gu, '-');
      assignId(heading, slug || 'section');
    }
  }
}

export function previewDocument(
  html: string,
  { styles = '', docx = false }: { styles?: string; docx?: boolean } = {},
): string {
  // Keep DOCX's leading style elements inside the body during HTML parsing.
  const clean = DOMPurify.sanitize(docx ? `<div>${html}</div>` : html, {
    WHOLE_DOCUMENT: false,
    ADD_TAGS: docx ? ['style'] : [],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'video',
      'audio',
      'link',
      'meta',
      'base',
      ...(docx ? [] : ['style']),
    ],
    FORBID_ATTR: [
      ...(docx ? ['href'] : ['download', 'ping', 'hspace', 'vspace', 'border', 'nonce']),
      'xlink:href',
      'srcset',
      'target',
      'action',
      'formaction',
      ...(docx ? [] : ['style']),
    ],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  if (!docx) {
    prepareMarkdownLinks(clean);
    assignHeadingIds(clean);
  }
  // Only embedded raster images are rendered; filesystem and network URLs are not resolved.
  for (const image of clean.querySelectorAll('[src]')) {
    if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(image.getAttribute('src')!)) {
      image.removeAttribute('src');
      image.setAttribute(
        'alt',
        'Image unavailable: only embedded raster images are allowed in M0.',
      );
    }
  }
  const holder = document.createElement('template');
  holder.content.append(clean);
  const colorScheme = docx ? 'light' : 'dark';
  const surface = docx
    ? 'color:#223044;background:#fff;font-family:system-ui,sans-serif'
    : 'color:#ededed;background:#1c1c1c;font-family:"Adamant Sans",sans-serif';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${previewPolicy}"><meta name="color-scheme" content="${colorScheme}"><style>${docx ? '' : fontFaces}html{color-scheme:${colorScheme}}body{margin:0;${surface}}${styles}</style></head><body>${holder.innerHTML}</body></html>`;
}

// This literal runs only in the opaque Markdown frame; it has no parent-scope dependencies.
// Its SHA-256 must also be allowed by the production CSP in native/tauri.conf.json.
const markdownBridge = `
(() => {
  const token = document.currentScript.nonce;
  let ready = false;
  let pending = null;
  const send = (type, values = {}) =>
    parent.postMessage({ token, type, ...values }, '*');
  const scrollToAnchor = (fragment) => {
    let id = fragment.replace(/^#/, '');
    try { id = decodeURIComponent(id); } catch {}
    const surface = document.scrollingElement;
    if (!surface) return;
    if (!id) {
      surface.scrollTop = 0;
      return;
    }
    const target = document.getElementById(id) ||
      document.querySelector('a[name="' + CSS.escape(id) + '"]');
    if (target) surface.scrollTop += target.getBoundingClientRect().top;
  };
  const applyAnchor = () => {
    if (!ready || !pending) return;
    if (!innerHeight) {
      addEventListener('resize', applyAnchor);
      return;
    }
    removeEventListener('resize', applyAnchor);
    const request = pending;
    pending = null;
    scrollToAnchor(request.anchor);
    send('anchor-applied', request);
  };
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || typeof data !== 'object' ||
        data.token !== token || data.type !== 'anchor' ||
        !Number.isSafeInteger(data.request) ||
        (data.anchor !== null && typeof data.anchor !== 'string')) return;
    pending = data.anchor === null ? null : { request: data.request, anchor: data.anchor };
    removeEventListener('resize', applyAnchor);
    applyAnchor();
  });
  const activate = (event) => {
    const link = event.target?.closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    if (event.type === 'auxclick' && event.button !== 1) return;
    const href = link.getAttribute('href');
    if (href.startsWith('#')) scrollToAnchor(href);
    else send('link', { href });
  };
  document.addEventListener('click', activate, true);
  document.addEventListener('auxclick', activate, true);
  addEventListener('load', () => {
    void document.fonts.ready.then(() => {
      ready = true;
      send('ready');
      applyAnchor();
    });
  }, { once: true });
})();
`;

type BridgeMessage = { token: string; type: string; [key: string]: unknown };

function isBridgeMessage(value: unknown): value is BridgeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof value.token === 'string' &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

export default function PreviewFrame({
  content,
  title,
  onOpenLink,
  anchor,
  onAnchorApplied,
}: {
  content: string;
  title: string;
  onOpenLink?: (href: string) => void;
  anchor?: string;
  onAnchorApplied?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const readyToken = useRef<string | null>(null);
  const sequence = useRef(0);
  const pending = useRef<{ token: string; request: number; anchor: string } | null>(null);
  const interactive = onOpenLink !== undefined;
  const preview = useMemo(() => {
    const token = crypto.randomUUID();
    if (!interactive) {
      return { token, source: content };
    }
    // Only the trusted policy and final body boundary of previewDocument are replaced.
    const policy = previewPolicy.replace("script-src 'none'", `script-src 'nonce-${token}'`);
    const source = content
      .replace(previewPolicy, policy)
      .replace(
        '</body></html>',
        `<script nonce="${token}">${markdownBridge}</script></body></html>`,
      );
    return { token, source };
  }, [content, interactive]);
  const requestAnchor = useEffectEvent(() => {
    const target = frame.current?.contentWindow;
    if (!target || readyToken.current !== preview.token) {
      return;
    }
    const request = ++sequence.current;
    pending.current = anchor === undefined ? null : { token: preview.token, request, anchor };
    // Opaque origins require '*'; the recipient is the owned frame and checks this token.
    target.postMessage(
      { token: preview.token, type: 'anchor', request, anchor: anchor ?? null },
      '*',
    );
  });
  const openLink = useEffectEvent((href: unknown) => {
    if (typeof href === 'string' && !href.startsWith('#') && isSafeLink(href)) {
      onOpenLink?.(href);
    }
  });
  const acknowledgeAnchor = useEffectEvent((message: BridgeMessage) => {
    const request = pending.current;
    if (
      request?.token === preview.token &&
      message.request === request.request &&
      message.anchor === request.anchor &&
      anchor === request.anchor
    ) {
      pending.current = null;
      onAnchorApplied?.();
    }
  });

  useLayoutEffect(() => {
    if (!interactive) {
      return;
    }
    const receive = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        event.source !== frame.current?.contentWindow ||
        !isBridgeMessage(message) ||
        message.token !== preview.token
      ) {
        return;
      }
      switch (message.type) {
        case 'ready':
          if (readyToken.current !== preview.token) {
            readyToken.current = preview.token;
            requestAnchor();
          }
          break;
        case 'link':
          openLink(message.href);
          break;
        case 'anchor-applied':
          acknowledgeAnchor(message);
          break;
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      readyToken.current = null;
      pending.current = null;
    };
  }, [preview.token, interactive]);

  useLayoutEffect(() => {
    requestAnchor();
  }, [anchor, preview.token]);
  return (
    <iframe
      key={interactive ? 'markdown' : 'inert'}
      ref={frame}
      className="preview-frame"
      title={title}
      sandbox={interactive ? 'allow-scripts' : ''}
      referrerPolicy="no-referrer"
      srcDoc={preview.source}
    />
  );
}
