const LONG_HAUL_OFF_DUTY_CODES = new Set(["A", "X", "AL", "GL", "LSL"]);
const SHORT_HAUL_OFF_DUTY_CODES = new Set(["D/O", "LA"]);
const SHORT_HAUL_RESERVE_DUTY_REGEX = /^R[A-Z0-9]*$/i;
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
]);

export function compareRosterTexts(crewAFile, crewAText, crewBFile, crewBText, options = {}) {
  const rosterA = parseRosterText(crewAFile, crewAText);
  const rosterB = parseRosterText(crewBFile, crewBText);
  const portMatchWindowMs = Math.max(1, Number(options.minPortOverlapHours || 1)) * 60 * 60 * 1000;
  const matches = [
    ...compareDaysOff(rosterA, rosterB),
    ...comparePortMatches(rosterA, rosterB, portMatchWindowMs),
  ].sort((left, right) => {
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
    crew_a: buildSummary(rosterA),
    crew_b: buildSummary(rosterB),
    matches,
    notes: buildNotes(rosterA, rosterB),
  };
}

export function parseRosterText(fileName, rawText) {
  const text = normalizeText(rawText);
  const metadata = {
    crewName:
      matchGroup(text, /Name\s*:\s*([A-Z][A-Z\s'\-]+?)(?=\s{2,}[A-Za-z][A-Za-z ]*:\s|$)/m) || "Unknown",
    staffNumber: matchGroup(text, /Staff No:\s*(\d+)/m),
    base: matchGroup(text, /Base\s*:\s*([A-Z]{3})/m),
    bidPeriod: matchGroup(text, /Bid Period\s+(\d+)/im),
    source: detectSource(fileName, text),
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

  const offDays = calendar.filter((entry) => LONG_HAUL_OFF_DUTY_CODES.has(entry.dutyCode));
  const { portWindows, unresolvedDuties } = buildDutyWindows(calendar, patterns);

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
    portWindows,
    unresolvedDuties,
    preview: text.split("\n").slice(0, 20).join("\n"),
  });
}

function parseShortHaulRoster(fileName, text, metadata) {
  const detailData = parseShortHaulDetailBlocks(text);
  const calendar = parseShortHaulCalendarEntries(text, detailData.anchorDate || metadata.generationDate);

  if (!calendar.length) {
    throw new Error("No calendar entries could be parsed from the roster.");
  }

  const offDays = calendar.filter((entry) => isShortHaulOffDay(entry.dutyCode));
  const portWindows = buildShortHaulPortWindows(calendar, detailData.blocks, metadata.base);
  const unresolvedDuties = buildShortHaulUnresolvedDuties(calendar, detailData.blocks);

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
  portWindows,
  unresolvedDuties,
  preview,
}) {
  return {
    crewName: crewName.replace(/\s+/g, " ").trim(),
    staffNumber,
    base,
    bidPeriod,
    source,
    fileName,
    calendar,
    patterns,
    offDays,
    portWindows,
    unresolvedDuties,
    coverageStart: calendar.length ? calendar[0].date : null,
    coverageEnd: calendar.length ? calendar[calendar.length - 1].date : null,
    preview,
  };
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
  const legs = [];
  let previousDate = null;

  for (const line of lines) {
    const leg = parseShortHaulLegLine(line, blockDate, previousDate);
    if (!leg) {
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

function parseShortHaulCalendarEntries(text, anchorDate) {
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

  return assignShortHaulCalendarDates(entries, anchorDate);
}

function parseShortHaulCalendarLine(line) {
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

function buildShortHaulPortWindows(calendar, blocks, base) {
  const windows = blocks.flatMap((block) => block.portWindows);

  for (const entry of calendar) {
    if (!isShortHaulReserveDuty(entry.dutyCode) || !entry.report || !entry.end) {
      continue;
    }

    const start = combineDateTime(entry.date, entry.report);
    let end = combineDateTime(entry.date, entry.end);
    if (end < start) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }

    windows.push({
      start,
      end,
      port: base || entry.port || "?",
      dutyCode: entry.dutyCode,
      matchType: "home_reserve",
    });
  }

  return windows;
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
    if (!entry.dutyCode || isShortHaulOffDay(entry.dutyCode) || isShortHaulReserveDuty(entry.dutyCode)) {
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
  return rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  const columns = [[], [], []];
  let capture = false;
  const lineRegex = /(?<date>\d{2}\/\d{2})\s+(?<dow>[MTWFSU])\s+(?<duty>[A-Z0-9]+)(?<rest>.*)/;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");

    if (line.startsWith("Date") && line.includes("Duty") && line.includes("Detail")) {
      capture = true;
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
      columns[Math.min(index, 2)].push({
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
    detail: nonTimeTokens[0] || null,
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

  for (const group of groupCalendarDuties(calendar)) {
    if (LONG_HAUL_OFF_DUTY_CODES.has(group[0].dutyCode)) {
      continue;
    }

    const pattern = patterns.get(group[0].dutyCode);
    if (!pattern || !pattern.flights.length) {
      unresolvedDuties.push(group[0]);
      continue;
    }

    const instantiated = instantiatePattern(group[0].date, pattern);
    if (!instantiated.length) {
      unresolvedDuties.push(group[0]);
      continue;
    }

    instantiated.forEach((leg, index) => {
      const { departureDateTime, arrivalDateTime, flight } = leg;

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

  return { portWindows, unresolvedDuties };
}

function groupCalendarDuties(calendar) {
  const groups = [];
  let currentGroup = [];

  for (const entry of calendar) {
    if (!currentGroup.length) {
      currentGroup = [entry];
      continue;
    }

    const previous = currentGroup[currentGroup.length - 1];
    if (
      entry.dutyCode === previous.dutyCode &&
      differenceInDays(entry.date, previous.date) === 1
    ) {
      currentGroup.push(entry);
      continue;
    }

    groups.push(currentGroup);
    currentGroup = [entry];
  }

  if (currentGroup.length) {
    groups.push(currentGroup);
  }

  return groups;
}

function instantiatePattern(anchorDate, pattern) {
  const instantiated = [];
  let cursorDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate());

  for (const flight of pattern.flights) {
    const departureDate = nextMatchingWeekday(cursorDate, flight.departureDay);
    const arrivalDate = resolveArrivalDate(departureDate, flight.departureDay, flight.arrivalDay);
    const departureDateTime = combineDateTime(departureDate, flight.departureTime);
    let arrivalDateTime = combineDateTime(arrivalDate, flight.arrivalTime);
    if (arrivalDateTime < departureDateTime) {
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

function resolveArrivalDate(departureDate, departureDayCode, arrivalDayCode) {
  const departureWeekday = DAY_CODES.get(departureDayCode);
  const arrivalWeekday = DAY_CODES.get(arrivalDayCode);
  const delta = (arrivalWeekday - departureWeekday + 7) % 7;
  return new Date(departureDate.getFullYear(), departureDate.getMonth(), departureDate.getDate() + delta);
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
  const byDate = new Map(rosterB.offDays.map((entry) => [formatSortableLocalDate(entry.date), entry]));
  const matches = [];

  for (const entryA of rosterA.offDays) {
    const key = formatSortableLocalDate(entryA.date);
    const entryB = byDate.get(key);
    if (!entryB) {
      continue;
    }

    matches.push({
      date: formatDisplayLocalDate(entryA.date),
      sort_date: key,
      port: rosterA.base && rosterA.base === rosterB.base ? rosterA.base : `${rosterA.base || "?"} / ${rosterB.base || "?"}`,
      match_type: "Shared day off",
      match_key: "shared_day_off",
      overlap_window: "All day",
      crew_a: `${entryA.dutyCode} (${rosterA.base || "base unknown"})`,
      crew_b: `${entryB.dutyCode} (${rosterB.base || "base unknown"})`,
      window_a: "All day",
      window_b: "All day",
      visual_group: "home_match",
    });
  }

  return matches;
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
    staff_number: roster.staffNumber,
    base: roster.base,
    bid_period: roster.bidPeriod,
    source: roster.source,
    file_name: roster.fileName,
    off_days: roster.offDays.length,
    resolved_patterns: roster.portWindows.length,
    unresolved_duties: roster.unresolvedDuties.map((entry) => ({
      date: formatDisplayLocalDate(entry.date),
      duty_code: entry.dutyCode,
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
  if (rosterA.base !== rosterB.base) {
    notes.push(`Home bases differ (${rosterA.base || "?"} vs ${rosterB.base || "?"}), so shared days off may not mean the same physical port.`);
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

function formatCoverageRange(roster) {
  return `${formatDisplayLocalDate(roster.coverageStart)} to ${formatDisplayLocalDate(roster.coverageEnd)}`;
}

function differenceInDays(left, right) {
  const utcLeft = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const utcRight = Date.UTC(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.round((utcLeft - utcRight) / (24 * 60 * 60 * 1000));
}
