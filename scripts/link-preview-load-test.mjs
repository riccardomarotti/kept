import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixture } from '../test-support/session-fixture.cjs';

// Run after npm run build. Rich link previews must be inert when disabled and
// bounded to visible demand (with capped concurrency and dedupe) when enabled.
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
  const noteCount = 60;
  for (let index = 0; index < noteCount; index += 1) {
    const links = [0, 1, 2].map(slot => `https://example.com/note-${index}-link-${slot}`).join(' ');
    await api('/notes', 'POST', {
      noteTitle: `Linkful ${index}`, noteBody: `<div>${links}</div>`, isCbox: false, pinned: false,
      bgColor: '', bgImage: '', checkBoxes: [], images: [], labels: [], archived: false, trashed: false
    }, token);
  }
  const totalUrls = noteCount * 3;
  browser = await chromium.launch({ headless: true });

  for (const enabled of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(enabledValue => {
      localStorage.setItem('kept_notification_permission_prompt_dismissed', '1');
      localStorage.setItem('kept_user_preferences', JSON.stringify({ richLinkPreviews: enabledValue }));
    }, enabled);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => console.error('Browser error:', error));
    const requests = new Map(); // url -> times requested
    let inFlight = 0;
    let maxInFlight = 0;
    await page.route('**/api/link-preview**', async route => {
      const url = route.request().url();
      requests.set(url, (requests.get(url) || 0) + 1);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 100));
      inFlight -= 1;
      const target = new URL(url).searchParams.get('url') || url;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ title: `Preview ${target}`, description: null, image: null, url: target, domain: 'example.com' })
      });
    });
    await page.route(/https:\/\/(fonts\.|cdn\.jsdelivr)/, route => route.abort());
    await page.goto(fixture.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('app-notes').waitFor();
    await page.waitForTimeout(3000);

    if (!enabled) {
      assert.equal(requests.size, 0, 'disabled previews must issue no link-preview requests at all');
      await page.waitForTimeout(2000);
      assert.equal(requests.size, 0, 'disabled previews must stay inert while browsing');
      // Plain links are still rendered as text/anchors in the cards.
      assert.ok(await page.locator('app-notes .note-container').first().isVisible());
      console.log('PASS rich link previews disabled: zero requests, cards render');
    } else {
      const initialRequests = requests.size;
      assert.ok(initialRequests > 0, 'enabled previews must fetch for visible cards');
      assert.ok(initialRequests < totalUrls, `initial fetch must be bounded by visible demand (${initialRequests} of ${totalUrls})`);
      assert.ok(maxInFlight <= 3, `preview concurrency must stay capped (saw ${maxInFlight})`);
      // Idle time must not produce more preview work once the bounded
      // visible-demand queue has drained.
      await page.waitForTimeout(2500);
      assert.equal(requests.size, initialRequests, 'no background preview churn while idle');

      // Scrolling loads more, but every URL is fetched at most once.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const duplicates = [...requests.values()].filter(count => count > 1);
      assert.deepEqual(duplicates, [], 'preview requests must be deduplicated');
      assert.ok(requests.size <= totalUrls, 'never more requests than links');
      assert.ok(maxInFlight <= 3, `preview concurrency must stay capped after scrolling (saw ${maxInFlight})`);
      console.log(`PASS rich link previews enabled: ${initialRequests}/${totalUrls} initial requests, ${requests.size} after scrolling, max concurrency ${maxInFlight}`);
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
