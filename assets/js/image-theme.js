const MIN_TEXT_CONTRAST = 4.5;
const MIN_STATE_DISTANCE = 0.16;
const MIN_IMAGE_CHROMA = 0.025;
const MIN_AUXILIARY_CHROMA = 0.01;
const LINK_CHROMA = { normal: 0.12, hover: 0.10, maximum: 0.18 };
const LINK_LIGHTNESS = {
  light: { normal: 0.48, hover: 0.56, neutralHover: 0.28 },
  dark: { normal: 0.76, hover: 0.84, neutralHover: 0.96 },
};

const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
const mix = (from, to, amount) => from.map((value, index) => clamp(value + (to[index] - value) * amount));
const hex = rgb => '#' + rgb.map(value => clamp(value).toString(16).padStart(2, '0')).join('');
const hueDistance = (first, second) => Math.min(Math.abs(first - second), 360 - Math.abs(first - second));

function linearChannel(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function rgbToOklab(rgb) {
  const [red, green, blue] = rgb.map(linearChannel);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * long + 0.7936177850 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.4285922050 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.8086757660 * short,
  ];
}

export function rgbToOklch(rgb) {
  const [l, a, b] = rgbToOklab(rgb);
  return { l, c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 };
}

function oklchToRgb(lightness, chroma, hue) {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short,
  ];
  return linear.map(value => clamp(255 * (value <= 0.0031308
    ? 12.92 * value
    : 1.055 * value ** (1 / 2.4) - 0.055)));
}

function squaredDistance(first, second) {
  const lightness = first[0] - second[0];
  const a = first[1] - second[1];
  const b = first[2] - second[2];
  return lightness * lightness + a * a + b * b;
}

function paletteColor(rgb, population) {
  const rounded = rgb.map(clamp);
  return { rgb: rounded, lch: rgbToOklch(rounded), population };
}

export function extractPalette(pixels) {
  const histogram = new Map();
  const whiteSum = [0, 0, 0];
  let whiteCount = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] < 125) continue;
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    if (red > 250 && green > 250 && blue > 250) {
      whiteSum[0] += red;
      whiteSum[1] += green;
      whiteSum[2] += blue;
      whiteCount++;
      continue;
    }
    // Group nearby RGB samples before perceptual clustering to keep 64px sampling cheap.
    const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    if (!histogram.has(key)) histogram.set(key, [0, 0, 0, 0]);
    const bin = histogram.get(key);
    bin[0] += red;
    bin[1] += green;
    bin[2] += blue;
    bin[3]++;
  }
  if (!histogram.size) {
    return whiteCount ? [paletteColor(whiteSum.map(value => value / whiteCount), whiteCount)] : [];
  }
  const samples = [...histogram].map(([key, bin]) => {
    const rgb = bin.slice(0, 3).map(value => value / bin[3]);
    const lab = rgbToOklab(rgb);
    // Favor hue diversity so dark/light shades do not consume every palette slot.
    lab[0] *= 0.05;
    return { key, rgb, lab, population: bin[3] };
  }).sort((first, second) => second.population - first.population || first.key - second.key);

  const centroids = [samples[0].lab.slice()];
  const count = Math.min(8, samples.length);
  // Weighted farthest-point initialization makes the result deterministic.
  while (centroids.length < count) {
    let chosen = null;
    let bestScore = 0;
    for (const sample of samples) {
      const nearest = Math.min(...centroids.map(center => squaredDistance(sample.lab, center)));
      const score = nearest * sample.population;
      if (score > bestScore) {
        chosen = sample;
        bestScore = score;
      }
    }
    if (!chosen) break;
    centroids.push(chosen.lab.slice());
  }
  const assignments = new Int16Array(samples.length).fill(-1);
  let groups;
  for (let step = 0; step < 16; step++) {
    groups = centroids.map(() => ({ lab: [0, 0, 0], rgb: [0, 0, 0], population: 0 }));
    let changed = false;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      let closest = 0;
      let distance = Infinity;
      for (let cluster = 0; cluster < centroids.length; cluster++) {
        const candidate = squaredDistance(sample.lab, centroids[cluster]);
        if (candidate < distance) {
          closest = cluster;
          distance = candidate;
        }
      }
      if (assignments[index] !== closest) changed = true;
      assignments[index] = closest;
      const group = groups[closest];
      group.population += sample.population;
      for (let channel = 0; channel < 3; channel++) {
        group.lab[channel] += sample.lab[channel] * sample.population;
        group.rgb[channel] += sample.rgb[channel] * sample.population;
      }
    }
    if (!changed) break;
    for (let cluster = 0; cluster < centroids.length; cluster++) {
      const group = groups[cluster];
      if (group.population) centroids[cluster] = group.lab.map(value => value / group.population);
    }
  }
  return groups.filter(group => group.population).map(group =>
    paletteColor(group.rgb.map(value => value / group.population), group.population)
  ).sort((first, second) => second.population - first.population);
}

export function luminance(rgb) {
  const linear = rgb.map(linearChannel);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function colorDistance(first, second) {
  return Math.sqrt(squaredDistance(rgbToOklab(first), rgbToOklab(second)));
}

export function selectSeed(palette) {
  if (!palette?.length) return null;
  const usable = palette.filter(color => color.lch.l >= 0.12 && color.lch.l <= 0.94);
  const chromatic = usable.filter(color => color.lch.c >= MIN_IMAGE_CHROMA);
  if (!chromatic.length) {
    return palette.reduce((best, color) => color.population > best.population ? color : best).rgb.slice();
  }
  // Sum squared distance from the neutral axis over neighboring hues. This avoids
  // penalizing a blue family just because quantization split it into several shades.
  const contribution = color => color.population * Math.min(color.lch.c, 0.18) ** 2;
  const families = chromatic.map(center => {
    const members = usable.filter(color => hueDistance(color.lch.h, center.lch.h) <= 15);
    const representatives = members.filter(color => color.lch.c >= MIN_IMAGE_CHROMA);
    return {
      score: members.reduce((sum, color) => sum + contribution(color), 0),
      color: representatives.reduce((best, color) => contribution(color) > contribution(best) ? color : best),
    };
  });
  return families.reduce((best, family) => family.score > best.score ? family : best).color.rgb.slice();
}

export function selectHoverSeed(palette, seed) {
  if (!palette?.length || !seed) return null;
  const primary = rgbToOklch(seed);
  const population = palette.reduce((sum, color) => sum + color.population, 0);
  const eligible = palette.filter(color => {
    const { c, h } = color.lch;
    return c >= MIN_AUXILIARY_CHROMA && color.population >= population * 0.04 && hueDistance(h, primary.h) >= 45;
  });
  if (!eligible.length) return null;
  // Muted images can carry a useful second hue below the primary-color cutoff.
  const preferred = eligible.filter(color => color.lch.c >= MIN_IMAGE_CHROMA);
  const candidates = preferred.length ? preferred : eligible;
  const score = color => colorDistance(seed, color.rgb) * Math.sqrt(color.population);
  return candidates.reduce((best, color) => score(color) > score(best) ? color : best).rgb.slice();
}

function gamutMappedTone(lightness, chroma, hue) {
  const error = (candidateChroma, rgb) => {
    const actual = rgbToOklch(rgb);
    const angle = (actual.h - hue) * Math.PI / 180;
    return Math.sqrt(Math.max(0, (actual.l - lightness) ** 2 + actual.c ** 2
      + candidateChroma ** 2 - 2 * actual.c * candidateChroma * Math.cos(angle)));
  };
  const requested = oklchToRgb(lightness, chroma, hue);
  // Reduce chroma at the sRGB boundary instead of letting channel clipping shift the hue.
  // The small tolerance allows for conversion to 8-bit RGB.
  if (error(chroma, requested) <= 0.005) return requested;
  let low = 0, high = chroma;
  for (let step = 0; step < 10; step++) {
    const candidateChroma = (low + high) / 2;
    const rgb = oklchToRgb(lightness, candidateChroma, hue);
    if (error(candidateChroma, rgb) <= 0.005) low = candidateChroma;
    else high = candidateChroma;
  }
  return oklchToRgb(lightness, low, hue);
}

function readableTone(lightness, chroma, hue, background) {
  const endpoint = contrast([0,0,0], background) >= contrast([255,255,255], background) ? 0 : 1;
  for (let step = 0; step <= 100; step++) {
    const candidateLightness = lightness + (endpoint - lightness) * step / 100;
    const candidate = gamutMappedTone(candidateLightness, chroma, hue);
    if (contrast(candidate, background) >= MIN_TEXT_CONTRAST) return candidate;
  }
  return endpoint === 0 ? [0,0,0] : [255,255,255];
}

export function buildAccents(seed, background, activeBackground = background) {
  const black = [0, 0, 0], white = [255, 255, 255];
  const target = contrast(black, activeBackground) >= contrast(white, activeBackground) ? black : white;
  let accent = target;
  for (let step = 0; step <= 100; step++) {
    accent = mix(seed, target, step / 100);
    if (contrast(accent, activeBackground) >= 4.5) break;
  }
  return {
    '--image-accent': hex(accent),
    '--image-avatar-ring': `rgb(${accent.join(' ')} / 16%)`,
    '--image-sidebar-end': hex(mix(background, seed, 0.06)),
  };
}

export function buildLinkAccents(seed, background, hoverSeed = null) {
  const black = [0, 0, 0], white = [255, 255, 255];
  const dark = contrast(white, background) > contrast(black, background);
  const tones = dark ? LINK_LIGHTNESS.dark : LINK_LIGHTNESS.light;
  const source = rgbToOklch(seed);
  const chromatic = source.c >= MIN_IMAGE_CHROMA;
  const auxiliary = hoverSeed ? rgbToOklch(hoverSeed) : source;
  const normalChroma = chromatic ? Math.max(LINK_CHROMA.normal, Math.min(source.c, LINK_CHROMA.maximum)) : 0;
  const hoverChroma = chromatic ? Math.max(LINK_CHROMA.hover, Math.min(auxiliary.c, LINK_CHROMA.maximum)) : 0;
  const hueAngle = (source.h - auxiliary.h) * Math.PI / 180;
  const hueSeparation = Math.sqrt(Math.max(0, normalChroma ** 2 + hoverChroma ** 2
    - 2 * normalChroma * hoverChroma * Math.cos(hueAngle)));
  // Close or absent auxiliary hues use a stronger tone of the image's primary hue.
  const tonalHover = !chromatic || !hoverSeed || hueSeparation < MIN_STATE_DISTANCE;
  const hoverHue = tonalHover ? source.h : auxiliary.h;
  const normal = readableTone(tones.normal, normalChroma, source.h, background);
  const hoverLightness = tonalHover ? tones.neutralHover : tones.hover;
  let hover = readableTone(hoverLightness, hoverChroma, hoverHue, background);
  // Test the final, gamut-mapped colors. Low-chroma hue differences can be invisible.
  if (chromatic && colorDistance(normal, hover) < MIN_STATE_DISTANCE) {
    hover = readableTone(tones.neutralHover, hoverChroma, source.h, background);
  }
  // Mid-gray custom surfaces can restrict the available text tones severely.
  if (colorDistance(normal, hover) < MIN_STATE_DISTANCE) {
    const extreme = dark ? white : black;
    if (colorDistance(normal, extreme) > colorDistance(normal, hover)) hover = extreme;
  }
  return {
    '--link-color': hex(normal),
    '--link-hover-color': hex(hover),
  };
}
