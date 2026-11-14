import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const worker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
function setup() {
  const events = {}, deleted = [], installed = [], cached = new Map();
  const cache = { addAll: async requests => installed.push(...requests), put: async (key, value) => cached.set(String(key.url || key), value), match: async key => cached.get(String(key.url || key)) };
  const fetches = [];
  const context = vm.createContext({ Request, URL, Error, self: { location: { href: 'https://example.com/rosters/service-worker.js', origin: 'https://example.com' }, addEventListener: (name, callback) => events[name] = callback, skipWaiting() {}, clients: { claim() {} } },
    caches: { open: async () => cache, keys: async () => ['roster-compare-static-v4', worker.match(/const CACHE_NAME = "([^"]+)"/)[1], 'another-app-v1'], delete: async key => deleted.push(key), match() { throw new Error('Must not use an older cache'); } },
    fetch: async (request, options) => { fetches.push({ request, options }); return new Response('current release'); },
  });
  vm.runInContext(worker, context);
  return { context, events, deleted, installed, cached, fetches };
}
test('HTML, application import and offline shell use matching release URLs', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const appUrl = html.match(/src="(\.\/app\.js\?v=[^"]+)"/)[1];
  const parserUrl = app.match(/from "(\.\/roster-browser\.js\?v=[^"]+)"/)[1];
  const styleUrl = html.match(/href="(\.\/styles\.css\?v=[^"]+)"/)[1];
  assert.equal(new URL(appUrl, 'https://example.com').search, new URL(parserUrl, 'https://example.com').search);
  assert.equal(new URL(appUrl, 'https://example.com').search, new URL(styleUrl, 'https://example.com').search);
  const ui = setup(); let pending;
  ui.events.install({ waitUntil: promise => pending = promise }); await pending;
  for (const asset of [appUrl, parserUrl, styleUrl]) assert.ok(ui.installed.some(request => request.url === new URL(asset, 'https://example.com/rosters/').href));
  assert.ok(ui.installed.every(request => request.cache === 'reload'));
});
test('network assets are revalidated and offline fallback uses the current cache', async () => {
  const ui = setup(); const request = new Request('https://example.com/rosters/roster-browser.js?v=20261114-3');
  await ui.context.networkFirst(request);
  assert.equal(ui.fetches[0].options.cache, 'no-cache');
  vm.runInContext('fetch = async () => { throw new Error("Offline"); }', ui.context);
  const response = await ui.context.networkFirst(request);
  assert.equal(await response.text(), 'current release');
  await assert.rejects(ui.context.networkFirst(new Request('https://example.com/uncached.js')), /no cached response/);
});
test('cache upgrade removes only this app’s superseded caches', async () => {
  const ui = setup(); let pending;
  ui.events.activate({ waitUntil: promise => pending = promise }); await pending;
  assert.deepEqual(ui.deleted, ['roster-compare-static-v4']);
});
