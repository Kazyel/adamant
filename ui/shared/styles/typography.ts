import sans from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';
import sansExtended from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?inline';
import sansItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?inline';
import sansExtendedItalic from '@fontsource-variable/inter/files/inter-latin-ext-wght-italic.woff2?inline';
import heading from '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?inline';
import headingExtended from '@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2?inline';
import mono from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline';

// Data URLs also work inside the isolated Markdown frame without relaxing its CSP.
export const fontFaces = `
  @font-face { font-family: "Adamant Sans"; src: url("${sans}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Adamant Sans"; src: url("${sansExtended}") format("woff2"); font-style: normal; font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Adamant Sans"; src: url("${sansItalic}") format("woff2"); font-style: italic; font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Adamant Sans"; src: url("${sansExtendedItalic}") format("woff2"); font-style: italic; font-weight: 100 900; font-display: swap; }
  @font-face { font-family: "Adamant Heading"; src: url("${headingExtended}") format("woff2"); font-style: normal; font-weight: 200 800; font-display: swap; unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
  @font-face { font-family: "Adamant Heading"; src: url("${heading}") format("woff2"); font-style: normal; font-weight: 200 800; font-display: swap; }
  @font-face { font-family: "Adamant Mono"; src: url("${mono}") format("woff2"); font-style: normal; font-weight: 100 800; font-display: swap; }
`;
