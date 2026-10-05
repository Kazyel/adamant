export const fontFamilies = {
  inter: { label: 'Inter', family: '"Adamant Sans", sans-serif' },
  libron: { label: 'Libron', family: '"Libron", Georgia, serif' },
  jetbrainsMono: { label: 'JetBrains Mono', family: '"Adamant Mono", monospace' },
};

export type FontFamily = keyof typeof fontFamilies | { local: string };

export function validFontFamily(value: unknown): value is FontFamily {
  if (typeof value === 'string') {
    return Object.hasOwn(fontFamilies, value);
  }
  if (!value || typeof value !== 'object' || !('local' in value)) {
    return false;
  }
  return (
    typeof value.local === 'string' &&
    value.local.trim().length > 0 &&
    !Array.from(value.local).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

export function resolveFontFamily(font: FontFamily): string {
  if (typeof font === 'string') {
    return fontFamilies[font].family;
  }
  if (!font.local.trim()) {
    return fontFamilies.inter.family;
  }
  // Quote one family name, including CSS punctuation, and keep iframe styles intact.
  const name = Array.from(font.local.trim(), (character) => {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || '"\\<>'.includes(character)) {
      return `\\${code.toString(16)} `;
    }
    return character;
  }).join('');
  return `"${name}", ${fontFamilies.inter.family}`;
}
