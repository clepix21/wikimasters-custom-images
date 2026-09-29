/**
 * Shared chrome.storage.local helpers, loaded as a classic script by the
 * content script, the popup and the editor. Exposes `globalThis.WmioStore`.
 *
 * Layout:
 *   "overrides"   -> { [key]: Override }       small, read on every page load
 *   "img:<key>"   -> "data:image/webp;base64,…" one entry per image
 *
 * A key is "id:<card uuid>" when the card's UUID is known, "name:<title>" otherwise.
 */
(() => {
  const OVERRIDES_KEY = 'overrides';
  const IMAGE_PREFIX = 'img:';
  const MODES = Object.freeze(['always', 'missing']);

  /** @typedef {'always' | 'missing'} Mode */
  /**
   * @typedef {Object} Override
   * @property {string} name      Card title as displayed on the site.
   * @property {string} category  Card subtitle, used to tell homonyms apart.
   * @property {Mode} mode
   * @property {number} updatedAt Epoch ms, also used as a version by the content script.
   */

  const idKey = (uuid) => `id:${uuid}`;
  const nameKey = (title) => `name:${title}`;
  const imageKey = (key) => IMAGE_PREFIX + key;
  const isValidKey = (key) => typeof key === 'string' && /^(id|name):.+/.test(key);

  function assertKey(key) {
    if (!isValidKey(key)) throw new Error(`Invalid override key: ${key}`);
  }

  function assertMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  }

  /** @returns {Promise<Record<string, Override>>} */
  async function getOverrides() {
    const { [OVERRIDES_KEY]: overrides = {} } = await chrome.storage.local.get(OVERRIDES_KEY);
    return overrides;
  }

  /** @returns {Promise<string | null>} the stored data URL, or null. */
  async function getImage(key) {
    const storageKey = imageKey(key);
    const { [storageKey]: dataUrl = null } = await chrome.storage.local.get(storageKey);
    return dataUrl;
  }

  /**
   * Creates or replaces the override for a card, image included.
   * @param {string} key
   * @param {{ name: string, category: string, mode: Mode, image: string }} data
   */
  async function saveOverride(key, { name, category, mode, image }) {
    assertKey(key);
    assertMode(mode);
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      throw new Error('Image must be an image data URL');
    }
    const overrides = await getOverrides();
    overrides[key] = { name, category, mode, updatedAt: Date.now() };
    await chrome.storage.local.set({ [OVERRIDES_KEY]: overrides, [imageKey(key)]: image });
  }

  /** Changes the mode of an existing override without touching its image. */
  async function setMode(key, mode) {
    assertKey(key);
    assertMode(mode);
    const overrides = await getOverrides();
    if (!overrides[key]) throw new Error(`No override for ${key}`);
    overrides[key] = { ...overrides[key], mode, updatedAt: Date.now() };
    await chrome.storage.local.set({ [OVERRIDES_KEY]: overrides });
  }

  /** Deletes an override and its image. */
  async function removeOverride(key) {
    assertKey(key);
    const overrides = await getOverrides();
    delete overrides[key];
    await chrome.storage.local.set({ [OVERRIDES_KEY]: overrides });
    await chrome.storage.local.remove(imageKey(key));
  }

  // ------------------------------------------------------------ backup files

  const BACKUP_FORMAT = 'wmio-backup';
  const BACKUP_VERSION = 1;
  const IMPORT_STRATEGIES = Object.freeze(['overwrite', 'keep', 'replace']);
  const IMAGE_DATA_URL_RE = /^data:image\/(webp|png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/;

  /**
   * @typedef {Object} Backup
   * @property {'wmio-backup'} format
   * @property {number} version
   * @property {string} exportedAt ISO date.
   * @property {Record<string, Override & { image: string }>} cards
   */

  /** @returns {Promise<Backup>} every override with its image, ready to be written to a file. */
  async function exportBackup() {
    const all = await chrome.storage.local.get(null);
    const overrides = all[OVERRIDES_KEY] ?? {};
    const cards = {};
    for (const [key, override] of Object.entries(overrides)) {
      const image = all[imageKey(key)];
      if (typeof image === 'string') cards[key] = { ...override, image };
    }
    return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), cards };
  }

  /**
   * Validates a parsed backup file. Invalid entries are dropped, not fatal.
   * @returns {{ cards: Record<string, Override & { image: string }>, skipped: number }}
   * @throws {Error} when the file is not a backup of this extension at all.
   */
  function parseBackup(data) {
    if (data?.format !== BACKUP_FORMAT || typeof data.cards !== 'object' || data.cards === null) {
      throw new Error("Ce fichier n'est pas une sauvegarde de l'extension.");
    }
    if (data.version !== BACKUP_VERSION) {
      throw new Error(`Version de sauvegarde non prise en charge (${data.version}).`);
    }
    const cards = {};
    let skipped = 0;
    for (const [key, entry] of Object.entries(data.cards)) {
      const valid = isValidKey(key)
        && typeof entry?.name === 'string'
        && typeof entry.category === 'string'
        && MODES.includes(entry.mode)
        && typeof entry.image === 'string' && IMAGE_DATA_URL_RE.test(entry.image);
      if (!valid) {
        skipped++;
        continue;
      }
      cards[key] = {
        name: entry.name,
        category: entry.category,
        mode: entry.mode,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
        image: entry.image,
      };
    }
    return { cards, skipped };
  }

  /**
   * Writes backup cards into storage.
   * - "overwrite": file wins on conflicts, other local overrides are kept.
   * - "keep":      local overrides win on conflicts, only new cards are added.
   * - "replace":   local overrides not in the file are deleted.
   * @returns {Promise<{ written: number, removed: number }>}
   */
  async function importBackup(cards, strategy) {
    if (!IMPORT_STRATEGIES.includes(strategy)) throw new Error(`Invalid strategy: ${strategy}`);
    const current = await getOverrides();
    const next = strategy === 'replace' ? {} : { ...current };
    const writes = {};
    for (const [key, { image, ...override }] of Object.entries(cards)) {
      if (strategy === 'keep' && current[key]) continue;
      next[key] = override;
      writes[imageKey(key)] = image;
    }
    const staleImages = Object.keys(current).filter((key) => !next[key]).map(imageKey);
    // Write first, clean up after: a failure midway never loses the imported data.
    await chrome.storage.local.set({ ...writes, [OVERRIDES_KEY]: next });
    if (staleImages.length > 0) await chrome.storage.local.remove(staleImages);
    return { written: Object.keys(writes).length, removed: staleImages.length };
  }

  globalThis.WmioStore = Object.freeze({
    OVERRIDES_KEY,
    IMAGE_PREFIX,
    MODES,
    IMPORT_STRATEGIES,
    idKey,
    nameKey,
    imageKey,
    isValidKey,
    getOverrides,
    getImage,
    saveOverride,
    setMode,
    removeOverride,
    exportBackup,
    parseBackup,
    importBackup,
  });
})();
