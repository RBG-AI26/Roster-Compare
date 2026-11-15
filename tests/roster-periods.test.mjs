import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortPeriod } from './fixtures/short-period.mjs';
const moduleFrom = async file => import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../' + file, import.meta.url))).toString('base64'));
const { parseRosterText, mergeRosterPeriods, findRosterPilotIndex } = await moduleFrom('roster-browser.js');
const { buildRosterCalendar, sharedCalendarWindows } = await moduleFrom('roster-calendar.js');
const parse = options => parseRosterText('short.txt', shortPeriod(options));

test('two four-week periods produce one eight-week pilot with full coverage', () => {
  const first = parse({ duty: 'LD' });
  const second = parse({ start: new Date(2026, 10, 30), bid: '2' });
  const merged = mergeRosterPeriods([second, first]);
  merged.domicile = 'ADL';
  assert.equal(merged.calendar.length, 56);
  assert.equal(merged.coverageStart.getDate(), 2);
  assert.equal(merged.coverageEnd.getMonth(), 11);
  assert.equal(merged.coverageEnd.getDate(), 27);
  assert.equal(merged.unresolvedDuties.length, 0);
  assert.equal(first.calendar[0].dutyInfo.label, 'LD · Defence leave');
  const calendar = buildRosterCalendar([merged], new Date(2026, 10, 1), { range: 'roster' });
  assert.equal(calendar.weeks.length, 8);
  assert.match(calendar.weeks[0].rows[0][0].detail, /LD · Defence leave/);
  assert.ok(calendar.weeks.every(week => week.rows.length === 1 && week.rows[0].every(cell => cell.kind === 'home' && cell.label === 'ADL · home')));
  const other = { ...merged, staffNumber: '654321' };
  assert.ok(sharedCalendarWindows([merged, other]).every(window => window.port === 'ADL'));
});

test('LD is defence leave at domicile in long-haul rosters too', () => {
  const roster = parseRosterText('arms.txt', 'ARMS\nName: TEST PILOT Staff No: 123456\nBase: MEL\nDate: 02 Nov 2026\nDate Duty Detail\n02/11 M LD\nEND OF REPORT\n');
  roster.domicile = 'ADL';
  assert.equal(roster.offDays[0].dutyCode, 'LD');
  assert.equal(roster.unresolvedDuties.length, 0);
  assert.equal(sharedCalendarWindows([roster, roster])[0].port, 'ADL');
});

test('identity uses staff number, with a unique known-name fallback', () => {
  const first = parse();
  assert.equal(findRosterPilotIndex([first], { ...first, crewName: 'RENAMED PILOT' }), 0);
  assert.equal(findRosterPilotIndex([first], { ...first, staffNumber: '654321' }), -1);
  assert.equal(findRosterPilotIndex([first], { ...first, staffNumber: null, crewName: ' test   pilot a ' }), 0);
  assert.equal(findRosterPilotIndex([first, { ...first, staffNumber: '654321' }], { ...first, staffNumber: null }), -1);
  assert.equal(findRosterPilotIndex([{ ...first, crewName: 'Unknown', staffNumber: null }], { ...first, crewName: 'Unknown', staffNumber: null }), -1);
  assert.throws(() => mergeRosterPeriods([first, { ...first, staffNumber: '654321' }]), /different staff/);
});

test('newer issued dates replace old duties and presence in either import order', () => {
  const old = parse({ duty: 'MS 0800 1200', issued: '13Nov26 1555' });
  const revision = parse({ duty: 'LD', issued: '15Nov26 1055' });
  for (const sources of [[old, revision], [revision, old]]) {
    const merged = mergeRosterPeriods(sources);
    merged.domicile = 'ADL';
    assert.equal(merged.calendar.length, 28);
    assert.ok(merged.calendar.every(entry => entry.dutyCode === 'LD'));
    assert.equal(merged.portWindows.length, 0);
    assert.equal(merged.dutyBlocks.length, 0);
    assert.equal(merged.homeBoundaryWindows.length, 0);
    assert.ok(sharedCalendarWindows([merged, merged]).every(window => window.port === 'ADL' && !window.onDuty));
  }
});

test('real gaps stay unavailable and do not generate overlap windows', () => {
  const merged = mergeRosterPeriods([parse(), parse({ start: new Date(2026, 11, 7) })]);
  const model = buildRosterCalendar([merged], new Date(2026, 10, 1), { range: 'roster' });
  assert.ok(model.weeks[4].rows[0].every(cell => cell.kind === 'unavailable'));
  assert.ok(sharedCalendarWindows([merged, merged]).every(window => window.end <= new Date(2026, 10, 30) || window.start >= new Date(2026, 11, 7)));
});
