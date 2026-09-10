import { useDeferredValue, useMemo } from 'react';
import { marked } from 'marked';
import PreviewFrame, { previewDocument } from '../../shared/ui/PreviewFrame';
import { validatedMarkdownPrefix } from './markdownSource';

const readingStyles = `
  * { box-sizing: border-box; }
  html { min-height: 100%; background: hsl(240.000000 11.111111% 14.345412%); scrollbar-color: hsl(255.000000 8.450704% 33.500236%) hsl(240.000000 11.111111% 14.345412%); scrollbar-width: thin; }
  body { max-width: 816px; margin-inline: auto; padding: 56px 48px 96px; font-size: 17px; line-height: 1.6; overflow-wrap: anywhere; }
  body > :first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 { font-family: "Adamant Sans", sans-serif; color: hsl(257.142857 25.925926% 95.120941%); line-height: 1.25; font-weight: 700; margin-top: 1.7em; margin-bottom: .65em; }
  h1 { font-size: 36px; letter-spacing: -1.1px; }
  h2 { font-size: 27px; letter-spacing: -.6px; }
  h3 { font-size: 21px; letter-spacing: -.3px; }
  h4, h5, h6 { font-size: 17px; }
  p, ul, ol, pre, blockquote, table { margin-top: 0; margin-bottom: 1.35em; }
  ul, ol { padding-left: 1.6em; }
  li + li { margin-top: .3em; }
  li > ul, li > ol { margin-bottom: 0; }
  li::marker { color: hsl(261.428571 7.526882% 66.388706%); }
  strong { color: hsl(257.142857 25.925926% 95.120941%); }
  pre, code { font-family: "Adamant Mono", monospace; font-size: .9em; }
  code { padding: .15em .35em; border-radius: 3px; color: hsl(261.230769 76.470588% 84.640000%); background: hsl(240.000000 13.157895% 21.573647%); }
  pre { padding: 18px 20px; border: 1px solid hsl(240.000000 8.571429% 26.814118%); border-radius: 4px; background: hsl(240.000000 14.285714% 16.694588%); overflow: auto; white-space: pre; line-height: 1.75; }
  pre code { padding: 0; color: hsl(255.000000 17.391304% 91.687529%); background: transparent; font-size: inherit; }
  blockquote { margin-inline: 0; padding: 1px 20px; border-left: 2px solid hsl(260.000000 85.321101% 80.303059%); color: hsl(261.176471 11.724138% 73.797647%); }
  blockquote > :last-child { margin-bottom: 0; }
  table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid hsl(240.000000 8.571429% 26.814118%); padding: 10px 14px; text-align: left; }
  th { background: hsl(240.000000 12.903226% 19.043764%); color: hsl(255.000000 17.391304% 91.687529%); }
  tr:nth-child(even) { background: hsl(240.000000 14.285714% 16.694588%); }
  img { max-width: 100%; height: auto; }
  a { color: hsl(260.000000 85.321101% 80.303059%); text-decoration: underline; text-underline-offset: 3px; }
  hr { border: 0; border-top: 1px solid hsl(240.000000 8.571429% 26.814118%); margin-block: 2.5em; }
  ::selection { background: hsl(266.250000 22.222222% 33.861647%); color: #fff; }
  @media (max-width: 600px) {
    body { padding: 40px 24px 72px; }
    h1 { font-size: 32px; }
  }
`;

export default function MarkdownPreview({
  value,
  validatedSource,
}: {
  value: string;
  validatedSource?: string;
}) {
  const deferred = useDeferredValue(value);
  const prefix = validatedMarkdownPrefix(deferred, validatedSource);
  const markdown = deferred.slice(prefix.length);
  const content = useMemo(
    () => previewDocument(marked.parse(markdown, { async: false }), readingStyles),
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
      <PreviewFrame content={content} title="Sanitized Markdown preview" />
    </>
  );
}
