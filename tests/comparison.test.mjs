import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = await readFile(new URL('../roster-browser.js', import.meta.url), 'utf8');
const { compareRosterGroupTexts, parseRosterText } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function roster(index, { off = true, arrival = '1000', departure = '1400', port = 'LAX', month = '01' } = {}) {
  return { fileName: `webcis-${index}.txt`, text: `webCIS\nName: TEST PILOT ${String.fromCharCode(65 + index)}  Staff No: ${100000 + index}\nBase: SYD\nBid Period 1\nDate: 01 Jan 2026\nDate Duty Detail\n05/${month} M P1\n06/${month} T ${off ? 'A' : 'Z'}\nEND OF REPORT\nPattern: P1\nQF1 SYD/${port} MO 0800 0200 MO ${arrival}\nQF2 ${port}/SYD MO ${departure} 0800 MO 2200\n` };
}
test('two through five selected crew share a day off and a common port window', () => {
  for (let count = 2; count <= 5; count++) {
    const payload = compareRosterGroupTexts(Array.from({ length: count }, (_, i) => roster(i)));
    assert.equal(payload.crews.length, count);
    assert.equal(payload.matches.filter(m => m.match_key === 'shared_day_off').length, 1);
    assert.equal(payload.matches.filter(m => m.match_key === 'port_match').length, 1);
    assert.ok(payload.matches.every(m => m.participants.length === count));
  }
});
test('fifth crew limits the common window; threshold is inclusive', () => {
  const inputs = [0, 1, 2, 3].map(i => roster(i));
  inputs.push(roster(4, { arrival: '1300', departure: '1400', off: false }));
  assert.equal(compareRosterGroupTexts(inputs).matches.length, 1);
  assert.equal(compareRosterGroupTexts(inputs, { minPortOverlapMinutes: 61 }).matches.length, 0);
});
test('different port or non-overlapping windows cannot produce a group port match', () => {
  for (const options of [{ port: 'SIN' }, { arrival: '1500', departure: '1800' }]) {
    const inputs = [0, 1, 2, 3].map(i => roster(i));
    inputs.push(roster(4, { ...options, off: false }));
    assert.equal(compareRosterGroupTexts(inputs).matches.length, 0);
  }
});
test('comparison uses only the selected subset', () => {
  const inputs = [roster(0), roster(1), roster(2, { port: 'SIN', off: false })];
  assert.equal(compareRosterGroupTexts(inputs).matches.length, 0);
  assert.equal(compareRosterGroupTexts(inputs.slice(0, 2)).matches.length, 2);
});
test('disjoint coverage reports actual group size', () => {
  const inputs = [0, 1, 2, 3].map(i => roster(i));
  inputs.push(roster(4, { month: '02' }));
  assert.ok(compareRosterGroupTexts(inputs).notes.some(note => note.includes('all 5 rosters')));
});
test('rejects invalid group sizes and unparseable input', () => {
  for (const count of [0, 1, 6]) assert.throws(() => compareRosterGroupTexts(Array.from({ length: count }, (_, i) => roster(i))), /between 2 and 5/);
  assert.throws(() => parseRosterText('bad.txt', 'not a roster'), /No calendar entries/);
});
test('a day off uses domicile when matching a visiting pilot, without moving base', async () => {
  const {compareRosterGroup}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const a=parseRosterText(roster(0).fileName,roster(0).text);
  const b=parseRosterText(roster(1).fileName,roster(1).text);
  a.base='MEL';a.domicile='ADL';
  a.calendar[0].dutyCode='A';a.offDays.push(a.calendar[0]);a.portWindows=[];
  b.portWindows.forEach(window=>window.port='ADL');
  const matches=compareRosterGroup([a,b]).matches;
  assert.ok(matches.some(match=>match.match_key==='port_match'&&match.port==='ADL'));
  assert.equal(a.base,'MEL');
});
