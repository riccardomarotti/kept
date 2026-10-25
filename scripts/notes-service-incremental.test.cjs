const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const rx = require('rxjs');

// NotesService must update the visible list incrementally on local writes:
// no whole-library re-read on every save, and scoped cache changes touch only
// the affected notes.
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname,
  '../src/app/services/notes.service.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

const moduleCache = new Map();
function loadRelativeModule(specifier, fromDir) {
  const filename = path.resolve(fromDir, specifier + '.ts');
  if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
  const record = { exports: {} };
  moduleCache.set(filename, record);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: record.exports, console, performance: globalThis.performance,
    setTimeout, clearTimeout, queueMicrotask, crypto: globalThis.crypto,
    require(name) {
      if (name.startsWith('.')) return loadRelativeModule(name, path.dirname(filename));
      throw new Error(`Unexpected runtime import: ${name}`);
    }
  }, { filename });
  return record.exports;
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const settleAll = async (times = 4) => { for (let i = 0; i < times; i++) await settle(); };

function harness(t) {
  const notes = [
    { id: 1, syncId: 'note-a', noteTitle: 'Alpha', noteBody: '', pinned: true, sortOrder: 30, isCbox: false, checkBoxes: [], images: [], labels: [], archived: false, trashed: false },
    { id: 2, syncId: 'note-b', noteTitle: 'Bravo', noteBody: '', pinned: false, sortOrder: 20, isCbox: false, checkBoxes: [], images: [], labels: [], archived: false, trashed: false },
    { id: 3, syncId: 'note-c', noteTitle: 'Charlie', noteBody: '', pinned: false, sortOrder: 10, isCbox: false, checkBoxes: [], images: [], labels: [], archived: false, trashed: false }
  ];
  const counters = { listNotes: 0, getNoteBySyncId: 0, getNote: 0, commits: 0, fullPublishes: 0 };
  const cacheChanged$ = new rx.Subject();
  const store = {
    listNotes: async () => { counters.listNotes += 1; return notes.map(note => ({ ...note })); },
    getNote: async (_partition, id) => { counters.getNote += 1; const note = notes.find(candidate => candidate.id === id); return note ? { ...note } : undefined; },
    getNoteBySyncId: async (_partition, syncId) => { counters.getNoteBySyncId += 1; const note = notes.find(candidate => candidate.syncId === syncId); return note ? { ...note } : undefined; },
    putNote: async () => {},
    deleteNote: async () => {},
    listResources: async () => [{ id: 77, syncId: 'att-1', noteId: 2, noteSyncId: 'note-b', originalName: 'f.txt', fileSize: 1, mimeType: 'text/plain', uploadedAt: '' }],
    getBlob: async () => undefined,
    cacheMedia: async () => {},
    offlineMediaUrl: async (_partition, url) => url,
    ensureNoteIdentity: note => note.syncId || 'note-x',
    cancelPendingAttachmentUpload: async () => false
  };
  const sync = {
    partition: 'account:1',
    generation: 'gen-1',
    writesLocally: true,
    cacheChanged$,
    state$: new rx.BehaviorSubject('saved'),
    syncNowCalls: [],
    async commit(type, syncId, payload) {
      counters.commits += 1;
      const existing = notes.find(note => note.syncId === syncId);
      const value = { ...existing, ...payload, syncId, id: payload.id ?? existing?.id ?? 42 };
      if (type.endsWith('.delete')) {
        const index = notes.findIndex(note => note.syncId === syncId);
        if (index >= 0) notes.splice(index, 1);
        cacheChanged$.next({ noteSyncIds: [syncId], reminders: true });
        return value;
      }
      if (value.sortOrder == null) value.sortOrder = 100; // mirrors commitMutation assigning the highest order
      if (existing) Object.assign(existing, value);
      else notes.push(value);
      cacheChanged$.next({ noteSyncIds: [syncId], reminders: type.startsWith('reminder') });
      return value;
    },
    syncNow(options) { this.syncNowCalls.push(options); return Promise.resolve(); },
    enqueue: async () => ({ operationId: 'op-1' }),
    isConnectionDegraded: () => false,
    markConnectionDegraded() {},
    clearConnectionDegraded() {}
  };
  const reminders = {
    calls: { refreshNoteContent: 0, load: 0, markNoteInactive: 0 },
    async refreshNoteContent() { this.calls.refreshNoteContent += 1; },
    async load() { this.calls.load += 1; },
    markNoteInactive() { this.calls.markNoteInactive += 1; },
    updateNoteLifecycle() {},
    getActiveForNote() { return undefined; }
  };
  const auth = {
    currentUser: { id: 1, token: 'token' },
    isLocal: false,
    usesBrowserSession: true,
    workspace: { ready: Promise.resolve() },
    accessChanges$: new rx.Subject(),
    authHeaders: () => ({}),
    canonicalImageUrl: value => value,
    canonicalImageHtml: value => value,
    authenticatedImageHtml: value => value,
    authenticatedImageUrl: value => value,
    prepareImageUrl: async value => value,
    isAuthExpiredError: () => false,
    notifySessionExpired: () => false
  };
  const preferences = { value: { richLinkPreviews: false } };
  const http = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, () => rx.throwError(() => new Error('network disabled'))]));
  const sandbox = {
    exports: {}, console, performance: globalThis.performance,
    setTimeout, clearTimeout, queueMicrotask,
    navigator: { onLine: true }, window: {}, document: { visibilityState: 'visible' },
    WebSocket: class { constructor() {} close() {} },
    URL, Blob, File: class {}, FormData: class {},
    require(name) {
      if (name === '@angular/core') return { Injectable: () => target => target };
      if (name === '@angular/common/http') return { HttpErrorResponse: class extends Error {} };
      if (name === '@capacitor/core') return {
        Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
        registerPlugin: () => ({})
      };
      if (name === 'rxjs') return rx;
      if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
      if (name.startsWith('.')) return loadRelativeModule(name, path.join(__dirname, '../src/app/services'));
      throw new Error(`Unexpected runtime import: ${name}`);
    }
  };
  vm.runInNewContext(source, sandbox);
  const service = new sandbox.exports.NotesService(http, auth, reminders, store, sync, preferences);
  t.after(() => {});
  return { service, notes, counters, store, sync, reminders, cacheChanged$ };
}

test('a local save updates the visible note without reloading the library', async t => {
  const h = harness(t);
  await h.service.load();
  await settleAll();
  const readsAfterLoad = h.counters.listNotes;
  assert.equal(h.counters.listNotes, readsAfterLoad);

  await h.service.update({ noteTitle: 'Alpha edited' }, 1);
  await settleAll();
  assert.equal(h.counters.listNotes, readsAfterLoad, 'saving must not re-read the whole cache');
  const visible = h.service.notesList$.value.find(note => note.id === 1);
  assert.equal(visible.noteTitle, 'Alpha edited');
  assert.equal(h.reminders.calls.refreshNoteContent, 1);
});

test('scoped cache changes touch only the affected notes', async t => {
  const h = harness(t);
  await h.service.load();
  await settleAll();
  h.counters.listNotes = 0;
  h.counters.getNoteBySyncId = 0;

  h.cacheChanged$.next({ noteSyncIds: ['note-b'] });
  await settleAll();
  assert.equal(h.counters.listNotes, 0, 'a scoped change must not trigger a full publish');
  assert.equal(h.counters.getNoteBySyncId, 1);
  assert.equal(h.service.notesList$.value.find(note => note.id === 2).noteTitle, 'Bravo');

  h.cacheChanged$.next({ noteSyncIds: [], preferences: true });
  await settleAll();
  assert.equal(h.counters.listNotes, 0, 'a change that touches no note must not repaint the list');

  h.cacheChanged$.next(undefined);
  h.cacheChanged$.next(undefined);
  await settleAll();
  assert.equal(h.counters.listNotes, 1, 'full invalidations coalesce into a single publish');
});

test('new and deleted notes update the list incrementally in sorted order', async t => {
  const h = harness(t);
  await h.service.load();
  await settleAll();

  const id = await h.service.add({ noteTitle: 'Fresh', noteBody: '', pinned: false, isCbox: false, checkBoxes: [], images: [], labels: [], archived: false, trashed: false });
  await settleAll();
  assert.equal(id, 42);
  const titles = Array.from(h.service.notesList$.value, note => note.noteTitle);
  assert.deepEqual(titles, ['Alpha', 'Fresh', 'Bravo', 'Charlie'], 'pinned first, then by recency');

  await h.service.delete(2);
  await settleAll();
  assert.deepEqual(Array.from(h.service.notesList$.value, note => note.noteTitle), ['Alpha', 'Fresh', 'Charlie']);
  assert.equal(h.reminders.calls.markNoteInactive, 1);
});

test('attachment changes refresh their parent note only', async t => {
  const h = harness(t);
  await h.service.load();
  await settleAll();
  h.counters.listNotes = 0;
  h.notes.find(note => note.id === 2).noteSyncId = 'note-b';
  await h.service.deleteAttachment(2, 77);
  await settleAll();
  assert.equal(h.counters.listNotes, 0);
  assert.equal(h.counters.commits, 1);
});
