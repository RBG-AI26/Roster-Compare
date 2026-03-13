const OFF_DUTY_CODES = new Set(["A", "X", "AL", "GL", "LSL"]);
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
    const dateSort = left.date.localeCompare(right.date);
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
  const crewName = matchGroup(text, /Name:\s+([A-Z][A-Z\s'\-]+?)\s+Staff No:/m) || "Unknown";
  const staffNumber = matchGroup(text, /Staff No:\s*(\d+)/m);
  const base = matchGroup(text, /Base:\s*([A-Z]{3})/m);
  const bidPeriod = matchGroup(text, /BID PERIOD\s+(\d+)/m);
  const source = detectSource(fileName, text);
  const generationDate = extractGenerationDate(text);
  const calendar = parseCalendarEntries(text, generationDate);
  const patterns = parsePatternDefinitions(text);

  if (!calendar.length) {
    throw new Error("No calendar entries could be parsed from the roster.");
  }

  const offDays = calendar.filter((entry) => OFF_DUTY_CODES.has(entry.dutyCode));
  const { portWindows, touchpoints, unresolvedDuties } = buildDutyWindows(calendar, patterns);

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
    touchpoints,
    unresolvedDuties,
    preview: text.split("\n").slice(0, 20).join("\n"),
  };
}

function normalizeText(rawText) {
  return rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectSource(fileName, text) {
  const loweredName = fileName.toLowerCase();
  const loweredText = text.toLowerCase();
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
  const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(monthText);
  return new Date(Number(year), monthIndex, Number(day));
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
  const touchpoints = [];
  const unresolvedDuties = [];

  for (const group of groupCalendarDuties(calendar)) {
    if (OFF_DUTY_CODES.has(group[0].dutyCode)) {
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
      touchpoints.push({
        start: departureDateTime,
        end: departureDateTime,
        port: flight.origin,
        dutyCode: pattern.code,
        matchType: "departure",
      });
      touchpoints.push({
        start: arrivalDateTime,
        end: arrivalDateTime,
        port: flight.destination,
        dutyCode: pattern.code,
        matchType: "arrival",
      });

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

  return { portWindows, touchpoints, unresolvedDuties };
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
  const byDate = new Map(rosterB.offDays.map((entry) => [formatIsoLocalDate(entry.date), entry]));
  const matches = [];

  for (const entryA of rosterA.offDays) {
    const key = formatIsoLocalDate(entryA.date);
    const entryB = byDate.get(key);
    if (!entryB) {
      continue;
    }

    matches.push({
      date: key,
      port: rosterA.base && rosterA.base === rosterB.base ? rosterA.base : `${rosterA.base || "?"} / ${rosterB.base || "?"}`,
      match_type: "Shared day off",
      match_key: "shared_day_off",
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
  const overlapKeys = new Set();

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

      const date = formatIsoLocalDate(new Date(overlapStart));
      overlapKeys.add(buildPortKey(date, windowA.port, windowA.dutyCode, windowB.dutyCode));
      matches.push({
        date,
        port: windowA.port,
        match_type: "Port match",
        match_key: "port_match",
        crew_a: windowA.dutyCode,
        crew_b: windowB.dutyCode,
        window_a: formatWindow(windowA.start, windowA.end),
        window_b: formatWindow(windowB.start, windowB.end),
        visual_group: "away_port",
      });
    }
  }

  for (const pointA of rosterA.touchpoints) {
    for (const pointB of rosterB.touchpoints) {
      if (pointA.port !== pointB.port || pointA.matchType === pointB.matchType) {
        continue;
      }

      const delta = Math.abs(pointA.start.getTime() - pointB.start.getTime());
      if (delta > portMatchWindowMs) {
        continue;
      }

      const date = formatIsoLocalDate(new Date(Math.min(pointA.start.getTime(), pointB.start.getTime())));
      if (overlapKeys.has(buildPortKey(date, pointA.port, pointA.dutyCode, pointB.dutyCode))) {
        continue;
      }

      matches.push({
        date,
        port: pointA.port,
        match_type: "Port match",
        match_key: "port_match",
        crew_a: `${pointA.dutyCode} ${pointA.matchType}`,
        crew_b: `${pointB.dutyCode} ${pointB.matchType}`,
        window_a: formatPoint(pointA.start),
        window_b: formatPoint(pointB.start),
        visual_group: "away_port",
      });
    }
  }
  return dedupeMatches(matches);
}

function buildPortKey(date, port, crewADuty, crewBDuty) {
  return [date, port, crewADuty, crewBDuty].join("|");
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
      date: formatIsoLocalDate(entry.date),
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

function formatIsoLocalDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatWindow(start, end) {
  const startParts = buildDateParts(start);
  const endParts = buildDateParts(end);
  return `${startParts.day}/${startParts.month} ${startParts.hours}:${startParts.minutes} to ${endParts.day}/${endParts.month} ${endParts.hours}:${endParts.minutes}`;
}

function formatPoint(date) {
  const parts = buildDateParts(date);
  return `${parts.day}/${parts.month} ${parts.hours}:${parts.minutes}`;
}

function differenceInDays(left, right) {
  const utcLeft = Date.UTC(left.getFullYear(), left.getMonth(), left.getDate());
  const utcRight = Date.UTC(right.getFullYear(), right.getMonth(), right.getDate());
  return Math.round((utcLeft - utcRight) / (24 * 60 * 60 * 1000));
}
