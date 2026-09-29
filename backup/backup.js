/**
 * Backup page: exports every override (images included) to a JSON file, and
 * imports such a file with a user-chosen conflict strategy.
 */
(() => {
  const Store = globalThis.WmioStore;

  const $ = (id) => document.getElementById(id);
  const els = {
    exportSummary: $('export-summary'),
    exportButton: $('export'),
    exportStatus: $('export-status'),
    file: $('import-file'),
    importError: $('import-error'),
    plan: $('import-plan'),
    importSummary: $('import-summary'),
    consequence: $('import-consequence'),
    importButton: $('import'),
    importStatus: $('import-status'),
  };

  /** Parsed file waiting for confirmation. */
  let pending = null;

  // Pluralises every word: "nouvelle carte" -> "nouvelles cartes".
  const plural = (count, words) => `${count} ${count > 1 ? words.replace(/\S+/g, '$&s') : words}`;
  const kilobytes = (text) => `${Math.max(1, Math.round(text.length / 1024))} Ko`;

  function setStatus(element, text, success = false) {
    element.textContent = text;
    element.classList.toggle('is-success', success);
  }

  function showImportError(message) {
    els.importError.textContent = message;
    els.importError.hidden = !message;
  }

  // ------------------------------------------------------------------ export

  async function refreshExportSummary() {
    const count = Object.keys(await Store.getOverrides()).length;
    els.exportSummary.textContent = count === 0
      ? 'Aucune image perso enregistrée sur ce PC pour le moment.'
      : `${plural(count, 'carte')} avec une image perso sur ce PC.`;
    els.exportButton.disabled = count === 0;
  }

  async function exportToFile() {
    els.exportButton.disabled = true;
    try {
      const backup = await Store.exportBackup();
      const json = JSON.stringify(backup);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), {
        href: url,
        download: `wikimasters-images-${backup.exportedAt.slice(0, 10)}.json`,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(els.exportStatus, `Sauvegarde créée : ${plural(Object.keys(backup.cards).length, 'carte')}, ${kilobytes(json)}.`, true);
    } catch (error) {
      console.error('[wmio] export', error);
      setStatus(els.exportStatus, `L'export a échoué : ${error.message}`);
    } finally {
      els.exportButton.disabled = false;
    }
  }

  // ------------------------------------------------------------------ import

  const selectedStrategy = () => document.querySelector('input[name="strategy"]:checked').value;

  function describeConsequence() {
    const { newKeys, conflictKeys, localOnlyKeys } = pending;
    const strategy = selectedStrategy();
    const destructive = strategy === 'replace' && localOnlyKeys.length > 0;
    const parts = {
      overwrite: `À écrire : ${plural(newKeys.length + conflictKeys.length, 'carte')}, dont ${conflictKeys.length} remplacée${conflictKeys.length > 1 ? 's' : ''}.`,
      keep: `À ajouter : ${plural(newKeys.length, 'carte')}. Déjà présentes et conservées : ${conflictKeys.length}.`,
      replace: destructive
        ? `${plural(localOnlyKeys.length, 'image perso')} de ce PC ${localOnlyKeys.length > 1 ? 'absentes du fichier seront supprimées' : 'absente du fichier sera supprimée'}. Exporte d'abord si tu veux les garder.`
        : 'Ce PC sera identique au fichier.',
    };
    els.consequence.textContent = parts[strategy];
    els.consequence.classList.toggle('is-destructive', destructive);
    els.importButton.classList.toggle('danger', destructive);
    els.importButton.classList.toggle('primary', !destructive);
    els.importButton.textContent = destructive ? 'Tout remplacer' : 'Importer';
  }

  async function prepareImport(file) {
    pending = null;
    els.plan.hidden = true;
    showImportError('');
    setStatus(els.importStatus, '');
    if (!file) return;

    let parsed;
    try {
      parsed = Store.parseBackup(JSON.parse(await file.text()));
    } catch (error) {
      showImportError(error instanceof SyntaxError ? "Ce fichier n'est pas un JSON valide." : error.message);
      return;
    }

    const fileKeys = Object.keys(parsed.cards);
    if (fileKeys.length === 0) {
      showImportError('Ce fichier ne contient aucune image valide.');
      return;
    }
    const local = await Store.getOverrides();
    pending = {
      cards: parsed.cards,
      newKeys: fileKeys.filter((key) => !local[key]),
      conflictKeys: fileKeys.filter((key) => local[key]),
      localOnlyKeys: Object.keys(local).filter((key) => !parsed.cards[key]),
    };

    const lines = [
      `${plural(fileKeys.length, 'carte')} dans « ${file.name} »`,
      `${plural(pending.newKeys.length, 'nouvelle carte')} pour ce PC`,
      `${plural(pending.conflictKeys.length, 'carte')} ayant déjà une image ici`,
      `${plural(pending.localOnlyKeys.length, 'image perso')} de ce PC absente${pending.localOnlyKeys.length > 1 ? 's' : ''} du fichier`,
    ];
    if (parsed.skipped > 0) lines.push(`${plural(parsed.skipped, 'entrée invalide')} ignorée${parsed.skipped > 1 ? 's' : ''}`);
    els.importSummary.replaceChildren(...lines.map((text) => Object.assign(document.createElement('li'), { textContent: text })));

    els.plan.hidden = false;
    describeConsequence();
  }

  async function runImport() {
    if (!pending) return;
    els.importButton.disabled = true;
    try {
      const { written, removed } = await Store.importBackup(pending.cards, selectedStrategy());
      const removedText = removed > 0 ? `, ${plural(removed, 'image')} supprimée${removed > 1 ? 's' : ''}` : '';
      setStatus(els.importStatus, `Import terminé : ${plural(written, 'image')} écrite${written > 1 ? 's' : ''}${removedText}. Les onglets WikiMasters ouverts se mettent à jour tout seuls.`, true);
      pending = null;
      els.plan.hidden = true;
      els.file.value = '';
      await refreshExportSummary();
    } catch (error) {
      console.error('[wmio] import', error);
      showImportError(`L'import a échoué : ${error.message}`);
    } finally {
      els.importButton.disabled = false;
    }
  }

  // -------------------------------------------------------------------- init

  els.exportButton.addEventListener('click', exportToFile);
  els.file.addEventListener('change', () => prepareImport(els.file.files[0]));
  els.importButton.addEventListener('click', runImport);
  for (const radio of document.querySelectorAll('input[name="strategy"]')) {
    radio.addEventListener('change', describeConsequence);
  }
  refreshExportSummary().catch((error) => setStatus(els.exportStatus, `Erreur : ${error.message}`));
})();
