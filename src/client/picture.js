// A design as an image, to copy or save it. The browser draws it from the page as its frame has it:
// the page's HTML and CSS go into an SVG <foreignObject>, with the files they use (stylesheets, fonts,
// images) inlined, since an image can't load anything. Scripts don't run in an image, so it shows the
// page as built when it was taken.
//
// What it can't show: images from another site that doesn't allow reading them (CORS), pages inside
// the page (iframes), shadow DOM. A video shows the frame it is at, or its poster.

const MAX_SIDE = 16384; // px: the longest side browsers draw a canvas at
const MAX_AREA = 64e6; // px: about 256 MB of pixels
const LOAD_MS = 10000;
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const IMPORT_RULE = 3;
const FONT_FACE_RULE = 5;
const LEFT_OUT = new Set(['script', 'noscript', 'style', 'link', 'source', 'track']);

/**
 * The page in `iframe` drawn on a canvas, `width` × `height` CSS px at `scale` device px per CSS px
 * (less when that would make a canvas too big to draw).
 */
export async function drawDesign(iframe, { width, height, scale = 1 }) {
  const doc = await loaded(iframe);
  const win = iframe.contentWindow;
  await doc.fonts?.ready;
  const files = reader(win);
  const [css, root] = await Promise.all([styles(doc, files), copyPage(doc, files)]);
  const style = doc.createElement('style');
  style.textContent = css;
  (root.querySelector('head') || root).append(style);
  const markup = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`;
  const image = new Image();
  // A data: URL, not a blob: one, which would keep the canvas from being read (Chromium)
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await image.decode();
  } catch {
    throw new Error('the browser couldn’t draw this page');
  }
  scale = Math.min(scale, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  // The page's background fills the frame in a browser; in an image it would cover only its box.
  context.fillStyle = backdrop(doc, win);
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The frame's page once it has loaded (a frame reloading after a save is waited for) */
function loaded(iframe) {
  const ready = () => {
    const doc = iframe.contentDocument;
    return doc && doc.readyState === 'complete' && doc.URL !== 'about:blank' ? doc : null;
  };
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      iframe.removeEventListener('load', done);
      if (ready()) resolve(ready());
      else reject(new Error('the page didn’t load'));
    };
    const timer = setTimeout(done, LOAD_MS);
    iframe.addEventListener('load', done);
  });
}

// ---------------------------------------------------------------- the files the page uses

// Reads the files the page uses as data: URLs, each once. `used` holds the files the page loaded, to
// leave out the fonts it never needed (another alphabet's part of a font); null when it can't tell.
function reader(win) {
  let used = null;
  try {
    const entries = win.performance.getEntriesByType('resource');
    if (entries.length < 250) used = new Set(entries.map((entry) => entry.name)); // browsers stop listing at 250
  } catch {
    // Can't tell
  }
  const read = new Map();
  return {
    used,
    // '' when it can't be read: missing, or another site's that doesn't allow it
    dataUrl(url) {
      if (!read.has(url)) {
        read.set(url, fetch(url)
          .then((res) => (res.ok ? res.blob() : null))
          .then((blob) => (blob ? asDataUrl(blob) : ''))
          .catch(() => ''));
      }
      return read.get(url);
    },
  };
}

function asDataUrl(blob) {
  return new Promise((resolve) => {
    const fileReader = new FileReader();
    fileReader.onload = () => resolve(String(fileReader.result));
    fileReader.onerror = () => resolve('');
    fileReader.readAsDataURL(blob);
  });
}

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/** CSS with every url(…) in it as a data: URL (an empty one for a file it can't read) */
async function inlineUrls(css, base, files) {
  const urls = new Map();
  for (const [, , raw] of css.matchAll(URL_RE)) {
    const url = raw.trim();
    if (!url || urls.has(url) || /^(data:|#|about:)/i.test(url)) continue;
    const full = absolute(url, base);
    if (full) urls.set(url, files.dataUrl(full));
  }
  if (!urls.size) return css;
  const data = new Map();
  for (const [url, reading] of urls) data.set(url, await reading);
  return css.replace(URL_RE, (whole, quote, raw) => {
    const value = data.get(raw.trim());
    return value === undefined ? whole : `url("${value || 'data:,'}")`;
  });
}

// ---------------------------------------------------------------- the page's CSS

/** All the CSS the page has, in its order, with the files it uses inlined */
async function styles(doc, files) {
  const parts = [];
  for (const sheet of doc.styleSheets) if (!sheet.disabled) parts.push(await sheetCss(sheet, doc.baseURI, files));
  for (const sheet of doc.adoptedStyleSheets || []) parts.push(await rulesCss(sheet.cssRules, doc.baseURI, files));
  return parts.join('\n');
}

async function sheetCss(sheet, base, files, media = sheet.media?.mediaText) {
  const href = sheet.href || base;
  let css;
  try {
    css = await rulesCss(sheet.cssRules, href, files);
  } catch {
    // Another site's stylesheet, which the page can use but not read: fetched again, as most allow
    // (font services and CDNs do).
    css = sheet.href ? await fetch(sheet.href).then((res) => (res.ok ? res.text() : '')).catch(() => '') : '';
    css = await inlineUrls(css, href, files);
  }
  return media && media !== 'all' ? `@media ${media} {\n${css}\n}` : css;
}

async function rulesCss(rules, base, files) {
  const parts = [];
  for (const rule of rules) {
    if (rule.type === IMPORT_RULE) {
      let css = rule.styleSheet ? await sheetCss(rule.styleSheet, base, files, rule.media?.mediaText) : '';
      if (rule.supportsText) css = `@supports ${rule.supportsText} {\n${css}\n}`;
      if (rule.layerName != null) css = `@layer${rule.layerName ? ` ${rule.layerName}` : ''} {\n${css}\n}`;
      parts.push(css);
    } else if (rule.type !== FONT_FACE_RULE || !unusedFont(rule, base, files.used)) {
      parts.push(rule.cssText);
    }
  }
  return inlineUrls(parts.join('\n'), base, files);
}

// A font face whose files the page never loaded
function unusedFont(rule, base, used) {
  if (!used) return false;
  const urls = [...rule.cssText.matchAll(URL_RE)].map((match) => match[2].trim()).filter((url) => !/^data:/i.test(url));
  return urls.length > 0 && !urls.some((url) => used.has(absolute(url, base)));
}

// ---------------------------------------------------------------- the page's HTML

/**
 * A copy of the page as it is now: without scripts and stylesheets (their CSS comes whole), with what
 * the page's elements hold but their markup doesn't say (the image each <img> chose, form values, a
 * canvas's drawing) and its files inlined.
 */
async function copyPage(doc, files) {
  const root = doc.documentElement;
  const copy = root.cloneNode(true);
  const live = [root, ...root.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')]; // the same elements, in the same order
  const waits = [];
  live.forEach((el, i) => {
    const out = copies[i];
    const tag = el.localName;
    if (LEFT_OUT.has(tag)) {
      out.remove();
      return;
    }
    if (tag === 'img') {
      const src = el.currentSrc || el.src;
      for (const attribute of ['srcset', 'sizes', 'loading']) out.removeAttribute(attribute);
      if (src) waits.push(files.dataUrl(src).then((data) => out.setAttribute('src', data || TRANSPARENT)));
    } else if (tag === 'image' && (el.getAttribute('href') || el.getAttribute('xlink:href'))) {
      const full = absolute(el.getAttribute('href') || el.getAttribute('xlink:href'), doc.baseURI);
      if (full) {
        waits.push(files.dataUrl(full).then((data) => {
          out.removeAttribute('xlink:href');
          out.setAttribute('href', data || TRANSPARENT);
        }));
      }
    } else if (tag === 'canvas') {
      // Without scripts (as in an image), a canvas shows what it holds instead of its drawing
      asImage(el, out, canvasData(el));
    } else if (tag === 'video') {
      const frame = videoFrame(el);
      waits.push((frame || !el.poster ? Promise.resolve(frame) : files.dataUrl(el.poster)).then((data) => asImage(el, out, data, 'contain')));
    } else if (tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object') {
      for (const attribute of ['src', 'srcdoc', 'data']) out.removeAttribute(attribute);
    } else if (tag === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') out.toggleAttribute('checked', el.checked);
      else if (el.type !== 'file') out.setAttribute('value', el.value);
    } else if (tag === 'textarea') {
      out.textContent = el.value;
    } else if (tag === 'option') {
      out.toggleAttribute('selected', el.selected);
    }
    const style = out.getAttribute('style');
    if (style && /url\(/i.test(style)) waits.push(inlineUrls(style, doc.baseURI, files).then((css) => out.setAttribute('style', css)));
  });
  await Promise.all(waits);
  return copy;
}

// An <img> of what a canvas or a video shows, in its place: its attributes (for the page's CSS) and
// the size the page gave it.
function asImage(el, out, data, fit = 'fill') {
  const img = el.ownerDocument.createElement('img');
  for (const { name, value } of out.attributes) {
    if (!['src', 'poster', 'autoplay', 'controls', 'width', 'height'].includes(name)) img.setAttribute(name, value);
  }
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  img.style.width = style.width;
  img.style.height = style.height;
  img.style.objectFit = fit;
  img.src = data || TRANSPARENT;
  out.replaceWith(img);
}

function canvasData(canvas) {
  try {
    return canvas.toDataURL();
  } catch {
    return 'data:,'; // drawn from another site: unreadable
  }
}

function videoFrame(video) {
  try {
    if (video.readyState < 2 || !video.videoWidth) return '';
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.9);
  } catch {
    return '';
  }
}

/** The colour that fills the page behind its content: the root's background, or the body's, or white */
function backdrop(doc, win) {
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    const color = win.getComputedStyle(el).backgroundColor;
    if (color && !/^transparent$|,\s*0\)$|\/\s*0\)$/.test(color)) return color;
  }
  return '#FFFFFF';
}
