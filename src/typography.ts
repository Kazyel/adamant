import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';
import interItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?inline';
import mono from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline';

// Data URLs also work inside the isolated Markdown frame without relaxing its CSP.
export const fontFaces = `
  @font-face { font-family: "Adamant Sans"; src: url("${inter}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Adamant Sans"; src: url("${interItalic}") format("woff2"); font-style: italic; font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Adamant Mono"; src: url("${mono}") format("woff2"); font-style: normal; font-weight: 100 800; font-display: swap; }
`;
