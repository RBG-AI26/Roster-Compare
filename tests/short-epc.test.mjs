import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortEpcRoster } from './fixtures/short-epc.mjs';
const moduleFrom = async file => import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../' + file, import.meta.url))).toString('base64'));
const { parseRosterText } = await moduleFrom('roster-browser.js');
const { buildRosterCalendar, sharedCalendarWindows } = await moduleFrom('roster-calendar.js');
const parse = options => parseRosterText('short.txt', shortEpcRoster(options));
const clock = date => `${date.getHours()}:${date.getMinutes()}`;

test('short-haul EP29 is EPC in the port shown by its C course sector', () => {
  const roster = parse();
  const entry = roster.calendar.find(row => row.dutyCode === 'EP29');
  assert.equal(entry.dutyInfo.kind, 'training');
  assert.match(entry.dutyInfo.label, /EPC.*EP29/);
  assert.equal(entry.dutyInfo.port, 'MEL');
  assert.equal(clock(entry.dutyInfo.start), '7:35');
  assert.equal(clock(entry.dutyInfo.end), '15:25');
  assert.equal(entry.report, '0705'); // Preserve the original base-clock column.
  assert.equal(roster.unresolvedDuties.length, 0);
  assert.deepEqual(roster.trips[0].legs.map(leg => leg.marker), ['P', 'C', 'P']);
  assert.equal(roster.trips[0].legs[1].service, 'EP29');
  const model = buildRosterCalendar([roster], new Date(2026, 11, 1), { range: 'roster' });
  const cell = model.weeks.flatMap(week => week.rows[0]).find(cell => /EPC/.test(cell.label));
  assert.match(cell.detail, /EPC.*EP29/);
  assert.match(cell.detail, /Matched EPC course-sector times \(port local\)/);
  assert.doesNotMatch(cell.detail, /Port not supplied|Location unknown/);
});

test('EPC hours are on duty and are removed from the surrounding MEL layover', () => {
  const roster = parse();
  const start = new Date(2026, 11, 13, 7, 35), end = new Date(2026, 11, 13, 15, 25);
  assert.ok(roster.portWindows.some(window => window.onDuty && window.port === 'MEL' && +window.start === +start && +window.end === +end));
  assert.ok(roster.portWindows.filter(window => window.matchType === 'in_port').every(window => window.end <= start || window.start >= end));
  const windows = sharedCalendarWindows([roster, roster]);
  const during = windows.filter(window => window.start < end && window.end > start && window.port === 'MEL');
  assert.ok(during.length > 0);
  assert.ok(during.every(window => window.onDuty));
});

test('an explicit course sector supplies times when the calendar times are absent', () => {
  const roster = parse({ courseTimes: false });
  const entry = roster.calendar.find(row => row.dutyCode === 'EP29');
  assert.equal(clock(entry.dutyInfo.start), '7:35');
  assert.equal(clock(entry.dutyInfo.end), '15:25');
  assert.equal(roster.unresolvedDuties.length, 0);
});

test('enclosing PAX sectors in one pattern can identify the course port', () => {
  const roster = parse({ course: false });
  const entry = roster.calendar.find(row => row.dutyCode === 'EP29');
  assert.equal(entry.dutyInfo.port, 'MEL');
  assert.match(entry.dutyInfo.locationSource, /PAX.*overnight/);
  assert.equal(roster.unresolvedDuties.length, 0);
});

test('conflicting positioning ports do not invent a course location', () => {
  const roster = parse({ course: false, outboundPort: 'SYD' });
  const entry = roster.calendar.find(row => row.dutyCode === 'EP29');
  assert.equal(entry.dutyInfo.port, null);
  assert.ok(roster.unresolvedDuties.some(row => row.dutyCode === 'EP29'));
});

test('explicit course location takes priority over base and domicile', () => {
  const roster = parse({ coursePort: 'BNE' });
  roster.domicile = 'PER';
  assert.equal(roster.calendar.find(row => row.dutyCode === 'EP29').dutyInfo.port, 'BNE');
});

test('EP-number shorthand is restricted to short-haul and needs location evidence', () => {
  const short = parseRosterText('short.txt', 'SH Flight Crew Roster\nName: TEST PILOT A Category: CPT\nBase: ADL\n13 Dec 2026 - 13 Dec 2026\nDate    Duty(Role)                  S-On\n13 Sun  EP30 0800 1200\nGlobal Preferences');
  assert.match(short.calendar[0].dutyInfo.label, /EPC.*EP30/);
  assert.equal(short.calendar[0].dutyInfo.port, null);
  assert.equal(short.unresolvedDuties.length, 1);
  const long = parseRosterText('arms.txt', 'ARMS\nName: TEST PILOT A Staff No: 123456\nBase: ADL\nDate: 13 Dec 2026\nDate Duty Detail\n13/12 S EP29 0800 1200\nEND OF REPORT');
  assert.equal(long.calendar[0].dutyInfo, undefined);
  assert.equal(long.unresolvedDuties.length, 1);
});
