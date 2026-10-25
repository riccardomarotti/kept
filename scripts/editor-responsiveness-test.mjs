import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Verifies that closing an edited note responds as
// soon as the edit is durably committed on the device — not when the server
// answers — and that slow/failing storage or networking never loses text.
const fixture = await startFixture();
let browser;
try {
  const credentials = { username: 'owner', displayName: 'Owner', password: 'test-password-123' };
  const api = async (path, method = 'GET', body, token) => {
    const response = await fetch(fixture.origin + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  await api('/setup/admin', 'POST', credentials);
  await fixture.sql('UPDATE users SET demoNotesCreatedAt = ?', [new Date().toISOString()]);
  const { token } = await api('/auth/login', 'POST', credentials);
  const seeded = [];
  for (let index = 0; index < 12; index += 1) {
    seeded.push(await api('/notes', 'POST', {
      noteTitle: `Responsiveness ${index}`, noteBody: `Body ${index}`, isCbox: false, pinned: false,
      bgColor: '', bgImage: '', checkBoxes: [], images: [], labels: [], archived: false, trashed: false
    }, token));
  }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile Back' : 'desktop Close';
    const context = await browser.newContext({
      viewport: { width: mobile ? 390 : 1280, height: 900 }, hasTouch: mobile, serviceWorkers: 'block'
    });
    await context.addInitScript(() => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      localStorage.setItem('kept_perf', '1');
      // Failure injection for local storage: abort read-write transactions
      // on demand so the editor's durable-save error path can be exercised.
      window.__failStorageWrites = false;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args);
        if (window.__failStorageWrites && args[1] === 'readwrite') queueMicrotask(() => tx.abort());
        return tx;
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => console.error('Browser error:', error));
    // Slow server: both the legacy note endpoints and the journal-first sync
    // flush are delayed well beyond the acceptable close latency.
    await page.route('**/api/sync/mutations', async route => {
      await new Promise(resolve => setTimeout(resolve, 6000));
      await route.continue();
    });
    await page.route(/\/api\/notes\/\d+$/, async route => {
      if (route.request().method() === 'PUT' || route.request().method() === 'PATCH') {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
      await route.continue();
    });
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('app-notes').waitFor();

    const closeEditor = async editor => {
      if (mobile) await editor.locator('.mobile-top-bar button.back').click();
      else await editor.getByRole('button', { name: 'Close', exact: true }).click();
    };

    // 1. Closing an edited note must be fast although the server is slow.
    await page.getByText('Responsiveness 0', { exact: true }).click();
    let editor = page.locator('app-input .note-main:visible').last();
    await editor.locator('.note-body[contenteditable]').fill('Edited with a slow server');
    const t0 = Date.now();
    await closeEditor(editor);
    await editor.waitFor({ state: 'hidden' });
    const closeMs = Date.now() - t0;
    assert.ok(closeMs < 2000, `${label}: close took ${closeMs}ms with a 6s-slow server`);
    let editorSave = null;
    for (let attempt = 0; attempt < 20 && !editorSave; attempt += 1) {
      editorSave = await page.evaluate(() => {
        const snapshot = window.__keptPerf?.snapshot() || {};
        return snapshot['editor.save'] || null;
      });
      if (!editorSave) await page.waitForTimeout(100);
    }
    assert.ok(editorSave, `${label}: editor.save must be instrumented`);
    assert.ok(editorSave.maxMs < 500, `${label}: durable local save took ${editorSave.maxMs}ms`);

    // 2. The edit survives a reload and reaches the server later.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Responsiveness 0', { exact: true }).waitFor();
    await page.getByText('Responsiveness 0', { exact: true }).click();
    editor = page.locator('app-input .note-main:visible').last();
    await editor.locator('.note-body[contenteditable]').getByText('Edited with a slow server').waitFor();
    await closeEditor(editor);
    await editor.waitFor({ state: 'hidden' });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await fixture.sql('SELECT noteBody FROM notes WHERE noteTitle = ?', ['Responsiveness 0']);
      if (rows[0]?.noteBody?.includes('Edited with a slow server')) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const [stored] = await fixture.sql('SELECT noteBody FROM notes WHERE noteTitle = ?', ['Responsiveness 0']);
    assert.ok(stored.noteBody.includes('Edited with a slow server'), `${label}: the edit must reach the server after the delay`);

    // 3. Rapid successive edits + close keep the final content exactly once.
    await page.getByText('Responsiveness 1', { exact: true }).click();
    editor = page.locator('app-input .note-main:visible').last();
    const body = editor.locator('.note-body[contenteditable]');
    await body.fill('first');
    await body.fill('second');
    await body.fill('final content');
    await closeEditor(editor);
    await editor.waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Responsiveness 1', { exact: true }).click();
    editor = page.locator('app-input .note-main:visible').last();
    await editor.locator('.note-body[contenteditable]').getByText('final content').waitFor();
    await closeEditor(editor);
    await editor.waitFor({ state: 'hidden' });
    const count = await fixture.sql('SELECT COUNT(*) AS count FROM notes WHERE noteTitle = ?', ['Responsiveness 1']);
    assert.equal(Number(count[0].count), 1, `${label}: rapid edits must not duplicate the note`);

    // 4. A failing local store keeps the editor open with visible feedback.
    await page.evaluate(() => { window.__failStorageWrites = true; });
    await page.getByText('Responsiveness 2', { exact: true }).click();
    editor = page.locator('app-input .note-main:visible').last();
    await editor.locator('.note-body[contenteditable]').fill('must not be lost');
    await closeEditor(editor);
    await page.locator('.save-status.is-error:visible').waitFor();
    assert.equal(await editor.isVisible(), true, `${label}: a storage failure must keep the editor open`);
    assert.ok((await editor.locator('.note-body[contenteditable]').textContent()).includes('must not be lost'),
      `${label}: a storage failure must keep the text`);
    await page.evaluate(() => { window.__failStorageWrites = false; });
    await closeEditor(editor);
    await editor.waitFor({ state: 'hidden' });

    console.log(`PASS ${label}: close-to-list ${closeMs}ms with slow server (durable save max ${Math.round(editorSave.maxMs)}ms), survival, rapid edits, storage failure`);
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
