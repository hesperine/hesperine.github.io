import { extractPalette, buildAccents, buildLinkAccents, selectSeed, selectHoverSeed } from './image-theme.js';

const linkProperties = ['--link-color', '--link-hover-color'];
const properties = ['--image-accent', '--image-avatar-ring', '--image-sidebar-end', ...linkProperties];

function surfaceColor(element) {
  const ancestors = [];
  for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
  let background = [255, 255, 255];
  for (const node of ancestors) {
    const match = getComputedStyle(node).backgroundColor.match(/^rgba?\(([^)]+)\)$/);
    if (!match) continue;
    const values = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    const opacity = values[3] ?? 1;
    background = background.map((value, index) => Math.round(value * (1 - opacity) + values[index] * opacity));
  }
  return background;
}

async function extract(url, circular) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  let timer;
  try {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Image decode timed out')), 8000); }),
    ]);
    if (!image.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    if (circular) {
      // Match the centered square crop and circular mask of Chirpy's avatar.
      context.beginPath(); context.arc(32, 32, 32, 0, Math.PI * 2); context.clip();
      const edge = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, (image.naturalWidth - edge) / 2, (image.naturalHeight - edge) / 2, edge, edge, 0, 0, 64, 64);
    } else {
      context.drawImage(image, 0, 0, 64, 64);
    }
    const pixels = context.getImageData(0, 0, 64, 64).data;
    if (!pixels.some((value, index) => index % 4 === 3 && value >= 125)) return null;
    const palette = extractPalette(pixels);
    const seed = selectSeed(palette);
    return seed ? { seed, hoverSeed: selectHoverSeed(palette, seed) } : null;
  } finally { clearTimeout(timer); }
}

function initialize() {
  const root = document.documentElement;
  const sidebar = document.getElementById('sidebar');
  const script = document.getElementById('image-accents');
  if (!sidebar || !script) return;
  let seed = null, hoverSeed = null, request = 0, scheduled = false, avatar = null;
  const previousLinkColors = new Map();

  function apply() {
    if (!seed) {
      properties.forEach(property => root.style.removeProperty(property));
      for (const [link, previous] of previousLinkColors) {
        for (const [property, saved] of Object.entries(previous)) {
          if (saved.value) link.style.setProperty(property, saved.value, saved.priority);
          else link.style.removeProperty(property);
        }
      }
      previousLinkColors.clear();
      return;
    }
    const activeLink = sidebar.querySelector('.nav-item.active .nav-link');
    const roles = buildAccents(seed, surfaceColor(sidebar), surfaceColor(activeLink || sidebar));
    for (const [property, value] of Object.entries(roles)) root.style.setProperty(property, value);
    const colorsBySurface = new Map();
    const linkRoles = background => {
      const key = background.join(',');
      if (!colorsBySurface.has(key)) {
        colorsBySurface.set(key, buildLinkAccents(seed, background, hoverSeed));
      }
      return colorsBySurface.get(key);
    };
    for (const [property, value] of Object.entries(linkRoles(surfaceColor(document.querySelector('main') || document.body)))) {
      root.style.setProperty(property, value);
    }
    // Category headers, breadcrumbs and callouts can sit on different surfaces.
    // Override the theme's shared link token, leaving explicit component text intact.
    for (const link of document.querySelectorAll('a[href]')) {
      if (!previousLinkColors.has(link)) previousLinkColors.set(link, Object.fromEntries(linkProperties.map(property => [property, {
        value: link.style.getPropertyValue(property),
        priority: link.style.getPropertyPriority(property),
      }])));
      for (const [property, value] of Object.entries(linkRoles(surfaceColor(link)))) {
        link.style.setProperty(property, value);
      }
    }
  }

  function sources() {
    const image = sidebar.querySelector('#avatar img');
    const icon = document.querySelector('link[rel~="icon"][type="image/png"]') || document.querySelector('link[rel~="icon"]');
    const candidates = {
      avatar: image ? { kind: 'avatar', url: image.complete ? image.currentSrc || image.src : image.src } : null,
      favicon: icon ? { kind: 'favicon', url: icon.href } : null,
    };
    const order = script.dataset.source === 'favicon' ? ['favicon', 'avatar'] : ['avatar', 'favicon'];
    return order.map(kind => candidates[kind]).filter(source => source?.url);
  }

  async function update() {
    const current = ++request;
    root.dataset.imageAccents = 'loading';
    for (const source of sources()) {
      try {
        const extracted = await extract(source.url, source.kind === 'avatar');
        if (current !== request) return;
        if (!extracted) continue;
        seed = extracted.seed; hoverSeed = extracted.hoverSeed; apply();
        root.dataset.imageAccents = 'ready';
        root.dataset.imageAccentsSource = source.kind;
        return;
      } catch { if (current !== request) return; }
    }
    if (current !== request) return;
    seed = null; hoverSeed = null; apply();
    root.dataset.imageAccents = 'fallback';
    root.dataset.imageAccentsSource = 'none';
  }

  function schedule() {
    // Invalidate pending work immediately; an old decode must not win a race.
    request++;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; update(); });
  }

  function bindAvatar() {
    const next = sidebar.querySelector('#avatar img');
    if (next === avatar) return;
    avatar?.removeEventListener('load', schedule);
    avatar?.removeEventListener('error', schedule);
    avatar = next;
    avatar?.addEventListener('load', schedule);
    avatar?.addEventListener('error', schedule);
  }
  new MutationObserver(() => { bindAvatar(); schedule(); }).observe(sidebar, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes'],
  });
  new MutationObserver(records => {
    if (records.some(record => record.type === 'childList' || record.target === script || record.target.matches?.('link[rel~="icon"]'))) schedule();
  }).observe(document.head, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'rel', 'type', 'data-source'],
  });
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-bs-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  sidebar.addEventListener('transitionend', event => {
    if (event.propertyName === 'background-color' && event.target.matches('#sidebar, .nav-item.active .nav-link')) {
      apply();
    }
  });
  bindAvatar(); schedule();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
