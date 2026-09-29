/**
 * Popup: lists the cards detected on the active wiki-masters.com tab, lets the
 * user pick the mode of each override, remove it, or open the editor tab to
 * add or change an image.
 */
(() => {
  const Store = globalThis.WmioStore;
  const SITE_URL_RE = /^https:\/\/(www\.)?wiki-masters\.com\//;
  const MODE_LABELS = { always: 'Toujours', missing: 'Si manquante' };
  const DISARM_DELAY_MS = 3000;

  const els = {
    summary: document.getElementById('summary'),
    notice: document.getElementById('notice'),
    toolbar: document.getElementById('toolbar'),
    search: document.getElementById('search'),
    filters: document.querySelectorAll('[data-filter]'),
    cards: document.getElementById('cards'),
  };

  const state = { tabId: null, cards: [], overrides: {}, filter: 'all', query: '' };

  const normalize = (text) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function showNotice(text, tone = 'warn') {
    els.notice.textContent = text;
    els.notice.dataset.tone = tone;
    els.notice.hidden = false;
  }

  function overrideOf(card) {
    return card.activeKey ? state.overrides[card.activeKey] ?? null : null;
  }

  function updateSummary() {
    const total = state.cards.length;
    const missing = state.cards.filter((card) => card.missing).length;
    const custom = state.cards.filter(overrideOf).length;
    els.summary.textContent = `${total} carte${total > 1 ? 's' : ''} sur la page · ${missing} sans image · ${custom} modifiée${custom > 1 ? 's' : ''}`;
  }

  function matchesFilter(card) {
    if (state.filter === 'missing') return card.missing;
    if (state.filter === 'custom') return Boolean(overrideOf(card));
    return true;
  }

  function renderThumb(card, override) {
    const thumb = el('div', { className: 'thumb' });
    if (override) {
      thumb.classList.add('is-custom');
      const img = el('img', { alt: '' });
      Store.getImage(card.activeKey).then((src) => { if (src) img.src = src; });
      thumb.append(img);
    } else if (card.originalSrc) {
      thumb.append(el('img', { alt: '', src: card.originalSrc, referrerPolicy: 'no-referrer' }));
    } else {
      thumb.textContent = 'Sans image';
    }
    return thumb;
  }

  function renderModeSwitch(card, override) {
    const group = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Mode de remplacement' });
    for (const mode of Store.MODES) {
      const button = el('button', { type: 'button', textContent: MODE_LABELS[mode] });
      button.setAttribute('aria-pressed', String(override.mode === mode));
      button.addEventListener('click', async () => {
        if (override.mode === mode) return;
        await Store.setMode(card.activeKey, mode);
        state.overrides[card.activeKey] = { ...override, mode };
        render();
      });
      group.append(button);
    }
    return group;
  }

  function renderRemoveButton(card) {
    const button = el('button', { type: 'button', className: 'btn danger', textContent: 'Retirer' });
    let disarmTimer = null;
    button.addEventListener('click', async () => {
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
      const key = card.activeKey;
      await Store.removeOverride(key);
      delete state.overrides[key];
      card.activeKey = null;
      render();
    });
    return button;
  }

  function renderCard(card) {
    const override = overrideOf(card);

    const titleRow = el('div', { className: 'title-row' }, [
      el('span', { className: 'title', textContent: card.title, title: card.title }),
    ]);
    if (card.missing) titleRow.append(el('span', { className: 'badge missing', textContent: 'sans image' }));
    if (override) titleRow.append(el('span', { className: 'badge custom', textContent: 'perso' }));

    const actions = el('div', { className: 'actions' });
    if (override) {
      actions.append(
        renderModeSwitch(card, override),
        el('button', { type: 'button', className: 'btn', textContent: 'Changer', onclick: () => openEditor(card) }),
        renderRemoveButton(card),
      );
    } else {
      actions.append(el('button', { type: 'button', className: 'btn primary', textContent: 'Ajouter une image', onclick: () => openEditor(card) }));
    }

    return el('li', { className: 'card' }, [
      renderThumb(card, override),
      el('div', { className: 'body' }, [
        titleRow,
        el('p', { className: 'category', textContent: card.category, title: card.category }),
        actions,
      ]),
    ]);
  }

  function render() {
    const query = normalize(state.query.trim());
    const visible = state.cards.filter((card) => matchesFilter(card) && (!query || normalize(card.title).includes(query)));
    els.cards.replaceChildren(...visible.map(renderCard));
    if (visible.length === 0) els.cards.append(el('li', { className: 'empty', textContent: 'Aucune carte ne correspond.' }));
    updateSummary();
  }

  async function openEditor(card) {
    const params = new URLSearchParams({
      key: card.activeKey ?? card.newKey,
      title: card.title,
      category: card.category,
      missing: card.missing ? '1' : '0',
      tabId: String(state.tabId),
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?${params}`) });
    window.close();
  }

  function bindToolbar() {
    els.search.addEventListener('input', () => {
      state.query = els.search.value;
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

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !SITE_URL_RE.test(tab.url ?? '')) {
      showNotice('Ouvre une page de wiki-masters.com pour voir ses cartes.', 'info');
      return;
    }
    state.tabId = tab.id;

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'wmio:list' });
    } catch {
      showNotice("L'extension ne répond pas sur cet onglet. Recharge la page, puis rouvre ce panneau.");
      return;
    }

    state.cards = response?.cards ?? [];
    state.overrides = await Store.getOverrides();
    updateSummary();

    if (state.cards.length === 0) {
      showNotice(
        'Aucune carte détectée sur cette page. Si elle affiche pourtant des cartes, la structure du site a '
        + "probablement changé : l'extension ne remplace plus rien, mais tes images restent enregistrées.",
      );
      return;
    }

    els.toolbar.hidden = false;
    bindToolbar();
    render();
  }

  document.getElementById('open-manage').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('manage/manage.html') });
    window.close();
  });

  init().catch((error) => {
    console.error('[wmio] popup', error);
    showNotice(`Erreur inattendue : ${error.message}`);
  });
})();
