// Duty meanings are aligned with Roster Export iCal/public/shared/roster-parser.mjs
// and roster-analysis.mjs. Recognition never supplies missing clock times.
const LONG_HAUL_OFF_DUTY_CODES = new Set(["A", "X", "RX", "AL", "GL", "HL", "LSL"]);
const LEAVE_LABELS = { AL: "Annual leave", GL: "Golden leave", HL: "High priority leave", LSL: "Long service leave", LA: "Leave", SL: "Sick leave", UL: "Upline sick leave" };
const EMERGENCY_PORTS = { SY: "SYD", ML: "MEL", BN: "BNE", PH: "PER" };
const KNOWN_PORTS = new Set(["ADL", "MEL", "SYD", "BNE", "PER", "DRW", "HBA", "CBR", "OOL", "CNS", "AKL", "WLG", "CHC", "SIN", "HKG", "NRT", "HND", "LAX", "LHR", "DFW", "JNB", "SCL", "DPS", "BKK", "NAN", "HTI", "MCY", "TSV", "NTL"]);
const SHORT_HAUL_OFF_DUTY_CODES = new Set(["D/O", "LA", "A/V", ...LONG_HAUL_OFF_DUTY_CODES]);
const SHORT_HAUL_RESERVE_DUTY_REGEX = /^(?:SR|R(?:[0-9]+|SV|ES(?:ERVE)?)?)$/i;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_CODES = new Map([
  ["MO", 1],
  ["TU", 2],
  ["WE", 3],
  ["TH", 4],
  ["FR", 5],
  ["SA", 6],
  ["SU", 7],
]);
const DEFAULT_PORT_MATCH_WINDOW_MS = 60 * 60 * 1000;
const MATCH_SORT_ORDER = new Map([
  ["port_match", 0],
  ["shared_day_off", 1],
  ["reserve_at_base", 2],
]);

export function compareRosterGroupTexts(rosterInputs, options = {}) {
  if (!Array.isArray(rosterInputs) || rosterInputs.length < 2 || rosterInputs.length > 5) {
    throw new Error("Select between 2 and 5 rosters to compare.");
  }

  return compareRosterGroup(rosterInputs.map((input) => parseRosterText(input.fileName, input.text)), options);
}

export function compareRosterGroup(rosters, options = {}) {
  if (!Array.isArray(rosters) || rosters.length < 2 || rosters.length > 5) {
    throw new Error("Select between 2 and 5 rosters to compare.");
  }
  const portMatchWindowMs =
    options.minPortOverlapMinutes != null
      ? Math.max(1, Number(options.minPortOverlapMinutes || 60)) * 60 * 1000
      : Math.max(1, Number(options.minPortOverlapHours || 1)) * 60 * 60 * 1000;

  const matches = (
    rosters.length === 2
      ? buildTwoRosterMatches(rosters[0], rosters[1], portMatchWindowMs)
      : buildGroupRosterMatches(rosters, portMatchWindowMs)
  ).sort((left, right) => {
    const prioritySort = (MATCH_SORT_ORDER.get(left.match_key) ?? 99) - (MATCH_SORT_ORDER.get(right.match_key) ?? 99);
    if (prioritySort !== 0) {
      return prioritySort;
    }
    const dateSort = left.sort_date.localeCompare(right.sort_date);
    if (dateSort !== 0) {
      return dateSort;
    }
    const typeSort = left.match_type.localeCompare(right.match_type);
    if (typeSort !== 0) {
      return typeSort;
    }
    return left.port.localeCompare(right.port);
  });

  return {
    crews: rosters.map((roster) => buildSummary(roster)),
    matches,
    notes: buildGroupNotes(rosters),
  };
}

export function compareRosterTexts(crewAFile, crewAText, crewBFile, crewBText, options = {}) {
  const payload = compareRosterGroupTexts(
    [
      { fileName: crewAFile, text: crewAText },
      { fileName: crewBFile, text: crewBText },
    ],
    options
  );

  return {
    crew_a: payload.crews[0],
    crew_b: payload.crews[1],
    matches: payload.matches.map(genericMatchToLegacyMatch),
    notes: payload.notes,
  };
}

function buildTwoRosterMatches(rosterA, rosterB, portMatchWindowMs) {
  return dedupeMatches(
    [
      ...compareDaysOff(rosterA, rosterB),
      ...compareReserveDays(rosterA, rosterB, portMatchWindowMs),
      ...compareGroupPortMatches([rosterA, rosterB], portMatchWindowMs).map(genericMatchToLegacyMatch),
    ].map(legacyMatchToGenericMatch)
  );
}

function buildGroupRosterMatches(rosters, portMatchWindowMs) {
  return dedupeMatches([
    ...compareGroupDaysOff(rosters),
    ...compareGroupPortMatches(rosters, portMatchWindowMs),
  ]);
}

function legacyMatchToGenericMatch(match) {
  return {
    date: match.date,
    sort_date: match.sort_date,
    port: match.port,
    match_type: match.match_type,
    match_key: match.match_key,
    overlap_window: match.overlap_window,
    participants: [
      { label: match.crew_a, window: match.window_a },
      { label: match.crew_b, window: match.window_b },
    ],
    visual_group: match.visual_group,
  };
}

function genericMatchToLegacyMatch(match) {
  return {
    date: match.date,
    sort_date: match.sort_date,
    port: match.port,
    match_type: match.match_type,
    match_key: match.match_key,
    overlap_window: match.overlap_window,
    crew_a: match.participants[0]?.label || "",
    window_a: match.participants[0]?.window || "",
    crew_b: match.participants[1]?.label || "",
    window_b: match.participants[1]?.window || "",
    visual_group: match.visual_group,
  };
}

function offDayWindows(entry) {
  return entry.homeWindows || [{ start: entry.date, end: addDays(entry.date, 1) }];
}

function compareGroupDaysOff(rosters) {
  const others = rosters.slice(1).map(roster => new Map(roster.offDays.map(entry => [formatSortableLocalDate(entry.date), entry])));
  return rosters[0].offDays.flatMap(first => {
    const entries = [first, ...others.map(byDate => byDate.get(formatSortableLocalDate(first.date)))];
    if (entries.some(entry => !entry)) return [];
    let common = offDayWindows(first);
    for (const entry of entries.slice(1)) common = common.flatMap(a => offDayWindows(entry).map(b => ({ start: new Date(Math.max(a.start, b.start)), end: new Date(Math.min(a.end, b.end)) })).filter(window => window.end > window.start));
    return common.map(window => {
      const allDay = window.start.getTime() === first.date.getTime() && window.end.getTime() === addDays(first.date, 1).getTime();
      return { date: formatDisplayLocalDate(first.date), sort_date: formatSortableLocalDate(first.date),
        port: formatCombinedPort(rosters.map(homePort)), match_type: "Shared day off", match_key: "shared_day_off", overlap_window: allDay ? "All day" : formatWindow(window.start, window.end),
        participants: entries.map((entry, index) => ({ label: `${entry.dutyCode} (${homePort(rosters[index]) || "home unknown"})`, window: allDay ? "All day" : offDayWindows(entry).map(w => formatWindow(w.start, w.end)).join(" / ") })), visual_group: "home_match" };
    });
  });
}

const homePort = roster => roster.requiresDomicile ? null : roster.domicile || roster.base;

function comparisonWindows(roster) {
  return [...roster.portWindows, ...roster.offDays.filter(() => homePort(roster)).flatMap(entry => offDayWindows(entry).map(window => ({
    ...window, port: homePort(roster), dutyCode: `${entry.dutyCode} (${homePort(roster)} · assumed home)`, assumed: true,
  }))), ...boundaryHomeWindows(roster)];
}

function compareGroupPortMatches(rosters, portMatchWindowMs) {
  const matches = [], windows = rosters.map(comparisonWindows);
  function intersect(index, port, start, end, participants) {
    if (index === rosters.length) {
      // Shared days off already have a dedicated result; avoid duplicating them.
      if (participants.every(window => window.assumed && !window.boundary)) return;
      if (rosters.length === 2 && participants.some(window => window.matchType === "home_reserve") && participants.some(window => window.assumed)) return;
      const date = new Date(start);
      matches.push({ date: formatDisplayLocalDate(date), sort_date: formatSortableLocalDate(date), port,
        match_type: participants.every(window => window.assumed) ? "Shared time off" : "Port match", match_key: "port_match", overlap_window: formatWindow(date, new Date(end)),
        participants: participants.map(window => ({ label: window.dutyCode, window: formatWindow(window.start, window.end) })),
        visual_group: rosters.some(roster => homePort(roster) === port) ? "home_match" : "away_port" });
      return;
    }
    for (const window of windows[index]) {
      if (window.port !== port) continue;
      const a = Math.max(start, window.start.getTime()), b = Math.min(end, window.end.getTime());
      if (b - a >= portMatchWindowMs) intersect(index + 1, port, a, b, [...participants, window]);
    }
  }
  for (const window of windows[0]) intersect(1, window.port, window.start.getTime(), window.end.getTime(), [window]);
  return matches;
}

function classifyNonFlyingDuty(entry) {
  const code = String(entry.dutyCode || "").replace(/\(T\)$/i, "").trim().toUpperCase();
  const text = `${code} ${entry.detail || ""} ${entry.service || ""}`.toUpperCase();
  if (["A", "X", "RX", "D/O", "A/V"].includes(code)) return { kind: "off", label: `${code} · day off`, assumeHome: true };
  if (LEAVE_LABELS[code]) return { kind: "leave", label: `${code} · ${LEAVE_LABELS[code]}`, assumeHome: !["SL", "UL"].includes(code) };
  if (SHORT_HAUL_RESERVE_DUTY_REGEX.test(code)) return { kind: "reserve", label: code === "SR" ? "SR · standby" : `${code} · reserve` };
  if (code === "TSPD") return { kind: "training", label: "TSPD", rulePort: "MEL", ruleSource: "Roster Export TSPD Melbourne rule" };
  if (/\bSIM[A-Z0-9]*\b/.test(text)) {
    const exercise = text.match(/\bSIM([A-Z0-9]{4})\b/) || text.match(/\bSIM\s+([A-Z0-9]{4})\b/);
    return { kind: "sim", label: exercise ? `SIM · Ex ${exercise[1]}` : "SIM · simulator" };
  }
  const emergency = text.match(/\bEP[AC]([A-Z]{2})?\b/);
  if (emergency) return { kind: "training", label: `${emergency[0]} · emergency procedures`, rulePort: EMERGENCY_PORTS[emergency[1]] || null, ruleSource: "Roster Export EPA/EPC location code" };
  if (/^(?:EPA|EPC|EPE|TPA|TPAX|TNR|PMI|EBT)/.test(code) || /\b(?:TRAIN\w*|TRG)\b/.test(text)) return { kind: "training", label: `${code} · ground / training duty` };
  return null;
}

function validDutyTime(value) {
  return /^\d{4}$/.test(value || "") && Number(value.slice(0, 2)) < 24 && Number(value.slice(2)) < 60;
}

function dutyTimeWindow(entry) {
  if (!validDutyTime(entry.report) || !validDutyTime(entry.end)) return null;
  const start = combineDateTime(entry.date, entry.report);
  let end = combineDateTime(entry.date, entry.end);
  if (end <= start) end = combineDateTime(addDays(entry.date, 1), entry.end);
  return { start, end, source: "Roster report / end times" };
}

function resolveNonFlyingDuties(calendar, patterns, trips, base) {
  const portWindows = [], unresolvedDuties = [];
  const legs = trips.flatMap(trip => trip.legs);
  const definitions = Array.isArray(patterns) ? patterns : [...patterns.values()];
  const knownPorts = new Set([...KNOWN_PORTS, base, ...legs.flatMap(leg => [leg.origin, leg.destination])].filter(Boolean));
  for (const entry of calendar) {
    const info = classifyNonFlyingDuty(entry);
    if (!info) continue;
    entry.dutyInfo = info;
    if (info.assumeHome) continue;
    if (info.kind === "leave") {
      info.issues = ["Leave location is not supplied; no home presence assumed."];
      entry.uncertainty = info.issues.join(" ");
      unresolvedDuties.push(entry);
      continue;
    }
    const code = normalizeShortHaulCode(entry.dutyCode);
    const services = new Set([code, ...(`${entry.detail || ""} ${entry.service || ""}`.match(/[A-Z0-9]+(?:\(T\))?/gi) || []).map(normalizeShortHaulCode)]);
    let matchingLegs = legs.filter(leg => leg.origin === leg.destination && formatSortableLocalDate(leg.departureDateTime) === formatSortableLocalDate(entry.date) && services.has(normalizeShortHaulCode(leg.service)));
    const matchingDefinition = definitions.find(pattern => services.has(normalizeShortHaulCode(pattern.code)) && (!pattern.coveredDates || pattern.coveredDates.has(formatSortableLocalDate(entry.date))));
    const definitionLegs = matchingDefinition?.flights || matchingDefinition?.legs || [];
    const definitionPorts = new Set(definitionLegs.flatMap(leg => [leg.origin, leg.destination]).filter(Boolean));
    let port = null, locationSource = null;
    if (/^[A-Z]{3}$/.test(entry.port || "") && !["UNK", "NIL"].includes(entry.port)) { port = entry.port; locationSource = "Roster port column"; }
    if (!port && matchingLegs.length && new Set(matchingLegs.map(leg => leg.origin)).size === 1) { port = matchingLegs[0].origin; locationSource = "Matched same-port simulator / ground sector"; }
    if (!port && definitionPorts.size === 1) { port = [...definitionPorts][0]; locationSource = "Same-port pattern definition"; }
    if (!port && info.rulePort) { port = info.rulePort; locationSource = info.ruleSource; }
    if (!port) {
      const mentioned = [...new Set(String(entry.detail || "").toUpperCase().match(/\b[A-Z]{3}\b/g) || [])].filter(token => knownPorts.has(token));
      if (mentioned.length === 1) { port = mentioned[0]; locationSource = "Airport code in roster detail"; }
    }
    if (!port && info.kind === "reserve" && base) { port = base; locationSource = "Roster base for reserve / standby"; }
    let window = dutyTimeWindow(entry);
    if (!matchingLegs.length && matchingDefinition?.flights?.length && definitionPorts.size === 1) matchingLegs = instantiatePattern(entry.date, matchingDefinition).map(leg => ({ ...leg.flight, departureDateTime: leg.departureDateTime, arrivalDateTime: leg.arrivalDateTime })).filter(leg => formatSortableLocalDate(leg.departureDateTime) === formatSortableLocalDate(entry.date));
    if (!window && matchingLegs.length) window = { start: matchingLegs[0].departureDateTime, end: matchingLegs.at(-1).arrivalDateTime, source: "Matched ground-sector times" };
    const issues = [];
    if (!port) issues.push("Duty location is not supplied or cannot be decoded.");
    if (!window) issues.push("Report / end times are missing or invalid; no full-day duty window inferred.");
    Object.assign(info, { port, locationSource, timingSource: window?.source || null, start: window?.start || null, end: window?.end || null, issues });
    if (issues.length) { entry.uncertainty = issues.join(" "); unresolvedDuties.push(entry); }
    if (port && window) portWindows.push({ start: window.start, end: window.end, port, dutyCode: `${info.label} (${info.kind === "reserve" ? "on call" : "on duty"})`, matchType: info.kind === "reserve" ? "home_reserve" : "ground_duty", onDuty: info.kind !== "reserve", dutyLabel: info.label });
  }
  return { portWindows, unresolvedDuties };
}

function excludeGroundDutyFromLayovers(windows) {
  const duties = windows.filter(window => window.onDuty);
  return windows.flatMap(window => {
    if (window.matchType !== "in_port") return [window];
    let pieces = [window];
    for (const duty of duties.filter(duty => duty.port === window.port)) {
      pieces = pieces.flatMap(piece => {
        if (duty.end <= piece.start || duty.start >= piece.end) return [piece];
        return [piece.start < duty.start ? { ...piece, end: duty.start } : null,
          piece.end > duty.end ? { ...piece, start: duty.end } : null].filter(Boolean);
      });
    }
    return pieces;
  });
}

function collectOffDays(calendar, occupiedWindows = []) {
  const busy = new Set(calendar.filter(entry => !classifyNonFlyingDuty(entry)?.assumeHome).map(entry => formatSortableLocalDate(entry.date)));
  return calendar.filter(entry => classifyNonFlyingDuty(entry)?.assumeHome && !busy.has(formatSortableLocalDate(entry.date))).map(entry => {
    let pieces = [{ start: entry.date, end: addDays(entry.date, 1) }];
    for (const occupied of occupiedWindows) pieces = pieces.flatMap(piece => {
      if (occupied.end <= piece.start || occupied.start >= piece.end) return [piece];
      return [piece.start < occupied.start ? { start: piece.start, end: occupied.start } : null,
        piece.end > occupied.end ? { start: occupied.end, end: piece.end } : null].filter(Boolean);
    });
    return { ...entry, homeWindows: pieces };
  }).filter(entry => entry.homeWindows.length);
}

export function parseRosterText(fileName, rawText) {
  const text = normalizeText(rawText);
  const source = detectSource(fileName, text);
  const metadata = {
    crewName: extractCrewName(text, source) || "Unknown",
    staffNumber: matchGroup(text, /Staff\s*(?:No\.?|Number)\s*:\s*(\d+)/im),
    base: matchGroup(text, /Base\s*:\s*([A-Z]{3})/m),
    bidPeriod: matchGroup(text, /Bid Period\s+(\d+)/im),
    source,
    generationDate: extractGenerationDate(text),
  };

  if (isShortHaulRoster(text)) {
    return parseShortHaulRoster(fileName, text, metadata);
  }

  return parseLongHaulRoster(fileName, text, metadata);
}

function parseLongHaulRoster(fileName, text, metadata) {
  const calendar = parseCalendarEntries(text, metadata.generationDate);
  const patterns = parsePatternDefinitions(text);

  if (!calendar.length) {
    throw new Error("No calendar entries could be parsed from the roster.");
  }

  const flightData = buildDutyWindows(calendar, patterns);
  const { trips } = flightData;
  const nonFlying = resolveNonFlyingDuties(calendar, patterns, trips, metadata.base);
  const offDays = collectOffDays(calendar, [...flightData.portWindows, ...nonFlying.portWindows, ...trips.flatMap(trip => trip.legs.map(leg => ({ start: leg.departureDateTime, end: leg.arrivalDateTime })))]);
  const reserveDays = calendar.filter(entry => entry.dutyInfo?.kind === "reserve");
  const portWindows = excludeGroundDutyFromLayovers([...flightData.portWindows, ...nonFlying.portWindows]);
  const unresolvedDuties = [...flightData.unresolvedDuties, ...nonFlying.unresolvedDuties];

  return buildRosterRecord({
    crewName: metadata.crewName,
    staffNumber: metadata.staffNumber,
    base: metadata.base,
    bidPeriod: metadata.bidPeriod,
    source: metadata.source,
    fileName,
    calendar,
    patterns,
    offDays,
    reserveDays,
    trips,
    portWindows,
    unresolvedDuties,
    preview: text.split("\n").slice(0, 20).join("\n"),
  });
}

function parseShortHaulRoster(fileName, text, metadata) {
  const detailData = parseShortHaulDetailBlocks(text);
  const calendar = parseShortHaulCalendarEntries(text, detailData.blocks, metadata.generationDate);

  if (!calendar.length) {
    throw new Error("No calendar entries could be parsed from the roster.");
  }

  const trips = detailData.blocks.map((block) => ({ code: block.code, anchorDate: block.startDate, dutyTimes: block.dutyTimes, legs: block.legs }));
  const nonFlying = resolveNonFlyingDuties(calendar, detailData.blocks, trips, metadata.base);
  const offDays = collectOffDays(calendar, [...detailData.blocks.flatMap(block => block.portWindows), ...nonFlying.portWindows, ...trips.flatMap(trip => trip.legs.map(leg => ({ start: leg.departureDateTime, end: leg.arrivalDateTime })))]);
  const reserveDays = calendar.filter(entry => entry.dutyInfo?.kind === "reserve");
  const portWindows = excludeGroundDutyFromLayovers([...detailData.blocks.flatMap(block => block.portWindows), ...nonFlying.portWindows]);
  const unresolvedDuties = [...buildShortHaulUnresolvedDuties(calendar, detailData.blocks), ...nonFlying.unresolvedDuties];

  return buildRosterRecord({
    crewName: metadata.crewName,
    staffNumber: metadata.staffNumber,
    base: metadata.base,
    bidPeriod: metadata.bidPeriod,
    source: metadata.source,
    fileName,
    calendar,
    patterns: detailData.blocks,
    offDays,
    reserveDays,
    trips,
    portWindows,
    unresolvedDuties,
    preview: text.split("\n").slice(0, 20).join("\n"),
  });
}

function buildRosterRecord({
  crewName,
  staffNumber,
  base,
  bidPeriod,
  source,
  fileName,
  calendar,
  patterns,
  offDays,
  reserveDays = [],
  trips = [],
  portWindows,
  unresolvedDuties,
  preview,
}) {
  const roster = {
    crewName: crewName.replace(/\s+/g, " ").trim(),
    displayName: buildDisplayName(crewName, source),
    staffNumber,
    base,
    domicile: base,
    bidPeriod,
    source,
    fileName,
    calendar,
    patterns,
    offDays,
    reserveDays,
    trips,
    portWindows,
    unresolvedDuties,
    coverageStart: calendar.length ? calendar[0].date : null,
    coverageEnd: calendar.length ? calendar[calendar.length - 1].date : null,
    preview,
  };
  roster.dutyBlocks = buildRosterDutyBlocks(roster);
  // Printed report/release times also trim an adjacent full-day off marker.
  roster.offDays = roster.offDays.map(entry => ({ ...entry,
    homeWindows: subtractWindows(offDayWindows(entry), roster.dutyBlocks),
  })).filter(entry => entry.homeWindows.length);
  roster.homeBoundaryWindows = buildHomeBoundaryWindows(roster);
  return roster;
}

function subtractWindows(windows, occupied) {
  let pieces = windows;
  for (const busy of occupied) pieces = pieces.flatMap(piece => {
    if (busy.end <= piece.start || busy.start >= piece.end) return [piece];
    return [piece.start < busy.start ? { ...piece, end: busy.start } : null,
      piece.end > busy.end ? { ...piece, start: busy.end } : null].filter(Boolean);
  });
  return pieces;
}

function datedDutyEnd(entry) {
  if (!validDutyTime(entry.end)) return null;
  const end = combineDateTime(entry.date, entry.end);
  return validDutyTime(entry.report) && entry.end <= entry.report ? combineDateTime(addDays(entry.date, 1), entry.end) : end;
}

function buildRosterDutyBlocks(roster) {
  const blocks = [];
  for (const trip of roster.trips) {
    const first = trip.legs[0], last = trip.legs.at(-1);
    if (!first || !last) continue;
    const anchor = trip.anchorDate || new Date(first.departureDateTime.getFullYear(), first.departureDateTime.getMonth(), first.departureDateTime.getDate());
    const lastDayEnd = addDays(last.arrivalDateTime, 1);
    const rows = roster.calendar.filter(entry => entry.dutyCode === trip.code && entry.date >= anchor && entry.date < lastDayEnd);
    const details = trip.dutyTimes || [];
    const reports = [...rows, ...details].filter(entry => validDutyTime(entry.report)).map(entry => combineDateTime(entry.date, entry.report)).filter(time => time <= first.departureDateTime);
    // A report time printed in the flight pattern belongs to its departure day,
    // or the preceding evening when it is later than the departure clock time.
    if (!reports.length && validDutyTime(first.report)) {
      let report = combineDateTime(first.departureDateTime, first.report);
      if (report > first.departureDateTime) report = combineDateTime(addDays(first.departureDateTime, -1), first.report);
      reports.push(report);
    }
    const releases = [...rows, ...details].map(datedDutyEnd).filter(time => time && time >= last.arrivalDateTime);
    const start = reports.length ? new Date(Math.min(...reports)) : first.departureDateTime;
    const end = releases.length ? new Date(Math.max(...releases)) : last.arrivalDateTime;
    if (end <= start) continue;
    blocks.push({ start, end, startKnown: reports.length > 0, endKnown: releases.length > 0,
      startPort: first.origin, endPort: last.destination, dutyCode: trip.code });
  }
  for (const entry of roster.calendar) {
    const info = entry.dutyInfo;
    if (info?.port && !info.assumeHome && (!entry.report || validDutyTime(entry.report)) && (!entry.end || validDutyTime(entry.end))) {
      const startKnown = Boolean(info.start) || validDutyTime(entry.report);
      const endKnown = Boolean(info.end) || validDutyTime(entry.end);
      if (startKnown || endKnown) blocks.push({ start: info.start || (startKnown ? combineDateTime(entry.date, entry.report) : entry.date),
        end: info.end || datedDutyEnd(entry) || addDays(entry.date, 1), startKnown, endKnown,
        startPort: info.port, endPort: info.port, dutyCode: info.label });
    }
  }
  // Unknown or incompletely timed duties are barriers, never gaps to fill at home.
  for (const entry of roster.unresolvedDuties) {
    if (entry.dutyInfo?.port && (!entry.report || validDutyTime(entry.report)) && (!entry.end || validDutyTime(entry.end)) && (validDutyTime(entry.report) || validDutyTime(entry.end) || entry.dutyInfo.start)) continue;
    blocks.push({ start: entry.date, end: addDays(entry.date, 1), startKnown: false, endKnown: false,
      startPort: null, endPort: null, dutyCode: entry.dutyCode });
  }
  return blocks.sort((a, b) => a.start - b.start || a.end - b.end);
}

function buildHomeBoundaryWindows(roster) {
  const groups = [];
  for (const block of roster.dutyBlocks) {
    const previous = groups.at(-1);
    if (!previous || block.start > previous.end) { groups.push({ ...block }); continue; }
    if (block.start.getTime() === previous.start.getTime()) {
      previous.startKnown &&= block.startKnown;
      if (previous.startPort !== block.startPort) previous.startPort = null;
    }
    if (block.end > previous.end) {
      previous.end = block.end; previous.endKnown = block.endKnown; previous.endPort = block.endPort;
    } else if (block.end.getTime() === previous.end.getTime()) {
      previous.endKnown &&= block.endKnown;
      if (previous.endPort !== block.endPort) previous.endPort = null;
    }
    previous.dutyCode = [...new Set([...previous.dutyCode.split(" / "), block.dutyCode])].join(" / ");
  }
  const dates = new Set(roster.calendar.map(entry => formatSortableLocalDate(entry.date)));
  const windows = new Map();
  const offWindows = roster.offDays.flatMap(offDayWindows);
  function add(start, end, anchors, label, kind) {
    if (end <= start || anchors.some(port => !port) || !dates.has(formatSortableLocalDate(start))) return;
    for (const piece of subtractWindows([{ start, end }], offWindows)) {
      const key = `${piece.start.getTime()}:${piece.end.getTime()}:${[...new Set(anchors)].sort().join(",")}`;
      const previous = windows.get(key);
      if (previous) { previous.dutyCode += ` / ${label}`; previous.kind = "between"; }
      else windows.set(key, { ...piece, anchorPorts: [...new Set(anchors)], dutyCode: label, kind, boundary: true });
    }
  }
  groups.forEach((block, index) => {
    const previous = groups[index - 1], next = groups[index + 1];
    const firstDay = new Date(block.start.getFullYear(), block.start.getMonth(), block.start.getDate());
    const lastDayEnd = addDays(block.end, 1);
    if (block.startKnown && block.startPort) {
      const sameDayPrevious = previous && previous.end > firstDay;
      if (!sameDayPrevious || previous.endKnown) add(sameDayPrevious ? previous.end : firstDay, block.start,
        [block.startPort, ...(sameDayPrevious ? [previous.endPort] : [])], `${block.dutyCode} · before duty`, "before");
    }
    if (block.endKnown && block.endPort) {
      const sameDayNext = next && next.start < lastDayEnd;
      if (!sameDayNext || next.startKnown) add(block.end, sameDayNext ? next.start : lastDayEnd,
        [block.endPort, ...(sameDayNext ? [next.startPort] : [])], `${block.dutyCode} · after duty`, "after");
    }
  });
  return [...windows.values()].sort((a, b) => a.start - b.start);
}

function boundaryHomeWindows(roster) {
  const port = homePort(roster);
  if (!port) return [];
  return (roster.homeBoundaryWindows || []).filter(window => window.anchorPorts.every(anchor => anchor === roster.base || anchor === port)).map(window => ({
    ...window, port, assumed: true, dutyCode: `${window.dutyCode} (${port} · assumed domicile; commute not included)`,
  }));
}

function isShortHaulRoster(text) {
  return /SH Flight Crew Roster/i.test(text);
}

function isShortHaulOffDay(dutyCode) {
  return SHORT_HAUL_OFF_DUTY_CODES.has(String(dutyCode || "").toUpperCase());
}

function isShortHaulReserveDuty(dutyCode) {
  return SHORT_HAUL_RESERVE_DUTY_REGEX.test(String(dutyCode || "").toUpperCase());
}

function normalizeShortHaulCode(value) {
  return String(value || "")
    .trim()
    .replace(/\(T\)$/i, "")
    .replace(/^[P&]+/, "")
    .toUpperCase();
}

function splitShortHaulServiceCodes(serviceText) {
  return String(serviceText || "")
    .split("/")
    .map((token) => normalizeShortHaulCode(token))
    .filter(Boolean);
}

function parseShortHaulDetailBlocks(text) {
  const blocks = [];
  let anchorDate = null;
  let inDetails = false;
  let blockLines = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");

    if (line.includes("Pattern Details")) {
      inDetails = true;
      blockLines = [];
      continue;
    }
    if (!inDetails) {
      continue;
    }
    if (line.includes("*** End of Report")) {
      break;
    }

    const footerMatch = line.match(/([A-Z0-9]+)\s+DATED\s+(\d{2}[A-Z][a-z]{2}\d{2})/);
    if (footerMatch) {
      const blockDate = parseCompactDayMonthYearText(footerMatch[2]);
      const block = parseShortHaulDetailBlock(footerMatch[1], blockDate, blockLines);
      if (block) {
        blocks.push(block);
        if (!anchorDate || block.startDate < anchorDate) {
          anchorDate = block.startDate;
        }
      }
      blockLines = [];
      continue;
    }

    blockLines.push(line);
  }

  return { blocks, anchorDate };
}

function parseShortHaulDetailBlock(code, blockDate, lines) {
  const legs = [], dutyTimes = [];
  let previousDate = null;

  for (const line of lines) {
    const leg = parseShortHaulLegLine(line, blockDate, previousDate);
    if (!leg) {
      const times = line.match(/\bRpt\s+(\d{4})\s+Rls\s+(\d{4})\b/);
      if (times && previousDate) dutyTimes.push({ date: previousDate, report: times[1], end: times[2] });
      continue;
    }
    legs.push(leg);
    previousDate = leg.flightDate;
  }

  if (!legs.length) {
    return null;
  }

  const coveredDates = new Set();
  const servicesByDate = new Map();
  const portWindows = [];

  for (const leg of legs) {
    const dateKey = formatSortableLocalDate(leg.flightDate);
    coveredDates.add(dateKey);
    addValueToSetMap(servicesByDate, dateKey, normalizeShortHaulCode(leg.service));
  }

  for (let index = 0; index + 1 < legs.length; index += 1) {
    const currentLeg = legs[index];
    const nextLeg = legs[index + 1];
    if (
      currentLeg.destination === nextLeg.origin &&
      nextLeg.departureDateTime > currentLeg.arrivalDateTime
    ) {
      portWindows.push({
        start: currentLeg.arrivalDateTime,
        end: nextLeg.departureDateTime,
        port: currentLeg.destination,
        dutyCode: code,
        matchType: "in_port",
      });
    }
  }

  return {
    code,
    legs,
    dutyTimes,
    startDate: legs[0].flightDate,
    coveredDates,
    servicesByDate,
    portWindows,
  };
}

function parseShortHaulLegLine(line, blockDate, previousDate) {
  const match = line.match(
    /^(?<date>\d{2}[A-Z][a-z]{2})\s+(?:(?<marker>[P&])\s+)?(?<service>\S+)\s+(?<origin>[A-Z]{3})\s+(?<departure>\d{4})\s+(?<destination>[A-Z]{3})\s+(?<arrival>\d{4})/
  );
  if (!match || !match.groups) {
    return null;
  }

  const flightDate = parseShortHaulFlightDate(match.groups.date, blockDate, previousDate);
  const departureDateTime = combineDateTime(flightDate, match.groups.departure);
  let arrivalDateTime = combineDateTime(flightDate, match.groups.arrival);
  if (arrivalDateTime < departureDateTime) {
    arrivalDateTime = new Date(arrivalDateTime.getTime() + 24 * 60 * 60 * 1000);
  }

  return {
    flightDate,
    service: match.groups.service,
    origin: match.groups.origin,
    destination: match.groups.destination,
    departureDateTime,
    arrivalDateTime,
  };
}

function parseShortHaulFlightDate(dateText, blockDate, previousDate) {
  const day = Number(dateText.slice(0, 2));
  const monthIndex = MONTH_NAMES.indexOf(dateText.slice(2, 5));
  let year = (previousDate || blockDate).getFullYear();

  if (previousDate && monthIndex < previousDate.getMonth()) {
    year += 1;
  }

  return new Date(year, monthIndex, day);
}

function parseShortHaulCalendarEntries(text, blocks, generationDate) {
  const entries = [];
  let capture = false;
  let activeDutyCode = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.startsWith("Date") && line.includes("Duty(Role)") && line.includes("S-On")) {
      capture = true;
      continue;
    }
    if (capture && line.startsWith("Global Preferences")) {
      break;
    }
    if (!capture || /^-+$/.test(line.trim()) || !/^\d{2}\s+[A-Z][a-z]{2}\b/.test(line.trim())) {
      continue;
    }

    const parsed = parseShortHaulCalendarLine(line);
    if (!parsed) {
      continue;
    }

    if (parsed.explicitDutyCode) {
      activeDutyCode = parsed.explicitDutyCode;
      parsed.dutyCode = parsed.explicitDutyCode;
    } else if (parsed.service || parsed.report || parsed.end) {
      parsed.dutyCode = activeDutyCode;
    }

    entries.push(parsed);
  }

  return assignShortHaulCalendarDates(entries, resolveShortHaulCalendarStart(entries, text, blocks, generationDate));
}

function parseShortHaulCalendarLine(line) {
  const compact = line.trim().match(/^(\d{2})\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\S+)(.*)$/);
  if (compact && line.slice(8, 20).trim() !== compact[3] && classifyNonFlyingDuty({ dutyCode: compact[3], detail: compact[4] })) {
    const rest = parseCalendarRest(compact[4]);
    return { dayOfMonth: Number(compact[1]), rosterDay: compact[2], explicitDutyCode: compact[3], dutyCode: null, ...rest, port: null, service: null, code: null, duty: null };
  }

  const datePart = line.slice(0, 8).trim();
  const [dayText, rosterDay] = datePart.split(/\s+/);
  if (!dayText || !rosterDay) {
    return null;
  }

  return {
    dayOfMonth: Number(dayText),
    rosterDay,
    explicitDutyCode: line.slice(8, 20).trim() || null,
    dutyCode: null,
    detail: line.slice(20, 48).trim() || null,
    report: extractTimeField(line.slice(48, 53)),
    end: extractTimeField(line.slice(53, 58)),
    duty: line.slice(58, 64).trim() || null,
    credit: line.slice(64, 71).trim() || null,
    port: line.slice(71, 76).trim() || null,
    code: line.slice(76).trim() || null,
    service: line.slice(20, 48).trim() || null,
  };
}

function parseShortHaulPrintedDate(value) {
  const m = value.trim().match(/^(\d{1,2})\s*([A-Za-z]{3})\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = MONTH_NAMES.findIndex(name => name.toLowerCase() === m[2].toLowerCase());
  if (month < 0) return null;
  return new Date(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), month, Number(m[1]));
}

function shortHaulWeekdaysMatch(entries, start) {
  const calendar = assignShortHaulCalendarDates(entries, start);
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return calendar.every((entry, index) => entry.date.getDate() === entries[index].dayOfMonth && names[entry.date.getDay()] === entry.rosterDay);
}

function resolveShortHaulCalendarStart(entries, text, blocks, generationDate) {
  if (!entries.length) return generationDate;
  const fail = () => { throw new Error("Cannot determine the short-haul roster period reliably. Check the printed dates and weekdays."); };
  const printed = text.match(/(\d{1,2}\s*[A-Za-z]{3}\s*\d{2,4})\s*[-–]\s*(\d{1,2}\s*[A-Za-z]{3}\s*\d{2,4})/);
  const available = text.match(/Available Date\/Time this.*?:\s*(\d{2}[A-Za-z]{3}\d{2})/i);
  const explicit = printed ? parseShortHaulPrintedDate(printed[1]) : available ? parseShortHaulPrintedDate(available[1]) : null;
  if (explicit) {
    if (explicit.getDate() !== entries[0].dayOfMonth || !shortHaulWeekdaysMatch(entries, explicit)) return fail();
    return explicit;
  }
  const candidates = new Map();
  for (const anchor of [generationDate, ...blocks.map(block => block.startDate)]) {
    for (let offset = -13; offset <= 13; offset++) {
      const date = new Date(anchor.getFullYear(), anchor.getMonth() + offset, entries[0].dayOfMonth);
      if (date.getDate() !== entries[0].dayOfMonth || !shortHaulWeekdaysMatch(entries, date)) continue;
      const calendar = assignShortHaulCalendarDates(entries, date);
      const evidence = blocks.reduce((count, block) => count + calendar.filter(entry => block.coveredDates.has(formatSortableLocalDate(entry.date)) && (entry.dutyCode === block.code || (entry.service && serviceCodesResolved(entry.service, block.servicesByDate.get(formatSortableLocalDate(entry.date)))))).length, 0);
      candidates.set(date.getTime(), { date, evidence });
    }
  }
  const choices = [...candidates.values()].filter(candidate => !blocks.length || candidate.evidence > 0).sort((a, b) => b.evidence - a.evidence || Math.abs(a.date - generationDate) - Math.abs(b.date - generationDate));
  return choices[0]?.date || fail();
}

function assignShortHaulCalendarDates(entries, anchorDate) {
  if (!entries.length) {
    return [];
  }

  let currentYear = anchorDate.getFullYear();
  let currentMonth = anchorDate.getMonth();
  let previousDay = entries[0].dayOfMonth;

  return entries.map((entry) => {
    if (entry.dayOfMonth < previousDay && previousDay - entry.dayOfMonth > 7) {
      currentMonth += 1;
      if (currentMonth > 11) {
        currentMonth = 0;
        currentYear += 1;
      }
    }
    previousDay = entry.dayOfMonth;

    return {
      date: new Date(currentYear, currentMonth, entry.dayOfMonth),
      rosterDay: entry.rosterDay,
      dutyCode: entry.dutyCode,
      explicitDutyCode: entry.explicitDutyCode,
      detail: entry.detail,
      report: entry.report,
      end: entry.end,
      credit: entry.credit,
      port: entry.port,
      code: entry.code,
      service: entry.service,
    };
  });
}

function buildShortHaulUnresolvedDuties(calendar, blocks) {
  const coveredByCode = new Map();
  const servicesByDate = new Map();

  for (const block of blocks) {
    if (!coveredByCode.has(block.code)) {
      coveredByCode.set(block.code, new Set());
    }
    for (const dateKey of block.coveredDates) {
      coveredByCode.get(block.code).add(dateKey);
    }
    for (const [dateKey, services] of block.servicesByDate.entries()) {
      for (const service of services) {
        addValueToSetMap(servicesByDate, dateKey, service);
      }
    }
  }

  return calendar.filter((entry) => {
    if (!entry.dutyCode || entry.dutyInfo || isShortHaulOffDay(entry.dutyCode) || isShortHaulReserveDuty(entry.dutyCode)) {
      return false;
    }

    const dateKey = formatSortableLocalDate(entry.date);
    if (coveredByCode.get(entry.dutyCode)?.has(dateKey)) {
      return false;
    }

    const resolvedServices = servicesByDate.get(dateKey);
    if (entry.service && serviceCodesResolved(entry.service, resolvedServices)) {
      return false;
    }

    const normalizedDutyCode = normalizeShortHaulCode(entry.explicitDutyCode || entry.dutyCode);
    return !(normalizedDutyCode && resolvedServices?.has(normalizedDutyCode));
  });
}

function serviceCodesResolved(serviceText, resolvedServices) {
  if (!resolvedServices) {
    return false;
  }

  return splitShortHaulServiceCodes(serviceText).every((serviceCode) => resolvedServices.has(serviceCode));
}

function addValueToSetMap(target, key, value) {
  if (!value) {
    return;
  }
  if (!target.has(key)) {
    target.set(key, new Set());
  }
  target.get(key).add(value);
}

function normalizeText(rawText) {
  return rawText.replace(/\uFEFF/g, "").replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectSource(fileName, text) {
  const loweredName = fileName.toLowerCase();
  const loweredText = text.toLowerCase();
  if (loweredText.includes("sh flight crew roster")) {
    return "webcis-short-haul";
  }
  if (loweredName.includes("webcis") || loweredText.includes("webcis")) {
    return "webcis";
  }
  if (loweredText.includes("arms") && loweredText.includes("operations roster for bid period")) {
    return "arms";
  }
  return "text";
}

function extractCrewName(text) {
  const line = text.match(/^\s*Name\s*:\s*([^\n]+)/im)?.[1];
  return line ? line.split(/\s+(?:Staff\s*(?:No\.?|Number)|Category)\s*:/i)[0].trim() : null;
}

function buildDisplayName(crewName, source) {
  const normalized = String(crewName || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Unknown";
  }
  if (source === "webcis-short-haul") {
    return normalized;
  }

  const parts = normalized.split(/\s+/);
  return formatPersonName(parts[parts.length - 1] || normalized);
}

function formatPersonName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
}

function matchGroup(text, regex) {
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function extractGenerationDate(text) {
  const direct = text.match(/(\d{2}\s+[A-Z][a-z]{2}\s+\d{4})\s+\d{2}:\d{2}/);
  if (direct) {
    return parseDayMonthYearText(direct[1]);
  }

  const dateLine = text.match(/Date:\s+(\d{2}\s+[A-Z][a-z]{2}\s+\d{4})/);
  if (dateLine) {
    return parseDayMonthYearText(dateLine[1]);
  }

  return new Date();
}

function parseDayMonthYearText(value) {
  const [day, monthText, year] = value.split(/\s+/);
  const monthIndex = MONTH_NAMES.indexOf(monthText);
  return new Date(Number(year), monthIndex, Number(day));
}

function parseCompactDayMonthYearText(value) {
  const day = Number(value.slice(0, 2));
  const monthIndex = MONTH_NAMES.indexOf(value.slice(2, 5));
  const year = Number(value.slice(5, 7)) + 2000;
  return new Date(year, monthIndex, day);
}

function extractTimeField(value) {
  return /^\d{4}$/.test(value.trim()) ? value.trim() : null;
}

function parseCalendarEntries(text, generationDate) {
  const columns = [];
  let capture = false;
  let timeColumns = null;
  const lineRegex = /(?<date>\d{2}\/\d{2})\s+(?<dow>[MTWFSU])\s+(?<duty>[A-Z0-9]+)(?<rest>.*)/;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");

    if (/^\s*Date\b/i.test(line) && /Duty/i.test(line) && /Detail/i.test(line)) {
      capture = true;
      const header = line.split("|")[0];
      const report = header.search(/\bRept\b/), end = header.search(/\bEnd\b/);
      timeColumns = report >= 20 && end > report ? { report, end } : null;
      continue;
    }
    if (capture && (line.includes("Carry Out") || line.includes("END OF REPORT"))) {
      break;
    }
    if (!capture || !/\d{2}\/\d{2}/.test(line)) {
      continue;
    }

    const segments = line.split("|").filter((segment) => /\d{2}\/\d{2}/.test(segment));
    const scanSegments = segments.length ? segments : [line];

    scanSegments.forEach((segment, index) => {
      const match = segment.trim().match(lineRegex);
      if (!match || !match.groups) {
        return;
      }
      const parsedRest = parseCalendarRest(match.groups.rest.trim());
      if (timeColumns) {
        parsedRest.report = extractTimeField(segment.slice(timeColumns.report, timeColumns.end));
        parsedRest.end = extractTimeField(segment.slice(timeColumns.end, timeColumns.end + 5));
      }
      if (!columns[index]) columns[index] = [];
      columns[index].push({
        dateText: match.groups.date,
        rosterDay: match.groups.dow,
        dutyCode: match.groups.duty,
        ...parsedRest,
      });
    });
  }

  const orderedEntries = columns.flat();
  return assignCalendarYears(orderedEntries, generationDate);
}

function parseCalendarRest(rest) {
  if (!rest) {
    return { detail: null, report: null, end: null, credit: null };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  let credit = null;
  if (tokens.length && /^\d{1,3}:\d{2}$/.test(tokens[tokens.length - 1])) {
    credit = tokens.pop();
  }

  const timeTokens = tokens.filter((token) => /^\d{4}$/.test(token));
  const nonTimeTokens = tokens.filter((token) => !/^\d{4}$/.test(token));

  return {
    detail: nonTimeTokens.join(" ") || null,
    report: timeTokens[0] || null,
    end: timeTokens[1] || null,
    credit,
  };
}

function assignCalendarYears(entries, generationDate) {
  if (!entries.length) {
    return [];
  }

  const firstMonth = Number(entries[0].dateText.split("/")[1]);
  let currentYear = firstMonth - (generationDate.getMonth() + 1) > 6 ? generationDate.getFullYear() - 1 : generationDate.getFullYear();
  let previousMonth = firstMonth;

  return entries.map((entry) => {
    const [dayText, monthText] = entry.dateText.split("/");
    const month = Number(monthText);
    if (month < previousMonth) {
      currentYear += 1;
    }
    previousMonth = month;
    return {
      date: new Date(currentYear, month - 1, Number(dayText)),
      rosterDay: entry.rosterDay,
      dutyCode: entry.dutyCode,
      detail: entry.detail,
      report: entry.report,
      end: entry.end,
      credit: entry.credit,
    };
  });
}

function parsePatternDefinitions(text) {
  const patterns = new Map();
  let current = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const patternMatch = line.match(/Pattern:\s*([A-Z0-9]+)/);
    if (patternMatch) {
      current = {
        code: patternMatch[1],
        routeCode: matchGroup(line, /Route Code:\s*([A-Z0-9]+)/),
        daysAway: parseOptionalNumber(matchGroup(line, /Days Away:\s*(\d+)/)),
        flights: [],
      };
      patterns.set(current.code, current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("---") || line.startsWith("Regards,")) {
      current = null;
      continue;
    }

    if (!current.routeCode) {
      current.routeCode = matchGroup(line, /Route Code:\s*([A-Z0-9]+)/);
    }
    if (current.daysAway == null) {
      current.daysAway = parseOptionalNumber(matchGroup(line, /Days Away:\s*(\d+)/));
    }

    const flight = parseFlightLine(line);
    if (flight) {
      current.flights.push(flight);
    }
  }

  return patterns;
}

function parseOptionalNumber(value) {
  return value == null ? null : Number(value);
}

function parseFlightLine(line) {
  const sectorMatch = line.match(/\b([A-Z]{3})\/([A-Z]{3})\b/);
  if (!sectorMatch) {
    return null;
  }

  const tokens = line.split(/\s+/).filter(Boolean);
  const sectorIndex = tokens.indexOf(sectorMatch[0]);
  if (sectorIndex === -1) {
    return null;
  }

  const trailing = tokens.slice(sectorIndex + 1).map((token) => token.replace(/[()]/g, ""));
  const dayPositions = trailing.flatMap((token, index) => (DAY_CODES.has(token) ? [index] : []));
  if (dayPositions.length < 2) {
    return null;
  }

  const firstDayIndex = dayPositions[0];
  const report = firstDayIndex > 0 && /^\d{4}$/.test(trailing[firstDayIndex - 1]) ? trailing[firstDayIndex - 1] : null;

  const departureDay = trailing[firstDayIndex];
  const departureTime = trailing[firstDayIndex + 1];
  const arrivalDay = trailing[firstDayIndex + 3];
  const arrivalTime = trailing[firstDayIndex + 4];
  if (!/^\d{4}$/.test(departureTime || "") || !/^\d{4}$/.test(arrivalTime || "")) {
    return null;
  }

  return {
    service: tokens[0],
    origin: sectorMatch[1],
    destination: sectorMatch[2],
    report,
    departureDay,
    departureTime,
    arrivalDay,
    arrivalTime,
  };
}

function buildDutyWindows(calendar, patterns) {
  const portWindows = [];
  const unresolvedDuties = [];
  const trips = [];

  const seenThrough = new Map();
  for (const entry of calendar) {
    const info = classifyNonFlyingDuty(entry);
    if (info?.assumeHome || info?.kind === "leave" || info?.kind === "reserve") continue;
    const pattern = patterns.get(entry.dutyCode);
    if (!pattern || !pattern.flights.length) {
      if (!info) unresolvedDuties.push({ ...entry, uncertainty: "No matching flight pattern or recognised non-flying duty." });
      continue;
    }
    if (seenThrough.get(entry.dutyCode) >= entry.date.getTime()) continue;
    const instantiated = instantiatePattern(entry.date, pattern);
    if (!instantiated.length) { unresolvedDuties.push(entry); continue; }
    seenThrough.set(entry.dutyCode, instantiated.at(-1).arrivalDateTime.getTime());
    trips.push({ code: pattern.code, anchorDate: entry.date, legs: instantiated.map(leg => ({ ...leg.flight, departureDateTime: leg.departureDateTime, arrivalDateTime: leg.arrivalDateTime })) });

    instantiated.forEach((leg, index) => {
      const { departureDateTime, arrivalDateTime, flight } = leg;
      if (flight.origin === flight.destination && !calendar.some(row => classifyNonFlyingDuty(row) && row.dutyCode === flight.service && formatSortableLocalDate(row.date) === formatSortableLocalDate(departureDateTime))) {
        portWindows.push({ start: departureDateTime, end: arrivalDateTime, port: flight.origin, dutyCode: `${flight.service} (on duty)`, matchType: "ground_duty", onDuty: true, dutyLabel: flight.service });
      }

      if (index + 1 < instantiated.length) {
        const nextLeg = instantiated[index + 1];
        if (flight.destination === nextLeg.flight.origin && nextLeg.departureDateTime > arrivalDateTime) {
          portWindows.push({
            start: arrivalDateTime,
            end: nextLeg.departureDateTime,
            port: flight.destination,
            dutyCode: pattern.code,
            matchType: "in_port",
          });
        }
      }
    });
  }

  return { portWindows, unresolvedDuties, trips };
}

function instantiatePattern(anchorDate, pattern) {
  const instantiated = [];
  let cursorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate());

  for (const flight of pattern.flights) {
    const departureDate = nextMatchingWeekday(cursorDate, flight.departureDay);
    const arrivalDayDelta = weekdayDelta(flight.departureDay, flight.arrivalDay);
    const arrivalDate = addDays(departureDate, arrivalDayDelta);
    const departureDateTime = combineDateTime(departureDate, flight.departureTime);
    let arrivalDateTime = combineDateTime(arrivalDate, flight.arrivalTime);
    if (arrivalDayDelta > 0 && arrivalDateTime < departureDateTime) {
      arrivalDateTime = new Date(arrivalDateTime.getTime() + 24 * 60 * 60 * 1000);
    }
    instantiated.push({ departureDateTime, arrivalDateTime, flight });
    cursorDate = new Date(arrivalDateTime.getFullYear(), arrivalDateTime.getMonth(), arrivalDateTime.getDate());
  }

  return instantiated;
}

function nextMatchingWeekday(startDate, targetDayCode) {
  const targetWeekday = DAY_CODES.get(targetDayCode);
  const currentWeekday = jsWeekdayToIso(startDate.getDay());
  const delta = (targetWeekday - currentWeekday + 7) % 7;
  return new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + delta);
}

function weekdayDelta(departureDayCode, arrivalDayCode) {
  const departureWeekday = DAY_CODES.get(departureDayCode);
  const arrivalWeekday = DAY_CODES.get(arrivalDayCode);
  return (arrivalWeekday - departureWeekday + 7) % 7;
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function combineDateTime(date, timeText) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Number(timeText.slice(0, 2)),
    Number(timeText.slice(2, 4))
  );
}

function jsWeekdayToIso(jsDay) {
  return jsDay === 0 ? 7 : jsDay;
}

function compareDaysOff(rosterA, rosterB) {
  return compareGroupDaysOff([rosterA, rosterB]).map(genericMatchToLegacyMatch);
}

function compareReserveDays(rosterA, rosterB, thresholdMs = DEFAULT_PORT_MATCH_WINDOW_MS) {
  const matches = [];
  for (const [reserveRoster, offRoster, reserveIndex] of [[rosterA, rosterB, 0], [rosterB, rosterA, 1]]) {
    for (const reserve of reserveRoster.portWindows.filter(window => window.matchType === "home_reserve")) {
      for (const off of comparisonWindows(offRoster).filter(window => window.assumed && window.port === reserve.port)) {
        const start = new Date(Math.max(reserve.start.getTime(), off.start.getTime()));
        const end = new Date(Math.min(reserve.end.getTime(), off.end.getTime()));
        if (end - start < thresholdMs) continue;
        const participants = [{ label: reserve.dutyCode, window: formatWindow(reserve.start, reserve.end) }, { label: off.dutyCode, window: formatWindow(off.start, off.end) }];
        if (reserveIndex) participants.reverse();
        matches.push({ date: formatDisplayLocalDate(start), sort_date: formatSortableLocalDate(start), port: reserve.port,
          match_type: reserve.port === reserveRoster.base ? "Reserve at base" : "Standby / reserve in port", match_key: "reserve_at_base",
          overlap_window: formatWindow(start, end), crew_a: participants[0].label, window_a: participants[0].window,
          crew_b: participants[1].label, window_b: participants[1].window, visual_group: "home_match" });
      }
    }
  }
  return dedupeMatches(matches);
}

function comparePortMatches(rosterA, rosterB, portMatchWindowMs = DEFAULT_PORT_MATCH_WINDOW_MS) {
  const matches = [];

  for (const windowA of rosterA.portWindows) {
    for (const windowB of rosterB.portWindows) {
      if (windowA.port !== windowB.port) {
        continue;
      }

      const overlapStart = Math.max(windowA.start.getTime(), windowB.start.getTime());
      const overlapEnd = Math.min(windowA.end.getTime(), windowB.end.getTime());
      if (overlapEnd - overlapStart < portMatchWindowMs) {
        continue;
      }

      const overlapDate = new Date(overlapStart);
      matches.push({
        date: formatDisplayLocalDate(overlapDate),
        sort_date: formatSortableLocalDate(overlapDate),
        port: windowA.port,
        match_type: "Port match",
        match_key: "port_match",
        overlap_window: formatWindow(new Date(overlapStart), new Date(overlapEnd)),
        crew_a: windowA.dutyCode,
        crew_b: windowB.dutyCode,
        window_a: formatWindow(windowA.start, windowA.end),
        window_b: formatWindow(windowB.start, windowB.end),
        visual_group: "away_port",
      });
    }
  }

  return dedupeMatches(matches);
}

function dedupeMatches(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = JSON.stringify(match);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildSummary(roster) {
  return {
    crew_name: roster.crewName,
    display_name: roster.displayName,
    staff_number: roster.staffNumber,
    base: roster.base,
    domicile: homePort(roster),
    coverage_start: roster.coverageStart ? formatDisplayLocalDate(roster.coverageStart) : null,
    coverage_end: roster.coverageEnd ? formatDisplayLocalDate(roster.coverageEnd) : null,
    bid_period: roster.bidPeriod,
    source: roster.source,
    file_name: roster.fileName,
    off_days: roster.offDays.length,
    resolved_patterns: roster.portWindows.length,
    unresolved_duties: roster.unresolvedDuties.map((entry) => ({
      date: formatDisplayLocalDate(entry.date),
      duty_code: entry.dutyCode,
      label: entry.dutyInfo?.label || entry.dutyCode,
      reason: entry.uncertainty || "Duty details are incomplete.",
    })),
    preview: roster.preview,
  };
}

function buildNotes(rosterA, rosterB) {
  const notes = [];
  if (rosterA.unresolvedDuties.length) {
    notes.push(`${rosterA.crewName}: ${rosterA.unresolvedDuties.length} duty entries were treated as uncertain.`);
  }
  if (rosterB.unresolvedDuties.length) {
    notes.push(`${rosterB.crewName}: ${rosterB.unresolvedDuties.length} duty entries were treated as uncertain.`);
  }
  if (homePort(rosterA) !== homePort(rosterB)) {
    notes.push(`Domiciles differ (${homePort(rosterA) || "?"} vs ${homePort(rosterB) || "?"}), so shared days off may not mean the same physical port.`);
  }
  const overlapStart = Math.max(rosterA.coverageStart?.getTime() || 0, rosterB.coverageStart?.getTime() || 0);
  const overlapEnd = Math.min(rosterA.coverageEnd?.getTime() || 0, rosterB.coverageEnd?.getTime() || 0);
  if (rosterA.coverageStart && rosterA.coverageEnd && rosterB.coverageStart && rosterB.coverageEnd) {
    if (overlapStart > overlapEnd) {
      notes.push(
        `Roster date coverage does not overlap (${formatCoverageRange(rosterA)} vs ${formatCoverageRange(rosterB)}), so dates outside each roster's range are treated as unavailable.`
      );
    } else if (
      rosterA.coverageStart.getTime() !== rosterB.coverageStart.getTime() ||
      rosterA.coverageEnd.getTime() !== rosterB.coverageEnd.getTime()
    ) {
      notes.push(
        `Roster coverage differs (${formatCoverageRange(rosterA)} vs ${formatCoverageRange(rosterB)}). Dates outside a roster's range are treated as unavailable, which is expected for short-haul rosters.`
      );
    }
  }
  if (!notes.length) {
    notes.push("No additional caveats.");
  }
  return notes;
}

function buildGroupNotes(rosters) {
  if (rosters.length === 2) {
    return buildNotes(rosters[0], rosters[1]);
  }

  const notes = [];
  for (const roster of rosters) {
    if (roster.unresolvedDuties.length) {
      notes.push(`${roster.crewName}: ${roster.unresolvedDuties.length} duty entries were treated as uncertain.`);
    }
  }

  const bases = rosters.map((roster) => homePort(roster) || "?");
  if (new Set(bases).size > 1) {
    notes.push(`Domiciles differ (${bases.join(" vs ")}), so shared home-based availability may not mean the same physical port.`);
  }

  const overlapStart = Math.max(...rosters.map((roster) => roster.coverageStart?.getTime() || 0));
  const overlapEnd = Math.min(...rosters.map((roster) => roster.coverageEnd?.getTime() || 0));
  const ranges = rosters.map((roster) => formatCoverageRange(roster));
  if (rosters.every((roster) => roster.coverageStart && roster.coverageEnd)) {
    if (overlapStart > overlapEnd) {
      notes.push(
        `Roster date coverage does not overlap across all ${rosters.length} rosters (${ranges.join(" vs ")}), so dates outside each roster's range are treated as unavailable.`
      );
    } else if (
      new Set(rosters.map((roster) => `${roster.coverageStart.getTime()}-${roster.coverageEnd.getTime()}`)).size > 1
    ) {
      notes.push(
        `Roster coverage differs (${ranges.join(" vs ")}). Dates outside a roster's range are treated as unavailable, which is expected when mixing short-haul and longer rosters.`
      );
    }
  }

  if (!notes.length) {
    notes.push("No additional caveats.");
  }
  return notes;
}

function buildDateParts(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return { day, month, hours, minutes };
}

function formatSortableLocalDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDisplayLocalDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function formatWindow(start, end) {
  const startParts = buildDateParts(start);
  const endParts = buildDateParts(end);
  return `${startParts.day}/${startParts.month} ${startParts.hours}:${startParts.minutes} to ${endParts.day}/${endParts.month} ${endParts.hours}:${endParts.minutes}`;
}

function formatHomePort(baseA, baseB) {
  return baseA && baseA === baseB ? baseA : `${baseA || "?"} / ${baseB || "?"}`;
}

function formatCombinedPort(ports) {
  return new Set(ports.filter(Boolean)).size === 1 ? ports[0] : ports.map((port) => port || "?").join(" / ");
}

function formatCoverageRange(roster) {
  return `${formatDisplayLocalDate(roster.coverageStart)} to ${formatDisplayLocalDate(roster.coverageEnd)}`;
}

function differenceInDays(left, right) {
  const utcLeft = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const utcRight = Date.UTC(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.round((utcLeft - utcRight) / (24 * 60 * 60 * 1000));
}
