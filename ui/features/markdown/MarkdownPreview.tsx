import { useDeferredValue, useMemo } from 'react';
import { marked } from 'marked';
import PreviewFrame, { previewDocument } from '../../shared/ui/PreviewFrame';
import { validatedMarkdownPrefix } from './markdownSource';

const readingStyles = `
  * { box-sizing: border-box; min-width: 0; max-width: 100%; white-space: normal; }
  html { width: 100%; min-height: 100%; background: #1c1c1c; scrollbar-color: #484848 #1c1c1c; scrollbar-width: thin; }
  body { width: 100%; max-width: 816px; margin-inline: auto; padding: 56px 48px 96px; font-size: 17px; line-height: 1.6; overflow-wrap: anywhere; }
  body > :first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 { font-family: "Adamant Sans", sans-serif; color: #ededed; line-height: 1.25; font-weight: 700; margin-top: 1.7em; margin-bottom: .65em; }
  h1 { font-size: 36px; letter-spacing: -1.1px; }
  h2 { font-size: 27px; letter-spacing: -.6px; }
  h3 { font-size: 21px; letter-spacing: -.3px; }
  h4, h5, h6 { font-size: 17px; }
  p, ul, ol, pre, blockquote, table { margin-top: 0; margin-bottom: 1.35em; }
  ul, ol { padding-left: 1.6em; }
  li + li { margin-top: .3em; }
  li > ul, li > ol { margin-bottom: 0; }
  li::marker { color: #a6a6a6; }
  strong { color: #ededed; }
  pre, code { font-family: "Adamant Mono", monospace; font-size: .9em; }
  code { padding: .15em .35em; border-radius: 3px; color: #d4d4d4; background: #303030; }
  pre { padding: 18px 20px; border: 1px solid #3a3a3a; border-radius: 4px; background: #232323; overflow: auto; white-space: pre; line-height: 1.75; }
  pre * { white-space: pre; }
  pre code { padding: 0; color: #ededed; background: transparent; font-size: inherit; }
  blockquote { margin-inline: 0; padding: 1px 20px; border-left: 2px solid #d4d4d4; color: #a6a6a6; }
  blockquote > :last-child { margin-bottom: 0; }
  table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #3a3a3a; padding: 10px 14px; text-align: left; }
  th { background: #232323; color: #ededed; }
  tr:nth-child(even) { background: #232323; }
  img, svg, canvas { max-width: 100%; height: auto; }
  a[href] { color: #d4d4d4; text-decoration: underline; text-underline-offset: 3px; }
  hr { border: 0; border-top: 1px solid #3a3a3a; margin-block: 2.5em; }
  ::selection { background: #484848; color: #ededed; }
  @media (max-width: 600px) {
    body { padding: 40px 24px 72px; }
    h1 { font-size: 32px; }
  }
`;

export default function MarkdownPreview({
  value,
  validatedSource,
  onOpenLink,
  anchor,
  onAnchorApplied,
}: {
  value: string;
  validatedSource?: string;
  onOpenLink: (href: string) => void;
  anchor?: string;
  onAnchorApplied?: () => void;
}) {
  const deferred = useDeferredValue(value);
  const prefix = validatedMarkdownPrefix(deferred, validatedSource);
  const markdown = deferred.slice(prefix.length);
  const content = useMemo(
    () => previewDocument(marked.parse(markdown, { async: false }), { styles: readingStyles }),
    [markdown],
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
