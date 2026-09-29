/**
 * Editor tab: pick an image, crop it to the card illustration ratio, choose the
 * mode, and save it as a WebP data URL through WmioStore.
 *
 * Crop state is { cx, cy, zoom }: the image point shown at the viewport centre
 * (in image pixels) and a zoom factor relative to the "cover" scale. Everything
 * drawn (viewport, previews, final output) derives from it with drawCrop().
 */
(() => {
  const Store = globalThis.WmioStore;
  // Card illustration slot: 160×101 in grids, 288×189 in the detail modal → output at 2× the modal.
  const OUTPUT_WIDTH = 576;
  const OUTPUT_HEIGHT = 372;
  const OUTPUT_TYPE = 'image/webp';
  const OUTPUT_QUALITY = 0.85;
  const MAX_ZOOM = 8;
  const WHEEL_ZOOM_SPEED = 0.0015;
  const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('card-title'),
    category: $('card-category'),
    error: $('error'),
    picker: $('picker'),
    dropzone: $('dropzone'),
    file: $('file'),
    workspace: $('workspace'),
    viewport: $('viewport'),
    canvas: $('crop-canvas'),
    zoom: $('zoom'),
    changeFile: $('change-file'),
    urlForm: $('url-form'),
    urlInput: $('url-input'),
    urlSubmit: $('url-submit'),
    grant: $('grant'),
    backToCrop: $('back-to-crop'),
    previews: [$('preview-grid'), $('preview-modal')],
    save: $('save'),
    status: $('status'),
  };

  const params = new URLSearchParams(window.location.search);
  const card = {
    key: params.get('key'),
    title: params.get('title') ?? '',
    category: params.get('category') ?? '',
    missing: params.get('missing') === '1',
    // Tab that opened the editor (site tab or "Mes images"), focused again after saving.
    tabId: Number(params.get('tabId')),
  };

  /** @type {ImageBitmap | null} */
  let image = null;
  const crop = { cx: 0, cy: 0, zoom: 1 };

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = !message;
  }

  // ------------------------------------------------------------------ geometry

  /** Scale at which the image exactly covers a w×h box. */
  const coverScale = (w, h) => Math.max(w / image.width, h / image.height);

  /** Keeps the visible window inside the image. */
  function clampCrop() {
    const scale = coverScale(OUTPUT_WIDTH, OUTPUT_HEIGHT) * crop.zoom;
    const halfW = OUTPUT_WIDTH / scale / 2;
    const halfH = OUTPUT_HEIGHT / scale / 2;
    crop.cx = Math.min(Math.max(crop.cx, halfW), image.width - halfW);
    crop.cy = Math.min(Math.max(crop.cy, halfH), image.height - halfH);
  }

  /** Draws the current crop into a w×h context. Output ratio is fixed, so any box of that ratio matches. */
  function drawCrop(ctx, w, h) {
    const scale = coverScale(w, h) * crop.zoom;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, w / 2 - crop.cx * scale, h / 2 - crop.cy * scale, image.width * scale, image.height * scale);
  }

  // ----------------------------------------------------------------- rendering

  const output = Object.assign(document.createElement('canvas'), { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT });

  /** Draws the final image into a w×h box the way the site does (object-fit: cover, centred). */
  function drawAsSite(ctx, w, h) {
    const scale = Math.max(w / OUTPUT_WIDTH, h / OUTPUT_HEIGHT);
    const dw = OUTPUT_WIDTH * scale;
    const dh = OUTPUT_HEIGHT * scale;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(output, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  let frameRequested = false;
  function redraw() {
    if (frameRequested || !image) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      const { canvas } = els;
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      drawCrop(canvas.getContext('2d'), canvas.width, canvas.height);
      drawCrop(output.getContext('2d'), OUTPUT_WIDTH, OUTPUT_HEIGHT);
      for (const preview of els.previews) drawAsSite(preview.getContext('2d'), preview.width, preview.height);
      els.zoom.value = String(crop.zoom);
    });
  }

  function setZoom(zoom, anchor) {
    const next = Math.min(Math.max(zoom, 1), MAX_ZOOM);
    if (anchor) {
      // Keep the image point under the cursor fixed while zooming.
      const rect = els.viewport.getBoundingClientRect();
      const before = coverScale(rect.width, rect.height) * crop.zoom;
      const after = coverScale(rect.width, rect.height) * next;
      const dx = anchor.x - rect.left - rect.width / 2;
      const dy = anchor.y - rect.top - rect.height / 2;
      crop.cx += dx / before - dx / after;
      crop.cy += dy / before - dy / after;
    }
    crop.zoom = next;
    clampCrop();
    redraw();
  }

  // -------------------------------------------------------------------- input

  function showPicker(visible) {
    els.picker.hidden = !visible;
    els.workspace.hidden = visible;
    els.backToCrop.hidden = !image;
  }

  /** Decodes any image blob (file, clipboard, download) and opens it in the cropper. */
  async function loadBlob(blob, label) {
    showError('');
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      showError(`Impossible de lire ${label} comme une image. Essaie un PNG, JPEG ou WebP.`);
      return;
    }
    image?.close();
    image = bitmap;
    crop.cx = image.width / 2;
    crop.cy = image.height / 2;
    crop.zoom = 1;
    showPicker(false);
    els.status.textContent = `${image.width} × ${image.height} px`;
    redraw();
  }

  function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showError(`« ${file.name} » n'est pas une image.`);
      return;
    }
    loadBlob(file, `« ${file.name} »`);
  }

  /** Host permission pattern covering a URL, e.g. "https://example.com/*". */
  const originPattern = (url) => `${url.protocol}//${url.hostname}/*`;

  function offerPermission(url) {
    els.grant.textContent = `Autoriser l'extension à télécharger depuis ${url.hostname}`;
    els.grant.dataset.url = url.href;
    els.grant.hidden = false;
  }

  /** Downloads an http(s) image. Without CORS on the server, offers to grant a host permission. */
  async function loadUrl(raw) {
    showError('');
    els.grant.hidden = true;
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      showError('Cette adresse n\'est pas valide.');
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      showError('Seules les adresses http:// et https:// sont acceptées.');
      return;
    }

    els.urlSubmit.disabled = true;
    els.status.textContent = 'Téléchargement…';
    try {
      let response;
      try {
        response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      } catch {
        // Network failure or CORS refusal: only a host permission can get around the latter.
        if (await chrome.permissions.contains({ origins: [originPattern(url)] })) {
          showError(`Impossible de joindre ${url.hostname}.`);
        } else {
          showError(`${url.hostname} n'autorise pas le téléchargement direct de ses images.`);
          offerPermission(url);
        }
        return;
      }
      if (!response.ok) {
        showError(`${url.hostname} a répondu « ${response.status} ». Vérifie l'adresse.`);
        return;
      }
      if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
        showError('Cette image dépasse 20 Mo.');
        return;
      }
      const blob = await response.blob();
      if (blob.size > MAX_DOWNLOAD_BYTES) {
        showError('Cette image dépasse 20 Mo.');
        return;
      }
      await loadBlob(blob, `l'adresse ${url.hostname}`);
    } finally {
      els.urlSubmit.disabled = false;
      if (els.status.textContent === 'Téléchargement…') els.status.textContent = '';
    }
  }

  /** First http(s) image address in dropped or pasted data: an <img> in HTML, then plain URLs. */
  function findImageUrl(dataTransfer) {
    const html = dataTransfer.getData('text/html');
    if (html) {
      const src = new DOMParser().parseFromString(html, 'text/html').querySelector('img[src]')?.getAttribute('src');
      if (src && /^https?:\/\//i.test(src)) return src;
    }
    const lines = `${dataTransfer.getData('text/uri-list')}\n${dataTransfer.getData('text/plain')}`.split(/\r?\n/);
    return lines.map((line) => line.trim()).find((line) => /^https?:\/\/\S+$/i.test(line)) ?? null;
  }

  /** Handles a drop or a paste. @returns {boolean} whether the data contained an image source. */
  function loadFromTransfer(dataTransfer) {
    const file = [...dataTransfer.files].find((candidate) => candidate.type.startsWith('image/'));
    if (file) {
      loadBlob(file, file.name ? `« ${file.name} »` : "l'image collée");
      return true;
    }
    const url = findImageUrl(dataTransfer);
    if (url) {
      els.urlInput.value = url;
      loadUrl(url);
      return true;
    }
    return false;
  }

  function bindPicker() {
    els.file.addEventListener('change', () => {
      loadFile(els.file.files[0]);
      els.file.value = ''; // lets the same file be picked again
    });
    els.changeFile.addEventListener('click', () => showPicker(true));
    els.backToCrop.addEventListener('click', () => showPicker(false));

    els.urlForm.addEventListener('submit', (event) => {
      event.preventDefault();
      loadUrl(els.urlInput.value);
    });
    els.grant.addEventListener('click', async () => {
      const url = new URL(els.grant.dataset.url);
      // Must be the first await: Chrome only shows the prompt during the click gesture.
      const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
      if (granted) loadUrl(url.href);
      else showError(`Accès à ${url.hostname} refusé. Tu peux enregistrer l'image puis la choisir comme fichier.`);
    });

    // Drop anywhere on the page, from the file system or from another tab.
    const setOver = (over) => document.body.classList.toggle('is-dragging-over', over);
    document.addEventListener('dragover', (event) => {
      event.preventDefault();
      setOver(true);
    });
    document.addEventListener('dragleave', (event) => {
      if (!event.relatedTarget) setOver(false);
    });
    document.addEventListener('drop', (event) => {
      event.preventDefault();
      setOver(false);
      if (!loadFromTransfer(event.dataTransfer)) showError('Rien d\'utilisable dans ce qui a été déposé.');
    });

    document.addEventListener('paste', (event) => {
      if (event.target === els.urlInput) return; // normal paste into the address field
      if (loadFromTransfer(event.clipboardData)) event.preventDefault();
    });
  }

  function bindCropper() {
    let drag = null;
    els.viewport.addEventListener('pointerdown', (event) => {
      if (!image) return;
      els.viewport.setPointerCapture(event.pointerId);
      els.viewport.classList.add('is-dragging');
      drag = { x: event.clientX, y: event.clientY };
    });
    els.viewport.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const rect = els.viewport.getBoundingClientRect();
      const scale = coverScale(rect.width, rect.height) * crop.zoom;
      crop.cx -= (event.clientX - drag.x) / scale;
      crop.cy -= (event.clientY - drag.y) / scale;
      drag = { x: event.clientX, y: event.clientY };
      clampCrop();
      redraw();
    });
    const endDrag = () => {
      drag = null;
      els.viewport.classList.remove('is-dragging');
    };
    els.viewport.addEventListener('pointerup', endDrag);
    els.viewport.addEventListener('pointercancel', endDrag);

    els.viewport.addEventListener('wheel', (event) => {
      if (!image) return;
      event.preventDefault();
      setZoom(crop.zoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), { x: event.clientX, y: event.clientY });
    }, { passive: false });

    els.zoom.addEventListener('input', () => setZoom(Number(els.zoom.value)));
    new ResizeObserver(redraw).observe(els.viewport);
  }

  // --------------------------------------------------------------------- save

  function renderOutput() {
    drawCrop(output.getContext('2d'), OUTPUT_WIDTH, OUTPUT_HEIGHT);
    return output.toDataURL(OUTPUT_TYPE, OUTPUT_QUALITY);
  }

  async function returnToSite() {
    if (Number.isInteger(card.tabId)) {
      await chrome.tabs.update(card.tabId, { active: true }).catch(() => {});
    }
    const current = await chrome.tabs.getCurrent();
    if (current?.id !== undefined) await chrome.tabs.remove(current.id);
  }

  async function save() {
    if (!image) return;
    const mode = document.querySelector('input[name="mode"]:checked')?.value;
    els.save.disabled = true;
    els.status.textContent = 'Enregistrement…';
    try {
      const dataUrl = renderOutput();
      await Store.saveOverride(card.key, { name: card.title, category: card.category, mode, image: dataUrl });
      els.status.textContent = `Enregistré (${Math.round(dataUrl.length / 1024)} Ko).`;
      await returnToSite();
    } catch (error) {
      console.error('[wmio] save', error);
      showError(`L'enregistrement a échoué : ${error.message}`);
      els.status.textContent = '';
      els.save.disabled = false;
    }
  }

  // --------------------------------------------------------------------- init

  async function init() {
    if (!Store.isValidKey(card.key) || !card.title) {
      showError('Paramètres manquants : ouvre cet éditeur depuis le panneau de l\'extension.');
      els.picker.hidden = true;
      return;
    }
    document.title = `${card.title} — Image perso`;
    els.title.textContent = card.title;
    els.category.textContent = card.category;

    // Default mode: keep the existing one, otherwise "if missing" for imageless cards, "always" for others.
    const existing = (await Store.getOverrides())[card.key];
    const mode = existing?.mode ?? (card.missing ? 'missing' : 'always');
    document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;

    bindPicker();
    bindCropper();
    els.save.addEventListener('click', save);
  }

  init().catch((error) => showError(`Erreur inattendue : ${error.message}`));
})();
