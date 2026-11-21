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
export function calendarBounds(rosters, period) {
  const first = period?.first ?? new Date(Math.min(...rosters.map(roster => +roster.coverageStart)));
  const last = period?.last ?? new Date(Math.max(...rosters.map(roster => +roster.coverageEnd)));
  return { first: new Date(first.getFullYear(), first.getMonth(), 1), last: new Date(last.getFullYear(), last.getMonth(), 1) };
}
// Open the month containing most of the common roster period, so a period
// starting on 30 November opens in December rather than a mostly empty November.
export function initialCalendarMonth(rosters, period) {
  const covered = rosters.filter(roster => roster.coverageStart);
  if (!covered.length) return calendarBounds(rosters, period).first;
  const start = new Date(Math.max(...covered.map(roster => +roster.coverageStart), period ? +period.first : -Infinity));
  const end = new Date(Math.min(...covered.map(roster => +roster.coverageEnd), period ? +period.last : Infinity));
  if (start > end) return calendarBounds(rosters, period).first;
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
  return (roster.homeBoundaryWindows || []).filter(window => window.anchorPorts.every(anchor => anchor === (window.rosterBase || roster.base) || anchor === port)).map(window => ({
    ...window, port, assumed: true, reserve: false, onDuty: false,
    dutyCode: `${window.dutyCode} (${port})`,
  }));
}

function presenceWindows(roster) {
  if (!roster.coverageEnd) return [];
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
function groupCategory(rosters, port, participants) {
  const homes = participants.filter(participant => homePort(rosters[participant.crewIndex]) === port).length;
  return homes === participants.length ? 'all-home' : homes ? 'some-home' : 'all-away';
}

export function sharedCalendarWindows(rosters, minOverlapMinutes = 60) {
  const windows = rosters.map((roster, crewIndex) => presenceWindows(roster).map(window => ({ ...window, crewIndex })));
  const threshold = Math.max(1, Number(minOverlapMinutes) || 60) * 60000;
  const matches = [], seen = new Set();
  // Qualify each pair independently, so an unavailable third pilot never
  // suppresses a valid meeting. The display combines coincident pairs below.
  for (let first = 0; first < rosters.length; first++) for (let second = first + 1; second < rosters.length; second++) {
    for (const a of windows[first]) for (const b of windows[second]) {
      if (a.port !== b.port) continue;
      const start = Math.max(a.start.getTime(), b.start.getTime());
      const end = Math.min(a.end.getTime(), b.end.getTime());
      if (end - start < threshold) continue;
      const participants = [a,b];
      const key = `${a.port}:${start}:${end}:${participants.map(item => `${item.crewIndex}:${Boolean(item.assumed)}:${Boolean(item.reserve)}:${Boolean(item.onDuty)}`).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ port: a.port, start: new Date(start), end: new Date(end), participants,
        crewIndices: [first,second], assumed: participants.some(item => item.assumed),
        reserve: participants.some(item => item.reserve), onDuty: participants.some(item => item.onDuty),
        category: groupCategory(rosters, a.port, participants) });
    }
  }
  return matches.sort((a,b) => a.start - b.start || a.port.localeCompare(b.port) || a.crewIndices[0] - b.crewIndices[0] || a.crewIndices[1] - b.crewIndices[1]);
}

// Sweep qualified pairs into the actual group(s) present at each time and port.
// Membership changes split a segment, even when its port and status stay the same.
function timelineWindows(windows, rosters) {
  const points = [...new Set(windows.flatMap(window => [window.start.getTime(), window.end.getTime()]))].sort((a,b) => a-b);
  const combinations = new Map();
  const rank = participant => participant.onDuty ? 2 : participant.reserve ? 1 : 0;
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index], end = points[index + 1];
    const active = windows.filter(window => window.start.getTime() <= start && window.end.getTime() >= end);
    if (!active.length) continue;
    const ports = [...new Set(active.map(window => window.port))].sort();
    const groups = ports.map(port => {
      const members = new Map();
      for (const window of active.filter(window => window.port === port)) for (const candidate of window.participants) {
        const previous = members.get(candidate.crewIndex);
        if (!previous) members.set(candidate.crewIndex, { ...candidate });
        else members.set(candidate.crewIndex, { ...(rank(candidate) > rank(previous) ? candidate : previous),
          reserve: previous.reserve || candidate.reserve, onDuty: previous.onDuty || candidate.onDuty });
      }
      const participants = [...members.values()].sort((a,b) => a.crewIndex - b.crewIndex);
      return { port, participants, crewIndices: participants.map(item => item.crewIndex), category: groupCategory(rosters, port, participants) };
    });
    // Each crew combination has its own history, so an unrelated group's
    // arrival, departure or duty change never fragments this group's period.
    const simultaneous = new Map();
    for (const group of groups) {
      const key = group.crewIndices.join(',');
      if (!simultaneous.has(key)) simultaneous.set(key, []);
      simultaneous.get(key).push(group);
    }
    for (const [combinationKey, matchingGroups] of simultaneous) {
      const participants = matchingGroups.flatMap(group => group.participants);
      const crewIndices = matchingGroups[0].crewIndices;
      const reserve = participants.some(item => item.reserve), onDuty = participants.some(item => item.onDuty);
      const category = matchingGroups.length === 1 ? matchingGroups[0].category : 'mixed';
      const matchingPorts = matchingGroups.map(group => group.port);
      const signature = matchingGroups.map(group => `${group.port}:${group.category}:${group.participants.map(item => `${item.crewIndex}:${Boolean(item.reserve)}:${Boolean(item.onDuty)}`).join(',')}`).join('|');
      if (!combinations.has(combinationKey)) combinations.set(combinationKey, []);
      const intervals = combinations.get(combinationKey), previous = intervals.at(-1);
      if (previous && previous.signature === signature && previous.end.getTime() === start) previous.end = new Date(end);
      else intervals.push({ ...active[0], ports: matchingPorts, port: matchingPorts.join(' / '), category,
        groups: matchingGroups, participants, crewIndices, combinationKey, assumed: participants.some(item => item.assumed), reserve, onDuty,
        signature, start: new Date(start), end: new Date(end) });
    }
  }
  return [...combinations.values()].flat().sort((a,b) => a.start - b.start || a.combinationKey.localeCompare(b.combinationKey));
}

function pilotDay(roster, date) {
  const start = dayStart(date), end = addDays(date, 1);
  const entries = roster.calendar.filter(item => dateKey(item.date) === dateKey(date));
  const entry = entries[0];
  if (!entry) return { label: 'No roster', kind: 'unavailable', detail: 'No roster entry is available for this date.' };
  const ground = roster.calendar.filter(item => (entry.sourcePeriod == null || item.sourcePeriod === entry.sourcePeriod) && item.dutyInfo && !item.dutyInfo.assumeHome && (entries.includes(item) || (item.dutyInfo.start < end && item.dutyInfo.end > start)));
  const available = boundaryHomeWindows(roster).filter(window => window.start < end && window.end > start);
  const clock = time => time.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', hour12:false});
  const availabilityLabel = available.length ? ` · ${homePort(roster)} home ${available.map(window => window.start <= start ? `until ${clock(window.end)}` : window.end >= end ? `from ${clock(window.start)}` : `${clock(window.start)}–${clock(window.end)}`).join(' / ')}` : '';
  const availabilityDetail = available.length ? `\n\nHome availability outside duty:\n${available.map(window => `${window.dutyCode}\n${formatTime(window.start)} – ${formatTime(window.end)}`).join('\n\n')}` : '';
  const offEntry = roster.offDays.find(item => dateKey(item.date) === dateKey(date));
  const homeDetail = offEntry?.homeWindows ? `\n${homePort(roster) || 'Home location not set'} · outside duty:\n${offEntry.homeWindows.map(window => `${formatTime(window.start)} – ${formatTime(window.end)}`).join('\n')}` : '';
  const groundDetail = item => {
    const info = item.dutyInfo;
    return [info.label, item.detail, info.port ? `${info.port} · ${info.locationSource}` : null,
      info.start ? `${formatTime(info.start)} – ${formatTime(info.end)} · ${info.timingSource}` : null,
      ...(info.issues || []), info.kind === 'reserve' ? 'On call; this does not imply free time.' : info.kind !== 'leave' ? 'On duty; this does not imply free time.' : null].filter(Boolean).join('\n');
  };
  const allLegs = (roster.trips || []).flatMap(trip => trip.legs).filter(leg => (entry.sourcePeriod == null || leg.sourcePeriod === entry.sourcePeriod) && leg.departureDateTime < end && leg.arrivalDateTime > start);
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
    label: ground.map(item => `${item.dutyInfo.port || (item.dutyInfo.kind === 'leave' ? '' : 'Port not supplied')}${item.dutyInfo.port || item.dutyInfo.kind !== 'leave' ? ' · ' : ''}${item.dutyInfo.label}`).join(' / ') + (offEntry ? ` / ${homePort(roster) || 'Home'} · home` : '') + availabilityLabel,
    kind: ground.every(item => item.dutyInfo.kind === 'reserve') ? 'reserve' : ground.every(item => item.dutyInfo.kind === 'leave') ? 'leave' : 'ground',
    detail: ground.map(groundDetail).join('\n\n') + homeDetail + availabilityDetail,
  };
  if (allLegs.length) return { label: [...new Set(allLegs.map(leg => `${leg.origin} · ${leg.service || 'ground duty'}`))].join(' / '), kind: 'ground',
    detail: allLegs.map(leg => `${leg.service || 'Ground duty'} · ${leg.origin}\n${formatTime(leg.departureDateTime)} – ${formatTime(leg.arrivalDateTime)}\nOn duty; this does not imply free time.`).join('\n\n') };
  const offDay = roster.offDays.some(item => dateKey(item.date) === dateKey(date));
  const home = homePort(roster);
  if (offDay) return { label: home ? `${home} · home` : roster.requiresDomicile ? 'Day off · choose domicile' : 'Day off · base unknown', kind: 'home', detail: `${entry.dutyInfo?.kind === 'leave' ? entry.dutyInfo.label : `${entry.dutyCode} · day off`}${home ? `\n${home}${homeDetail || `\n${formatTime(start)} – ${formatTime(end)}`}` : '\nHome location is not set.'}` };
  const reserve = (roster.reserveDays || []).some(item => dateKey(item.date) === dateKey(date));
  if (reserve) return { label: `${roster.base || 'Base unknown'} · reserve`, kind: 'reserve', detail: `${entry.dutyCode} · reserve at base${entry.report && entry.end ? `\n${entry.report} – ${entry.end} roster local time` : '\nReserve times are unavailable.'}\nOn call; this does not imply free time.` };
  if (available.length) return { label: `${entry.dutyCode}${availabilityLabel}`, kind: 'home', detail: `${entry.dutyCode}${availabilityDetail}` };
  const stays = roster.portWindows.filter(window => window.start < end && window.end > start);
  if (stays.length) return { label: `${[...new Set(stays.map(window => window.port))].join(' / ')} · in port`, kind: 'trip', detail: stays.map(window => `${window.port} · ${window.dutyCode}\n${formatTime(window.start)} – ${formatTime(window.end)}`).join('\n\n') };
  return { label: 'Location unknown', kind: 'unknown', detail: `${entry.dutyCode}${entry.detail ? ` · ${entry.detail}` : ''}\nThe roster does not resolve this duty to a location.` };
}
export function buildRosterCalendar(rosters, month, { minOverlapMinutes = 60, range = 'month', period } = {}) {
  const fullRoster = range === 'roster';
  const first = fullRoster
    ? period?.first ?? dayStart(new Date(Math.min(...rosters.map(roster => +roster.coverageStart))))
    : new Date(Math.max(+new Date(month.getFullYear(), month.getMonth(), 1), period ? +period.first : -Infinity));
  const last = fullRoster
    ? period?.last ?? dayStart(new Date(Math.max(...rosters.map(roster => +roster.coverageEnd))))
    : new Date(Math.min(+new Date(month.getFullYear(), month.getMonth() + 1, 0), period ? +period.last : Infinity));
  const gridStart = addDays(first, -((first.getDay() + 6) % 7));
  const gridEnd = addDays(last, 6 - ((last.getDay() + 6) % 7));
  const windows = timelineWindows(sharedCalendarWindows(rosters, minOverlapMinutes), rosters);
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
        label: window.port,
        participantLabel: window.groups.map(group => `${group.port} · ${group.participants.map(participant => crews[participant.crewIndex].name).join(' + ')}`).join('; '),
        detailId: detailId({ title: `${window.port} · shared time`, subtitle: `${formatTime(window.start)} – ${formatTime(window.end)} · roster local time`,
          text: window.groups.map(group => group.participants.map(participant => `${crews[participant.crewIndex].name} · ${group.port}${participant.reserve ? ' · on call' : ''}${participant.onDuty ? ' · on duty' : ''}`).join('\n')).join('\n\n'),
        }),
      };
    });
    const timelineDays = dates.map((date, column) => {
      const end = addDays(date, 1);
      const minute = time => time <= date ? 0 : time >= end ? 1440 : time.getHours() * 60 + time.getMinutes() + time.getSeconds() / 60;
      return { date, column, segments: overlaps.filter(window => window.start < end && window.end > date).map(window => {
        const visibleStart = new Date(Math.max(date.getTime(), window.start.getTime()));
        const visibleEnd = new Date(Math.min(end.getTime(), window.end.getTime()));
        const offset = minute(visibleStart) / 14.4, width = (minute(visibleEnd) - minute(visibleStart)) / 14.4;
        return { ...window, visibleStart, visibleEnd, offset, width,
          continuesBefore: window.start < date, continuesAfter: window.end > end };
      }) };
    });
    const rowKeys = [...new Set(overlaps.map(window => window.combinationKey))].sort();
    const timelineRows = rowKeys.map(key => {
      const crewIndices = overlaps.find(window => window.combinationKey === key).crewIndices;
      const crewNames = crewIndices.map(index => crews[index].name);
      return { key, crewIndices, crewNames, label: crewNames.join(' + '),
        days: timelineDays.map(day => ({ ...day, segments: day.segments.filter(segment => segment.combinationKey === key) })),
      };
    });
    if (!timelineRows.length) timelineRows.push({ key: 'none', crewIndices: [], crewNames: [], label: 'Together', days: timelineDays });
    const number = period?.cycleStart ? dayDistance(period.cycleStart, weekStart) / 7 + 1 : weeks.length + 1;
    weeks.push({ number, dates, rows, overlaps, timelineDays, timelineRows });
  }
  const displayDate = date => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const dateTitle = fullRoster ? `${displayDate(first)} – ${displayDate(last)}` : first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return { month: new Date(month.getFullYear(), month.getMonth(), 1), first, last, range,
    title: period?.label ? `${period.label} · ${dateTitle}` : dateTitle,
    dayCount: dayDistance(first, last) + 1, crews, weeks, details };
}
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function renderCalendarMarkup(model, now = new Date()) {
  const today = dateKey(now);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const placement = bar => `grid-column: ${bar.column + 2} / span ${bar.span}`;
  const button = (bar, classes, style = '') => `<div class="calendar-cell" role="cell" aria-colindex="${bar.column + 2}" aria-colspan="${bar.span}" style="${placement(bar)};${style}"><button type="button" class="calendar-bar ${classes}" data-calendar-detail="${bar.detailId}" aria-label="${escapeHtml(`${model.details[bar.detailId].title} · ${model.details[bar.detailId].subtitle} · ${bar.label}`)}" title="${escapeHtml(bar.label)}">${escapeHtml(bar.label)}</button></div>`;
  const timeline = week => {
    const showNames = model.crews.length > 2 && week.timelineRows.some(row => row.crewIndices.length);
    return `<div class="calendar-together">${showNames ? '<div class="calendar-together-title">Together</div>' : ''}${week.timelineRows.map(row => `<div class="calendar-lane calendar-timeline-lane" role="row" data-crew-combination="${row.key}"><span class="calendar-row-name${showNames ? ' calendar-combination-name' : ''}" role="rowheader" aria-label="${escapeHtml(row.label)}" title="${escapeHtml(row.label)}">${showNames ? row.crewNames.map((name,index) => `<span>${index ? '+ ' : ''}${escapeHtml(name)}</span>`).join('') : 'Together'}</span>${row.days.map(day => `<div class="calendar-timeline-cell" role="cell" aria-colindex="${day.column + 2}" aria-label="${escapeHtml(day.date.toLocaleDateString('en-GB', {day:'numeric', month:'short'}))} · ${day.segments.length ? 'shared time' : 'no shared time'}"><div class="calendar-time-track">${day.segments.map(segment => {
    const detail = model.details[segment.detailId];
    const status = [segment.onDuty ? 'on duty' : '', segment.reserve ? 'on call' : ''].filter(Boolean).join(' / ') || 'free time';
    const classes = `calendar-overlap calendar-${segment.category} calendar-time-segment${segment.reserve ? ' is-on-call' : ''}${segment.onDuty ? ' is-on-duty' : ''}${segment.continuesBefore ? ' continues-before' : ''}${segment.continuesAfter ? ' continues-after' : ''}${segment.width < 18 ? ' is-narrow' : ''}`;
    return `<button type="button" class="calendar-bar ${classes}" data-calendar-detail="${segment.detailId}" style="left: ${segment.offset}%; width: ${segment.width}%" aria-label="${escapeHtml(`${segment.participantLabel} · ${status} · ${detail.subtitle}`)}" title="${escapeHtml(`${segment.participantLabel} · ${status} · ${detail.subtitle}`)}"><span>${escapeHtml(segment.label)}</span></button>`;
  }).join('')}</div></div>`).join('')}</div>`).join('')}</div>`;
  };
  return `<div class="calendar-lane calendar-day-head" role="row"><span role="columnheader">Pilots / overlaps</span>${days.map(day => `<span role="columnheader">${day}</span>`).join('')}</div>` + model.weeks.map(week => {
    const todayColumn = week.dates.findIndex(date => dateKey(date) === today);
    return `
    <div class="calendar-week${todayColumn >= 0 ? ' has-today' : ''}" role="rowgroup"${todayColumn >= 0 ? ` style="--today-column: ${todayColumn}"` : ''}>
      <div class="calendar-lane calendar-dates" role="row"><span role="cell" class="calendar-week-number">Week ${week.number}</span>${week.dates.map(date => `<span role="cell" class="${date < model.first || date > model.last ? 'is-outside' : ''}${dateKey(date) === today ? ' is-today' : ''}"><time datetime="${dateKey(date)}"${dateKey(date) === today ? ' aria-current="date" title="Today"' : ''}>${model.range === 'roster' || date.getMonth() !== model.month.getMonth() ? `${date.getDate()} ${date.toLocaleDateString('en-GB', { month: 'short' })}` : date.getDate()}</time></span>`).join('')}</div>
      ${week.rows.map((bars, index) => `<div class="calendar-lane calendar-pilot-lane" role="row"><span class="calendar-row-name" role="rowheader" style="--crew-colour: ${model.crews[index].colour}" title="${escapeHtml(model.crews[index].name)}">${escapeHtml(model.crews[index].name)}</span>${bars.map(bar => button(bar, `calendar-${bar.kind}${bar.outside ? ' is-outside' : ''}`, `--crew-colour: ${model.crews[index].colour}`)).join('')}</div>`).join('')}
      ${timeline(week)}
    </div>`;
  }).join('');
}
