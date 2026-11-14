import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = await readFile(new URL('../roster-browser.js', import.meta.url), 'utf8');
const { parseRosterText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
function shortHaul({ start = new Date(2026,10,30), printed = false, detail = true, generated = '14 Nov 2026', name = 'TEST PILOT' } = {}) {
  const end = new Date(start); end.setDate(end.getDate()+27);
  const printedDate = date => `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
  const rows = Array.from({length:28}, (_,index) => {
    const day = new Date(start); day.setDate(day.getDate()+index);
    return `${String(day.getDate()).padStart(2,'0')} ${weekdays[day.getDay()]}  ${index === 1 && detail ? 'P1' : 'D/O'}`;
  });
  const flight = new Date(start); flight.setDate(flight.getDate()+1);
  const stamp = `${String(flight.getDate()).padStart(2,'0')}${months[flight.getMonth()]}`;
  return `SH Flight Crew Roster\nName: ${name}  Category: CPT\nBase: MEL\nBid Period 3785\nDate: ${generated}\n${printed ? `${printedDate(start)} - ${printedDate(end)}\n` : ''}Date    Duty(Role)                  S-On\n${rows.join('\n')}\nGlobal Preferences\n${detail ? `Pattern Details\n${stamp} QF1 MEL 0800 SYD 0900\n${stamp} QF2 SYD 1200 MEL 1300\nP1 DATED ${stamp}${String(flight.getFullYear()).slice(-2)}\n*** End of Report` : ''}`;
}
test('first flight in December anchors calendar to 30 November–27 December', () => {
  for (const name of ['TEST PILOT A', 'TEST PILOT B']) {
    const roster = parseRosterText('webcis.txt', shortHaul({name}));
    assert.equal(dateKey(roster.coverageStart),'2026-11-30');
    assert.equal(dateKey(roster.coverageEnd),'2026-12-27');
    assert.equal(roster.calendar.length,28);
    assert.equal(roster.unresolvedDuties.length,0);
  }
});
test('explicit period wins over an unrelated January generation timestamp', () => {
  const roster = parseRosterText('webcis.txt', shortHaul({printed:true, detail:false, generated:'01 Jan 2026'}));
  assert.equal(dateKey(roster.coverageStart),'2026-11-30');
  assert.equal(dateKey(roster.coverageEnd),'2026-12-27');
});
test('a January flight can anchor a December calendar in the previous year', () => {
  const roster = parseRosterText('webcis.txt', shortHaul({start:new Date(2026,11,31),generated:'14 Dec 2026'}));
  assert.equal(dateKey(roster.coverageStart),'2026-12-31');
  assert.equal(dateKey(roster.coverageEnd),'2027-01-27');
});
test('leave-only roster uses weekday checks around its report date', () => {
  const roster = parseRosterText('webcis.txt', shortHaul({detail:false}));
  assert.equal(dateKey(roster.coverageStart),'2026-11-30');
  assert.equal(dateKey(roster.coverageEnd),'2026-12-27');
});
test('inconsistent weekday evidence is rejected instead of silently producing wrong dates', () => {
  const text = shortHaul().replace('30 Mon','30 Tue');
  assert.throws(() => parseRosterText('webcis.txt',text), /Cannot determine the short-haul roster period reliably/);
});
