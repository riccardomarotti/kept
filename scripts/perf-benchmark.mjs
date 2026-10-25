import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Usage: node scripts/perf-benchmark.mjs
// Measures startup/reopen/save-close cost on a ~80-note library. Works on
// builds without app instrumentation (it wraps IndexedDB and the network in
// the page), so the same script can benchmark old and new revisions.
const fixture = await startFixture();
const summary = {};
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
  const noteCount = Number(process.env.NOTES || 80);
  for (let index = 0; index < noteCount; index += 1) {
    const links = index % 3 === 0 ? `<div>https://example.com/note-${index}</div>` : '';
    const checkboxes = index % 4 === 0
      ? Array.from({ length: 5 }, (_, slot) => ({ id: slot, data: `Task ${slot}`, done: slot === 0, indentLevel: 0 }))
      : [];
    await api('/notes', 'POST', {
      noteTitle: `Bench ${index}`, noteBody: `<div>Bench body ${index} ${'<b>bold</b> '.repeat(10)}</div>${links}`,
      isCbox: checkboxes.length > 0, pinned: index % 10 === 0, bgColor: '', bgImage: '',
      checkBoxes: checkboxes, images: [], labels: [], archived: false, trashed: false
    }, token);
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
    localStorage.setItem('kept_perf', '1');
    // Baseline-compatible instrumentation around IndexedDB and the network.
    window.__bench = { idbReads: 0, idbWrites: 0, requests: [] };
    const wrap = (proto, method, kind) => {
      const original = proto[method];
      if (!original) return;
      proto[method] = function (...args) {
        window.__bench[kind] += 1;
        return original.apply(this, args);
      };
    };
    wrap(IDBObjectStore.prototype, 'get', 'idbReads');
    wrap(IDBObjectStore.prototype, 'getAll', 'idbReads');
    wrap(IDBObjectStore.prototype, 'getAllKeys', 'idbReads');
    wrap(IDBObjectStore.prototype, 'openCursor', 'idbReads');
    wrap(IDBObjectStore.prototype, 'put', 'idbWrites');
    wrap(IDBObjectStore.prototype, 'add', 'idbWrites');
    wrap(IDBObjectStore.prototype, 'delete', 'idbWrites');
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const url = String(args[0]?.url || args[0]);
      if (url.includes('/api/')) window.__bench.requests.push(new URL(url, location.origin).pathname);
      return originalFetch(...args);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__benchUrl = String(url);
      return originalOpen.call(this, method, url, ...rest);
    };
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      if (this.__benchUrl && this.__benchUrl.includes('/api/')) {
        window.__bench.requests.push(new URL(this.__benchUrl, location.origin).pathname);
      }
      return originalSend.apply(this, args);
    };
    window.__benchReset = () => {
      window.__bench.idbReads = 0;
      window.__bench.idbWrites = 0;
      window.__bench.requests = [];
    };
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.route('**/api/link-preview**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ title: 'Preview', description: null, image: null, url: 'https://example.com', domain: 'example.com' })
  }));
  await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());

  const snap = async () => page.evaluate(() => ({
    idbReads: window.__bench.idbReads, idbWrites: window.__bench.idbWrites,
    requests: [...window.__bench.requests], perf: window.__keptPerf ? window.__keptPerf.snapshot() : null
  }));

  // 1. Cold start after login on a warm server.
  const loginStart = Date.now();
  await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__benchReset());
  await page.getByLabel('Username', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('app-notes .note-container').first().waitFor();
  const firstNotesMs = Date.now() - loginStart;
  await page.waitForTimeout(4000); // let the startup sync settle
  summary.coldStart = { firstNotesMs, ...(await snap()) };

  // 2. Reopen (reload) with an up-to-date local cache and zero server changes.
  await page.evaluate(() => window.__benchReset());
  const reopenStart = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('app-notes .note-container').first().waitFor();
  const reopenNotesMs = Date.now() - reopenStart;
  await page.waitForTimeout(4000);
  summary.reopen = { firstNotesMs: reopenNotesMs, ...(await snap()) };

  // 3. Edit + close with the server artificially slowed to 6s.
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
  await page.getByText('Bench 1', { exact: true }).click();
  const editor = page.locator('app-input .note-main:visible').last();
  await editor.locator('.note-body[contenteditable]').fill('Edited for the benchmark');
  await page.evaluate(() => window.__benchReset());
  const closeStart = Date.now();
  if (await editor.locator('.mobile-top-bar button.back').isVisible()) await editor.locator('.mobile-top-bar button.back').click();
  else await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  summary.slowServerClose = { closeMs: Date.now() - closeStart, ...(await snap()) };

  console.log(JSON.stringify(summary, null, 2));
  await context.close();
} finally {
  await browser?.close();
  await fixture.close();
}
