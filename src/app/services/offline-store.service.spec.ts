import { NoteI } from '../interfaces/notes';
import { OfflineStoreService } from './offline-store.service';

describe('OfflineStoreService', () => {
  let store: OfflineStoreService;
  let partition: string;
  let otherPartition: string;

  const note = (id: number, syncId: string, noteTitle: string, updatedAt = '2030-01-01T00:00:00.000Z'): NoteI => ({
    id,
    syncId,
    noteTitle,
    noteBody: '',
    pinned: false,
    bgColor: '',
    bgImage: '',
    checkBoxes: [],
    images: [],
    isCbox: false,
    labels: [],
    archived: false,
    trashed: false,
    updatedAt
  });

  beforeEach(() => {
    store = new OfflineStoreService();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    partition = `spec-${suffix}`;
    otherPartition = `spec-${suffix}-other`;
  });

  afterEach(async () => {
    await store.purgePartition(partition);
    await store.purgePartition(otherPartition);
  });

  it('gets a note back by id after it is written', async () => {
    await store.putNote(partition, note(7, 'sync-7', 'Seven'));
    const loaded = await store.getNote(partition, 7);
    expect(loaded?.noteTitle).toBe('Seven');
    expect(loaded?.syncId).toBe('sync-7');
  });

  it('keeps only the newest record when one note id is written under two sync ids', async () => {
    await store.putNote(partition, note(7, 'sync-old', 'Old', '2020-01-01T00:00:00.000Z'));
    await store.putNote(partition, note(7, 'sync-new', 'New', '2030-01-01T00:00:00.000Z'));
    const notes = await store.listNotes(partition);
    expect(notes.length).toBe(1);
    expect(notes[0].noteTitle).toBe('New');
    expect((await store.getNote(partition, 7))?.noteTitle).toBe('New');
  });

  it('prefers the newest record even when writes arrive out of order', async () => {
    await store.putNote(partition, note(7, 'sync-new', 'New', '2030-01-01T00:00:00.000Z'));
    await store.putNote(partition, note(7, 'sync-old', 'Old', '2020-01-01T00:00:00.000Z'));
    expect((await store.getNote(partition, 7))?.noteTitle).toBe('New');
    expect((await store.listNotes(partition)).length).toBe(1);
  });

  it('exposes notes stored through replaceSnapshot to id lookups', async () => {
    await store.replaceSnapshot(partition, [note(11, 'sync-11', 'Eleven')], [], [], 3, Date.now());
    expect((await store.getNote(partition, 11))?.noteTitle).toBe('Eleven');
  });

  it('keeps equal note ids from different partitions apart', async () => {
    await store.putNote(partition, note(7, 'sync-mine', 'Mine'));
    await store.putNote(otherPartition, note(7, 'sync-theirs', 'Theirs'));
    expect((await store.getNote(partition, 7))?.noteTitle).toBe('Mine');
    expect((await store.getNote(otherPartition, 7))?.noteTitle).toBe('Theirs');
  });

  it('deletes notes by sync id', async () => {
    await store.putNote(partition, note(7, 'sync-7', 'Seven'));
    await store.deleteNote(partition, 'sync-7');
    expect(await store.getNote(partition, 7)).toBeUndefined();
  });

  it('downloads media only once per url', async () => {
    const originalFetch = window.fetch;
    let fetches = 0;
    (window as unknown as { fetch: unknown }).fetch = async () => {
      fetches += 1;
      return { ok: true, blob: async () => new Blob(['image-bytes']) };
    };
    try {
      await store.cacheMedia(partition, '/uploads/images/pic.png', '/api/uploads/images/pic.png');
      await store.cacheMedia(partition, '/uploads/images/pic.png', '/api/uploads/images/pic.png');
      expect(fetches).toBe(1);
    } finally {
      (window as unknown as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
