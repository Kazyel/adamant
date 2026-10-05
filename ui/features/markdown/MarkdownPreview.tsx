import { useDeferredValue, useMemo } from 'react';
import { marked } from 'marked';
import PreviewFrame, { previewDocument } from '../../shared/ui/PreviewFrame';
import { validatedMarkdownPrefix } from './markdownSource';
import { resolveFontFamily } from '../../shared/styles/fontFamilies';
import { defaultEditorPreferences, type EditorPreferences } from '../interaction/types';

const readingStyles = `
  * { box-sizing: border-box; min-width: 0; max-width: 100%; white-space: normal; }
  html { width: 100%; min-height: 100%; background: var(--reading); scrollbar-width: none; }
  html::-webkit-scrollbar { display: none; }
  html::before, html::after { content: ''; position: fixed; left: 0; right: 0; height: 56px; z-index: 1; opacity: 0; pointer-events: none; }
  html::before { top: 0; background: linear-gradient(to bottom, var(--reading) 12%, transparent 100%); }
  html::after { bottom: 0; background: linear-gradient(to top, var(--reading) 12%, transparent 100%); }
  html[data-scroll-top]::before, html[data-scroll-bottom]::after { opacity: 1; }
  body { width: 100%; max-width: 896px; margin-inline: auto; padding: 56px 48px 96px; font-family: "Libron", Georgia, serif; font-size: 17px; line-height: 1.6; overflow-wrap: anywhere; }
  body > :first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 { color: var(--text); line-height: 1.25; font-weight: 700; margin-top: 1.7em; margin-bottom: .65em; }
  h1 { font-size: calc(36em / 17); letter-spacing: -.03em; }
  h2 { font-size: calc(27em / 17); letter-spacing: -.02em; }
  h3 { font-size: calc(21em / 17); letter-spacing: -.014em; }
  h4, h5, h6 { font-size: 1em; }
  p, ul, ol, pre, blockquote, table { margin-top: 0; margin-bottom: 1.35em; }
  ul, ol { padding-left: 1.6em; }
  li + li { margin-top: .3em; }
  li > ul, li > ol { margin-bottom: 0; }
  li::marker { color: var(--muted); }
  strong { color: var(--text); }
  pre, code { font-family: "Adamant Mono", monospace; font-size: .9em; }
  code { padding: .15em .35em; border-radius: 3px; color: var(--secondary-text); background: var(--raised); }
  pre { padding: 18px 20px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); overflow: auto; white-space: pre; line-height: 1.75; }
  pre * { white-space: pre; }
  pre code { padding: 0; color: var(--text); background: transparent; font-size: inherit; }
  blockquote { margin-inline: 0; padding: 1px 20px; border-left: 2px solid var(--secondary-text); color: var(--muted); }
  blockquote > :last-child { margin-bottom: 0; }
  table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; font-size: calc(14em / 17); }
  th, td { border: 1px solid var(--border); padding: 10px 14px; text-align: left; }
  th { background: var(--surface); color: var(--text); }
  tr:nth-child(even) { background: var(--surface); }
  img, svg, canvas { max-width: 100%; height: auto; }
  a[href] { color: var(--secondary-text); text-decoration: underline; text-underline-offset: 3px; }
  hr { border: 0; border-top: 1px solid var(--border); margin-block: 2.5em; }
  ::selection { background: var(--selection); color: var(--text); }
  @media (max-width: 600px) {
    body { padding: 40px 24px 72px; }
    h1 { font-size: calc(32em / 17); }
  }
`;

export default function MarkdownPreview({
  value,
  validatedSource,
  onOpenLink,
  anchor,
  onAnchorApplied,
  preferences = defaultEditorPreferences,
}: {
  value: string;
  validatedSource?: string;
  onOpenLink: (href: string) => void;
  anchor?: string;
  onAnchorApplied?: () => void;
  preferences?: EditorPreferences;
}) {
  const deferred = useDeferredValue(value);
  const prefix = validatedMarkdownPrefix(deferred, validatedSource);
  const markdown = deferred.slice(prefix.length);
  const fontFamily = resolveFontFamily(preferences.readingFont ?? 'libron');
  const fontSize = preferences.readingFontSize ?? 17;
  const content = useMemo(
    () =>
      previewDocument(marked.parse(markdown, { async: false }), {
        styles: `${readingStyles}body{font-family:${fontFamily};font-size:${fontSize}px}`,
      }),
    [markdown, fontFamily, fontSize],
  );
  if (!value.trim()) {
    return (
      <div className="empty-preview">
        <h3>Your preview appears here</h3>
        <p>
          Write Markdown in the buffer. Saving a Vault Note is explicit; standalone originals are
          never changed.
        </p>
      </div>
    );
  }
  return (
    <>
      {!prefix && /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(deferred) ? (
        <div className="pane-footer" role="status">
          Unvalidated or unclosed frontmatter is shown below. Save a Vault Note to validate
          metadata; validated metadata is kept outside the editable body.
        </div>
      ) : null}
      <PreviewFrame
        content={content}
        title="Sanitized Markdown preview"
        onOpenLink={onOpenLink}
        anchor={anchor}
        onAnchorApplied={onAnchorApplied}
      />
    </>
  );
}
