const frontmatter = /^\uFEFF?---[ \t]*\r?\n(?:[^\n]*\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function validatedMarkdownPrefix(source: string, validatedSource?: string): string {
  if (validatedSource === undefined) {
    return '';
  }
  const prefix = source.match(frontmatter)?.[0];
  const validatedPrefix = validatedSource.match(frontmatter)?.[0];
  if (!prefix || !validatedPrefix) {
    return '';
  }
  // Typing after an EOF delimiter adds only the header's original line ending.
  const matches =
    prefix === validatedPrefix ||
    (!validatedPrefix.endsWith('\n') &&
      prefix === validatedPrefix + validatedPrefix.match(/\r?\n/)![0]);
  return matches ? prefix : '';
}

export function joinMarkdownSource(prefix: string, body: string): string {
  // A delimiter at EOF needs a line boundary only once there is an edited body.
  const separator = prefix && body && !prefix.endsWith('\n') ? prefix.match(/\r?\n/)![0] : '';
  return prefix + separator + body;
}
