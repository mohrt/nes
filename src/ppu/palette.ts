/**
 * The 2C02's colours, worked out from the composite video signal it makes
 * (after Bisqwit's NTSC palette generator): each colour is a square wave
 * between two voltage levels, with its phase giving the hue. Decoding the
 * wave as a TV would gives YIQ, and from that RGB. The three emphasis bits
 * darken the signal during part of each colour cycle.
 *
 * Indexes are 9-bit: the 6-bit colour plus the emphasis bits (red, green, blue) above it.
 */

const BLACK = 0.518;
const WHITE = 1.962;
const ATTENUATION = 0.746;
const LOW_LEVELS = [0.35, 0.518, 0.962, 1.55];
const HIGH_LEVELS = [1.094, 1.506, 1.962, 1.962];

/** True during the half of the 12-step colour cycle where colour `hue`'s wave is high. */
const inPhase = (step: number, hue: number) => (hue + step + 8) % 12 < 6;

const channel = (value: number) => Math.max(0, Math.min(255, Math.round(255 * value)));

function colourRgb(index: number): number {
  const hue = index & 0x0f;
  const level = hue < 0x0e ? (index >> 4) & 3 : 1;
  const low = hue === 0 ? HIGH_LEVELS[level] : LOW_LEVELS[level];
  const high = hue < 0x0d ? HIGH_LEVELS[level] : LOW_LEVELS[level];
  let y = 0;
  let i = 0;
  let q = 0;
  for (let step = 0; step < 12; step++) {
    let signal = inPhase(step, hue) ? high : low;
    const emphasised =
      (index & 0x40 && inPhase(step, 12)) || (index & 0x80 && inPhase(step, 4)) || (index & 0x100 && inPhase(step, 8));
    if (emphasised) signal *= ATTENUATION;
    const v = (signal - BLACK) / (WHITE - BLACK) / 12;
    y += v;
    i += v * Math.cos((Math.PI / 6) * step);
    q += v * Math.sin((Math.PI / 6) * step);
  }
  const r = channel(y + 0.946882 * i + 0.623557 * q);
  const g = channel(y - 0.274788 * i - 0.635691 * q);
  const b = channel(y - 1.108545 * i + 1.709007 * q);
  return (r << 16) | (g << 8) | b;
}

/** 0xRRGGBB for each of the 512 colour and emphasis combinations. */
export const PALETTE_RGB = Uint32Array.from({ length: 512 }, (_, index) => colourRgb(index));

/** The same colours as canvas pixels (0xAABBGGRR on little-endian machines). */
export const PALETTE = Uint32Array.from(PALETTE_RGB, (rgb) => {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});
