import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as email from '../email-rosters.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortPeriod } from './fixtures/short-period.mjs';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const parserSource = await readFile(new URL('../roster-browser.js', import.meta.url), 'utf8');
const parser = await import(`data:text/javascript;base64,${Buffer.from(parserSource).toString('base64')}`);
const calendarSource = await readFile(new URL('../roster-calendar.js', import.meta.url), 'utf8');
const calendar = await import(`data:text/javascript;base64,${Buffer.from(calendarSource).toString('base64')}`);
const storageKey = 'roster-compare-state-v2';
const periodFile = options => ({ name: `period-${options?.bid || '1'}.txt`, type: 'text/plain', text: async () => shortPeriod(options) });

function longPeriodFile({ bid, start, days = 56 }) {
  const report = start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const rows = Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month} ${'UMTWTFS'[date.getDay()]} A`;
  });
  return { name: `long-${bid}.txt`, type: 'text/plain', text: async () => [
    'webCIS', 'Name: LONG HAUL PILOT  Staff No: 100000', 'Base: MEL', `Bid Period: BP${bid}`, `Date: ${report}`,
    'Date Duty Detail', ...rows, 'END OF REPORT',
  ].join('\n') };
}

function weekNumbers(ui) {
  return Array.from(ui.elements.get('calendar-grid').innerHTML.matchAll(/class="calendar-week-number">Week (\d+)/g), match => Number(match[1]));
}

test('multiple short-haul files import as one pilot and one calendar row', async () => {
  const ui = setup();
  await ui.add([periodFile({ duty: 'LD' }), periodFile({ start: new Date(2026, 10, 30), bid: '2' })]);
  assert.equal(ui.elements.get('roster-count').textContent, '1 / 5 loaded');
  assert.equal(ui.elements.get('selection-count').textContent, '1 selected');
  assert.equal(ui.comparisonCalls(), 0);
  assert.equal(ui.elements.get('results').classList.contains('hidden'), true);
  assert.match(ui.elements.get('crew-list').innerHTML, /2 roster files/);
  const other = periodFile({ staff: '654321', name: 'TEST PILOT B' });
  await ui.add([other]);
  assert.equal(ui.elements.get('selection-count').textContent, '2 selected');
  assert.equal(vm.runInContext('loadedRosters[0].parsed.calendar.length', ui.context), 56);
  assert.equal(vm.runInContext('calendarModel.weeks.length', ui.context), 8);
  assert.equal(vm.runInContext('calendarModel.weeks.every(week => week.rows.length === 2 && week.rows[0].every(cell => cell.kind !== "unavailable"))', ui.context), true);
});

test('additional periods preserve pilot settings and grouped files survive reload', async () => {
  const ui = setup();
  await ui.add([periodFile(), file(0)]);
  ui.domicile(0, 'ADL'); ui.select(0, false);
  const colour = vm.runInContext('loadedRosters[0].parsed.colour', ui.context);
  await ui.add([periodFile({ start: new Date(2026, 10, 30), bid: '2' })]);
  assert.equal(ui.elements.get('selection-count').textContent, '1 selected');
  const saved = JSON.parse(ui.store.get(storageKey));
  assert.equal(saved.currentInputs.rosters[0].files.length, 2);
  assert.equal(saved.currentInputs.rosters[0].domicile, 'ADL');
  assert.equal(saved.currentInputs.rosters[0].colour, colour);
  const restored = setup(saved);
  assert.equal(restored.elements.get('roster-count').textContent, '2 / 5 loaded');
  assert.equal(restored.elements.get('selection-count').textContent, '1 selected');
  assert.equal(vm.runInContext('loadedRosters[0].parsed.calendar.length', restored.context), 56);
  assert.equal(vm.runInContext('loadedRosters[0].parsed.domicile', restored.context), 'ADL');
  restored.remove(0);
  assert.equal(JSON.parse(restored.store.get(storageKey)).currentInputs.rosters.length, 1);
});

test('legacy saved periods for the same staff number automatically migrate to one pilot', () => {
  const ui = setup({ currentInputs: { rosters: [
    { fileName: 'nov.txt', text: shortPeriod(), domicile: 'ADL', selected: false },
    { fileName: 'dec.txt', text: shortPeriod({ start: new Date(2026, 10, 30) }), selected: true }, roster(0),
  ] } });
  assert.equal(ui.elements.get('roster-count').textContent, '2 / 5 loaded');
  assert.equal(ui.elements.get('selection-count').textContent, '2 selected');
  assert.equal(vm.runInContext('loadedRosters[0].parsed.calendar.length', ui.context), 56);
  assert.equal(vm.runInContext('loadedRosters[0].parsed.domicile', ui.context), 'ADL');
});

test('pilot capacity counts people, allowing more than five files and new periods at capacity', async () => {
  const ui = setup();
  await ui.add([periodFile(), periodFile({ start: new Date(2026, 10, 30) }), ...[0, 1, 2, 3].map(file)]);
  assert.equal(ui.elements.get('roster-count').textContent, '5 / 5 loaded');
  await ui.add([periodFile({ start: new Date(2026, 11, 28), bid: '3' })]);
  assert.equal(vm.runInContext('loadedRosters[0].files.length', ui.context), 3);
  await ui.add([periodFile()]);
  assert.match(ui.elements.get('upload-status').textContent, /already loaded/);
  await ui.add([file(4)]);
  assert.match(ui.elements.get('upload-status').textContent, /up to 5 pilots/);
});

test('same names with different staff numbers remain separate pilots', async () => {
  const ui = setup();
  await ui.add([periodFile(), periodFile({ staff: '654321' })]);
  assert.equal(ui.elements.get('roster-count').textContent, '2 / 5 loaded');
});

test('a damaged saved period does not discard another valid period for that pilot', () => {
  const ui = setup({ currentInputs: { rosters: [{ files: [
    { fileName: 'nov.txt', text: shortPeriod() }, { fileName: 'bad.txt', text: 'invalid' },
  ] }] } });
  assert.equal(ui.elements.get('roster-count').textContent, '1 / 5 loaded');
  assert.match(ui.elements.get('upload-status').textContent, /could not be read/);
});
function roster(index) {
  return { fileName: `webcis-${index}.txt`, text: `webCIS\nName: TEST PILOT ${String.fromCharCode(65 + index)}  Staff No: ${100000 + index}\nBase: SYD\nBid Period 1\nDate: 01 Jan 2026\nDate Duty Detail\n05/01 M A\nEND OF REPORT\n` };
}
function file(index) {
  const data = roster(index);
  return { name: data.fileName, type: 'text/plain', text: async () => data.text };
}
// A minimal DOM adapter exercises event handling/state without a browser dependency.
function setup(saved, theme, emailFetch) {
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
  const context = vm.createContext({ ...parser, ...calendar, ...email, ...(emailFetch ? { fetchEmailRosters: (connection, known) => email.fetchEmailRosters(connection, known, emailFetch) } : {}), compareRosterGroup: (...args) => { comparisonCalls += 1; return parser.compareRosterGroup(...args); }, console, Error, navigator: {}, window: { addEventListener() {} },
    document: { documentElement: { dataset: {} }, getElementById(id) { assert.ok(html.includes(`id="${id}"`), `Missing HTML element ${id}`); if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
  });
  vm.runInContext(app, context);
  return { context, elements, store, comparisonCalls: () => comparisonCalls, add: files => context.addRosterFiles(files),
    connect(code) { elements.get('email-connection-code').value = code; return context.connectEmailRoster(); },
    refresh: () => context.refreshEmailConnections(),
    disconnect(index) { elements.get('email-connections').events.click({ target: { closest: () => ({ dataset: { disconnectEmail: String(index) } }) } }); },
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

test('Full roster switches between eight-week bid periods and aligns both short-haul halves by date', async () => {
  const emailed = [shortPeriod({ bid: '3781' }), shortPeriod({ bid: '3785', start: new Date(2026, 10, 30) })];
  const ui = setup(undefined, undefined, async (_url, options) => Response.json(emailResponse(emailed, JSON.parse(options.body).known)));
  await ui.add([
    longPeriodFile({ bid: '377', start: new Date(2026, 8, 7) }),
    longPeriodFile({ bid: '378', start: new Date(2026, 10, 2) }),
  ]);
  await ui.connect(emailCode);
  const picker = ui.elements.get('calendar-bid-period');
  assert.equal(ui.elements.get('calendar-bid-period-control').hidden, false);
  assert.match(picker.innerHTML, />BP377 · 7 Sept? 2026/);
  assert.match(picker.innerHTML, />BP378 · 2 Nov 2026/);
  picker.value = '378:2026-11-02';
  picker.events.change();

  assert.equal(ui.elements.get('calendar-month').textContent, 'BP378 · 2 Nov 2026 – 27 Dec 2026');
  assert.deepEqual(weekNumbers(ui), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(ui.elements.get('calendar-grid').innerHTML, /Week 5<\/span><span[^>]*><time datetime="2026-11-30"/);
  assert.doesNotMatch(ui.elements.get('calendar-grid').innerHTML, /2026-10-31|No roster entry/);
  assert.match(ui.elements.get('summary-row').innerHTML, /BP378 · Long haul/);
  assert.match(ui.elements.get('summary-row').innerHTML, /BP3781 \/ BP3785 · Short haul/);
  const matchingDates = vm.runInContext('currentPayload.matches.map(match => match.sort_date)', ui.context);
  assert.ok(matchingDates.includes('2026-11-02') && matchingDates.includes('2026-12-27'));
  assert.ok(matchingDates.every(date => date >= '2026-11-02' && date <= '2026-12-27'));

  picker.value = '377:2026-09-07';
  picker.events.change();
  assert.match(ui.elements.get('calendar-month').textContent, /^BP377/);
  assert.deepEqual(weekNumbers(ui), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(ui.elements.get('summary-row').innerHTML, /No roster for this bid period/);
  assert.equal(vm.runInContext('currentPayload.matches.length', ui.context), 0);
  const reopened = setup(JSON.parse(ui.store.get(storageKey)));
  assert.match(reopened.elements.get('calendar-month').textContent, /^BP377/);
});

test('adjacent bid-period views share one trip and retain its original sectors and printed release', async () => {
  const ui = setup();
  const tripCode = 'P100';
  const formerStart = new Date(2026, 8, 7);
  const laterStart = new Date(2026, 10, 2);
  const original = longPeriodFile({ bid: '377', start: formerStart });
  const continuation = longPeriodFile({ bid: '378', start: laterStart });
  const originalText = (await original.text()).replace('30/10 F A', `30/10 F ${tripCode} 2100`)
    .replace('31/10 S A', `31/10 S ${tripCode}`).replace('01/11 U A', `01/11 U ${tripCode}`) +
    `\nPattern: ${tripCode}\nQF1 MEL/SIN FR 2200 1100 SA 0300\nQF2 SIN/MEL TU 2300 1500 WE 0830`;
  const continuationText = (await continuation.text()).replace('02/11 M A', `02/11 M ${tripCode}`)
    .replace('03/11 T A', `03/11 T ${tripCode}`).replace('04/11 W A', `04/11 W ${tripCode} 0700 0900`)
    .replace('21/11 S A', '21/11 S SL');
  const other = longPeriodFile({ bid: '378', start: laterStart });
  const otherText = (await other.text()).replace('100000', '200000');
  await ui.add([{ ...continuation, text: async () => continuationText }, { ...other, text: async () => otherText }]);
  ui.domicile(0, 'ADL');
  assert.equal(vm.runInContext('periodRosters[0].unresolvedDuties.length', ui.context), 3);
  await ui.add([{ ...original, text: async () => originalText }]);

  const picker = ui.elements.get('calendar-bid-period');
  picker.value = '378:2026-11-02';
  picker.events.change();
  assert.equal(vm.runInContext('periodRosters[0].unresolvedDuties.length', ui.context), 0);
  assert.equal(vm.runInContext('loadedRosters[0].parsed.trips.length', ui.context), 1);
  assert.equal(vm.runInContext('periodRosters[0].offDays.find(day => day.dutyCode === "SL").date.getDate()', ui.context), 21);
  assert.match(ui.elements.get('summary-row').innerHTML, /Domicile: ADL/);
  assert.ok(vm.runInContext('calendarModel.details.some(detail => detail.text.includes("P100 · Carry-in"))', ui.context));
  assert.ok(vm.runInContext('periodRosters[0].homeBoundaryWindows.some(window => window.start.getDate() === 4 && window.start.getHours() === 9)', ui.context));
  assert.ok(vm.runInContext('periodRosters[0].portWindows.some(window => window.port === "SIN" && window.start.getDate() === 2 && window.start.getHours() === 0)', ui.context));

  picker.value = '377:2026-09-07';
  picker.events.change();
  assert.ok(vm.runInContext('calendarModel.details.some(detail => detail.text.includes("P100 · Carry-out"))', ui.context));
  assert.ok(vm.runInContext('periodRosters[0].portWindows.every(window => window.end <= new Date(2026, 10, 2))', ui.context));

  const restored = setup(JSON.parse(ui.store.get(storageKey)));
  assert.ok(vm.runInContext('calendarModel.details.some(detail => detail.text.includes("P100 · Carry-out"))', restored.context));
});

test('a short-haul second half shows weeks 5–8 and keeps those numbers in Month view', async () => {
  const ui = setup();
  const start = new Date(2027, 0, 25);
  await ui.add([
    periodFile({ bid: '3795', start, issued: '10Jan27 1055' }),
    periodFile({ bid: '3795', start, issued: '10Jan27 1055', staff: '654321', name: 'TEST PILOT B' }),
  ]);
  assert.equal(ui.elements.get('calendar-bid-period-control').hidden, true);
  assert.equal(ui.elements.get('calendar-month').textContent, 'BP3795 · 25 Jan 2027 – 21 Feb 2027');
  assert.deepEqual(weekNumbers(ui), [5, 6, 7, 8]);
  assert.match(ui.elements.get('calendar-range-summary').textContent, /28 days · Weeks 5–8/);
  const range = ui.elements.get('calendar-range');
  range.value = 'month';
  range.events.change();
  assert.equal(ui.elements.get('calendar-month').textContent, 'BP3795 · February 2027');
  assert.deepEqual(weekNumbers(ui), [6, 7, 8]);
  ui.elements.get('calendar-previous').events.click();
  assert.deepEqual(weekNumbers(ui), [5]);
});

test('a partial long-haul report uses its scheduled bid-period week without filling missing days', async () => {
  const ui = setup();
  await ui.add([
    longPeriodFile({ bid: '378', start: new Date(2026, 10, 9), days: 49 }),
    periodFile({ bid: '3781' }),
  ]);
  assert.deepEqual(weekNumbers(ui), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(ui.elements.get('calendar-grid').innerHTML, /No roster entry is available|No roster/);
  const matchingDates = vm.runInContext('currentPayload.matches.map(match => match.sort_date)', ui.context);
  assert.ok(matchingDates.includes('2026-11-09'));
  assert.ok(matchingDates.every(date => date >= '2026-11-09' && date <= '2026-11-29'));
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
  assert.match(markup,/data-crew-combination="0,1"/);
  const id=markup.match(/class="calendar-bar calendar-overlap[^>]*data-calendar-detail="(\d+)"/)[1];
  ui.elements.get('calendar-grid').events.click({target:{closest:()=>({dataset:{calendarDetail:id}})}});
  assert.equal(ui.elements.get('calendar-detail-text').textContent,'A · SYD\nB · SYD');
  ui.select(0,false);
  assert.doesNotMatch(ui.elements.get('calendar-grid').innerHTML,/calendar-overlap/);
  ui.select(0,true);
  assert.match(ui.elements.get('calendar-grid').innerHTML,/data-crew-combination="0,1"/);
  ui.remove(2);
  assert.equal(ui.elements.get('selection-count').textContent,'2 selected');
  assert.match(ui.elements.get('calendar-grid').innerHTML,/calendar-overlap/);
});


const emailCode = 'roster-overlap:' + 'a'.repeat(48);
function emailResponse(texts, known = {}, staffNumber = '123456') {
  const entries = texts.map((text, index) => ({ periodKey: `period-${index}`, fileName: `email-${index}.txt`, rosterText: text,
    contentHash: createHash('sha256').update(text).digest('hex'), issuedAt: '2026-11-16T00:00:00Z', storedAtUtc: '2026-11-16T01:00:00Z' }));
  return { staffNumber, name: 'TEST PILOT A', periods: entries.map(({ rosterText, ...metadata }) => metadata), changed: entries.filter(entry => known[entry.periodKey] !== entry.contentHash), unavailable: [], checkedAtUtc: '2026-11-16T02:00:00Z', message: texts.length ? '' : 'Waiting for emailed roster text.' };
}

test('emailed periods connect as one pilot, mix with manual uploads, and revisions retain settings and other periods', async () => {
  let texts = [shortPeriod(), shortPeriod({ start: new Date(2026, 10, 30), bid: '2' })];
  const knownRequests = [];
  const ui = setup(undefined, undefined, async (url, options) => {
    assert.equal(url, email.EMAIL_ROSTER_API);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.authorization, 'Bearer ' + 'a'.repeat(48));
    const known = JSON.parse(options.body).known; knownRequests.push(known);
    return Response.json(emailResponse(texts, known));
  });
  await ui.connect(emailCode);
  assert.equal(ui.elements.get('roster-count').textContent, '1 / 5 loaded');
  assert.doesNotMatch(ui.elements.get('crew-list').innerHTML, /data-(?:roster|domicile)-index="\d+"[^>]*\bdisabled/);
  assert.equal(vm.runInContext('loadedRosters[0].parsed.calendar.length', ui.context), 56);
  await ui.add([file(0)]);
  ui.domicile(0, 'ADL'); ui.select(0, false);
  const colour = vm.runInContext('loadedRosters[0].parsed.colour', ui.context);
  texts[0] = shortPeriod({ issued: '16Nov26 1055', duty: 'LD' });
  await ui.refresh();
  assert.equal(vm.runInContext('loadedRosters[0].files.length', ui.context), 2);
  assert.equal(vm.runInContext('loadedRosters[0].parsed.calendar[0].dutyCode', ui.context), 'LD');
  assert.equal(vm.runInContext('loadedRosters[0].parsed.calendar.length', ui.context), 56);
  assert.equal(vm.runInContext('loadedRosters[0].domicile', ui.context), 'ADL');
  assert.equal(vm.runInContext('loadedRosters[0].parsed.colour', ui.context), colour);
  assert.equal(vm.runInContext('loadedRosters[0].selected', ui.context), false);
  assert.equal(Object.keys(knownRequests[1]).length, 2);
  await ui.refresh();
  assert.match(ui.elements.get('email-status').textContent, /0 roster periods updated/);
  const saved = JSON.parse(ui.store.get(storageKey));
  assert.equal(saved.emailConnections.length, 1);
  assert.equal(saved.currentInputs.rosters[0].files[0].emailSource.staffNumber, '123456');
  ui.disconnect(0);
  assert.equal(JSON.parse(ui.store.get(storageKey)).emailConnections.length, 0);
  assert.equal(vm.runInContext('loadedRosters[0].files.length', ui.context), 2);
});

test('failed or revoked refresh retains the last valid files; a bad period makes its pilot update atomic', async () => {
  let response = emailResponse([shortPeriod()]);
  let status = 200;
  const ui = setup(undefined, undefined, async () => Response.json(response, { status }));
  await ui.connect(emailCode);
  const previous = vm.runInContext('loadedRosters[0].text', ui.context);
  status = 403; response = { error: 'Access revoked' };
  await ui.refresh();
  assert.match(ui.elements.get('email-status').textContent, /Access revoked/);
  assert.equal(vm.runInContext('loadedRosters[0].text', ui.context), previous);
  status = 200;
  response = emailResponse([shortPeriod({ duty: 'LD', issued: '16Nov26 1055' }), 'invalid roster']);
  await ui.refresh();
  assert.equal(vm.runInContext('loadedRosters[0].files.length', ui.context), 1);
  assert.equal(vm.runInContext('loadedRosters[0].text', ui.context), previous);
  response = emailResponse([shortPeriod({ staff: '654321' })]);
  await ui.refresh();
  assert.match(ui.elements.get('email-status').textContent, /different pilot/);
  assert.equal(vm.runInContext('loadedRosters[0].text', ui.context), previous);
});

test('empty connections wait for first email and clear saved data removes codes and rosters', async () => {
  let texts = [];
  const ui = setup(undefined, undefined, async (_url, options) => Response.json(emailResponse(texts, JSON.parse(options.body).known)));
  await ui.connect(emailCode);
  assert.match(ui.elements.get('email-status').textContent, /Waiting/);
  assert.equal(JSON.parse(ui.store.get(storageKey)).emailConnections.length, 1);
  assert.equal(ui.elements.get('roster-count').textContent, '0 / 5 loaded');
  texts = [shortPeriod()];
  await ui.refresh();
  assert.equal(ui.elements.get('roster-count').textContent, '1 / 5 loaded');
  ui.elements.get('clear-storage-button').events.click();
  assert.equal(ui.store.has(storageKey), false);
  assert.equal(vm.runInContext('emailConnections.length', ui.context), 0);
  assert.equal(ui.elements.get('email-connection-code').value, '');
});

test('a saved connection refreshes on opening without locking crew settings', async () => {
  const requests = [];
  const fetcher = async (_url, options) => {
    const known = JSON.parse(options.body).known; requests.push(known);
    return Response.json(emailResponse([shortPeriod()], known));
  };
  const first = setup(undefined, undefined, fetcher);
  await first.connect(emailCode);
  await first.add([file(0), file(1)]);
  first.select(2, false);
  const saved = JSON.parse(first.store.get(storageKey));
  let finishRefresh;
  const pendingRefresh = new Promise(resolve => { finishRefresh = resolve; });
  const restored = setup(saved, undefined, async (...args) => {
    await pendingRefresh;
    return fetcher(...args);
  });
  const crewList = restored.elements.get('crew-list');
  restored.select(1, false);
  restored.select(2, true);
  restored.domicile(0, 'ADL');
  const controlsDuringRefresh = crewList.innerHTML;
  const savedDuringRefresh = JSON.parse(restored.store.get(storageKey));
  finishRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(Object.keys(requests[1]).length, 1);
  const disabledSettings = /data-(?:roster|domicile)-index="\d+"[^>]*\bdisabled/;
  assert.doesNotMatch(controlsDuringRefresh, disabledSettings);
  assert.doesNotMatch(crewList.innerHTML, disabledSettings);
  assert.deepEqual(savedDuringRefresh.currentInputs.rosters.map(roster => roster.selected), [true, false, true]);
  assert.equal(savedDuringRefresh.currentInputs.rosters[0].domicile, 'ADL');
  const refreshed = JSON.parse(restored.store.get(storageKey));
  assert.deepEqual(refreshed.currentInputs.rosters.map(roster => roster.selected), [true, false, true]);
  assert.equal(refreshed.currentInputs.rosters[0].domicile, 'ADL');
  assert.equal(vm.runInContext('loadedRosters[0].files.length', restored.context), 1);
  restored.remove(0);
  assert.equal(vm.runInContext('emailConnections.length', restored.context), 0);
});

test('capacity failures and invalid connection codes do not save a new connection', async () => {
  const ui = setup(undefined, undefined, async () => Response.json(emailResponse([shortPeriod()])));
  await ui.add([0,1,2,3,4].map(file));
  await ui.connect(emailCode);
  assert.match(ui.elements.get('email-status').textContent, /up to 5/);
  assert.equal(vm.runInContext('emailConnections.length', ui.context), 0);
  await ui.connect('https://untrusted.example/token');
  assert.match(ui.elements.get('email-status').textContent, /private Overlap connection code/);
});
