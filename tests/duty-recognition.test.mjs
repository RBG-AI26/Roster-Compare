import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortPeriod } from './fixtures/short-period.mjs';
const fromFile = async file => import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../' + file, import.meta.url), 'utf8')).toString('base64'));
const { parseRosterText, compareRosterGroup } = await fromFile('roster-browser.js');
const { buildRosterCalendar, sharedCalendarWindows } = await fromFile('roster-calendar.js');
const parse = (rows, patterns = '', base = 'ADL') => parseRosterText('arms.txt', `ARMS\nName: TEST PILOT Staff No: 123456\nBase: ${base}\nDate: 07 May 2026\nDate Duty Detail Rept End Credit\n${rows}\nEND OF REPORT\n${patterns}`);
const model = roster => buildRosterCalendar([roster, roster], new Date(2026, 4, 1));
const cells = roster => model(roster).weeks.flatMap(week => week.rows[0]);
// Synthetic examples mirror Roster Export iCal's parser/analysis rules and smoke fixtures.
test('BL is a day off at domicile in short-haul and long-haul rosters', () => {
  const short = parseRosterText('short.txt', shortPeriod({ start: new Date(2026, 10, 30), duty: index => index === 11 ? 'BL' : 'D/O' }));
  const long = parseRosterText('arms.txt', 'ARMS\nName: TEST PILOT Staff No: 123456\nBase: MEL\nDate: 14 Nov 2026\nDate Duty Detail\n11/12 F BL\nEND OF REPORT\n');
  for (const roster of [short, long]) {
    roster.domicile = 'ADL';
    const entry = roster.calendar.find(row => row.dutyCode === 'BL');
    assert.equal(entry.dutyInfo.label, 'BL · day off');
    assert.equal(entry.dutyInfo.assumeHome, true);
    assert.equal(roster.unresolvedDuties.length, 0);
    assert.ok(roster.offDays.some(row => row.dutyCode === 'BL'));
    assert.equal(roster.reserveDays.length, 0);
    const model = buildRosterCalendar([roster], new Date(2026, 11, 1), { range: 'roster' });
    const cell = model.weeks.flatMap(week => week.rows[0]).find(cell => cell.detail.startsWith('BL · day off'));
    assert.equal(cell.label, 'ADL · home');
    assert.equal(cell.kind, 'home');
    const windows = sharedCalendarWindows([roster, roster]);
    assert.ok(windows.some(window => window.port === 'ADL' && window.start <= entry.date && window.end > entry.date && !window.onDuty && !window.reserve));
    assert.ok(compareRosterGroup([roster, roster]).matches.some(match => match.sort_date === '2026-12-11' && match.match_key === 'shared_day_off'));
  }
});

test('RX is a day off, never reserve, and HL is recognised leave', () => {
  const roster = parse('21/05 T RX\n22/05 F HL');
  roster.domicile = 'PER';
  assert.deepEqual(roster.offDays.map(row => row.dutyCode), ['RX', 'HL']);
  assert.equal(roster.reserveDays.length, 0);
  assert.equal(roster.unresolvedDuties.length, 0);
  assert.equal(sharedCalendarWindows([roster, roster])[0].port, 'PER');
});
test('EPA and EPC city suffixes supply a location independent of base and domicile', () => {
  for (const prefix of ['EPA', 'EPC']) for (const [suffix, port] of Object.entries({SY:'SYD', ML:'MEL', BN:'BNE', PH:'PER'})) {
    const roster = parse(`21/05 T ${prefix}${suffix} 0800 1200 4:00`);
    roster.domicile = 'OOL';
    assert.equal(roster.unresolvedDuties.length, 0);
    assert.equal(roster.portWindows[0].port, port);
    assert.equal(roster.portWindows[0].start.getHours(), 8);
    assert.equal(roster.portWindows[0].end.getHours(), 12);
    assert.equal(roster.portWindows[0].onDuty, true);
    assert.ok(cells(roster).some(cell => cell.kind === 'ground' && cell.label.includes(port)));
  }
});
test('TSPD follows the export app Melbourne rule; credit never supplies missing times', () => {
  const timed = parse('21/05 T TSPD 0800 1200 4:00');
  assert.equal(timed.portWindows[0].port, 'MEL');
  assert.equal(timed.unresolvedDuties.length, 0);
  const marker = parse('21/05 T TSPD 5:30');
  assert.equal(marker.calendar[0].dutyInfo.port, 'MEL');
  assert.equal(marker.portWindows.length, 0);
  assert.match(marker.unresolvedDuties[0].uncertainty, /times are missing/);
  assert.ok(cells(marker).some(cell => cell.label === 'MEL · TSPD'));
});
test('SIM and other training codes retain their identity when location is missing', () => {
  for (const code of ['EPC', 'EPE', 'TPA', 'TPAX', 'TNR', 'PMI', 'EBT', 'TRG']) {
    const roster = parse(`21/05 T ${code} AW99 0800 1200 4:00`);
    assert.equal(roster.unresolvedDuties.length, 1, code);
    assert.equal(roster.portWindows.length, 0, code);
    assert.ok(cells(roster).some(cell => cell.kind === 'ground' && cell.label.includes(code.startsWith('SIM') ? 'SIM' : code)), code);
    const detail = compareRosterGroup([roster, roster]).crews[0].unresolved_duties[0];
    assert.match(detail.reason, /location/);
    assert.notEqual(detail.label, 'Location unknown');
  }
});
test('detail tokens after the first token can resolve a SIM city', () => {
  const roster = parse('21/05 T SIM07CA AW99 BNE 0800 1200 4:00');
  assert.equal(roster.calendar[0].detail, 'AW99 BNE');
  assert.equal(roster.portWindows[0].port, 'BNE');
  assert.equal(roster.unresolvedDuties.length, 0);
});
test('same-port SIM definition supplies location and sector timing without inventing a flight route', () => {
  const roster = parse('21/05 T SIM07CA', 'Pattern: SIM07CA\nSIM07CA & BNE/BNE TH 1100 0100 TH 1500 0500');
  assert.equal(roster.unresolvedDuties.length, 0);
  assert.equal(roster.portWindows.length, 1);
  assert.equal(roster.portWindows[0].port, 'BNE');
  assert.equal(roster.portWindows[0].start.getHours(), 11);
  const cell = cells(roster).find(cell => cell.kind === 'ground');
  assert.match(cell.label, /BNE.*SIM/);
  assert.doesNotMatch(cell.label, /→/);
});
test('interleaved SIM rows stay inside one trip; schedule times override narrower ground-sector times', () => {
  const roster = parse('21/05 T ZDA60 AW99 0615 4:50\n21/05 T SIM07CA AW99 1015 1545 5:30\n22/05 F SIM07CB AW99 1415 1945 5:30\n22/05 F ZDA60 2345', `Pattern: ZDA60 Route Code: TEST Days Away: 2
QFA0604 PAX MEL/BNE 0615 TH 0700 2100 TH 0920 2320
SIM07CA & BNE/BNE TH 1100 0100 TH 1500 0500
SIM07CB & BNE/BNE 1415 FR 1500 0500 FR 1900 0900
QFA1259 PAX BNE/MEL FR 2045 1045 FR 2315 1315`);
  assert.equal(roster.trips.length, 1);
  assert.equal(roster.trips[0].legs.length, 4);
  assert.equal(roster.unresolvedDuties.length, 0);
  const sim = roster.portWindows.filter(window => window.onDuty);
  assert.equal(sim.length, 2);
  assert.equal(sim[0].start.getHours(), 10);
  assert.equal(sim[0].start.getMinutes(), 15);
  assert.equal(sim[0].end.getHours(), 15);
  assert.equal(sim[0].end.getMinutes(), 45);
  for (const duty of sim) assert.ok(roster.portWindows.filter(w => w.matchType === 'in_port').every(w => w.end <= duty.start || w.start >= duty.end));
  assert.ok(cells(roster).some(cell => cell.label.includes('MEL → BNE') && cell.label.includes('SIM')));
  const windows = sharedCalendarWindows([roster, roster]);
  assert.ok(windows.some(window => window.onDuty));
  const calendar = model(roster);
  assert.ok(calendar.weeks.flatMap(w => w.overlaps).some(bar => bar.onDuty));
  assert.ok(compareRosterGroup([roster, roster]).matches.some(m => m.participants.some(p => p.label.includes('on duty'))));
});
test('standby uses base and real overnight times; untimed standby stays a marker', () => {
  const roster = parse('21/05 T SR 2200 0600 5:30\n22/05 F SR 5:30', '', 'MEL');
  assert.equal(roster.reserveDays.length, 2);
  assert.equal(roster.portWindows.length, 1);
  assert.equal(roster.portWindows[0].port, 'MEL');
  assert.equal(roster.portWindows[0].end.getDate(), 22);
  assert.equal(roster.unresolvedDuties.length, 1);
  assert.match(roster.unresolvedDuties[0].uncertainty, /times are missing/);
  assert.ok(cells(roster).some(cell => cell.label.includes('standby')));
});
test('sick leave uses the chosen domicile and upline sick leave retains uncertainty', () => {
  const roster = parse('21/05 T SL\n22/05 F UL', '', 'MEL');
  roster.domicile = 'ADL';
  assert.deepEqual(roster.offDays.map(entry => entry.dutyCode), ['SL']);
  assert.deepEqual(roster.unresolvedDuties.map(entry => entry.dutyCode), ['UL']);
  assert.ok(cells(roster).some(cell => cell.label === 'ADL · home' && cell.detail.includes('Sick leave')));
  assert.ok(cells(roster).some(cell => cell.kind === 'leave' && cell.label.includes('Upline sick')));
  assert.deepEqual(sharedCalendarWindows([roster, roster]).map(window => window.port), ['ADL']);
});
test('a day-off marker cannot create home presence alongside a training duty', () => {
  const roster = parse('21/05 T A\n21/05 T EPCSY 0800 1200');
  assert.equal(roster.offDays.length, 0);
  assert.equal(sharedCalendarWindows([roster, roster])[0].port, 'SYD');
});
test('genuine unknown codes and undecodable airports remain explicit gaps', () => {
  const roster = parse('21/05 T ZZZ\n22/05 F EPCZZ 0800 1200\n23/05 S SIM07CA AW99 2560 1200');
  assert.equal(roster.unresolvedDuties.length, 3);
  assert.equal(roster.portWindows.length, 0);
  assert.ok(cells(roster).some(cell => cell.kind === 'unknown'));
});
test('short-haul fixed columns preserve explicit ports for training and standby; RX stays off', () => {
  const row = (day, code, port) => `${day} Thu  ${code.padEnd(12)}${'AW99'.padEnd(28)}${'0800'.padEnd(5)}${'1200'.padEnd(5)}${'4:00'.padEnd(6)}${'4:00'.padEnd(7)}${port.padEnd(5)}`;
  // Columns match webCIS Date/Duty/Service/S-On/S-Off/Duty/Credit/Port.
  const text = `SH Flight Crew Roster\nName: TEST PILOT Category: CPT\nBase: MEL\nDate: 07 May 2026\n21 May 2026 - 22 May 2026\nDate    Duty(Role)                  S-On\n${row('21', 'SIM07CA', 'BNE')}\n${row('21', 'SR', 'SYD')}\n22 Fri  RX\nGlobal Preferences`;
  const roster = parseRosterText('short.txt', text);
  assert.equal(roster.unresolvedDuties.length, 0);
  assert.deepEqual(roster.portWindows.map(w => w.port), ['BNE', 'SYD']);
  assert.deepEqual(roster.offDays.map(row => row.dutyCode), ['RX']);
  const visitor = parse('21/05 T RX', '', 'SYD');
  assert.ok(compareRosterGroup([roster, visitor]).matches.some(m => m.port === 'SYD' && m.match_key === 'reserve_at_base'));
  assert.ok(!compareRosterGroup([roster, visitor]).matches.some(m => m.port === 'MEL'));
});
test('standby comparisons use the actual port and validated times, respecting the threshold', () => {
  const standby = parse('21/05 T SR 0800 0900', '', 'MEL');
  const home = parse('21/05 T RX', '', 'MEL');
  assert.equal(compareRosterGroup([standby, home]).matches.filter(m => m.match_key === 'reserve_at_base').length, 1);
  assert.equal(compareRosterGroup([standby, home], {minPortOverlapMinutes:61}).matches.filter(m => m.match_key === 'reserve_at_base').length, 0);
  assert.match(compareRosterGroup([standby, home]).matches.find(m => m.match_key === 'reserve_at_base').participants[0].label, /on call/);
  const invalid = parse('21/05 T SR 2560 1200', '', 'MEL');
  assert.equal(compareRosterGroup([invalid, home]).matches.length, 0);
});
test('an overnight training duty removes its hours from the following day-off home assumption', () => {
  const roster = parse('21/05 T EPCSY 2200 0600\n22/05 F RX', '', 'MEL');
  const home = parse('21/05 T A\n22/05 F A', '', 'MEL');
  const homeWindow = roster.offDays[0].homeWindows[0];
  assert.equal(homeWindow.start.getDate(), 22);
  assert.equal(homeWindow.start.getHours(), 6);
  assert.ok(sharedCalendarWindows([roster, home]).filter(w => w.port === 'MEL').every(w => w.start >= homeWindow.start));
  const dayOff = compareRosterGroup([roster, home]).matches.find(m => m.match_key === 'shared_day_off');
  assert.notEqual(dayOff.overlap_window, 'All day');
});

test('SIM exercise in the detail can match a same-port definition and its timing', () => {
  const roster = parse('21/05 T SIM SIM07CA AW99', 'Pattern: SIM07CA\nSIM07CA & BNE/BNE TH 1100 0100 TH 1500 0500');
  assert.equal(roster.unresolvedDuties.length, 0);
  assert.equal(roster.portWindows[0].port, 'BNE');
  assert.equal(roster.portWindows[0].start.getHours(), 11);
  assert.equal(roster.portWindows[0].end.getHours(), 15);
});


test('standalone consecutive SIM sessions use roster base, independent of domicile', () => {
  const roster = parse('21/05 T SIM08CA Sim: 78 0615 1145 5:30\n22/05 F SIM08CB Sim: 78 0615 1145 5:30', '', 'MEL');
  roster.domicile='ADL';
  assert.equal(roster.unresolvedDuties.length,0);
  assert.deepEqual(roster.calendar.map(row=>row.dutyInfo.port),['MEL','MEL']);
  assert.ok(roster.calendar.every(row=>row.dutyInfo.locationSource.includes('without associated positioning')));
  assert.ok(roster.portWindows.every(window=>window.port==='MEL'&&window.onDuty));
  assert.ok(cells(roster).some(cell=>cell.label.includes('MEL · SIM')));
  assert.ok(cells(roster).every(cell=>!cell.label.includes('Port not supplied')));
});
test('an untimed standalone SIM gets its base location without fabricated times', () => {
  const roster=parse('21/05 T SIM08CA 5:30','','MEL');
  assert.equal(roster.calendar[0].dutyInfo.port,'MEL');
  assert.equal(roster.portWindows.length,0);
  assert.equal(roster.unresolvedDuties.length,1);
  assert.match(roster.unresolvedDuties[0].uncertainty,/times are missing/);
  assert.doesNotMatch(roster.unresolvedDuties[0].uncertainty,/location/);
});
test('a SIM with no roster base or location remains unresolved', () => {
  const roster=parse('21/05 T SIM08CA 0615 1145 5:30','','');
  assert.equal(roster.base,null);
  assert.equal(roster.calendar[0].dutyInfo.port,null);
  assert.equal(roster.portWindows.length,0);
});
test('surrounding positioning sectors locate a two-day SIM visit away from base', () => {
  const roster=parse('20/05 W P1 0800\n21/05 T SIM08CA 0615 1145\n22/05 F SIM08CB 0615 1145\n23/05 S P1', `Pattern: P1
QF1 PAX MEL/BNE WE 0900 0200 WE 1100
QF2 PAX BNE/MEL SA 1500 0200 SA 1700`, 'MEL');
  assert.equal(roster.unresolvedDuties.length,0);
  const sims=roster.calendar.filter(row=>row.dutyInfo?.kind==='sim');
  assert.deepEqual(sims.map(row=>row.dutyInfo.port),['BNE','BNE']);
  assert.ok(sims.every(row=>row.dutyInfo.locationSource.includes('Associated positioning')));
});
test('conflicting travel ports prevent an incorrect base fallback', () => {
  const roster=parse('20/05 W P1\n21/05 T SIM08CA 0615 1145\n22/05 F P1', `Pattern: P1
QF1 PAX MEL/BNE WE 0900 0200 WE 1100
QF2 PAX SYD/MEL FR 1500 0200 FR 1700`, 'MEL');
  const sim=roster.calendar.find(row=>row.dutyInfo?.kind==='sim');
  assert.equal(sim.dutyInfo.port,null);
  assert.ok(roster.unresolvedDuties.includes(sim));
});
test('unrelated flights elsewhere in the roster do not stop standalone SIM base resolution', () => {
  const roster=parse('18/05 M P1\n21/05 T SIM08CA 0615 1145\n22/05 F SIM08CB 0615 1145\n25/05 M P1', `Pattern: P1
QF1 PAX MEL/SYD MO 0800 0200 MO 1000
QF2 PAX SYD/MEL MO 1200 0200 MO 1400`, 'MEL');
  assert.ok(roster.calendar.filter(row=>row.dutyInfo?.kind==='sim').every(row=>row.dutyInfo.port==='MEL'));
});


function shortDutyRoster(rows,base='ADL') {
  return parseRosterText('short-duties.txt',`SH Flight Crew Roster\nName: TEST PILOT Category: CPT\nBase: ${base}\nDate: 14 Nov 2026\n1 Dec 2026 - 4 Dec 2026\nDate    Duty(Role)                  S-On\n${rows}\nGlobal Preferences`);
}
test('short-haul AV is a full day off at domicile, alongside A/V and D/O', () => {
  const roster=shortDutyRoster('01 Tue  D/O\n02 Wed  AV\n03 Thu  A/V\n04 Fri  D/O');roster.domicile='MEL';
  assert.deepEqual(roster.offDays.map(row=>row.dutyCode),['D/O','AV','A/V','D/O']);
  assert.equal(roster.unresolvedDuties.length,0);
  const windows=sharedCalendarWindows([roster,roster]);
  assert.ok(windows.every(w=>w.port==='MEL'));
  assert.equal(windows[0].start.getDate(),1);assert.equal(windows[0].end.getDate(),5);
  assert.ok(compareRosterGroup([roster,roster]).matches.some(m=>m.sort_date==='2026-12-02'&&m.match_key==='shared_day_off'));
});
test('short-haul MS is on duty at base, separate from domicile and home time on either side', () => {
  const roster=shortDutyRoster('01 Tue  MS 1200 1201\n02 Wed  AV\n03 Thu  D/O\n04 Fri  D/O');roster.domicile='MEL';
  const ms=roster.calendar[0];
  assert.equal(ms.dutyInfo.port,'ADL');assert.equal(ms.dutyInfo.kind,'base_duty');
  assert.equal(roster.offDays.some(row=>row.dutyCode==='MS'),false);
  assert.equal(roster.unresolvedDuties.length,0);
  const duty=roster.portWindows.find(window=>window.dutyLabel.includes('MS'));
  assert.equal(duty.port,'ADL');assert.equal(duty.onDuty,true);assert.equal(duty.end-duty.start,60000);
  const visitor=shortDutyRoster('01 Tue  D/O\n02 Wed  D/O\n03 Thu  D/O\n04 Fri  D/O');
  const overlap=sharedCalendarWindows([roster,visitor],1).find(w=>w.onDuty);
  assert.equal(overlap.port,'ADL');assert.equal(overlap.start.getHours(),12);assert.equal(overlap.end.getMinutes(),1);
  assert.ok(roster.homeBoundaryWindows.some(w=>w.kind==='before'&&w.end.getHours()===12));
  assert.ok(roster.homeBoundaryWindows.some(w=>w.kind==='after'&&w.start.getMinutes()===1));
  assert.ok(buildRosterCalendar([roster,visitor],new Date(2026,11,1),{minOverlapMinutes:1}).weeks.flatMap(w=>w.rows[0]).some(cell=>cell.label.includes('ADL · MS')));
});
test('untimed short-haul MS retains its base location without a fabricated duty interval', () => {
  const roster=shortDutyRoster('01 Tue  MS\n02 Wed  AV\n03 Thu  D/O\n04 Fri  D/O');
  assert.equal(roster.calendar[0].dutyInfo.port,'ADL');
  assert.equal(roster.portWindows.length,0);assert.equal(roster.unresolvedDuties.length,1);
  assert.match(roster.unresolvedDuties[0].uncertainty,/times are missing/);
  assert.doesNotMatch(roster.unresolvedDuties[0].uncertainty,/location/);
});
test('AV and MS rules apply to short-haul rosters only', () => {
  const roster=parse('21/05 T AV\n22/05 F MS 1200 1201','','MEL');
  assert.equal(roster.offDays.length,0);assert.equal(roster.portWindows.length,0);
  assert.equal(roster.unresolvedDuties.length,2);
});
