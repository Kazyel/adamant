import { useDeferredValue, useMemo } from 'react';
import { marked } from 'marked';
import PreviewFrame, { previewDocument } from './PreviewFrame';

const readingStyles = `
  * { box-sizing: border-box; }
  html { min-height: 100%; background: #101014; scrollbar-color: #44414d #101014; scrollbar-width: thin; }
  body { max-width: 816px; margin-inline: auto; padding: 56px 48px 96px; font-size: 17px; line-height: 1.6; overflow-wrap: anywhere; }
  body > :first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 { font-family: "Adamant Sans", sans-serif; color: #f0eef5; line-height: 1.25; font-weight: 700; margin-top: 1.7em; margin-bottom: .65em; }
  h1 { font-size: 36px; letter-spacing: -1.1px; }
  h2 { font-size: 27px; letter-spacing: -.6px; }
  h3 { font-size: 21px; letter-spacing: -.3px; }
  h4, h5, h6 { font-size: 17px; }
  p, ul, ol, pre, blockquote, table { margin-top: 0; margin-bottom: 1.35em; }
  ul, ol { padding-left: 1.6em; }
  li + li { margin-top: .3em; }
  li > ul, li > ol { margin-bottom: 0; }
  li::marker { color: #a09ba9; }
  strong { color: #f0eef5; }
  pre, code { font-family: "Adamant Mono", monospace; font-size: .9em; }
  code { padding: .15em .35em; border-radius: 3px; color: #cbb4f5; background: #21212b; }
  pre { padding: 18px 20px; border: 1px solid #303039; border-radius: 4px; background: #15151c; overflow: auto; white-space: pre; line-height: 1.75; }
  pre code { padding: 0; color: #e6e4ec; background: transparent; font-size: inherit; }
  blockquote { margin-inline: 0; padding: 1px 20px; border-left: 2px solid #b99af7; color: #b4aebf; }
  blockquote > :last-child { margin-bottom: 0; }
  table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #303039; padding: 10px 14px; text-align: left; }
  th { background: #1b1b23; color: #e6e4ec; }
  tr:nth-child(even) { background: #15151c; }
  img { max-width: 100%; height: auto; }
  a { color: #b99af7; text-decoration: underline; text-underline-offset: 3px; }
  hr { border: 0; border-top: 1px solid #303039; margin-block: 2.5em; }
  ::selection { background: #463858; color: #fff; }
  @media (max-width: 600px) {
    body { padding: 40px 24px 72px; }
    h1 { font-size: 32px; }
  }
`;

export default function MarkdownPreview({ value }: { value: string }) {
  const deferred = useDeferredValue(value);
  const content = useMemo(() => previewDocument(marked.parse(deferred, { async: false }), readingStyles), [deferred]);
  if (!value.trim()) {
    return <div className="empty-preview"><h3>Your preview appears here</h3><p>Write Markdown in the buffer or open a local .md file. The original file is never changed.</p></div>;
  }
  return <PreviewFrame content={content} title="Sanitized Markdown preview" />;
}
