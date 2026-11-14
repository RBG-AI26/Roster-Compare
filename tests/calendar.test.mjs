import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const fromFile = async file => import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../'+file,import.meta.url),'utf8')).toString('base64'));
const {buildRosterCalendar,sharedCalendarWindows,renderCalendarMarkup,dateKey}=await fromFile('roster-calendar.js');
const {parseRosterText}=await fromFile('roster-browser.js');
const d=(day,hour=0)=>new Date(2026,11,day,hour);
function roster(crewName,base,{off=[],windows=[],start=1,end=31}={}){
 const calendar=Array.from({length:end-start+1},(_,i)=>({date:d(start+i),dutyCode:off.includes(start+i)?'A':'P1'}));
 return {crewName,base,calendar,coverageStart:d(start),coverageEnd:d(end),offDays:calendar.filter(e=>e.dutyCode==='A'),reserveDays:[],portWindows:windows,trips:[]};
}
const win=(port,start,end)=>({port,start,end,dutyCode:'P1',matchType:'in_port'});
test('Monday weeks include year rollover and leap February',()=>{
 const rs=[roster('A','MEL'),roster('B','ADL')],m=buildRosterCalendar(rs,d(1));
 assert.equal(m.title,'December 2026');assert.equal(m.weeks.length,5);
 assert.equal(dateKey(m.weeks[0].dates[0]),'2026-11-30');
 assert.equal(dateKey(m.weeks.at(-1).dates.at(-1)),'2027-01-03');
 assert.ok(m.weeks.every(w=>w.dates[0].getDay()===1));
 assert.ok(buildRosterCalendar(rs,new Date(2028,1,1)).weeks.flatMap(w=>w.dates).some(x=>dateKey(x)==='2028-02-29'));
});
test('assumed home presence combines with a visiting pilot; different bases do not imply co-location',()=>{
 const [w]=sharedCalendarWindows([roster('A','MEL',{off:[9,10]}),roster('B','ADL',{windows:[win('MEL',d(9,12),d(10,14))]})]);
 assert.equal(w.port,'MEL');assert.equal(w.category,'some-home');assert.equal(w.assumed,true);
 assert.equal(w.start.getTime(),d(9,12).getTime());assert.equal(w.end.getTime(),d(10,14).getTime());
 assert.equal(sharedCalendarWindows([roster('A','MEL',{off:[9]}),roster('B','ADL',{off:[9]})]).length,0);
 assert.equal(sharedCalendarWindows([roster('A','MEL',{off:[9]}),roster('B','MEL',{off:[9]})])[0].category,'all-home');
});
test('five selected pilots retain pairs and combine into the larger group only while it overlaps',()=>{
 const rs=Array.from({length:5},(_,i)=>roster('Crew '+i,'MEL',{windows:[win('SIN',d(9,i===4?13:10),d(9,14))]}));
 assert.equal(sharedCalendarWindows(rs,60).length,10);
 assert.equal(sharedCalendarWindows(rs,61).length,6);
 const groups=buildRosterCalendar(rs,d(1)).weeks[1].timelineDays[2].segments;
 assert.deepEqual(groups.map(s=>s.crewIndices),[[0,1,2,3],[0,1,2,3,4]]);
 assert.equal(groups[1].visibleStart.getTime(),d(9,13).getTime());
 assert.equal(groups[1].visibleEnd.getTime(),d(9,14).getTime());
 const longer=buildRosterCalendar(rs,d(1),{minOverlapMinutes:61}).weeks[1].timelineDays[2].segments;
 assert.deepEqual(longer.map(s=>s.crewIndices),[[0,1,2,3]]);
 assert.equal(groups[0].category,'all-away');
 assert.ok(buildRosterCalendar(rs,d(1)).weeks.every(w=>w.rows.length===5));
});
test('Sunday/Monday splits and midnight end do not add a false day',()=>{
 const rs=['A','B'].map(n=>roster(n,'MEL',{windows:[win('SIN',d(6,10),d(8))]}));
 assert.deepEqual(buildRosterCalendar(rs,d(1)).weeks.flatMap(w=>w.overlaps).map(b=>[b.column,b.span]),[[6,1],[0,1]]);
 const cross=['A','B'].map(n=>roster(n,'MEL',{end:34,windows:[win('SIN',d(31,10),new Date(2027,0,2,10))]}));
 const b=buildRosterCalendar(cross,d(1)).weeks.at(-1).overlaps[0];
 assert.equal(b.column,3);assert.equal(b.span,3);
});
test('unknown duties, missing coverage and missing home bases do not invent a location',()=>{
 const a=roster('A',null,{off:[9],start:5,end:10}),b=roster('B','MEL',{off:[9]});
 assert.equal(sharedCalendarWindows([a,b]).length,0);
 const cells=buildRosterCalendar([a,b],d(1)).weeks.flatMap(w=>w.rows[0]);
 assert.ok(cells.some(c=>c.kind==='unavailable'));assert.ok(cells.some(c=>c.kind==='unknown'));
 assert.ok(cells.some(c=>c.label==='Day off · base unknown'));
});
test('separate periods share one timeline row, details flag reserve on call and roster text is escaped',()=>{
 const rs=['<script>A</script>','B'].map(n=>roster(n,'MEL',{windows:[win('SIN',d(9,10),d(9,12)),win('LAX',d(9,15),d(9,17))]}));
 const m=buildRosterCalendar(rs,d(1));assert.equal(m.weeks[1].timelineDays[2].segments.length,2);
 assert.equal((renderCalendarMarkup(m).match(/calendar-timeline-lane/g)||[]).length,m.weeks.length);
 assert.doesNotMatch(renderCalendarMarkup(m),/<script>/);assert.match(renderCalendarMarkup(m),/&lt;script&gt;/);
 const a=roster('A','MEL',{windows:[{...win('MEL',d(9,10),d(9,12)),matchType:'home_reserve'}]}),b=roster('B','MEL',{off:[9]});
 const reserve=buildRosterCalendar([a,b],d(1)),bar=reserve.weeks[1].overlaps[0];
 assert.equal(bar.label,'MEL');assert.equal(bar.reserve,true);assert.match(reserve.details[bar.detailId].text,/on call/);
});
test('long-haul parsed legs produce a sector bar spanning two days',()=>{
 const text='webCIS\nName: TEST PILOT A  Staff No: 100001\nBase: MEL\nDate: 14 Nov 2026\nDate Duty Detail\n07/12 M P1\n08/12 T P1\n09/12 W P1\nEND OF REPORT\nPattern: P1\nQF1 MEL/SIN MO 2200 0200 TU 0200\nQF2 SIN/MEL WE 1000 0800 WE 1800\n';
 const a=parseRosterText('webcis.txt',text);assert.equal(a.trips[0].legs.length,2);
 const bar=buildRosterCalendar([a,a],d(1)).weeks[1].rows[0][0];assert.equal(bar.label,'MEL → SIN');assert.equal(bar.span,2);
});
test('short-haul detail legs produce the complete daily route on the resolved date',()=>{
 const text='SH Flight Crew Roster\nName: TEST PILOT  Category: CPT\nBase: MEL\nDate: 14 Nov 2026\n30 Nov 2026 - 2 Dec 2026\nDate    Duty(Role)                  S-On\n30 Mon  D/O\n01 Tue  P1\n02 Wed  D/O\nGlobal Preferences\nPattern Details\n01Dec QF1 MEL 0800 SYD 0900\n01Dec QF2 SYD 1200 MEL 1300\nP1 DATED 01Dec26\n*** End of Report';
 const a=parseRosterText('short.txt',text);assert.equal(a.trips[0].legs.length,2);
 assert.equal(dateKey(a.trips[0].legs[0].departureDateTime),'2026-12-01');
 assert.equal(buildRosterCalendar([a,a],d(1)).weeks[0].rows[0][1].label,'MEL → SYD → MEL');
});
test('initial month favours the main roster period over a one-day leading month', async()=>{
 const {initialCalendarMonth}=await fromFile('roster-calendar.js');
 const a=roster('A','MEL');a.coverageStart=new Date(2026,10,30);a.coverageEnd=new Date(2026,11,27);
 assert.equal(dateKey(initialCalendarMonth([a,a])),'2026-12-01');
 const b=roster('B','MEL');b.coverageStart=new Date(2027,0,1);b.coverageEnd=new Date(2027,0,31);
 assert.equal(dateKey(initialCalendarMonth([a,b])),'2026-11-01');
});
test('full roster view includes all eight weeks, including four-column ARMS rows', () => {
  const start=new Date(2026,10,2), rows=[];
  const codes=['S','M','T','W','T','F','S'];
  for(let row=0;row<14;row++) rows.push(Array.from({length:4},(_,column)=>{
    const date=new Date(start);date.setDate(date.getDate()+column*14+row);
    return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')} ${codes[date.getDay()]} A`;
  }).join(' | '));
  const text=`ARMS\nName: TEST PILOT A Staff No: 123456\nBase: MEL\nDate: 14 Nov 2026\nDate Duty Detail\n${rows.join('\n')}\nEND OF REPORT`;
  const a=parseRosterText('arms.txt',text);
  assert.equal(a.calendar.length,56);
  assert.equal(dateKey(a.coverageEnd),'2026-12-27');
  const model=buildRosterCalendar([a,a],new Date(2026,10,1),{range:'roster'});
  assert.equal(model.weeks.length,8);
  assert.equal(model.dayCount,56);
  assert.equal(dateKey(model.weeks.at(-1).dates.at(-1)),'2026-12-27');
});
test('domicile changes home presence and colours while reserve remains at base',()=>{
  const a=roster('A','MEL',{off:[9]}),b=roster('B','ADL',{off:[9]});a.domicile='ADL';
  const shared=sharedCalendarWindows([a,b]);
  assert.equal(shared[0].port,'ADL');assert.equal(shared[0].category,'all-home');
  a.reserveDays=[a.calendar.find(e=>dateKey(e.date)==='2026-12-10')];
  a.portWindows.push({...win('MEL',d(10,5),d(10,17)),matchType:'home_reserve'});
  b.portWindows.push(win('MEL',d(10,8),d(10,12)));
  assert.ok(sharedCalendarWindows([a,b]).some(w=>w.port==='MEL'&&w.reserve));
  const model=buildRosterCalendar([a,b],d(1));
  assert.ok(model.weeks.flatMap(w=>w.rows[0]).some(cell=>cell.label==='ADL · home'));
  assert.ok(model.weeks.flatMap(w=>w.rows[0]).some(cell=>cell.label==='MEL · reserve'));
});


test('day timelines use exact 24-hour positions and keep genuine gaps',()=>{
 const rs=['A','B'].map(n=>roster(n,'MEL',{windows:[win('ADL',d(9,3),d(9,6)),win('ADL',d(9,12),d(9,18))]}));
 const m=buildRosterCalendar(rs,d(1));const segments=m.weeks[1].timelineDays[2].segments;
 assert.deepEqual(segments.map(s=>[s.offset,s.width]),[[12.5,12.5],[50,25]]);
 assert.ok(segments.every(s=>s.label==='ADL'));
 assert.ok(segments[0].visibleEnd < segments[1].visibleStart);
 const markup=renderCalendarMarkup(m);
 assert.match(markup,/left: 12.5%; width: 12.5%/);
 assert.match(markup,/ADL · A \+ B · free time/);
});
test('duplicate free and on-call windows resolve into a non-overlapping free/on-call/free strip',()=>{
 const a=roster('A','MEL',{off:[9],windows:[{...win('MEL',d(9,4),d(9,16)),matchType:'home_reserve'}]}),b=roster('B','MEL',{off:[9]});
 const m=buildRosterCalendar([a,b],d(1)),day=m.weeks[1].timelineDays[2];
 assert.equal(day.segments.length,3);
 assert.deepEqual(day.segments.map(s=>[s.visibleStart.getHours(),s.visibleEnd.getTime()===d(10).getTime()?24:s.visibleEnd.getHours(),s.reserve]),[[0,4,false],[4,16,true],[16,24,false]]);
 assert.ok(day.segments.every((s,i)=>!i||day.segments[i-1].visibleEnd<=s.visibleStart));
 assert.match(renderCalendarMarkup(m),/calendar-time-segment is-on-call/);
 assert.match(m.details[day.segments[1].detailId].text,/A · MEL · on call/);
});
test('overlapping free representations merge without introducing extra segments',()=>{
 const rs=['A','B'].map(n=>roster(n,'MEL',{off:[9],windows:[win('MEL',d(9,8),d(9,12))]}));
 const day=buildRosterCalendar(rs,d(1)).weeks[1].timelineDays[2];
 assert.equal(day.segments.length,1);assert.equal(day.segments[0].offset,0);assert.equal(day.segments[0].width,100);
});
test('continuous shared time joins across dates and retains the complete period in every segment detail',()=>{
 const rs=['A','B'].map(n=>roster(n,'MEL',{windows:[win('ADL',d(9,6),d(11,12))]}));
 const m=buildRosterCalendar(rs,d(1)),week=m.weeks[1];
 const [first,middle,last]=[2,3,4].map(i=>week.timelineDays[i].segments[0]);
 assert.deepEqual([first.offset,first.width,middle.offset,middle.width,last.offset,last.width],[25,75,0,100,0,50]);
 assert.equal(first.continuesAfter,true);assert.equal(middle.continuesBefore,true);assert.equal(middle.continuesAfter,true);assert.equal(last.continuesBefore,true);
 assert.equal(first.detailId,middle.detailId);assert.equal(first.detailId,last.detailId);
 assert.match(m.details[middle.detailId].subtitle,/09 Dec 2026.*06:00.*11 Dec 2026.*12:00/);
});
test('on-duty periods remain distinct and conflicting simultaneous ports occupy a single segment',()=>{
 const rs=['A','B'].map(n=>roster(n,'MEL',{windows:[win('MEL',d(9,8),d(9,12)),{...win('MEL',d(9,10),d(9,11)),onDuty:true,matchType:'ground_duty'},win('ADL',d(9,8),d(9,12))]}));
 const m=buildRosterCalendar(rs,d(1)),segments=m.weeks[1].timelineDays[2].segments;
 assert.equal(segments.length,3);
 assert.ok(segments.every(s=>s.label==='ADL / MEL'&&s.category==='mixed'));
 assert.equal(segments[1].onDuty,true);
 assert.match(renderCalendarMarkup(m),/is-on-duty/);
 assert.ok(segments.every((s,i)=>!i||segments[i-1].visibleEnd<=s.visibleStart));
});


test('an unavailable first pilot does not suppress a matching pair later in the selection',()=>{
 const rs=[roster('Absent','SYD'),roster('B','ADL',{off:[9]}),roster('C','ADL',{off:[9]})];
 const matches=sharedCalendarWindows(rs);
 assert.equal(matches.length,1);assert.deepEqual(matches[0].crewIndices,[1,2]);
 const m=buildRosterCalendar(rs,d(1)),segment=m.weeks[1].timelineDays[2].segments[0];
 assert.equal(segment.label,'ADL · 2');assert.equal(segment.category,'all-home');
 assert.equal(m.details[segment.detailId].text,'B · ADL\nC · ADL');
 assert.doesNotMatch(m.details[segment.detailId].text,/Absent/);
 assert.match(renderCalendarMarkup(m),/ADL · B \+ C · free time/);
});
test('membership changes from pair to triple and back preserve the exact people and periods',()=>{
 const rs=[roster('A','ADL',{windows:[win('ADL',d(9,8),d(9,18))]}),roster('B','ADL',{windows:[win('ADL',d(9,8),d(9,18))]}),roster('C','MEL',{windows:[win('ADL',d(9,10),d(9,12))]})];
 const m=buildRosterCalendar(rs,d(1)),segments=m.weeks[1].timelineDays[2].segments;
 assert.deepEqual(segments.map(s=>[s.visibleStart.getHours(),s.visibleEnd.getHours(),s.crewIndices]),[[8,10,[0,1]],[10,12,[0,1,2]],[12,18,[0,1]]]);
 assert.deepEqual(segments.map(s=>s.label),['ADL · 2','ADL · 3','ADL · 2']);
 assert.deepEqual(segments.map(s=>s.category),['all-home','some-home','all-home']);
 assert.doesNotMatch(m.details[segments[0].detailId].text,/C ·/);
 assert.match(m.details[segments[1].detailId].text,/C · ADL/);
 assert.doesNotMatch(m.details[segments[2].detailId].text,/C ·/);
 assert.equal((renderCalendarMarkup(m).match(/calendar-timeline-lane/g)||[]).length,m.weeks.length);
});
test('simultaneous pairs at different ports keep distinct membership in one timeline segment',()=>{
 const rs=[roster('A','ADL',{off:[9]}),roster('B','ADL',{off:[9]}),roster('C','MEL',{off:[9]}),roster('D','MEL',{off:[9]})];
 const m=buildRosterCalendar(rs,d(1)),segments=m.weeks[1].timelineDays[2].segments;
 assert.equal(segments.length,1);
 const segment=segments[0];assert.equal(segment.label,'ADL · 2 / MEL · 2');
 assert.deepEqual(segment.groups.map(group=>[group.port,group.crewIndices]),[['ADL',[0,1]],['MEL',[2,3]]]);
 assert.equal(m.details[segment.detailId].text,'A · ADL\nB · ADL\n\nC · MEL\nD · MEL');
 assert.doesNotMatch(m.details[segment.detailId].text,/A · MEL|C · ADL/);
});
test('a change of matching pair splits the interval even when the port and group size stay the same',()=>{
 const rs=[roster('A','MEL',{windows:[win('MEL',d(9,8),d(9,10))]}),roster('B','MEL',{windows:[win('MEL',d(9,8),d(9,12))]}),roster('C','MEL',{windows:[win('MEL',d(9,10),d(9,12))]})];
 const m=buildRosterCalendar(rs,d(1)),segments=m.weeks[1].timelineDays[2].segments;
 assert.deepEqual(segments.map(s=>s.crewIndices),[[0,1],[1,2]]);
 assert.equal(segments[0].end.getTime(),d(9,10).getTime());
 assert.equal(segments[1].start.getTime(),d(9,10).getTime());
 assert.equal(m.details[segments[1].detailId].text,'B · MEL\nC · MEL');
});
test('an unrelated pilot on call elsewhere cannot change a matching pair into an on-call period',()=>{
 const rs=[roster('A','ADL',{off:[9]}),roster('B','ADL',{off:[9]}),roster('C','MEL',{windows:[{...win('MEL',d(9,4),d(9,16)),matchType:'home_reserve'}]})];
 const m=buildRosterCalendar(rs,d(1)),segments=m.weeks[1].timelineDays[2].segments;
 assert.equal(segments.length,1);assert.equal(segments[0].reserve,false);
 assert.deepEqual(segments[0].crewIndices,[0,1]);
 assert.doesNotMatch(m.details[segments[0].detailId].text,/C|on call/);
});
test('subset matches honour thresholds and cannot be made from one pilot or missing coverage',()=>{
 const rs=[roster('A','MEL',{windows:[win('SIN',d(9,8),d(9,9))]}),roster('B','MEL',{windows:[win('SIN',d(9,8),d(9,9))]}),roster('C','MEL',{off:[9],start:10,end:11})];
 assert.equal(sharedCalendarWindows(rs,60).length,1);assert.equal(sharedCalendarWindows(rs,61).length,0);
 assert.equal(buildRosterCalendar(rs,d(1),{minOverlapMinutes:61}).weeks[1].timelineDays[2].segments.length,0);
 assert.equal(sharedCalendarWindows([rs[0],rs[2]]).length,0);
});
