/**
 * Tests for the backup export/import logic in src/storage.js.
 * Run with: node --test
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** In-memory stand-in for chrome.storage.local. */
let data = {};
const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return structuredClone(data);
        const result = {};
        for (const key of [].concat(keys)) if (key in data) result[key] = structuredClone(data[key]);
        return result;
      },
      async set(items) { Object.assign(data, structuredClone(items)); },
      async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    },
  },
};

const context = vm.createContext({ chrome, structuredClone, Date, Number, Object, Error });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'storage.js'), 'utf8'), context);
const Store = context.WmioStore;

const image = (content) => `data:image/webp;base64,${Buffer.from(content).toString('base64')}`;
const card = (name, mode, content) => ({ name, category: 'cat', mode, image: image(content) });

/** Backup exported from a "PC A" holding cards id:a and name:B. */
async function backupFromPcA() {
  data = {};
  await Store.saveOverride('id:a', card('A', 'always', 'imgA'));
  await Store.saveOverride('name:B', card('B', 'missing', 'imgB'));
  return JSON.parse(JSON.stringify(await Store.exportBackup()));
}

/** "PC B" already has its own id:a (conflict) and name:C (local only). */
async function setUpPcB() {
  data = {};
  await Store.saveOverride('id:a', card('A', 'missing', 'localA'));
  await Store.saveOverride('name:C', card('C', 'always', 'imgC'));
}

let cards;
beforeEach(async () => {
  ({ cards } = Store.parseBackup(await backupFromPcA()));
  await setUpPcB();
});

test('export contains every override with its image', async () => {
  const backup = await backupFromPcA();
  assert.equal(backup.format, 'wmio-backup');
  assert.equal(backup.version, 1);
  assert.deepEqual(Object.keys(backup.cards).sort(), ['id:a', 'name:B']);
  assert.equal(backup.cards['id:a'].image, image('imgA'));
  assert.equal(backup.cards['name:B'].mode, 'missing');
});

test('"overwrite" lets the file win and keeps local-only cards', async () => {
  assert.deepEqual({ ...(await Store.importBackup(cards, 'overwrite')) }, { written: 2, removed: 0 });
  assert.equal(data['img:id:a'], image('imgA'));
  assert.equal(data.overrides['id:a'].mode, 'always');
  assert.ok(data.overrides['name:C'] && data['img:name:C']);
  assert.equal(data.overrides['id:a'].image, undefined, 'images must not leak into the overrides map');
});

test('"keep" preserves local cards and only adds new ones', async () => {
  assert.deepEqual({ ...(await Store.importBackup(cards, 'keep')) }, { written: 1, removed: 0 });
  assert.equal(data['img:id:a'], image('localA'));
  assert.equal(data['img:name:B'], image('imgB'));
});

test('"replace" makes storage identical to the file', async () => {
  assert.deepEqual({ ...(await Store.importBackup(cards, 'replace')) }, { written: 2, removed: 1 });
  assert.deepEqual(Object.keys(data.overrides).sort(), ['id:a', 'name:B']);
  assert.deepEqual(Object.keys(data).sort(), ['img:id:a', 'img:name:B', 'overrides']);
});

test('files that are not backups are rejected', () => {
  assert.throws(() => Store.parseBackup({ foo: 1 }), /pas une sauvegarde/);
  assert.throws(() => Store.parseBackup(null), /pas une sauvegarde/);
  assert.throws(() => Store.parseBackup({ format: 'wmio-backup', version: 99, cards: {} }), /Version/);
});

test('invalid entries are skipped, valid ones kept', () => {
  const parsed = Store.parseBackup({
    format: 'wmio-backup',
    version: 1,
    cards: {
      'id:ok': card('ok', 'always', 'x'),
      'no-prefix': card('e', 'always', 'x'),
      'id:bad-mode': card('m', 'sometimes', 'x'),
      'id:js': { ...card('j', 'always', 'x'), image: 'javascript:alert(1)' },
      'id:svg': { ...card('s', 'always', 'x'), image: 'data:image/svg+xml;base64,PHN2Zz4=' },
    },
  });
  assert.deepEqual(Object.keys(parsed.cards), ['id:ok']);
  assert.equal(parsed.skipped, 4);
});

test('unknown import strategy is refused', async () => {
  await assert.rejects(() => Store.importBackup(cards, 'nope'), /Invalid strategy/);
});
