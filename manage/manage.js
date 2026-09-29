/**
 * "Mes images": every stored override, whatever page the card lives on.
 * Search, filter by mode, change the mode, replace the image, remove it.
 * Stays in sync with the editor, the popup and imports through storage.onChanged.
 */
(() => {
  const Store = globalThis.WmioStore;
  const MODE_LABELS = { always: 'Toujours', missing: 'Si manquante' };
  const DISARM_DELAY_MS = 3000;

  const els = {
    summary: document.getElementById('summary'),
    toolbar: document.getElementById('toolbar'),
    search: document.getElementById('search'),
    filters: document.querySelectorAll('[data-filter]'),
    sort: document.getElementById('sort'),
    empty: document.getElementById('empty'),
    grid: document.getElementById('grid'),
  };

  const state = { overrides: {}, filter: 'all', query: '', sort: 'recent', tabId: null };
  /** "key@updatedAt" -> data URL, so re-renders don't reload unchanged images. */
  const imageCache = new Map();

  const normalize = (text) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  // Pluralises every word: "image perso" -> "images persos".
  const plural = (count, words) => `${count} ${count > 1 ? words.replace(/\S+/g, '$&s') : words}`;
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  // Images are loaded when their tile scrolls into view.
  const lazyImages = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      lazyImages.unobserve(entry.target);
      const { key, version } = entry.target.dataset;
      Store.getImage(key).then((src) => {
        if (!src) return;
        imageCache.set(version, src);
        entry.target.src = src;
      });
    }
  }, { rootMargin: '300px' });

  function renderImage(key, override) {
    const version = `${key}@${override.updatedAt}`;
    const img = el('img', { alt: '', decoding: 'async' });
    if (imageCache.has(version)) {
      img.src = imageCache.get(version);
    } else {
      img.dataset.key = key;
      img.dataset.version = version;
      lazyImages.observe(img);
    }
    return el('div', { className: 'tile-image' }, [img]);
  }

  function renderModeSwitch(key, override) {
    const group = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Mode de remplacement' });
    for (const mode of Store.MODES) {
      const button = el('button', { type: 'button', textContent: MODE_LABELS[mode] });
      button.setAttribute('aria-pressed', String(override.mode === mode));
      button.addEventListener('click', () => {
        if (override.mode !== mode) Store.setMode(key, mode); // re-render comes from storage.onChanged
      });
      group.append(button);
    }
    return group;
  }

  function renderRemoveButton(key) {
    const button = el('button', { type: 'button', className: 'btn danger', textContent: 'Retirer' });
    let disarmTimer = null;
    button.addEventListener('click', () => {
      if (!button.classList.contains('is-armed')) {
        button.classList.add('is-armed');
        button.textContent = 'Confirmer ?';
        disarmTimer = setTimeout(() => {
          button.classList.remove('is-armed');
          button.textContent = 'Retirer';
        }, DISARM_DELAY_MS);
        return;
      }
      clearTimeout(disarmTimer);
      Store.removeOverride(key);
    });
    return button;
  }

  async function openEditor(key, override) {
    const params = new URLSearchParams({
      key,
      title: override.name,
      category: override.category ?? '',
      missing: '0', // unknown here; the editor keeps the existing mode anyway
      tabId: String(state.tabId),
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?${params}`) });
  }

  function renderTile([key, override]) {
    const scope = key.startsWith('name:')
      ? 'Par nom : toutes les cartes de ce nom'
      : 'Carte précise (identifiant)';
    return el('li', { className: 'tile' }, [
      renderImage(key, override),
      el('div', { className: 'tile-body' }, [
        el('p', { className: 'tile-title', textContent: override.name, title: override.name }),
        el('p', { className: 'tile-category', textContent: override.category ?? '', title: override.category ?? '' }),
        el('p', { className: 'tile-meta', textContent: `${scope} · ${dateFormat.format(override.updatedAt)}` }),
        el('div', { className: 'tile-actions' }, [
          renderModeSwitch(key, override),
          el('button', { type: 'button', className: 'btn', textContent: 'Changer', onclick: () => openEditor(key, override) }),
          renderRemoveButton(key),
        ]),
      ]),
    ]);
  }

  function visibleEntries() {
    const query = normalize(state.query.trim());
    const entries = Object.entries(state.overrides).filter(([, override]) => {
      if (state.filter !== 'all' && override.mode !== state.filter) return false;
      return !query || normalize(`${override.name} ${override.category ?? ''}`).includes(query);
    });
    return entries.sort(state.sort === 'name'
      ? ([, a], [, b]) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
      : ([, a], [, b]) => b.updatedAt - a.updatedAt);
  }

  function render() {
    const total = Object.keys(state.overrides).length;
    els.summary.textContent = total === 0
      ? 'Aucune image perso pour le moment.'
      : `${plural(total, 'image perso')} enregistrée${total > 1 ? 's' : ''} sur ce PC.`;
    els.toolbar.hidden = total === 0;

    const entries = visibleEntries();
    els.grid.replaceChildren(...entries.map(renderTile));
    els.empty.hidden = entries.length > 0;
    els.empty.textContent = total === 0
      ? 'Ajoute une image depuis la popup de l\'extension sur wiki-masters.com, ou importe une sauvegarde.'
      : 'Aucune image ne correspond à ta recherche.';
  }

  async function reload() {
    state.overrides = await Store.getOverrides();
    render();
  }

  function bindToolbar() {
    els.search.addEventListener('input', () => {
      state.query = els.search.value;
      render();
    });
    els.sort.addEventListener('change', () => {
      state.sort = els.sort.value;
      render();
    });
    for (const chip of els.filters) {
      chip.addEventListener('click', () => {
        state.filter = chip.dataset.filter;
        for (const other of els.filters) other.setAttribute('aria-pressed', String(other === chip));
        render();
      });
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[Store.OVERRIDES_KEY]) reload();
  });

  async function init() {
    state.tabId = (await chrome.tabs.getCurrent())?.id ?? null;
    bindToolbar();
    await reload();
  }

  init().catch((error) => {
    console.error('[wmio] manage', error);
    els.summary.textContent = `Erreur inattendue : ${error.message}`;
  });
})();
