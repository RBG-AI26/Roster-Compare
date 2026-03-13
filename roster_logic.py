from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Dict, Iterable, List, Optional, Tuple


OFF_DUTY_CODES = {"A", "X", "AL", "GL", "LSL"}
SOURCE_PRIORITY = {"arms": 0, "webcis": 1, "email_pdf": 2, "unknown": 3}
DAY_CODES = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}
HEADER_DAY_CODES = {
    "M": 0,
    "T": 1,
    "W": 2,
    "T?": 3,
    "F": 4,
    "S": 5,
    "U": 6,
}
BRIEF_PORT_THRESHOLD = dt.timedelta(hours=2)
MIN_PORT_OVERLAP = dt.timedelta(hours=1)


@dataclass
class CalendarEntry:
    date: dt.date
    roster_day: str
    duty_code: str
    detail: Optional[str] = None
    report: Optional[str] = None
    end: Optional[str] = None
    credit: Optional[str] = None


@dataclass
class FlightLeg:
    service: str
    origin: str
    destination: str
    report: Optional[str]
    departure_day: str
    departure_time: str
    arrival_day: str
    arrival_time: str


@dataclass
class PatternDefinition:
    code: str
    route_code: Optional[str] = None
    days_away: Optional[int] = None
    flights: List[FlightLeg] = field(default_factory=list)


@dataclass
class DutyWindow:
    start: dt.datetime
    end: dt.datetime
    port: str
    duty_code: str
    match_type: str


@dataclass
class Roster:
    crew_name: str
    staff_number: Optional[str]
    base: Optional[str]
    bid_period: Optional[str]
    source: str
    file_name: str
    calendar: List[CalendarEntry]
    patterns: Dict[str, PatternDefinition]
    off_days: List[CalendarEntry]
    port_windows: List[DutyWindow]
    touchpoints: List[DutyWindow]
    unresolved_duties: List[CalendarEntry]
    extracted_text_preview: str


class RosterParseError(Exception):
    pass


def detect_source(file_name: str, text: str) -> str:
    lowered_name = file_name.lower()
    lowered_text = text.lower()

    if "webcis" in lowered_name or "webcis" in lowered_text:
        return "webcis"
    if "arms" in lowered_text and "operations roster for bid period" in lowered_text:
        return "arms"
    if file_name.lower().endswith(".pdf"):
        return "email_pdf"
    return "unknown"


def extract_text_from_file(file_path: Path, extractor_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix == ".txt":
        return file_path.read_text(encoding="utf-8", errors="replace")
    if suffix == ".pdf":
        result = subprocess.run(
            [str(extractor_path), str(file_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout
    raise RosterParseError(f"Unsupported file type: {file_path.suffix}")


def compile_pdf_extractor(project_root: Path) -> Path:
    binary_path = project_root / "pdf_extract"
    source_path = project_root / "pdf_extract.m"
    if binary_path.exists() and binary_path.stat().st_mtime >= source_path.stat().st_mtime:
        return binary_path

    subprocess.run(
        [
            "clang",
            "-fobjc-arc",
            "-framework",
            "Foundation",
            "-framework",
            "PDFKit",
            "-framework",
            "Vision",
            "-framework",
            "AppKit",
            str(source_path),
            "-o",
            str(binary_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return binary_path


def parse_roster_text(file_name: str, text: str) -> Roster:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    source = detect_source(file_name, normalized)

    crew_name = _extract_group(
        normalized,
        r"Name:\s+([A-Z][A-Z\s'\-]+?)\s+Staff No:",
    ) or "Unknown"
    staff_number = _extract_group(normalized, r"Staff No:\s*(\d+)")
    base = _extract_group(normalized, r"Base:\s*([A-Z]{3})")
    bid_period = _extract_group(normalized, r"BID PERIOD\s+(\d+)")
    generation_date = _extract_generation_date(normalized)
    calendar = _parse_calendar_entries(normalized, generation_date)
    patterns = _parse_pattern_definitions(normalized)

    if not calendar:
        raise RosterParseError("No calendar entries could be parsed from the roster.")

    off_days = [entry for entry in calendar if entry.duty_code in OFF_DUTY_CODES]
    port_windows, touchpoints, unresolved_duties = _build_duty_windows(calendar, patterns)

    return Roster(
        crew_name=" ".join(crew_name.split()),
        staff_number=staff_number,
        base=base,
        bid_period=bid_period,
        source=source,
        file_name=file_name,
        calendar=calendar,
        patterns=patterns,
        off_days=off_days,
        port_windows=port_windows,
        touchpoints=touchpoints,
        unresolved_duties=unresolved_duties,
        extracted_text_preview="\n".join(normalized.splitlines()[:20]),
    )


def choose_best_roster(parsed_rosters: Iterable[Roster]) -> Roster:
    rosters = list(parsed_rosters)
    if not rosters:
        raise RosterParseError("No roster files could be parsed.")

    rosters.sort(
        key=lambda roster: (
            SOURCE_PRIORITY.get(roster.source, 9),
            len(roster.unresolved_duties),
            -len(roster.port_windows),
        )
    )
    return rosters[0]


def compare_rosters(roster_a: Roster, roster_b: Roster) -> Dict[str, object]:
    matches = []
    matches.extend(_compare_days_off(roster_a, roster_b))
    matches.extend(_compare_port_windows(roster_a, roster_b))
    matches.extend(_compare_touchpoints(roster_a, roster_b))

    matches.sort(
        key=lambda item: (
            item["date"],
            item["match_type"],
            item["port"],
        )
    )

    return {
        "crew_a": _roster_summary(roster_a),
        "crew_b": _roster_summary(roster_b),
        "matches": matches,
        "notes": _build_notes(roster_a, roster_b),
    }


def process_uploads(uploaded_files: Dict[str, List[Tuple[str, bytes]]], project_root: Path) -> Dict[str, object]:
    extractor_path = compile_pdf_extractor(project_root)
    parsed_by_side: Dict[str, List[Roster]] = {"crew_a": [], "crew_b": []}
    errors: List[str] = []

    with TemporaryDirectory() as temp_dir:
        temp_root = Path(temp_dir)
        for side in ("crew_a", "crew_b"):
            for file_name, file_bytes in uploaded_files.get(side, []):
                file_path = temp_root / f"{side}_{Path(file_name).name}"
                file_path.write_bytes(file_bytes)

                try:
                    text = extract_text_from_file(file_path, extractor_path)
                    parsed = parse_roster_text(file_name, text)
                    parsed_by_side[side].append(parsed)
                except Exception as exc:
                    errors.append(f"{side}: {file_name}: {exc}")

    if not parsed_by_side["crew_a"] or not parsed_by_side["crew_b"]:
        raise RosterParseError(
            "At least one roster for each crew must parse successfully. "
            + (" Errors: " + " | ".join(errors) if errors else "")
        )

    roster_a = choose_best_roster(parsed_by_side["crew_a"])
    roster_b = choose_best_roster(parsed_by_side["crew_b"])
    result = compare_rosters(roster_a, roster_b)
    result["parse_errors"] = errors
    result["selected_sources"] = {
        "crew_a": roster_a.source,
        "crew_b": roster_b.source,
    }
    return result


def _extract_group(text: str, pattern: str) -> Optional[str]:
    match = re.search(pattern, text, flags=re.MULTILINE)
    return match.group(1).strip() if match else None


def _extract_generation_date(text: str) -> dt.date:
    for pattern in (
        r"(\d{2}\s+[A-Z][a-z]{2}\s+\d{4})\s+\d{2}:\d{2}",
        r"Date:\s+\d{2}\s+[A-Z][a-z]{2}\s+\d{4}",
    ):
        match = re.search(pattern, text)
        if match:
            raw_value = match.group(1) if match.lastindex else match.group(0).split("Date:")[-1].strip()
            return dt.datetime.strptime(raw_value, "%d %b %Y").date()
    return dt.date.today()


def _parse_calendar_entries(text: str, generation_date: dt.date) -> List[CalendarEntry]:
    columns: List[List[Tuple[str, str, str, Optional[str], Optional[str], Optional[str], Optional[str]]]] = [[], [], []]
    capture = False
    line_re = re.compile(r"(?P<date>\d{2}/\d{2})\s+(?P<dow>[MTWFSU])\s+(?P<duty>[A-Z0-9]+)(?P<rest>.*)")

    for raw_line in text.splitlines():
        line = raw_line.rstrip()

        if line.startswith("Date") and "Duty" in line and "Detail" in line:
            capture = True
            continue
        if capture and ("Carry Out" in line or "END OF REPORT" in line):
            break
        if not capture or not re.search(r"\d{2}/\d{2}", line):
            continue

        segments = [segment for segment in line.split("|") if re.search(r"\d{2}/\d{2}", segment)]
        if not segments:
            segments = [line]

        for index, segment in enumerate(segments):
            match = line_re.search(segment.strip())
            if not match:
                continue
            rest = match.group("rest").strip()
            detail, report, end, credit = _parse_calendar_rest(rest)
            target_column = min(index, len(columns) - 1)
            columns[target_column].append(
                (
                    match.group("date"),
                    match.group("dow"),
                    match.group("duty"),
                    detail,
                    report,
                    end,
                    credit,
                )
            )

    entries = [item for column in columns for item in column]
    return _assign_calendar_years(entries, generation_date)


def _parse_calendar_rest(rest: str) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    if not rest:
        return None, None, None, None

    tokens = rest.split()
    credit = None
    if tokens and re.fullmatch(r"\d{1,3}:\d{2}", tokens[-1]):
        credit = tokens.pop()

    time_tokens = [token for token in tokens if re.fullmatch(r"\d{4}", token)]
    non_time_tokens = [token for token in tokens if not re.fullmatch(r"\d{4}", token)]

    detail = non_time_tokens[0] if non_time_tokens else None
    report = time_tokens[0] if time_tokens else None
    end = time_tokens[1] if len(time_tokens) > 1 else None
    return detail, report, end, credit


def _assign_calendar_years(
    entries: List[Tuple[str, str, str, Optional[str], Optional[str], Optional[str], Optional[str]]],
    generation_date: dt.date,
) -> List[CalendarEntry]:
    if not entries:
        return []

    parsed_entries: List[CalendarEntry] = []
    first_month = int(entries[0][0].split("/")[1])
    current_year = generation_date.year - 1 if first_month - generation_date.month > 6 else generation_date.year
    previous_month = first_month

    for date_str, dow, duty, detail, report, end, credit in entries:
        day_str, month_str = date_str.split("/")
        month = int(month_str)
        if month < previous_month:
            current_year += 1
        previous_month = month
        parsed_entries.append(
            CalendarEntry(
                date=dt.date(current_year, month, int(day_str)),
                roster_day=dow,
                duty_code=duty,
                detail=detail,
                report=report,
                end=end,
                credit=credit,
            )
        )

    return parsed_entries


def _parse_pattern_definitions(text: str) -> Dict[str, PatternDefinition]:
    lines = text.splitlines()
    patterns: Dict[str, PatternDefinition] = {}
    current: Optional[PatternDefinition] = None

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        pattern_match = re.search(r"Pattern:\s*([A-Z0-9]+)", line)
        if pattern_match:
            code = pattern_match.group(1)
            route_code = _extract_group(line, r"Route Code:\s*([A-Z0-9]+)") if "Route Code:" in line else None
            days_away = None
            days_match = re.search(r"Days Away:\s*(\d+)", line)
            if days_match:
                days_away = int(days_match.group(1))
            current = PatternDefinition(code=code, route_code=route_code, days_away=days_away)
            patterns[code] = current
            continue

        if current is None:
            continue

        if line.startswith("---") or line.startswith("Regards,"):
            current = None
            continue

        route_match = re.search(r"Route Code:\s*([A-Z0-9]+)", line)
        if route_match and current.route_code is None:
            current.route_code = route_match.group(1)

        days_match = re.search(r"Days Away:\s*(\d+)", line)
        if days_match and current.days_away is None:
            current.days_away = int(days_match.group(1))

        flight = _parse_flight_line(line)
        if flight:
            current.flights.append(flight)

    return patterns


def _parse_flight_line(line: str) -> Optional[FlightLeg]:
    sector_match = re.search(r"\b([A-Z]{3})/([A-Z]{3})\b", line)
    if not sector_match:
        return None

    tokens = line.split()
    service = tokens[0]
    sector_token = sector_match.group(0)
    try:
        sector_index = tokens.index(sector_token)
    except ValueError:
        return None

    trailing = [token.strip("()") for token in tokens[sector_index + 1 :]]
    day_positions = [idx for idx, token in enumerate(trailing) if token in DAY_CODES]
    if len(day_positions) < 2:
        return None

    first_day_idx = day_positions[0]
    report = trailing[first_day_idx - 1] if first_day_idx > 0 and re.fullmatch(r"\d{4}", trailing[first_day_idx - 1]) else None

    try:
        departure_day = trailing[first_day_idx]
        departure_time = trailing[first_day_idx + 1]
        arrival_day = trailing[first_day_idx + 3]
        arrival_time = trailing[first_day_idx + 4]
    except IndexError:
        return None

    if not re.fullmatch(r"\d{4}", departure_time) or not re.fullmatch(r"\d{4}", arrival_time):
        return None

    return FlightLeg(
        service=service,
        origin=sector_match.group(1),
        destination=sector_match.group(2),
        report=report,
        departure_day=departure_day,
        departure_time=departure_time,
        arrival_day=arrival_day,
        arrival_time=arrival_time,
    )


def _build_duty_windows(
    calendar: List[CalendarEntry],
    patterns: Dict[str, PatternDefinition],
) -> Tuple[List[DutyWindow], List[DutyWindow], List[CalendarEntry]]:
    port_windows: List[DutyWindow] = []
    touchpoints: List[DutyWindow] = []
    unresolved: List[CalendarEntry] = []

    for group in _group_calendar_duties(calendar):
        if group[0].duty_code in OFF_DUTY_CODES:
            continue

        pattern = patterns.get(group[0].duty_code)
        if not pattern or not pattern.flights:
            unresolved.append(group[0])
            continue

        instantiated = _instantiate_pattern(group[0].date, pattern)
        if not instantiated:
            unresolved.append(group[0])
            continue

        for index, leg in enumerate(instantiated):
            departure_dt, arrival_dt, flight = leg
            touchpoints.append(
                DutyWindow(
                    start=departure_dt,
                    end=departure_dt,
                    port=flight.origin,
                    duty_code=pattern.code,
                    match_type="departure",
                )
            )
            touchpoints.append(
                DutyWindow(
                    start=arrival_dt,
                    end=arrival_dt,
                    port=flight.destination,
                    duty_code=pattern.code,
                    match_type="arrival",
                )
            )

            if index + 1 < len(instantiated):
                next_departure_dt, _, next_flight = instantiated[index + 1]
                if flight.destination == next_flight.origin and next_departure_dt > arrival_dt:
                    port_windows.append(
                        DutyWindow(
                            start=arrival_dt,
                            end=next_departure_dt,
                            port=flight.destination,
                            duty_code=pattern.code,
                            match_type="layover",
                        )
                    )

    return port_windows, touchpoints, unresolved


def _group_calendar_duties(calendar: List[CalendarEntry]) -> List[List[CalendarEntry]]:
    groups: List[List[CalendarEntry]] = []
    current_group: List[CalendarEntry] = []

    for entry in calendar:
        if not current_group:
            current_group = [entry]
            continue

        previous = current_group[-1]
        if (
            entry.duty_code == previous.duty_code
            and entry.date == previous.date + dt.timedelta(days=1)
        ):
            current_group.append(entry)
        else:
            groups.append(current_group)
            current_group = [entry]

    if current_group:
        groups.append(current_group)
    return groups


def _instantiate_pattern(
    anchor_date: dt.date,
    pattern: PatternDefinition,
) -> List[Tuple[dt.datetime, dt.datetime, FlightLeg]]:
    instantiated: List[Tuple[dt.datetime, dt.datetime, FlightLeg]] = []
    cursor_date = anchor_date

    for flight in pattern.flights:
        departure_date = _next_matching_weekday(cursor_date, flight.departure_day)
        arrival_date = _resolve_arrival_date(departure_date, flight.departure_day, flight.arrival_day)
        departure_dt = _combine_date_time(departure_date, flight.departure_time)
        arrival_dt = _combine_date_time(arrival_date, flight.arrival_time)
        if arrival_dt < departure_dt:
            arrival_dt += dt.timedelta(days=1)
        instantiated.append((departure_dt, arrival_dt, flight))
        cursor_date = arrival_dt.date()

    return instantiated


def _next_matching_weekday(start_date: dt.date, target_day: str) -> dt.date:
    target_weekday = DAY_CODES[target_day]
    delta = (target_weekday - start_date.weekday()) % 7
    return start_date + dt.timedelta(days=delta)


def _resolve_arrival_date(departure_date: dt.date, departure_day: str, arrival_day: str) -> dt.date:
    departure_weekday = DAY_CODES[departure_day]
    arrival_weekday = DAY_CODES[arrival_day]
    delta = (arrival_weekday - departure_weekday) % 7
    return departure_date + dt.timedelta(days=delta)


def _combine_date_time(day: dt.date, time_str: str) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(int(time_str[:2]), int(time_str[2:])))


def _compare_days_off(roster_a: Roster, roster_b: Roster) -> List[Dict[str, str]]:
    off_map_b = {entry.date: entry for entry in roster_b.off_days}
    matches = []

    for entry_a in roster_a.off_days:
        entry_b = off_map_b.get(entry_a.date)
        if not entry_b:
            continue

        same_base = roster_a.base and roster_a.base == roster_b.base
        port = roster_a.base if same_base and roster_a.base else f"{roster_a.base or '?'} / {roster_b.base or '?'}"
        matches.append(
            {
                "date": entry_a.date.isoformat(),
                "port": port,
                "match_type": "Shared day off",
                "crew_a": f"{entry_a.duty_code} ({roster_a.base or 'base unknown'})",
                "crew_b": f"{entry_b.duty_code} ({roster_b.base or 'base unknown'})",
                "window_a": "All day",
                "window_b": "All day",
                "confidence": "high" if same_base else "medium",
            }
        )

    return matches


def _compare_port_windows(roster_a: Roster, roster_b: Roster) -> List[Dict[str, str]]:
    matches = []

    for window_a in roster_a.port_windows:
        for window_b in roster_b.port_windows:
            if window_a.port != window_b.port:
                continue

            overlap_start = max(window_a.start, window_b.start)
            overlap_end = min(window_a.end, window_b.end)
            overlap = overlap_end - overlap_start
            if overlap < MIN_PORT_OVERLAP:
                continue

            matches.append(
                {
                    "date": overlap_start.date().isoformat(),
                    "port": window_a.port,
                    "match_type": "Port overlap",
                    "crew_a": window_a.duty_code,
                    "crew_b": window_b.duty_code,
                    "window_a": _format_window(window_a.start, window_a.end),
                    "window_b": _format_window(window_b.start, window_b.end),
                    "confidence": "high",
                }
            )

    return matches


def _compare_touchpoints(roster_a: Roster, roster_b: Roster) -> List[Dict[str, str]]:
    matches = []

    for point_a in roster_a.touchpoints:
        for point_b in roster_b.touchpoints:
            if point_a.port != point_b.port or point_a.match_type == point_b.match_type:
                continue

            delta = abs(point_a.start - point_b.start)
            if delta > BRIEF_PORT_THRESHOLD:
                continue

            matches.append(
                {
                    "date": min(point_a.start, point_b.start).date().isoformat(),
                    "port": point_a.port,
                    "match_type": "Brief port crossover",
                    "crew_a": f"{point_a.duty_code} {point_a.match_type}",
                    "crew_b": f"{point_b.duty_code} {point_b.match_type}",
                    "window_a": point_a.start.strftime("%d/%m %H:%M"),
                    "window_b": point_b.start.strftime("%d/%m %H:%M"),
                    "confidence": "medium",
                }
            )

    return matches


def _format_window(start: dt.datetime, end: dt.datetime) -> str:
    return f"{start.strftime('%d/%m %H:%M')} to {end.strftime('%d/%m %H:%M')}"


def _roster_summary(roster: Roster) -> Dict[str, object]:
    return {
        "crew_name": roster.crew_name,
        "staff_number": roster.staff_number,
        "base": roster.base,
        "bid_period": roster.bid_period,
        "source": roster.source,
        "file_name": roster.file_name,
        "off_days": len(roster.off_days),
        "resolved_patterns": len(roster.port_windows),
        "unresolved_duties": [
            {
                "date": entry.date.isoformat(),
                "duty_code": entry.duty_code,
            }
            for entry in roster.unresolved_duties
        ],
        "preview": roster.extracted_text_preview,
    }


def _build_notes(roster_a: Roster, roster_b: Roster) -> List[str]:
    notes = []
    if roster_a.unresolved_duties:
        notes.append(
            f"{roster_a.crew_name}: {len(roster_a.unresolved_duties)} duty entries could not be resolved to pattern detail and were treated as uncertain."
        )
    if roster_b.unresolved_duties:
        notes.append(
            f"{roster_b.crew_name}: {len(roster_b.unresolved_duties)} duty entries could not be resolved to pattern detail and were treated as uncertain."
        )
    if roster_a.base != roster_b.base:
        notes.append(
            f"Home bases differ ({roster_a.base or '?'} vs {roster_b.base or '?'}), so shared day-off matches may not imply the same physical port."
        )
    return notes


def result_to_json(result: Dict[str, object]) -> str:
    return json.dumps(result, indent=2)
