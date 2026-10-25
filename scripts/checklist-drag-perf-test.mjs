import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Desktop checklist drag-reordering must stay
// correct and smooth on long lists: layout reads per drag are bounded, the
// final order is right and it survives saving and reopening.
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

  const targetRow = 12;
  const sizes = [20, 100, 250];
  const seeded = [];
  for (const size of sizes) {
    const rows = Array.from({ length: size }, (_, index) => ({ id: index, data: `Item ${index}`, done: false, indentLevel: 0 }));
    seeded.push({ size, note: await api('/notes', 'POST', {
      noteTitle: `Drag list ${size}`, noteBody: '', isCbox: true, pinned: false,
      bgColor: '', bgImage: '', checkBoxes: rows, images: [], labels: [], archived: false, trashed: false
    }, token) });
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
    // Layout-read, drag-event and long-task instrumentation.
    window.__rectCalls = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
      window.__rectCalls += 1;
      return original.apply(this, args);
    };
    window.__dragOvers = 0;
    document.addEventListener('dragover', () => { window.__dragOvers += 1; }, true);
    window.__longTasks = [];
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch {}
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => console.error('Browser error:', error));
  await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
  await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('app-notes').waitFor();

  for (const { size, note } of seeded) {
    await page.getByText(`Drag list ${size}`, { exact: true }).click();
    const editor = page.locator('app-input .note-main:visible').last();
    const handle = editor.locator('[data-cbox-row-id="0"] .cbox-move-icon');
    await handle.hover(); // Wait for the modal's opening animation to settle.
    await page.evaluate(() => { window.__rectCalls = 0; window.__dragOvers = 0; window.__longTasks = []; });

    const start = await handle.boundingBox();
    const x = start.x + start.width / 2;
    const y = start.y + start.height / 2;
    const target = await editor.locator(`[data-cbox-row-id="${targetRow}"]`).boundingBox();
    const targetY = target.y + target.height * 0.85; // lower half => insert after the target row

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForFunction(id => document.querySelector(`[data-cbox-row-id="${id}"]`)?.draggable === true, '0');
    await page.mouse.move(x, y + 8, { steps: 3 });
    const t0 = Date.now();
    await page.mouse.move(x, targetY, { steps: 45 });
    await page.mouse.move(x, targetY); // one more dragover at the destination
    await page.mouse.up();
    const dragMs = Date.now() - t0;

    // The dragged row must sit directly after the target row.
    const fields = editor.locator('[data-cbox-id]');
    const texts = await fields.allTextContents();
    assert.deepEqual(
      texts.slice(Math.max(0, targetRow - 1), targetRow + 3),
      size > 2 ? [`Item ${targetRow}`, 'Item 0', `Item ${targetRow + 1}`, `Item ${targetRow + 2}`] : texts,
      `${size}: dragging Item 0 to row ${targetRow} must place it after that row`
    );
    const metrics = await page.evaluate(() => ({ rectCalls: window.__rectCalls, dragOvers: window.__dragOvers, longTasks: [...window.__longTasks] }));
    // One geometry batch per dragstart/reorder plus per moved row; not one
    // measurement per dragover event.
    assert.ok(metrics.rectCalls <= size * 12 + 256,
      `${size}: layout reads per drag must be bounded (saw ${metrics.rectCalls} rect reads for ${metrics.dragOvers} dragover events)`);

    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });

    // The order must survive saving and reopening.
    const expected = [
      ...Array.from({ length: targetRow }, (_, index) => `Item ${index + 1}`),
      'Item 0',
      ...Array.from({ length: size - targetRow - 1 }, (_, index) => `Item ${targetRow + 1 + index}`)
    ];
    let savedOrder = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const stored = await api(`/notes/${note.id}`, 'GET', undefined, token);
      savedOrder = stored.checkBoxes.map(cb => cb.data);
      if (savedOrder.join('|') === expected.join('|')) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.deepEqual(savedOrder, expected, `${size}: the new order must be persisted exactly once`);
    console.log(`PASS ${size} rows: drag ${dragMs}ms, ${metrics.rectCalls} rect reads / ${metrics.dragOvers} dragover events, long tasks ${JSON.stringify(metrics.longTasks)}`);
    await page.locator('app-input .placeholder:visible').waitFor().catch(() => {});
    await page.waitForTimeout(300);
  }
  await context.close();
} finally {
  await browser?.close();
  await fixture.close();
}
