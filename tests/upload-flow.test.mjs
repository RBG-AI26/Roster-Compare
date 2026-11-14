import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const parserSource = await readFile(new URL('../roster-browser.js', import.meta.url), 'utf8');
const parser = await import(`data:text/javascript;base64,${Buffer.from(parserSource).toString('base64')}`);
const calendarSource = await readFile(new URL('../roster-calendar.js', import.meta.url), 'utf8');
const calendar = await import(`data:text/javascript;base64,${Buffer.from(calendarSource).toString('base64')}`);
const storageKey = 'roster-compare-state-v2';
function roster(index) {
  return { fileName: `webcis-${index}.txt`, text: `webCIS\nName: TEST PILOT ${String.fromCharCode(65 + index)}  Staff No: ${100000 + index}\nBase: SYD\nBid Period 1\nDate: 01 Jan 2026\nDate Duty Detail\n05/01 M A\nEND OF REPORT\n` };
}
function file(index) {
  const data = roster(index);
  return { name: data.fileName, type: 'text/plain', text: async () => data.text };
}
// A minimal DOM adapter exercises event handling/state without a browser dependency.
function setup(saved) {
  const store = new Map(saved ? [[storageKey, JSON.stringify(saved)]] : []);
  const elements = new Map();
  let comparisonCalls = 0;
  function element() {
    const classes = new Set();
    return { textContent: '', innerHTML: '', value: '60', disabled: false, children: [], events: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
      addEventListener(name, callback) { this.events[name] = callback; },
      scrollIntoView() {}, querySelectorAll: () => [], appendChild(child) { this.children.push(child); }, reset() {}, checkValidity: () => true, reportValidity: () => true,
    };
  }
  const context = vm.createContext({ ...parser, ...calendar, compareRosterGroup: (...args) => { comparisonCalls += 1; return parser.compareRosterGroup(...args); }, console, Error, navigator: {}, window: { addEventListener() {} },
    document: { getElementById(id) { assert.ok(html.includes(`id="${id}"`), `Missing HTML element ${id}`); if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
  });
  vm.runInContext(app, context);
  return { context, elements, store, comparisonCalls: () => comparisonCalls, add: files => context.addRosterFiles(files),
    compare: () => elements.get('compare-form').events.submit({ preventDefault() {} }),
    select(index, checked) { elements.get('crew-list').events.change({ target: { closest: () => ({ dataset: { rosterIndex: String(index) }, checked }) } }); },
    remove(index) { elements.get('crew-list').events.click({ target: { closest: () => ({ dataset: { removeIndex: String(index) } }) } }); },
  };
}
test('one picker accepts five files, recognises crew and compares selected subset', async () => {
  const ui = setup();
  assert.match(html, /type="file"[^>]*multiple/);
  assert.equal(ui.elements.get('compare-button').disabled, true);
  await ui.add([0, 1, 2, 3, 4].map(file));
  assert.equal(ui.elements.get('roster-count').textContent, '5 / 5 loaded');
  assert.match(ui.elements.get('crew-list').innerHTML, /TEST PILOT E/);
  ui.select(1, false); ui.select(2, false); ui.select(3, false);
  ui.compare();
  const headers = ui.elements.get('results-head').innerHTML;
  assert.match(headers, /<th>A<\/th>/); assert.match(headers, /<th>E<\/th>/); assert.doesNotMatch(headers, /<th>B<\/th>/);
  ui.select(4, false);
  assert.equal(ui.elements.get('compare-button').disabled, true);
  assert.equal(ui.elements.get('results').classList.contains('hidden'), true);
});
test('mixed files retain valid rosters and report errors, duplicates are skipped', async () => {
  const ui = setup();
  await ui.add([file(0), { name: 'bad.txt', type: 'text/plain', text: async () => 'not a roster' }, file(1)]);
  assert.equal(ui.elements.get('roster-count').textContent, '2 / 5 loaded');
  assert.match(ui.elements.get('upload-status').textContent, /bad.txt: No calendar entries/);
  ui.compare();
  await ui.add([file(0)]);
  assert.match(ui.elements.get('upload-status').textContent, /already loaded/);
  assert.match(ui.elements.get('status').textContent, /Comparison complete/);
});
test('overflow is rejected without altering saved rosters; removing frees a slot', async () => {
  const ui = setup();
  await ui.add([0, 1, 2, 3, 4].map(file));
  await ui.add([file(5)]);
  assert.match(ui.elements.get('upload-status').textContent, /up to 5/);
  assert.equal(ui.elements.get('roster-count').textContent, '5 / 5 loaded');
  ui.remove(2);
  await ui.add([file(5)]);
  assert.match(ui.elements.get('crew-list').innerHTML, /TEST PILOT F/);
  assert.doesNotMatch(ui.elements.get('crew-list').innerHTML, /TEST PILOT C/);
});
test('reload restores all five rosters and chosen crew; clear removes saved state', async () => {
  const first = setup();
  await first.add([0, 1, 2, 3, 4].map(file)); first.select(1, false);
  const restored = setup(JSON.parse(first.store.get(storageKey)));
  assert.equal(restored.elements.get('roster-count').textContent, '5 / 5 loaded');
  assert.equal(restored.elements.get('selection-count').textContent, '4 selected');
  assert.doesNotMatch(restored.elements.get('results-head').innerHTML, /<th>B<\/th>/);
  restored.elements.get('clear-storage-button').events.click();
  assert.equal(restored.store.has(storageKey), false);
  assert.equal(restored.elements.get('roster-count').textContent, '0 / 5 loaded');
});
test('legacy two/three roster saves migrate and malformed saved rosters report errors', () => {
  for (const count of [2, 3]) {
    const ui = setup({ currentInputs: { rosters: Array.from({ length: count }, (_, i) => roster(i)) } });
    assert.equal(ui.elements.get('selection-count').textContent, `${count} selected`);
    assert.match(ui.elements.get('status').textContent, /Restored saved/);
  }
  const ui = setup({ currentInputs: { rosters: [roster(0), roster(1), { fileName: 'bad.txt', text: 'invalid' }] } });
  assert.equal(ui.elements.get('roster-count').textContent, '2 / 5 loaded');
  assert.match(ui.elements.get('upload-status').textContent, /could not be read/);
});
test('storage failure still permits in-memory upload and comparison', async () => {
  const ui = setup();
  vm.runInContext('localStorage.setItem = () => { throw new Error("Storage unavailable"); }', ui.context);
  await ui.add([file(0), file(1)]); ui.compare();
  assert.match(ui.elements.get('status').textContent, /Comparison complete/);
});

test('upload compares all subsets once and ticks display cached results without pressing compare', async () => {
  const ui = setup();
  await ui.add([0, 1, 2, 3, 4].map(file));
  assert.match(ui.elements.get('status').textContent, /Comparison complete/);
  assert.equal(ui.comparisonCalls(), 26);
  ui.select(1, false); ui.select(2, false); ui.select(3, false);
  assert.match(ui.elements.get('results-head').innerHTML, /<th>E<\/th>/);
  assert.doesNotMatch(ui.elements.get('results-head').innerHTML, /<th>B<\/th>/);
  ui.select(4, false);
  assert.equal(ui.elements.get('results').classList.contains('hidden'), true);
  ui.select(1, true);
  assert.equal(ui.elements.get('results').classList.contains('hidden'), false);
  assert.match(ui.elements.get('results-head').innerHTML, /<th>B<\/th>/);
  assert.equal(ui.comparisonCalls(), 26);
});
test('adding another roster immediately replaces results with the new crew selection', async () => {
  const ui = setup();
  await ui.add([file(0), file(1)]);
  assert.match(ui.elements.get('status').textContent, /Comparison complete/);
  await ui.add([file(2)]);
  assert.match(ui.elements.get('results-head').innerHTML, /<th>C<\/th>/);
  assert.match(ui.elements.get('status').textContent, /Comparison complete/);
});

test('calendar follows crew selection and clears alongside comparison results', async () => {
  const ui = setup();
  await ui.add([0, 1, 2, 3, 4].map(file));
  assert.equal(ui.elements.get('calendar-month').textContent, 'January 2026');
  assert.equal((ui.elements.get('calendar-grid').innerHTML.match(/class="calendar-lane calendar-pilot-lane"/g) || []).length, 25);
  ui.select(1, false); ui.select(2, false); ui.select(3, false);
  assert.equal((ui.elements.get('calendar-grid').innerHTML.match(/class="calendar-lane calendar-pilot-lane"/g) || []).length, 10);
  ui.select(4, false);
  assert.equal(ui.elements.get('calendar-grid').innerHTML, '');
  ui.select(1, true);
  assert.match(ui.elements.get('calendar-grid').innerHTML, /calendar-overlap/);
  ui.elements.get('clear-storage-button').events.click();
  assert.equal(ui.elements.get('calendar-grid').innerHTML, '');
});

test('calendar navigation respects coverage, persists month and opens/closes details', () => {
  const rosters = [0, 1].map(index => {
    const value = roster(index);
    value.text = value.text.replace('05/01 M A', '05/01 M A\n05/02 T A');
    return value;
  });
  const ui = setup({ calendarMonth: '2026-01-01', currentInputs: { rosters } });
  assert.equal(ui.elements.get('calendar-previous').disabled, true);
  ui.elements.get('calendar-next').events.click();
  assert.equal(ui.elements.get('calendar-month').textContent, 'February 2026');
  assert.equal(ui.elements.get('calendar-next').disabled, true);
  ui.elements.get('calendar-next').events.click();
  assert.equal(ui.elements.get('calendar-month').textContent, 'February 2026');
  assert.equal(JSON.parse(ui.store.get(storageKey)).calendarMonth, '2026-02-01');
  const restored = setup(JSON.parse(ui.store.get(storageKey)));
  assert.equal(restored.elements.get('calendar-month').textContent, 'February 2026');
  const markup = ui.elements.get('calendar-grid').innerHTML;
  const id = markup.match(/class="calendar-bar calendar-overlap[^>]*data-calendar-detail="(\d+)"/)[1];
  ui.elements.get('calendar-grid').events.click({ target: { closest: () => ({ dataset: { calendarDetail: id } }) } });
  assert.equal(ui.elements.get('calendar-details').hidden, false);
  assert.match(ui.elements.get('calendar-detail-title').textContent, /SYD/);
  assert.match(ui.elements.get('calendar-detail-subtitle').textContent, /Feb 2026/);
  assert.match(ui.elements.get('calendar-detail-text').textContent, /Assumed at home base/);
  ui.elements.get('calendar-detail-close').events.click();
  assert.equal(ui.elements.get('calendar-details').hidden, true);
  ui.elements.get('calendar-previous').events.click();
  assert.equal(ui.elements.get('calendar-month').textContent, 'January 2026');
});
