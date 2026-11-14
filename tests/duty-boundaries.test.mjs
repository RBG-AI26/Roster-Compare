import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const fromFile = async file => import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../' + file, import.meta.url), 'utf8')).toString('base64'));
const { parseRosterText, compareRosterGroup } = await fromFile('roster-browser.js');
const { sharedCalendarWindows, buildRosterCalendar, dateKey } = await fromFile('roster-calendar.js');
const d = (day, hour = 0, minute = 0) => new Date(2026, 11, day, hour, minute);
function row(day, code, {report='',end='',detail=''} = {}) {
  const date = d(day);
  return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')} ${['S','M','T','W','T','F','S'][date.getDay()]} ${code.padEnd(10)}${detail.padEnd(8)}${report.padEnd(5)}${end.padEnd(6)}`;
}
function parse(rows, patterns='', base='MEL') {
  return parseRosterText('boundary-test.txt', `ARMS\nName: TEST PILOT A Staff No: 100001\nBase: ${base}\nDate: 14 Nov 2026\nDate    Duty      Detail  Rept End   Credit\n${rows.join('\n')}\nEND OF REPORT\n${patterns}`);
}
const shortRow = (day, code, report='', end='') => `${String(day).padStart(2,'0')} ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d(day).getDay()]}  ${code.padEnd(12)}${''.padEnd(28)}${report.padEnd(5)}${end.padEnd(5)}`;
const shared = (rosters, minutes=60) => sharedCalendarWindows(rosters, minutes).filter(w => w.assumed && !w.reserve && !w.onDuty);
const pattern = `Pattern: QW03
QF21 MEL/DFW 1100 TH 1200 0100 TH 1055 1655
QF22 DFW/MEL 1725 SU 1825 0025 TU 0500 1800`;
function sixDay(release='0530') {
  return parse(Array.from({length:6},(_,i)=>row(10+i,'QW03',{report:i===0?'1100':'',end:i===5?release:''})),pattern);
}
// Synthetic fixtures preserve the reported December boundary case, without personal roster data.
test('15 December starts at the printed 05:30 release and extends until the other pilot reports on the 19th', () => {
  const a=sixDay();a.domicile='ADL';
  const b=parseRosterText('short-test.txt',`SH Flight Crew Roster\nName: TEST PILOT B Category: CPT\nBase: ADL\nDate: 14 Nov 2026\n14 Dec 2026 - 19 Dec 2026\nDate    Duty(Role)                  S-On\n${[shortRow(14,'D/O'),shortRow(15,'D/O'),shortRow(16,'D/O'),shortRow(17,'D/O'),shortRow(18,'D/O'),shortRow(19,'P1','0745','1925')].join('\n')}\nGlobal Preferences\nPattern Details\n19Dec QF1 ADL 0845 AKL 1530\n19Dec QF2 AKL 1630 ADL 1855\nP1 DATED 19Dec26\n*** End of Report`);
  const endRow=a.calendar.at(-1);
  assert.equal(endRow.report,null);assert.equal(endRow.end,'0530');
  const window=shared([a,b]).find(w=>w.port==='ADL'&&dateKey(w.start)==='2026-12-15');
  assert.equal(window.start.getTime(),d(15,5,30).getTime());
  // Coverage is clipped to A's last printed date; adding its subsequent off days extends the same window.
  assert.equal(window.end.getTime(),d(16).getTime());
  const full=parse([...Array.from({length:6},(_,i)=>row(10+i,'QW03',{report:i===0?'1100':'',end:i===5?'0530':''})),...[16,17,18,19].map(day=>row(day,'X'))],pattern);full.domicile='ADL';
  const extended=shared([full,b]).find(w=>w.port==='ADL'&&dateKey(w.start)==='2026-12-15');
  assert.equal(extended.start.getTime(),d(15,5,30).getTime());assert.equal(extended.end.getTime(),d(19,7,45).getTime());
  const match=compareRosterGroup([full,b]).matches.find(m=>m.sort_date==='2026-12-15'&&m.match_key==='port_match');
  assert.equal(match.port,'ADL');assert.match(match.overlap_window,/05:30/);assert.equal(match.match_type,'Shared time off');
  const calendar=buildRosterCalendar([full,b],d(1),{range:'roster'});
  const finish=calendar.weeks.flatMap(w=>w.rows[0]).find(cell=>cell.label.includes('from 05:30'));
  assert.ok(finish);assert.match(finish.detail,/15 Dec 2026.*05:30/);assert.doesNotMatch(finish.detail,/assum|commute/i);
  const bar=calendar.weeks.flatMap(w=>w.overlapLanes.flat()).find(bar=>bar.port==='ADL'&&bar.start.getTime()===d(15,5,30).getTime());
  const detail=calendar.details[bar.detailId];
  assert.match(detail.subtitle,/15 Dec 2026.*05:30.*19 Dec 2026.*07:45/);
  assert.doesNotMatch(detail.text,/assum|commute|QW03|20 Dec/i);
  assert.doesNotMatch(bar.label,/\*/);
  assert.ok(detail.text.split('\n').every(line=>line.endsWith(' · ADL')));
  assert.ok(calendar.weeks.flatMap(w=>w.overlapLanes.flat()).some(bar=>bar.port==='ADL'&&bar.start.getTime()===d(15,5,30).getTime()));
});
test('start-only, end-only and credit-only fields stay in their printed columns across ARMS panels', () => {
  const a=parse([`${row(14,'P1',{report:'2100'})}|${row(15,'P1',{end:'0530'})}|${row(16,'X')} 2:51`],`Pattern: P1\nQF1 MEL/SIN MO 2200 0200 TU 0400\nQF2 SIN/MEL TU 0430 0200 TU 0500`);
  assert.deepEqual(a.calendar.map(e=>[e.report,e.end]),[['2100',null],[null,'0530'],[null,null]]);
});
test('same-day flying duties expose time before report and after release, never at landing', () => {
  const a=parse([row(14,'P1',{report:'0500',end:'0900'})],`Pattern: P1\nQF1 MEL/SYD MO 0600 0200 MO 0730\nQF2 SYD/MEL MO 0800 0200 MO 0830`);
  const b=parse([row(14,'X')]);
  assert.deepEqual(shared([a,b]).map(w=>[w.start.getHours(),w.end.getTime()===d(15).getTime()?24:w.end.getHours()]),[[0,5],[9,24]]);
  assert.equal(a.homeBoundaryWindows.find(w=>w.kind==='after').start.getTime(),d(14,9).getTime());
});
test('two separate same-day duties expose the middle gap once', () => {
  const a=parse([row(14,'P1',{report:'0500',end:'0900'}),row(14,'P2',{report:'1400',end:'1800'})],`Pattern: P1\nQF1 MEL/SYD MO 0600 0200 MO 0730\nQF2 SYD/MEL MO 0800 0200 MO 0830\nPattern: P2\nQF3 MEL/BNE MO 1500 0200 MO 1600\nQF4 BNE/MEL MO 1700 0200 MO 1730`);
  const b=parse([row(14,'X')]);
  assert.deepEqual(a.homeBoundaryWindows.map(w=>[w.start.getHours(),w.end.getTime()===d(15).getTime()?24:w.end.getHours()]),[[0,5],[9,14],[18,24]]);
  assert.equal(shared([a,b]).filter(w=>w.start.getTime()===d(14,9).getTime()&&w.end.getTime()===d(14,14).getTime()).length,1);
  assert.equal(compareRosterGroup([a,b]).matches.filter(m=>m.match_type==='Shared time off').length,3);
});
test('an overnight duty finishes on the following date and off markers do not duplicate its home window', () => {
  const a=parse([row(14,'P1',{report:'2200',end:'0600'}),row(15,'X')],`Pattern: P1\nQF1 MEL/SYD MO 2300 0200 TU 0100\nQF2 SYD/MEL TU 0400 0200 TU 0530`);
  const b=parse([row(14,'X'),row(15,'X')]);
  assert.equal(a.dutyBlocks[0].end.getTime(),d(15,6).getTime());
  assert.equal(a.offDays[0].homeWindows[0].start.getTime(),d(15,6).getTime());
  assert.equal(a.homeBoundaryWindows.filter(w=>dateKey(w.start)==='2026-12-15').length,0);
  assert.ok(shared([a,b]).some(w=>w.start.getTime()===d(15,6).getTime()));
});
test('short-haul Rpt/Rls pattern detail times are used when calendar fields are blank', () => {
  const text=`SH Flight Crew Roster\nName: TEST PILOT Category: CPT\nBase: MEL\nDate: 14 Nov 2026\n14 Dec 2026 - 14 Dec 2026\nDate    Duty(Role)                  S-On\n14 Mon  P1\nGlobal Preferences\nPattern Details\n14Dec QF1 MEL 0800 SYD 0900\n14Dec QF2 SYD 1200 MEL 1300\n                 Rpt  0700 Rls  1330\nP1 DATED 14Dec26\n*** End of Report`;
  const a=parseRosterText('short.txt',text);
  assert.equal(a.homeBoundaryWindows[0].end.getTime(),d(14,7).getTime());
  assert.equal(a.homeBoundaryWindows[1].start.getTime(),d(14,13,30).getTime());
});
test('missing release times do not turn a landing into off-duty availability', () => {
  const a=sixDay('');const b=parse([row(15,'X')]);
  assert.equal(a.homeBoundaryWindows.filter(w=>w.kind==='after').length,0);
  assert.equal(shared([a,b]).filter(w=>dateKey(w.start)==='2026-12-15').length,0);
});
test('unknown duties and training with missing details block inferred free time on that date', () => {
  for(const unknown of ['ZZZ','SIM07CA']) {
    const a=parse([row(14,'EPCML',{report:'0800',end:'1200'}),row(14,unknown)]);
    assert.equal(a.homeBoundaryWindows.length,0,unknown);
  }
});
test('timed training and reserve include free time either side, keeping duty and on-call overlaps separate', () => {
  for(const code of ['EPCML','SR']) {
    const a=parse([row(14,code,{report:'0800',end:'1200'})]);const b=parse([row(14,'X')]);
    assert.deepEqual(shared([a,b]).map(w=>[w.start.getHours(),w.end.getTime()===d(15).getTime()?24:w.end.getHours()]),[[0,8],[12,24]]);
    assert.ok(sharedCalendarWindows([a,b]).some(w=>code==='SR'?w.reserve:w.onDuty));
  }
});
test('a finish away from base requires a matching domicile; changing domicile updates boundary matches', () => {
  const a=parse([row(14,'P1',{report:'0800',end:'1200'})],`Pattern: P1\nQF1 MEL/ADL MO 0900 0200 MO 1130`);
  const b=parse([row(14,'X')],'','ADL');
  assert.equal(shared([a,b]).length,0);
  a.domicile='ADL';
  assert.ok(shared([a,b]).some(w=>w.port==='ADL'&&w.start.getTime()===d(14,12).getTime()));
  a.requiresDomicile=true;assert.equal(shared([a,b]).length,0);
});
test('partial-day overlaps respect the minute threshold exactly', () => {
  const a=parse([row(14,'EPCML',{report:'0800',end:'2330'})]);const b=parse([row(14,'X')]);
  assert.equal(shared([a,b],30).filter(w=>w.start.getTime()===d(14,23,30).getTime()).length,1);
  assert.equal(shared([a,b],31).filter(w=>w.start.getTime()===d(14,23,30).getTime()).length,0);
  assert.equal(compareRosterGroup([a,b],{minPortOverlapMinutes:31}).matches.filter(m=>m.match_type==='Shared time off'&&m.overlap_window.includes('23:30')).length,0);
});
test('the same partial-day interval works for every selected pilot in groups of two to five', () => {
  for(let count=2;count<=5;count++) {
    const rosters=[parse([row(14,'EPCML',{report:'0800',end:'1200'})]),...Array.from({length:count-1},()=>parse([row(14,'X')]))];
    const matches=compareRosterGroup(rosters).matches.filter(m=>m.match_type==='Shared time off');
    assert.equal(matches.length,2);assert.ok(matches.every(m=>m.participants.length===count));
  }
});


test('a known training duty with only one printed boundary uses that side without inventing the other', () => {
  const before=parse([row(14,'EPCML',{report:'1300'})]);
  assert.equal(before.portWindows.length,0);assert.equal(before.unresolvedDuties.length,1);
  assert.deepEqual(before.homeBoundaryWindows.map(w=>w.kind),['before']);
  assert.equal(before.homeBoundaryWindows[0].end.getTime(),d(14,13).getTime());
  const after=parse([row(14,'EPCML',{end:'0600'})]);
  assert.equal(after.portWindows.length,0);assert.equal(after.unresolvedDuties.length,1);
  assert.deepEqual(after.homeBoundaryWindows.map(w=>w.kind),['after']);
  assert.equal(after.homeBoundaryWindows[0].start.getTime(),d(14,6).getTime());
});
