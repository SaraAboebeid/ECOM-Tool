/**
 * Ink colour for text or an icon drawn on top of a coloured fill.
 *
 * Picked by measured contrast rather than fixed, so it stays correct if the
 * palette changes. Every fill in the neon palette fails against white ink - the
 * yellow at 1.12:1 and the cyan at 1.28:1 are effectively invisible - while a
 * dark ink clears 4.5:1 on all of them and reaches 16:1 on the brightest.
 *
 * Shared between the map nodes and the Sankey, which draw labels on the same
 * fills and so hit the same failure.
 */

export const relativeLuminance = (hex: string): number => {
  const h = hex.replace('#', '').slice(0, 6);
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

/** Praxeti Midnight Mirage, the same ink the console uses on light surfaces. */
const DARK_INK = '#001F3F';

export const inkOn = (fill: string): string => {
  const contrast = (a: number, b: number) =>
    (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const bg = relativeLuminance(fill);
  // 1 is the luminance of white, so the second term is the contrast of white
  // ink on this fill.
  return contrast(bg, relativeLuminance(DARK_INK)) >= contrast(bg, 1)
    ? DARK_INK
    : '#F6F7ED';
};

export default inkOn;
