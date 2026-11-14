// All dates are roster-local wall dates, matching the existing comparison engine.
// Unknown duties never imply presence at home or in another port.
const DAY_MS = 86400000;
export const CREW_COLOURS = ['#38bdf8', '#fb923c', '#a78bfa', '#f472b6', '#facc15'];
export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const dayDistance = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
const homePort = roster => roster.requiresDomicile ? null : roster.domicile || roster.base;
const crewName = roster => roster.displayName || roster.crewName || roster.fileName;
const formatTime = date => date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
export function calendarBounds(rosters) {
  const first = new Date(Math.min(...rosters.map(roster => roster.coverageStart.getTime())));
  const last = new Date(Math.max(...rosters.map(roster => roster.coverageEnd.getTime())));
  return { first: new Date(first.getFullYear(), first.getMonth(), 1), last: new Date(last.getFullYear(), last.getMonth(), 1) };
}
// Open the month containing most of the common roster period, so a period
// starting on 30 November opens in December rather than a mostly empty November.
export function initialCalendarMonth(rosters) {
  const start = new Date(Math.max(...rosters.map(roster => roster.coverageStart.getTime())));
  const end = new Date(Math.min(...rosters.map(roster => roster.coverageEnd.getTime())));
  if (start > end) return calendarBounds(rosters).first;
  let best = new Date(start.getFullYear(), start.getMonth(), 1);
  let bestDays = 0;
  for (let month = best; month <= end; month = new Date(month.getFullYear(), month.getMonth() + 1, 1)) {
    const first = new Date(Math.max(start.getTime(), month.getTime()));
    const last = new Date(Math.min(end.getTime(), new Date(month.getFullYear(), month.getMonth() + 1, 0).getTime()));
    const days = dayDistance(first, last) + 1;
    if (days > bestDays) { best = month; bestDays = days; }
  }
  return best;
}

function boundaryHomeWindows(roster) {
  const port = homePort(roster);
  if (!port) return [];
  return (roster.homeBoundaryWindows || []).filter(window => window.anchorPorts.every(anchor => anchor === roster.base || anchor === port)).map(window => ({
    ...window, port, assumed: true, reserve: false, onDuty: false,
    dutyCode: `${window.dutyCode} (${port} · assumed domicile; commute not included)`,
  }));
}

function presenceWindows(roster) {
  const coverageEnd = addDays(roster.coverageEnd, 1);
  const windows = [
    ...boundaryHomeWindows(roster),
    ...roster.portWindows.map(window => ({ ...window, assumed: false, reserve: window.matchType === 'home_reserve', onDuty: Boolean(window.onDuty) })),
    ...roster.offDays.filter(() => homePort(roster)).flatMap(entry => (entry.homeWindows || [{ start: entry.date, end: addDays(entry.date, 1) }]).map(window => ({
      ...window, port: homePort(roster), dutyCode: entry.dutyCode, assumed: true, reserve: false, onDuty: false,
    }))),
  ].map(window => ({ ...window,
    start: new Date(Math.max(window.start.getTime(), roster.coverageStart.getTime())),
    end: new Date(Math.min(window.end.getTime(), coverageEnd.getTime())),
  })).filter(window => window.port && window.port !== '?' && window.end > window.start);
  windows.sort((a, b) => a.port.localeCompare(b.port) || Number(a.assumed) - Number(b.assumed) || Number(a.reserve) - Number(b.reserve) || Number(a.onDuty) - Number(b.onDuty) || a.start - b.start);
  const merged = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && previous.port === window.port && previous.assumed === window.assumed && previous.reserve === window.reserve && previous.onDuty === window.onDuty && window.start <= previous.end) {
      previous.end = new Date(Math.max(previous.end.getTime(), window.end.getTime()));
      previous.dutyCode = [...new Set([...previous.dutyCode.split(' / '), window.dutyCode])].join(' / ');
    } else merged.push({ ...window });
  }
  return merged;
}
export function sharedCalendarWindows(rosters, minOverlapMinutes = 60) {
  const windows = rosters.map(presenceWindows);
  const matches = [];
  const threshold = Math.max(1, Number(minOverlapMinutes) || 60) * 60000;
  function intersect(index, port, start, end, participants) {
    if (index === rosters.length) {
      const homeCount = rosters.filter(roster => (homePort(roster)) === port).length;
      matches.push({ port, start: new Date(start), end: new Date(end), participants,
        assumed: participants.some(window => window.assumed), reserve: participants.some(window => window.reserve), onDuty: participants.some(window => window.onDuty),
        category: homeCount === rosters.length ? 'all-home' : homeCount ? 'some-home' : 'all-away',
      });
      return;
    }
    for (const window of windows[index]) {
      if (window.port !== port) continue;
      const nextStart = Math.max(start, window.start.getTime());
      const nextEnd = Math.min(end, window.end.getTime());
      if (nextEnd - nextStart >= threshold) intersect(index + 1, port, nextStart, nextEnd, [...participants, window]);
    }
  }
  for (const window of windows[0] || []) intersect(1, window.port, window.start.getTime(), window.end.getTime(), [window]);
  const seen = new Set();
  return matches.sort((a, b) => a.start - b.start || a.port.localeCompare(b.port)).filter(match => {
    const key = `${match.port}:${match.start.getTime()}:${match.end.getTime()}:${match.assumed}:${match.reserve}:${match.onDuty}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function pilotDay(roster, date) {
  const start = dayStart(date), end = addDays(date, 1);
  const entries = roster.calendar.filter(item => dateKey(item.date) === dateKey(date));
  const entry = entries[0];
  if (!entry) return { label: 'No roster', kind: 'unavailable', detail: 'No roster entry is available for this date.' };
  const ground = roster.calendar.filter(item => item.dutyInfo && !item.dutyInfo.assumeHome && (entries.includes(item) || (item.dutyInfo.start < end && item.dutyInfo.end > start)));
  const available = boundaryHomeWindows(roster).filter(window => window.start < end && window.end > start);
  const clock = time => time.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', hour12:false});
  const availabilityLabel = available.length ? ` · ${homePort(roster)} home* ${available.map(window => window.start <= start ? `until ${clock(window.end)}` : window.end >= end ? `from ${clock(window.start)}` : `${clock(window.start)}–${clock(window.end)}`).join(' / ')}` : '';
  const availabilityDetail = available.length ? `\n\nHome availability outside duty:\n${available.map(window => `${window.dutyCode}\n${formatTime(window.start)} – ${formatTime(window.end)}`).join('\n\n')}\n* Assumed at the selected domicile. Commute time is not included.` : '';
  const offEntry = roster.offDays.find(item => dateKey(item.date) === dateKey(date));
  const homeDetail = offEntry?.homeWindows ? `\n* Assumed at domicile ${homePort(roster) || 'unknown'} outside known duty times:\n${offEntry.homeWindows.map(window => `${formatTime(window.start)} – ${formatTime(window.end)}`).join('\n')}` : '';
  const groundDetail = item => {
    const info = item.dutyInfo;
    return [info.label, item.detail, info.port ? `${info.port} · ${info.locationSource}` : null,
      info.start ? `${formatTime(info.start)} – ${formatTime(info.end)} · ${info.timingSource}` : null,
      ...(info.issues || []), info.kind === 'reserve' ? 'On call; this does not imply free time.' : info.kind !== 'leave' ? 'On duty; this does not imply free time.' : null].filter(Boolean).join('\n');
  };
  const allLegs = (roster.trips || []).flatMap(trip => trip.legs).filter(leg => leg.departureDateTime < end && leg.arrivalDateTime > start);
  const legs = allLegs.filter(leg => leg.origin !== leg.destination);
  if (legs.length) {
    const route = [legs[0].origin];
    for (const leg of legs) {
      if (route[route.length - 1] !== leg.origin) route.push(leg.origin);
      route.push(leg.destination);
    }
    return { label: route.join(' → ') + (ground.length ? ` · ${ground.map(item => item.dutyInfo.label).join(' / ')}` : '') + availabilityLabel, kind: 'trip', detail: legs.map(leg => `${leg.service || 'Flight'}: ${leg.origin} → ${leg.destination}\n${formatTime(leg.departureDateTime)} – ${formatTime(leg.arrivalDateTime)}`).concat(ground.map(groundDetail)).join('\n\n') + availabilityDetail };
  }
  if (ground.length) return {
    label: ground.map(item => `${item.dutyInfo.port || (item.dutyInfo.kind === 'leave' ? '' : 'Port not supplied')}${item.dutyInfo.port || item.dutyInfo.kind !== 'leave' ? ' · ' : ''}${item.dutyInfo.label}`).join(' / ') + (offEntry ? ` / ${homePort(roster) || 'Home'} · home*` : '') + availabilityLabel,
    kind: ground.every(item => item.dutyInfo.kind === 'reserve') ? 'reserve' : ground.every(item => item.dutyInfo.kind === 'leave') ? 'leave' : 'ground',
    detail: ground.map(groundDetail).join('\n\n') + homeDetail + availabilityDetail,
  };
  if (allLegs.length) return { label: [...new Set(allLegs.map(leg => `${leg.origin} · ${leg.service || 'ground duty'}`))].join(' / '), kind: 'ground',
    detail: allLegs.map(leg => `${leg.service || 'Ground duty'} · ${leg.origin}\n${formatTime(leg.departureDateTime)} – ${formatTime(leg.arrivalDateTime)}\nOn duty; this does not imply free time.`).join('\n\n') };
  const offDay = roster.offDays.some(item => dateKey(item.date) === dateKey(date));
  const home = homePort(roster);
  if (offDay) return { label: home ? `${home} · home*` : roster.requiresDomicile ? 'Day off · choose domicile' : 'Day off · base unknown', kind: 'home', detail: `${entry.dutyCode} · day off.${home ? `\n* Assumed at home base / domicile ${home}; it is not confirmed by a flight. Roster base: ${roster.base || 'unknown'}.${homeDetail}` : '\nNo home location has been inferred.'}` };
  const reserve = (roster.reserveDays || []).some(item => dateKey(item.date) === dateKey(date));
  if (reserve) return { label: `${roster.base || 'Base unknown'} · reserve`, kind: 'reserve', detail: `${entry.dutyCode} · reserve at base${entry.report && entry.end ? `\n${entry.report} – ${entry.end} roster local time` : '\nReserve times are unavailable.'}\nOn call; this does not imply free time.` };
  if (available.length) return { label: `${entry.dutyCode}${availabilityLabel}`, kind: 'home', detail: `${entry.dutyCode}${availabilityDetail}` };
  const stays = roster.portWindows.filter(window => window.start < end && window.end > start);
  if (stays.length) return { label: `${[...new Set(stays.map(window => window.port))].join(' / ')} · in port`, kind: 'trip', detail: stays.map(window => `${window.port} · ${window.dutyCode}\n${formatTime(window.start)} – ${formatTime(window.end)}`).join('\n\n') };
  return { label: 'Location unknown', kind: 'unknown', detail: `${entry.dutyCode}${entry.detail ? ` · ${entry.detail}` : ''}\nThe roster does not resolve this duty to a location.` };
}
export function buildRosterCalendar(rosters, month, { minOverlapMinutes = 60, range = 'month' } = {}) {
  const fullRoster = range === 'roster';
  const first = fullRoster ? dayStart(new Date(Math.min(...rosters.map(roster => roster.coverageStart.getTime())))) : new Date(month.getFullYear(), month.getMonth(), 1);
  const last = fullRoster ? dayStart(new Date(Math.max(...rosters.map(roster => roster.coverageEnd.getTime())))) : new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const gridStart = addDays(first, -((first.getDay() + 6) % 7));
  const gridEnd = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const windows = sharedCalendarWindows(rosters, minOverlapMinutes);
  const crews = rosters.map((roster, index) => ({ name: crewName(roster), base: roster.base, domicile: homePort(roster), colour: roster.colour || CREW_COLOURS[index] }));
  const details = [], weeks = [];
  const detailId = detail => { details.push(detail); return details.length - 1; };
  for (let weekStart = gridStart; weekStart <= gridEnd; weekStart = addDays(weekStart, 7)) {
    const dates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
    const weekEnd = addDays(weekStart, 7);
    const rows = rosters.map((roster, crewIndex) => dates.map((date, column) => {
      const day = pilotDay(roster, date);
      return { ...day, column, span: 1, outside: date < first || date > last,
        detailId: detailId({ title: crews[crewIndex].name, subtitle: date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), text: day.detail }),
      };
    }).reduce((bars, cell) => {
      const previous = bars[bars.length - 1];
      if (previous && cell.kind === 'trip' && previous.kind === cell.kind && previous.label === cell.label && previous.detail === cell.detail && previous.outside === cell.outside) previous.span += 1;
      else bars.push({ ...cell });
      return bars;
    }, []));
    const overlaps = windows.filter(window => window.start < weekEnd && window.end > weekStart).map(window => {
      const start = new Date(Math.max(weekStart.getTime(), window.start.getTime()));
      const end = new Date(Math.min(weekEnd.getTime(), window.end.getTime()));
      const column = dayDistance(weekStart, dayStart(start));
      const endColumn = dayDistance(weekStart, dayStart(new Date(end.getTime() - 1)));
      return { ...window, column, span: endColumn - column + 1,
        label: `${window.port} · ${crews.map(crew => crew.name).join(' + ')}${window.assumed ? ' *' : ''}${window.reserve ? ' · on call' : ''}${window.onDuty ? ' · on duty' : ''}`,
        detailId: detailId({ title: `${window.port} · shared time`, subtitle: `${formatTime(window.start)} – ${formatTime(window.end)} · roster local time`,
          text: window.participants.map((participant, index) => `${crews[index].name}: ${participant.dutyCode}\n${formatTime(participant.start)} – ${formatTime(participant.end)}${participant.assumed ? '\n* Assumed at the selected domicile outside duty. Commute time is not included.' : ''}${participant.reserve ? '\nReserve: on call, not confirmed free time.' : ''}${participant.onDuty ? '\nGround / training duty: on duty, not confirmed free time.' : ''}`).join('\n\n'),
        }),
      };
    });
    const overlapLanes = [];
    for (const overlap of overlaps) {
      let lane = overlapLanes.find(items => items.every(item => item.column + item.span <= overlap.column || overlap.column + overlap.span <= item.column));
      if (!lane) { lane = []; overlapLanes.push(lane); }
      lane.push(overlap);
    }
    weeks.push({ dates, rows, overlapLanes });
  }
  const displayDate = date => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return { month: new Date(month.getFullYear(), month.getMonth(), 1), first, last, range, title: fullRoster ? `${displayDate(first)} – ${displayDate(last)}` : first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), dayCount: dayDistance(first, last) + 1, crews, weeks, details };
}
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function renderCalendarMarkup(model) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const placement = bar => `grid-column: ${bar.column + 2} / span ${bar.span}`;
  const button = (bar, classes, style = '') => `<div class="calendar-cell" role="cell" aria-colindex="${bar.column + 2}" aria-colspan="${bar.span}" style="${placement(bar)};${style}"><button type="button" class="calendar-bar ${classes}" data-calendar-detail="${bar.detailId}" aria-label="${escapeHtml(`${model.details[bar.detailId].title} · ${model.details[bar.detailId].subtitle} · ${bar.label}`)}" title="${escapeHtml(bar.label)}">${escapeHtml(bar.label)}</button></div>`;
  return `<div class="calendar-lane calendar-day-head" role="row"><span role="columnheader">Pilots / overlaps</span>${days.map(day => `<span role="columnheader">${day}</span>`).join('')}</div>` + model.weeks.map((week, weekIndex) => `
    <div class="calendar-week" role="rowgroup">
      <div class="calendar-lane calendar-dates" role="row"><span role="cell" class="calendar-week-number">Week ${weekIndex + 1}</span>${week.dates.map(date => `<span role="cell" class="${date < model.first || date > model.last ? 'is-outside' : ''}"><time datetime="${dateKey(date)}">${model.range === 'roster' || date.getMonth() !== model.month.getMonth() ? `${date.getDate()} ${date.toLocaleDateString('en-GB', { month: 'short' })}` : date.getDate()}</time></span>`).join('')}</div>
      ${week.rows.map((bars, index) => `<div class="calendar-lane calendar-pilot-lane" role="row"><span class="calendar-row-name" role="rowheader" style="--crew-colour: ${model.crews[index].colour}" title="${escapeHtml(model.crews[index].name)}">${escapeHtml(model.crews[index].name)}</span>${bars.map(bar => button(bar, `calendar-${bar.kind}${bar.outside ? ' is-outside' : ''}`, `--crew-colour: ${model.crews[index].colour}`)).join('')}</div>`).join('')}
      <div class="calendar-together">${week.overlapLanes.length ? week.overlapLanes.map((lane, index) => `<div class="calendar-lane" role="row"><span class="calendar-row-name" role="rowheader">${index === 0 ? 'Together' : ''}</span>${lane.map(bar => button(bar, `calendar-overlap calendar-${bar.category}`)).join('')}</div>`).join('') : '<div class="calendar-lane" role="row"><span class="calendar-row-name" role="rowheader">Together</span><span class="calendar-no-overlap" role="cell">No shared time in port this week</span></div>'}</div>
    </div>`).join('');
}
