/**
 * Content script: detects WikiMasters cards in the DOM, resolves which stored
 * override applies to each one, and overlays the custom image on the card's
 * illustration slot. The site's own <img> is never modified (React/next/image
 * rewrite it), our <img> sits on top of it and is re-added when React re-renders.
 *
 * Card anatomy observed on /collection, /global-collection, /marketplace and the
 * detail modal:
 *   <div …rounded-2xl…>                         card root
 *     <div class="absolute top-0 … h-[45%]">    illustration slot
 *       <img src="…wikimedia…">                 or placeholder <img alt="WikiMasters" src="…/logo.png">
 *     <div class="absolute top-[45%] …">
 *       <h3>Title</h3><p>Category</p>
 */
(() => {
  const Store = globalThis.WmioStore;
  const HOOK_SOURCE = 'wmio-page-hook';
  const OVERLAY_CLASS = 'wmio-overlay';
  const SLOT_SELECTOR = ':scope > [class*="h-[45%]"]';
  const ORIGINAL_IMG_SELECTOR = `img:not(.${OVERLAY_CLASS})`;
  const MAX_CARD_DEPTH = 4;
  const MAX_TEXT_LENGTH = 500;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** title -> category -> Set<uuid>, learned from API responses via page-hook.js */
  const uuidIndex = new Map();
  /** @type {Record<string, import('./storage.js').Override>} */
  let overrides = {};
  /** key -> data URL, or null when the image is absent from storage */
  const imageCache = new Map();
  const pendingImageLoads = new Set();
  let scanScheduled = false;

  // ---------------------------------------------------------------- detection

  function isPlaceholder(img) {
    if (img.alt === 'WikiMasters') return true;
    try {
      return decodeURIComponent(img.getAttribute('src') || '').includes('/logo.png');
    } catch {
      return false;
    }
  }

  /**
   * @typedef {Object} DomCard
   * @property {HTMLElement} slot
   * @property {HTMLImageElement} original
   * @property {string} title
   * @property {string} category
   * @property {boolean} missing
   */

  /** @returns {DomCard[]} every card currently in the DOM (grid, modal, …). */
  function findCards() {
    const cards = [];
    for (const heading of document.querySelectorAll('h3')) {
      let ancestor = heading.parentElement;
      for (let depth = 0; ancestor && depth < MAX_CARD_DEPTH; depth++, ancestor = ancestor.parentElement) {
        const slot = ancestor.querySelector(SLOT_SELECTOR);
        const original = slot?.querySelector(ORIGINAL_IMG_SELECTOR);
        if (original) {
          const subtitle = heading.nextElementSibling;
          cards.push({
            slot,
            original,
            title: heading.textContent.trim(),
            category: subtitle?.tagName === 'P' ? subtitle.textContent.trim() : '',
            missing: isPlaceholder(original),
          });
          break;
        }
      }
    }
    return cards;
  }

  // --------------------------------------------------------------- resolution

  function uuidsFor(title, category) {
    return [...(uuidIndex.get(title)?.get(category) ?? [])];
  }

  /** @returns {string | null} the key of the override that applies to this card. */
  function resolveKey(card) {
    const uuids = uuidsFor(card.title, card.category);
    for (const uuid of uuids) {
      const key = Store.idKey(uuid);
      if (overrides[key]) return key;
    }
    const byName = Store.nameKey(card.title);
    if (overrides[byName]) return byName;
    if (uuids.length === 0) {
      // UUID unknown on this page (API not seen): fall back to the name saved with id overrides.
      for (const [key, override] of Object.entries(overrides)) {
        if (key.startsWith('id:') && override.name === card.title
            && (!override.category || override.category === card.category)) {
          return key;
        }
      }
    }
    return null;
  }

  /** Key to use when the user adds a new image to this card. */
  function keyForNewOverride(card) {
    const uuids = uuidsFor(card.title, card.category);
    // Several UUIDs for the same title+category: the image applies to all of them, by name.
    return uuids.length === 1 ? Store.idKey(uuids[0]) : Store.nameKey(card.title);
  }

  // ------------------------------------------------------------------ overlay

  function loadImage(key) {
    if (pendingImageLoads.has(key)) return;
    pendingImageLoads.add(key);
    Store.getImage(key)
      .then((dataUrl) => imageCache.set(key, dataUrl))
      .catch((error) => {
        console.warn('[wmio] Could not load image', key, error);
        imageCache.set(key, null);
      })
      .finally(() => {
        pendingImageLoads.delete(key);
        scheduleScan();
      });
  }

  function createOverlay() {
    const overlay = document.createElement('img');
    overlay.className = OVERLAY_CLASS;
    overlay.decoding = 'async';
    overlay.style.cssText = [
      'position:absolute', 'inset:0', 'width:100%', 'height:100%',
      'object-fit:cover', 'z-index:5', 'pointer-events:none', 'margin:0',
    ].join(';');
    return overlay;
  }

  function applyToCard(card) {
    const key = resolveKey(card);
    const override = key ? overrides[key] : null;
    const existing = card.slot.querySelector(`:scope > img.${OVERLAY_CLASS}`);

    if (!override || (override.mode === 'missing' && !card.missing)) {
      existing?.remove();
      return;
    }
    if (!imageCache.has(key)) {
      loadImage(key); // rescans once loaded
      return;
    }
    const dataUrl = imageCache.get(key);
    if (!dataUrl) {
      existing?.remove();
      return;
    }
    const version = `${key}@${override.updatedAt}`;
    if (existing?.dataset.wmioVersion === version) return;

    const overlay = existing ?? createOverlay();
    overlay.dataset.wmioVersion = version;
    overlay.alt = card.title;
    overlay.src = dataUrl;
    if (!existing) card.slot.appendChild(overlay);
  }

  function scan() {
    for (const card of findCards()) applyToCard(card);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scan();
    });
  }

  // ------------------------------------------------------------------- inputs

  function isOwnOverlay(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.classList.contains(OVERLAY_CLASS);
  }

  /** Ignores the mutations we cause ourselves, so a scan never triggers another one. */
  function isSiteMutation(mutation) {
    if (mutation.type === 'attributes') return !isOwnOverlay(mutation.target);
    if (mutation.type === 'characterData') return true;
    // A removed overlay counts: React may have wiped it, it must be put back.
    return mutation.removedNodes.length > 0 || [...mutation.addedNodes].some((node) => !isOwnOverlay(node));
  }

  new MutationObserver((mutations) => {
    if (mutations.some(isSiteMutation)) scheduleScan();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['src', 'alt'],
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source !== HOOK_SOURCE || data.type !== 'cards' || !Array.isArray(data.cards)) return;

    let learned = false;
    for (const card of data.cards) {
      if (typeof card?.id !== 'string' || !UUID_RE.test(card.id)) continue;
      if (typeof card.title !== 'string' || typeof card.category !== 'string') continue;
      const title = card.title.trim().slice(0, MAX_TEXT_LENGTH);
      const category = card.category.trim().slice(0, MAX_TEXT_LENGTH);
      if (!uuidIndex.has(title)) uuidIndex.set(title, new Map());
      const byCategory = uuidIndex.get(title);
      if (!byCategory.has(category)) byCategory.set(category, new Set());
      const ids = byCategory.get(category);
      if (!ids.has(card.id)) {
        ids.add(card.id);
        learned = true;
      }
    }
    if (learned) scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [storageKey, change] of Object.entries(changes)) {
      if (storageKey === Store.OVERRIDES_KEY) {
        overrides = change.newValue ?? {};
      } else if (storageKey.startsWith(Store.IMAGE_PREFIX)) {
        imageCache.delete(storageKey.slice(Store.IMAGE_PREFIX.length));
      }
    }
    scheduleScan();
  });

  /** Popup request: the distinct cards currently on the page. */
  function listCards() {
    const cards = new Map();
    for (const card of findCards()) {
      const id = `${card.title}\u0000${card.category}`;
      if (cards.has(id)) continue;
      cards.set(id, {
        title: card.title,
        category: card.category,
        missing: card.missing,
        originalSrc: card.missing ? null : (card.original.currentSrc || card.original.src),
        activeKey: resolveKey(card),
        newKey: keyForNewOverride(card),
      });
    }
    return [...cards.values()];
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'wmio:list') return false;
    sendResponse({ cards: listCards() });
    return false;
  });

  Store.getOverrides()
    .then((stored) => {
      overrides = stored;
      scheduleScan();
    })
    .catch((error) => console.warn('[wmio] Could not read overrides', error));
})();
