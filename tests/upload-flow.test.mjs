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
function setup(saved, theme) {
  const store = new Map(saved ? [[storageKey, JSON.stringify(saved)]] : []);
  if (theme) store.set("roster-compare-theme", theme);
  const elements = new Map();
  let comparisonCalls = 0;
  function element() {
    const classes = new Set();
    return { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, textContent: '', innerHTML: '', value: '60', disabled: false, children: [], events: {},
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) },
      addEventListener(name, callback) { this.events[name] = callback; },
      scrollIntoView() {}, querySelectorAll: () => [], appendChild(child) { this.children.push(child); }, reset() {}, checkValidity: () => true, reportValidity: () => true,
    };
  }
  const context = vm.createContext({ ...parser, ...calendar, compareRosterGroup: (...args) => { comparisonCalls += 1; return parser.compareRosterGroup(...args); }, console, Error, navigator: {}, window: { addEventListener() {} },
    document: { documentElement: { dataset: {} }, getElementById(id) { assert.ok(html.includes(`id="${id}"`), `Missing HTML element ${id}`); if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
  });
  vm.runInContext(app, context);
  return { context, elements, store, comparisonCalls: () => comparisonCalls, add: files => context.addRosterFiles(files),
    select(index, checked) { elements.get('crew-list').events.change({ target: { closest: selector => selector === '[data-roster-index]' ? ({ dataset: { rosterIndex: String(index) }, checked }) : null } }); },
    domicile(index, value) { elements.get('crew-list').events.change({ target: { closest: selector => selector === '[data-domicile-index]' ? ({ dataset: { domicileIndex: String(index) }, value }) : null } }); },
    remove(index) { elements.get('crew-list').events.click({ target: { closest: () => ({ dataset: { removeIndex: String(index) } }) } }); },
  };
}
test('one picker accepts five files, recognises crew and compares selected subset', async () => {
  const ui = setup();
  assert.match(html, /type="file"[^>]*multiple/);
  assert.doesNotMatch(html, /id="compare-button"/);
  await ui.add([0, 1, 2, 3, 4].map(file));
  assert.equal(ui.elements.get('roster-count').textContent, '5 / 5 loaded');
  assert.match(ui.elements.get('crew-list').innerHTML, /TEST PILOT E/);
  ui.select(1, false); ui.select(2, false); ui.select(3, false);

  const headers = ui.elements.get('results-head').innerHTML;
  assert.match(headers, /<th>A<\/th>/); assert.match(headers, /<th>E<\/th>/); assert.doesNotMatch(headers, /<th>B<\/th>/);
  ui.select(4, false);
  assert.doesNotMatch(html, /id="compare-button"/);
  assert.equal(ui.elements.get('results').classList.contains('hidden'), true);
});
test('mixed files retain valid rosters and report errors, duplicates are skipped', async () => {
  const ui = setup();
  await ui.add([file(0), { name: 'bad.txt', type: 'text/plain', text: async () => 'not a roster' }, file(1)]);
  assert.equal(ui.elements.get('roster-count').textContent, '2 / 5 loaded');
  assert.match(ui.elements.get('upload-status').textContent, /bad.txt: No calendar entries/);

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
  await ui.add([file(0), file(1)]);
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
  assert.equal(ui.elements.get('calendar-month').textContent, '5 Jan 2026 – 5 Jan 2026');
  assert.equal((ui.elements.get('calendar-grid').innerHTML.match(/class="calendar-lane calendar-pilot-lane"/g) || []).length, 5);
  ui.select(1, false); ui.select(2, false); ui.select(3, false);
  assert.equal((ui.elements.get('calendar-grid').innerHTML.match(/class="calendar-lane calendar-pilot-lane"/g) || []).length, 2);
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
  const ui = setup({ calendarRange: 'month', calendarMonth: '2026-01-01', currentInputs: { rosters } });
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
  assert.match(ui.elements.get('calendar-detail-text').textContent, /SYD/);
  assert.doesNotMatch(ui.elements.get('calendar-detail-text').textContent, /assum|commute/i);
  ui.elements.get('calendar-detail-close').events.click();
  assert.equal(ui.elements.get('calendar-details').hidden, true);
  ui.elements.get('calendar-previous').events.click();
  assert.equal(ui.elements.get('calendar-month').textContent, 'January 2026');
});

test('domicile changes are saved, leave base intact and recalculate matching ports', async () => {
  const ui=setup();await ui.add([file(0),file(1)]);
  assert.match(ui.elements.get('crew-list').innerHTML,/Home city \/ domicile/);
  ui.domicile(0,'ADL');
  const saved=JSON.parse(ui.store.get(storageKey));
  assert.equal(saved.currentInputs.rosters[0].domicile,'ADL');
  assert.match(ui.elements.get('calendar-crew-legend').innerHTML,/Home ADL · base SYD/);
  assert.match(ui.elements.get('calendar-grid').innerHTML,/ADL · home/);
  assert.match(ui.elements.get('results-body').children.at(-1).innerHTML,/ADL \/ SYD/);
  ui.domicile(1,'ADL');
  assert.match(ui.elements.get('calendar-grid').innerHTML,/calendar-all-home/);
  const restored=setup(JSON.parse(ui.store.get(storageKey)));
  assert.match(restored.elements.get('calendar-crew-legend').innerHTML,/Home ADL · base SYD/);
  assert.match(restored.elements.get('status').textContent,/Comparison complete/);
});

test('read failures recover and a second successful upload enables comparison', async () => {
  const ui=setup();let release;
  const delayed={name:'delayed.txt',type:'text/plain',text:()=>new Promise(resolve=>release=resolve)};
  const pending=ui.add([delayed,file(1)]);
  assert.equal(ui.elements.get('roster-files').disabled,true);
  release(roster(0).text);await pending;
  assert.equal(ui.elements.get('roster-files').disabled,false);
  assert.match(ui.elements.get('status').textContent,/Comparison complete/);
  const other=setup();await other.add([file(0),{name:'bad.txt',type:'text/plain',text:async()=>{throw new Error('Read failed');}}]);
  assert.equal(other.elements.get('results').classList.contains('hidden'),true);
  await other.add([file(1)]);
  assert.match(other.elements.get('status').textContent,/Comparison complete/);
});

test('crew summaries retain imported coverage dates', async () => {
  const ui=setup();await ui.add([file(0),file(1)]);
  assert.match(ui.elements.get('summary-row').innerHTML,/05\/01\/2026/);
  assert.doesNotMatch(ui.elements.get('summary-row').innerHTML,/Dates: Unknown/);
});


test('domicile options contain exactly the eight Australian capitals, including after a legacy save', () => {
  const rosters = [roster(0), roster(1)].map(r => ({...r, domicile:'SIN'}));
  const ui = setup({ currentInputs:{ rosters } });
  const markup = ui.elements.get('crew-list').innerHTML;
  const ports = [...markup.matchAll(/<option value="([A-Z]{3})"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(ports)].sort(), ['ADL','BNE','CBR','DRW','HBA','MEL','PER','SYD']);
  assert.equal(ports.length,16);
  assert.match(ui.elements.get('calendar-crew-legend').innerHTML,/Home SYD · base SYD/);
  ui.domicile(0,'SIN');
  assert.match(ui.elements.get('calendar-crew-legend').innerHTML,/Home SYD · base SYD/);
});
test('a non-capital base requires a domicile choice before assuming home presence', () => {
  const rosters = [roster(0),roster(1)].map(r => ({...r,text:r.text.replace('Base: SYD','Base: SIN')}));
  const ui = setup({currentInputs:{rosters}});
  assert.match(ui.elements.get('crew-list').innerHTML,/Choose a capital city/);
  assert.match(ui.elements.get('calendar-grid').innerHTML,/choose domicile/);
  assert.doesNotMatch(ui.elements.get('calendar-grid').innerHTML,/calendar-overlap/);
  ui.domicile(0,'ADL');ui.domicile(1,'ADL');
  assert.match(ui.elements.get('calendar-grid').innerHTML,/calendar-overlap/);
  assert.match(ui.elements.get('calendar-crew-legend').innerHTML,/Home ADL · base SIN/);
});
test('theme switch persists separately, restores on reload and survives clearing rosters', () => {
  const ui = setup();
  assert.equal(ui.context.document.documentElement.dataset.theme,'dark');
  assert.equal(ui.elements.get('theme-toggle').attributes['aria-checked'],'true');
  ui.elements.get('theme-toggle').events.click();
  assert.equal(ui.context.document.documentElement.dataset.theme,'light');
  assert.equal(ui.elements.get('theme-toggle').attributes['aria-checked'],'false');
  assert.equal(ui.elements.get('theme-colour').attributes.content,'#f3f6fa');
  const restored = setup(undefined,ui.store.get('roster-compare-theme'));
  assert.equal(restored.context.document.documentElement.dataset.theme,'light');
  restored.elements.get('clear-storage-button').events.click();
  assert.equal(restored.store.get('roster-compare-theme'),'light');
  restored.elements.get('theme-toggle').events.click();
  assert.equal(restored.store.get('roster-compare-theme'),'dark');
  const blocked = setup();
  vm.runInContext('localStorage.setItem = () => { throw new Error("Storage unavailable"); }',blocked.context);
  blocked.elements.get('theme-toggle').events.click();
  assert.equal(blocked.context.document.documentElement.dataset.theme,'light');
});


test('correcting an invalid overlap threshold restores automatic results without a compare button', async () => {
  const ui = setup();await ui.add([file(0),file(1)]);
  const threshold = ui.elements.get('min-overlap-minutes');
  threshold.value='0';threshold.reportValidity=()=>false;threshold.checkValidity=()=>false;
  threshold.events.change();
  assert.equal(ui.elements.get('results').classList.contains('hidden'),true);
  threshold.value='60';threshold.reportValidity=()=>true;threshold.checkValidity=()=>true;
  threshold.events.change();
  assert.equal(ui.elements.get('results').classList.contains('hidden'),false);
  assert.match(ui.elements.get('status').textContent,/Comparison complete/);
});

test('three selected pilots automatically retain a matching pair when the third has no matching duty', async () => {
  const ui=setup();const unknown=file(2);const raw=roster(2).text.replace('05/01 M A','05/01 M Z');unknown.text=async()=>raw;
  await ui.add([file(0),file(1),unknown]);
  assert.equal(ui.elements.get('selection-count').textContent,'3 selected');
  const markup=ui.elements.get('calendar-grid').innerHTML;
  assert.match(markup,/SYD · 2/);
  const id=markup.match(/class="calendar-bar calendar-overlap[^>]*data-calendar-detail="(\d+)"/)[1];
  ui.elements.get('calendar-grid').events.click({target:{closest:()=>({dataset:{calendarDetail:id}})}});
  assert.equal(ui.elements.get('calendar-detail-text').textContent,'A · SYD\nB · SYD');
  ui.select(0,false);
  assert.doesNotMatch(ui.elements.get('calendar-grid').innerHTML,/calendar-overlap/);
  ui.select(0,true);
  assert.match(ui.elements.get('calendar-grid').innerHTML,/SYD · 2/);
  ui.remove(2);
  assert.equal(ui.elements.get('selection-count').textContent,'2 selected');
  assert.match(ui.elements.get('calendar-grid').innerHTML,/calendar-overlap/);
});
