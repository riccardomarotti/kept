const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../test-support/workspace-store.cjs');

// Regression tests for the incremental reconcile() rewrite: empty pulls must
// not rewrite notes, and change sets must only touch the affected resources.
const serverWorkspace = async store => store.ensureServerWorkspace('server|1');

test('an empty reconcile keeps notes untouched and still advances cursor metadata', async () => {
  const store = createStore();
  const workspace = await serverWorkspace(store);
  await store.reconcile(workspace, {
    snapshot: { note: [{ id: 1, syncId: 'note-a', noteTitle: 'A' }, { id: 2, syncId: 'note-b', noteTitle: 'B' }] },
    cursor: 10, serverTime: Date.now()
  });
  const before = await store.listNotes(workspace.partition);

  const summary = await store.reconcile(workspace, { cursor: 10, serverTime: Date.now() + 5000 });
  assert.equal(summary.changed, false);
  assert.equal(summary.notesRewritten, 0);
  assert.deepEqual([...summary.noteSyncIds], []);
  assert.equal((await store.getSyncState(workspace.partition)).cursor, 10, 'cursor must not move backwards');
  const after = await store.listNotes(workspace.partition);
  assert.deepEqual(after.map(note => [note.syncId, note.noteTitle]), before.map(note => [note.syncId, note.noteTitle]));

  // An empty change set can still consume server sequence numbers.
  const advanced = await store.reconcile(workspace, { cursor: 42, serverTime: Date.now() + 5000 });
  assert.equal(advanced.changed, false);
  assert.equal(advanced.notesRewritten, 0);
  assert.equal((await store.getSyncState(workspace.partition)).cursor, 42);
});

test('a single remote update rewrites only its own note row', async () => {
  const store = createStore();
  const workspace = await serverWorkspace(store);
  await store.reconcile(workspace, {
    snapshot: { note: [{ id: 1, syncId: 'note-a', noteTitle: 'A' }, { id: 2, syncId: 'note-b', noteTitle: 'B' }, { id: 3, syncId: 'note-c', noteTitle: 'C' }] },
    cursor: 1, serverTime: Date.now()
  });

  const summary = await store.reconcile(workspace, {
    changes: [{ sequence: 2, resourceType: 'note', resourceSyncId: 'note-b', operation: 'upsert', payload: { id: 2, syncId: 'note-b', noteTitle: 'B changed' } }],
    cursor: 2, serverTime: Date.now()
  });
  assert.equal(summary.changed, true);
  assert.equal(summary.notesRewritten, 1);
  assert.deepEqual([...summary.noteSyncIds], ['note-b']);
  const notes = await store.listNotes(workspace.partition);
  assert.equal(notes.find(note => note.syncId === 'note-b').noteTitle, 'B changed');
  assert.equal(notes.find(note => note.syncId === 'note-a').noteTitle, 'A');
});

test('echoed acknowledgements matching the stored projection are not visible changes', async () => {
  const store = createStore();
  const workspace = await serverWorkspace(store);
  await store.reconcile(workspace, {
    snapshot: { note: [{ id: 1, syncId: 'note-a', noteTitle: 'Stable' }] },
    cursor: 1, serverTime: Date.now()
  });
  await store.commitMutation(workspace, 'note.upsert', 'note-a', { noteTitle: 'Edited locally' });
  const [entry] = await store.listOutbox(workspace.partition);

  // The server echoes the accepted write back as the canonical value.
  const accepted = { ...(await store.getNote(workspace.partition, 1)) };
  const summary = await store.reconcile(workspace, {
    sent: [entry], results: [{ operationId: entry.operationId, ok: true, canonical: accepted }],
    changes: [{ sequence: 2, resourceType: 'note', resourceSyncId: 'note-a', operation: 'upsert', payload: accepted }],
    cursor: 2, serverTime: Date.now()
  });
  assert.equal(summary.notesRewritten, 0, 'an identical echo must not rewrite the note row');
  assert.equal(summary.changed, false);
  assert.equal((await store.listOutbox(workspace.partition)).length, 0, 'the acked entry must be removed');
});

test('attachment changes rematerialize only their parent note', async () => {
  const store = createStore();
  const workspace = await serverWorkspace(store);
  await store.reconcile(workspace, {
    snapshot: {
      note: [{ id: 1, syncId: 'note-a', noteTitle: 'A' }, { id: 2, syncId: 'note-b', noteTitle: 'B' }],
      attachment: [{ id: 10, syncId: 'att-1', noteId: 1, noteSyncId: 'note-a', originalName: 'old.txt' }]
    },
    cursor: 1, serverTime: Date.now()
  });

  const summary = await store.reconcile(workspace, {
    changes: [{ sequence: 2, resourceType: 'attachment', resourceSyncId: 'att-1', operation: 'upsert', payload: { id: 10, syncId: 'att-1', noteId: 1, noteSyncId: 'note-a', originalName: 'new.txt' } }],
    cursor: 2, serverTime: Date.now()
  });
  assert.deepEqual([...summary.noteSyncIds].sort(), ['note-a']);
  assert.equal(summary.notesRewritten, 1);
  const notes = await store.listNotes(workspace.partition);
  assert.equal(notes.find(note => note.syncId === 'note-a').attachments[0].originalName, 'new.txt');
  assert.equal((notes.find(note => note.syncId === 'note-b').attachments || []).length, 0);
});

test('label catalog changes refresh only the notes that apply the label', async () => {
  const store = createStore();
  const workspace = await serverWorkspace(store);
  await store.reconcile(workspace, {
    snapshot: {
      note: [
        { id: 1, syncId: 'note-a', noteTitle: 'A', labels: [{ id: 5, syncId: 'label-1', name: 'Old name', added: true }] },
        { id: 2, syncId: 'note-b', noteTitle: 'B', labels: [] }
      ],
      label: [{ id: 5, syncId: 'label-1', name: 'Old name' }]
    },
    cursor: 1, serverTime: Date.now()
  });

  const summary = await store.reconcile(workspace, {
    changes: [{ sequence: 2, resourceType: 'label', resourceSyncId: 'label-1', operation: 'upsert', payload: { id: 5, syncId: 'label-1', name: 'Renamed' } }],
    cursor: 2, serverTime: Date.now()
  });
  assert.equal(summary.labelsChanged, true);
  assert.deepEqual([...summary.noteSyncIds], ['note-a'], 'only the labelled note needs a rewrite');
  const notes = await store.listNotes(workspace.partition);
  const applied = notes.find(note => note.syncId === 'note-a').labels[0];
  assert.equal(applied.name, 'Renamed');
  assert.equal(applied.added, true, 'catalog refreshes preserve the note’s applied flag');
});

test('reorder overlays only rewrite the ordered rows', async () => {
  const store = createStore();
  const workspace = await serverWorkspace(store);
  await store.reconcile(workspace, {
    snapshot: { note: [{ id: 1, syncId: 'note-a', noteTitle: 'A', sortOrder: 10 }, { id: 2, syncId: 'note-b', noteTitle: 'B', sortOrder: 20 }, { id: 3, syncId: 'note-c', noteTitle: 'C', sortOrder: 30 }] },
    cursor: 1, serverTime: Date.now()
  });
  await store.commitMutation(workspace, 'note.reorder', 'note-order', { syncIds: ['note-c', 'note-a'] });

  const summary = await store.reconcile(workspace, { cursor: 2, serverTime: Date.now() });
  assert.equal(summary.changed, false, 'commitMutation already persisted the visible order');
  assert.equal(summary.notesRewritten, 0);
  const notes = await store.listNotes(workspace.partition);
  assert.ok(notes.find(note => note.syncId === 'note-c').sortOrder > notes.find(note => note.syncId === 'note-a').sortOrder);
});
