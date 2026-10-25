const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const rx = require('rxjs');

// Regression tests for the coalescing sync scheduler and scoped cache
// invalidation: no-op pulls must not reconcile or repaint, duplicate startup
// triggers must collapse into one cycle, and new local work during a cycle
// must still be drained exactly once.
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname,
  '../src/app/services/offline-sync.service.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
}).outputText;

class HttpErrorResponse extends Error {
  constructor({ status }) { super(`HTTP ${status}`); this.status = status; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const settleAll = async (times = 4) => { for (let i = 0; i < times; i++) await settle(); };

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
    setTimeout, clearTimeout, queueMicrotask,
    require(name) {
      if (name.startsWith('.')) return loadRelativeModule(name, path.dirname(filename));
      throw new Error(`Unexpected runtime import: ${name}`);
    }
  }, { filename });
  return record.exports;
}

function harness(t, { cursor = 10, cachedNotes = [{ id: 1, syncId: 'note-a', noteTitle: 'A' }] } = {}) {
  const clock = {
    now: 100000, nextId: 0, timers: new Map(),
    setTimeout(callback, delay) { const id = ++this.nextId; this.timers.set(id, { callback, at: this.now + delay }); return id; },
    clearTimeout(id) { this.timers.delete(id); },
    async advance(ms) {
      const end = this.now + ms;
      for (;;) {
        const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        this.now = next[1].at;
        this.timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      this.now = end;
      await settle();
    }
  };
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const navigator = { onLine: true };
  const callbacks = new Map();
  const app = {
    async addListener(event, callback) {
      callbacks.set(event, callback);
      return { remove: async () => callbacks.delete(event) };
    }
  };
  let sequence = 0;
  const queued = [];
  const reconcileCalls = [];
  const cacheChanges = [];
  const store = {
    partition: id => `account:${id}`,
    ensureServerWorkspace: async partition => ({ id: partition, partition, generation: 'test', status: 'active', protocolVersion: 1 }),
    patchWorkspace: async () => {},
    reconcile: async (_workspace, input) => {
      reconcileCalls.push(input);
      for (const result of input.results || []) {
        if (!result.ok) continue;
        const entry = (input.sent || []).find(candidate => candidate.operationId === result.operationId);
        if (entry) await store.removeOutbox([entry.key]);
      }
      const changes = input.changes || [];
      return {
        changed: !!(input.snapshot || changes.length || (input.results || []).length),
        noteSyncIds: changes.flatMap(change => change.resourceType === 'note'
          ? [change.resourceSyncId]
          : change.payload?.noteSyncId ? [change.payload.noteSyncId] : []),
        remindersChanged: changes.some(change => change.resourceType === 'reminder'),
        labelsChanged: changes.some(change => change.resourceType === 'label'),
        bindersChanged: changes.some(change => change.resourceType === 'binder'),
        savedPlacesChanged: changes.some(change => change.resourceType === 'savedPlace'),
        preferencesChanged: changes.some(change => change.resourceType === 'preferences'),
        notesRewritten: 0
      };
    },
    purgePartition: async () => {},
    getSyncState: async () => ({ cursor, serverOffsetMs: 0 }),
    setSyncState: async () => {},
    listNotes: async () => cachedNotes,
    replaceSnapshot: async () => {},
    listOutbox: async () => [...queued],
    nextStamp: () => ({ operationId: `op-${++sequence}`, physicalMs: clock.now, logical: 0, deviceId: 'test' }),
    enqueue: async (partition, type, syncId, payload, lww) => queued.push({
      key: lww.operationId, operationId: lww.operationId, partition, type, syncId, payload, lww
    }),
    commitMutation: async (workspace, type, syncId, payload) => {
      const stamp = store.nextStamp();
      await store.enqueue(workspace.partition, type, syncId, payload, stamp);
      return { ...payload, syncId, id: payload.id ?? 42 };
    },
    removeOutbox: async keys => {
      for (let i = queued.length - 1; i >= 0; i--) if (keys.includes(queued[i].key)) queued.splice(i, 1);
    },
    getBlob: async () => null,
    cacheMedia: async () => {}
  };
  const auth = {
    workspace: { ready: Promise.resolve() },
    currentUser$: new rx.BehaviorSubject(null),
    get currentUser() { return this.currentUser$.value; },
    isLocal: false,
    authHeaders: () => ({}),
    canonicalImageUrl: value => value,
    prepareImageUrl: async value => value
  };
  const requests = [];
  let respond = (method, _url, body) => rx.of(method === 'POST'
    ? { results: (body?.mutations || []).map(mutation => ({ ok: true, operationId: mutation.operationId })), serverTime: clock.now }
    : { changes: [], cursor, hasMore: false, serverTime: clock.now });
  const http = Object.fromEntries(['get', 'post'].map(method => [method, (url, body) => rx.defer(() => {
    requests.push({ method: method.toUpperCase(), url, body, at: clock.now });
    return respond(method.toUpperCase(), url, body);
  })]));
  const sandbox = {
    exports: {}, navigator, window, document,
    console: { error: () => {}, warn: () => {} },
    Date: { now: () => clock.now }, queueMicrotask,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    performance: globalThis.performance,
    require(name) {
      if (name === '@angular/core') return { Injectable: () => target => target };
      if (name === '@angular/common/http') return { HttpErrorResponse };
      if (name === '@capacitor/core') return {
        Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => false },
        registerPlugin: () => app
      };
      if (name === 'rxjs') return rx;
      if (name.endsWith('/environment')) return { environment: { apiUrl: '/api' } };
      if (name.startsWith('.')) return loadRelativeModule(name, path.join(__dirname, '../src/app/services'));
      throw new Error(`Unexpected runtime import: ${name}`);
    }
  };
  vm.runInNewContext(source, sandbox);
  const service = new sandbox.exports.OfflineSyncService(http, auth, store, { run: work => work() });
  service.cacheChanged$.subscribe(change => cacheChanges.push(change));
  const states = [];
  service.state$.subscribe(state => states.push(state));
  t.after(() => service.ngOnDestroy());
  return {
    service, states, store, queued, requests, reconcileCalls, cacheChanges, clock, navigator, window, document,
    respond: handler => { respond = handler; },
    login: async () => { auth.currentUser$.next({ id: 1 }); await settleAll(); },
    commit: async (type, syncId, payload) => {
      const value = await service.commit(type, syncId, payload);
      await settleAll();
      return value;
    },
    emit: event => window.dispatchEvent(new Event(event)),
    changesUrl: () => '/api/sync/changes'
  };
}

test('an empty pull reconciles nothing, repaints nothing and settles promptly', async t => {
  const h = harness(t);
  await h.login();
  const requestsAfterLogin = h.requests.length;
  assert.deepEqual(h.requests.map(request => request.url), ['/api/sync/changes'], 'startup is a single lightweight check');
  assert.equal(h.reconcileCalls.length, 0, 'an empty change set must not run a reconcile transaction');
  assert.equal(h.cacheChanges.length, 0, 'an empty sync must not invalidate any cache');
  assert.equal(h.service.state$.value, 'saved');

  // Reopening (visibility recovery) right after does not repeat the work.
  h.document.dispatchEvent(new Event('visibilitychange'));
  await settleAll();
  assert.equal(h.requests.length, requestsAfterLogin, 'redundant visibility recovery is coalesced');

  // After the freshness window a genuine check runs again and is still cheap.
  await h.clock.advance(6000);
  h.document.dispatchEvent(new Event('visibilitychange'));
  await settleAll();
  assert.equal(h.requests.length, requestsAfterLogin + 1);
  assert.equal(h.reconcileCalls.length, 0);
  assert.equal(h.cacheChanges.length, 0);
});

test('simultaneous startup triggers collapse into a single cycle', async t => {
  const h = harness(t, { cursor: 0, cachedNotes: [] });
  const bootstrapResponse = new rx.Subject();
  const changesResponse = new rx.Subject();
  h.respond((_method, url) => url.endsWith('/bootstrap') ? bootstrapResponse : changesResponse);
  await h.login();
  // The login burst: every service asks for the same startup sync.
  await h.service.syncNow({ bootstrapIfEmpty: true });
  await h.service.syncNow({ bootstrapIfEmpty: true });
  await h.service.syncNow({ reason: 'visibility' });
  assert.equal(h.requests.length, 1, 'triggers during the running cycle are coalesced');
  bootstrapResponse.next({ notes: [{ id: 1, syncId: 'note-a', noteTitle: 'A' }], reminders: [], attachments: [], cursor: 5, serverTime: 100000 });
  await settleAll();
  changesResponse.next({ changes: [], cursor: 5, hasMore: false, serverTime: 100000 });
  await settleAll();
  const urls = h.requests.map(request => request.url);
  assert.equal(urls.filter(url => url === '/api/sync/bootstrap').length, 1, 'exactly one bootstrap');
  assert.equal(urls.filter(url => url === '/api/sync/changes').length, 1, 'exactly one follow-up pull');
  assert.equal(h.service.state$.value, 'saved');
});

test('a new edit during an active sync is drained by exactly one follow-up', async t => {
  const h = harness(t);
  const pull = new rx.Subject();
  h.respond(() => pull);
  await h.login();
  await h.commit('note.upsert', 'note-a', { noteTitle: 'During sync' });
  h.respond((method, _url, body) => rx.of(method === 'POST'
    ? { results: (body?.mutations || []).map(mutation => ({ ok: true, operationId: mutation.operationId })), serverTime: h.clock.now }
    : { changes: [], cursor: 11, hasMore: false, serverTime: h.clock.now }));
  pull.next({ changes: [], cursor: 10, hasMore: false, serverTime: h.clock.now });
  await settleAll();
  assert.equal(h.queued.length, 0, 'the outbox is drained');
  assert.deepEqual(h.requests.map(request => request.method), ['GET', 'POST', 'GET'], 'one coalesced follow-up cycle');
  assert.equal(h.service.state$.value, 'saved');
});

test('work committed before the cycle drains does not spawn a redundant pass', async t => {
  const h = harness(t, { cursor: 0, cachedNotes: [] });
  const bootstrapResponse = new rx.Subject();
  h.respond((method, url, body) => {
    if (url.endsWith('/bootstrap')) return bootstrapResponse;
    return rx.of(method === 'POST'
      ? { results: (body?.mutations || []).map(mutation => ({ ok: true, operationId: mutation.operationId })), serverTime: h.clock.now }
      : { changes: [], cursor: 5, hasMore: false, serverTime: h.clock.now });
  });
  await h.login();
  // The edit lands while the cycle is still starting: the same cycle's
  // flushOutbox will drain it, so no follow-up pass may run.
  await h.commit('note.upsert', 'note-a', { noteTitle: 'Queued early' });
  bootstrapResponse.next({ notes: [], reminders: [], attachments: [], cursor: 5, serverTime: h.clock.now });
  await settleAll();
  assert.equal(h.queued.length, 0, 'the running cycle drained the new entry');
  const before = h.requests.length;
  assert.deepEqual(h.requests.map(request => request.method), ['GET', 'POST', 'GET'], 'bootstrap, one drain, one pull');
  await h.clock.advance(30000);
  assert.equal(h.requests.length, before, 'no residual sync loop after the drain');
});

test('cache invalidation is scoped to the resources a commit or pull touched', async t => {
  const h = harness(t);
  await h.login();
  h.cacheChanges.length = 0;
  await h.commit('note.upsert', 'note-a', { noteTitle: 'Edited' });
  const noteChange = h.cacheChanges.find(change => change && Array.isArray(change.noteSyncIds));
  assert.ok(noteChange, 'a note commit reports the affected note');
  assert.deepEqual([...noteChange.noteSyncIds], ['note-a']);

  h.respond(() => rx.of({
    changes: [{ sequence: 11, resourceType: 'reminder', resourceSyncId: 'reminder-1', operation: 'upsert', payload: { syncId: 'reminder-1', noteSyncId: 'note-b' } }],
    cursor: 11, hasMore: false, serverTime: h.clock.now
  }));
  h.cacheChanges.length = 0;
  await h.service.syncNow({ reason: 'test' });
  await settleAll();
  const scoped = h.cacheChanges.find(change => change && Array.isArray(change.noteSyncIds) && change.reminders);
  assert.ok(scoped, 'a pulled reminder change reports reminders and its note');
  assert.deepEqual([...scoped.noteSyncIds], ['note-b']);
});

test('remote changes are applied exactly once and keep the cursor', async t => {
  const h = harness(t);
  let pulls = 0;
  h.respond((method, url, body) => {
    if (url.endsWith('/sync/changes')) {
      pulls += 1;
      return rx.of({ changes: pulls === 1
        ? [{ sequence: 11, resourceType: 'note', resourceSyncId: 'note-b', operation: 'upsert', payload: { syncId: 'note-b', noteTitle: 'Remote' } }]
        : [], cursor: 11, hasMore: false, serverTime: h.clock.now });
    }
    return rx.of({ results: (body?.mutations || []).map(mutation => ({ ok: true, operationId: mutation.operationId })), serverTime: h.clock.now });
  });
  await h.login();
  await h.service.syncNow({ reason: 'test' });
  await settleAll();
  assert.equal(pulls, 2);
  assert.equal(h.reconcileCalls.filter(call => (call.changes || []).length).length, 1, 'the remote change is reconciled exactly once');
  assert.equal(h.reconcileCalls.filter(call => (call.changes || []).length)[0].cursor, 11, 'the cursor does not skip unprocessed changes');
});
