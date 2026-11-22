import { connectionToken, knownEmailPeriods, fetchEmailRosters, prepareEmailFiles } from "./email-rosters.js?v=20261122-crew1";
import { compareRosterGroup, parseRosterText, findRosterPilotIndex, mergeRosterPeriods } from "./roster-browser.js?v=20261122-crew1";
import { CREW_COLOURS, buildRosterCalendar, calendarBounds, initialCalendarMonth, dateKey, renderCalendarMarkup } from "./roster-calendar.js?v=20261122-crew1";

const STORAGE_KEY = "roster-compare-state-v2";
const THEME_STORAGE_KEY = "roster-compare-theme";
const themeToggle = document.getElementById("theme-toggle");
const themeLabel = document.getElementById("theme-label");
const themeColour = document.getElementById("theme-colour");
const VALID_FILTERS = new Set(["all", "port_match", "shared_day_off"]);

const form = document.getElementById("compare-form");
const installButton = document.getElementById("install-button");
const clearStorageButton = document.getElementById("clear-storage-button");
const minOverlapInput = document.getElementById("min-overlap-minutes");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const resultsHead = document.getElementById("results-head");
const resultsBody = document.getElementById("results-body");
const notesEl = document.getElementById("notes");
const summaryRow = document.getElementById("summary-row");
const filterBar = document.getElementById("match-filters");
const fileInput = document.getElementById("roster-files");
const dropzone = document.getElementById("roster-dropzone");
const crewList = document.getElementById("crew-list");
const rosterCount = document.getElementById("roster-count");
const selectionCount = document.getElementById("selection-count");
const uploadStatus = document.getElementById("upload-status");
const MAX_ROSTERS = 5;
const emailCodeInput = document.getElementById("email-connection-code");
const emailConnectButton = document.getElementById("email-connect-button");
const emailRefreshButton = document.getElementById("email-refresh-button");
const emailConnectionList = document.getElementById("email-connections");
const sharedCrewList = document.getElementById("shared-crew");
const emailStatus = document.getElementById("email-status");
let emailConnections = [];
const excludedSharedCrew = new Set();
let emailBusy = false;

const calendarGrid = document.getElementById("calendar-grid");
const calendarTitle = document.getElementById("calendar-month");
const calendarLegend = document.getElementById("calendar-crew-legend");
const calendarPrevious = document.getElementById("calendar-previous");
const calendarNext = document.getElementById("calendar-next");
const calendarDetails = document.getElementById("calendar-details");
const calendarDetailTitle = document.getElementById("calendar-detail-title");
const calendarDetailSubtitle = document.getElementById("calendar-detail-subtitle");
const calendarDetailText = document.getElementById("calendar-detail-text");
const calendarDetailClose = document.getElementById("calendar-detail-close");
const calendarPeriodInput = document.getElementById("calendar-bid-period");
const calendarPeriodControl = document.getElementById("calendar-bid-period-control");
const calendarRangeInput = document.getElementById("calendar-range");
const calendarRangeSummary = document.getElementById("calendar-range-summary");
const HOME_PORTS = { ADL: "Adelaide", BNE: "Brisbane", CBR: "Canberra", DRW: "Darwin", HBA: "Hobart", MEL: "Melbourne", PER: "Perth", SYD: "Sydney" };
let calendarRange = "roster";
let preferredBidPeriod = "";
let activeBidPeriod = null;
let periodRosters = [];
let calendarMonth = null;
let calendarModel = null;
let renderedCalendarDate = null;

let loadedRosters = [];
let isProcessing = false;
let currentPayload = null;
const comparisonCache = new Map();
let activeFilter = "all";
let deferredInstallPrompt = null;
let pendingReloadForServiceWorker = false;

calendarPeriodInput.addEventListener("change", () => {
  preferredBidPeriod = calendarPeriodInput.value;
  calendarMonth = null;
  prepareComparisons();
  rerunComparison();
});
calendarRangeInput.addEventListener("change", () => {
  calendarRange = calendarRangeInput.value === "month" ? "month" : "roster";
  if (currentPayload) renderCalendar();
  persistState();
});
calendarPrevious.addEventListener("click", () => moveCalendarMonth(-1));
calendarNext.addEventListener("click", () => moveCalendarMonth(1));
calendarGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-calendar-detail]");
  if (!button || !calendarModel) return;
  const detail = calendarModel.details[Number(button.dataset.calendarDetail)];
  if (!detail) return;
  calendarDetailTitle.textContent = detail.title;
  calendarDetailSubtitle.textContent = detail.subtitle;
  calendarDetailText.textContent = detail.text;
  calendarDetails.hidden = false;
  calendarDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
calendarDetailClose.addEventListener("click", () => { calendarDetails.hidden = true; });

// A restored browser tab or installed app may still show yesterday's markup.
function refreshCalendarToday() {
  const today = dateKey(new Date());
  if (!calendarModel || renderedCalendarDate === today) return;
  calendarGrid.innerHTML = renderCalendarMarkup(calendarModel);
  renderedCalendarDate = today;
}
window.addEventListener("focus", refreshCalendarToday);
window.addEventListener("pageshow", refreshCalendarToday);

function moveCalendarMonth(offset) {
  if (!calendarMonth || !currentPayload) return;
  const bounds = calendarBounds(selectedPeriodRosters(), activeBidPeriod);
  const next = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
  if (next < bounds.first || next > bounds.last) return;
  calendarMonth = next;
  renderCalendar();
  persistState();
}

function renderCalendar() {
  const calendarRosters = selectedPeriodRosters();
  const bounds = calendarBounds(calendarRosters, activeBidPeriod);
  if (!calendarMonth || calendarMonth < bounds.first || calendarMonth > bounds.last) {
    calendarMonth = initialCalendarMonth(calendarRosters, activeBidPeriod);
  }
  calendarModel = buildRosterCalendar(calendarRosters, calendarMonth, {
    minOverlapMinutes: Number(minOverlapInput.value || 60), range: calendarRange, period: activeBidPeriod,
  });
  calendarTitle.textContent = calendarModel.title;
  calendarRangeInput.value = calendarRange;
  const weekRange = activeBidPeriod?.cycleStart
    ? `Weeks ${calendarModel.weeks[0].number}–${calendarModel.weeks.at(-1).number}`
    : `${calendarModel.weeks.length} calendar weeks`;
  calendarRangeSummary.textContent = calendarRange === "roster" || activeBidPeriod?.cycleStart
    ? `${calendarModel.dayCount} days · ${weekRange}` : "Month view";
  calendarPrevious.hidden = calendarRange !== "month";
  calendarNext.hidden = calendarRange !== "month";
  calendarPrevious.disabled = calendarMonth <= bounds.first;
  calendarNext.disabled = calendarMonth >= bounds.last;
  calendarLegend.innerHTML = calendarModel.crews.map((crew) => `<span style="--crew-colour: ${crew.colour}"><strong>${escapeHtml(crew.name)}</strong><span>Home ${escapeHtml(crew.domicile || "unknown")} · base ${escapeHtml(crew.base || "unknown")}</span></span>`).join("");
  calendarGrid.innerHTML = renderCalendarMarkup(calendarModel);
  renderedCalendarDate = dateKey(new Date());
  calendarDetails.hidden = true;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js", { updateViaCache: "none" })
      .then((registration) => {
        registration.update().catch(() => {});

        if (registration.waiting) {
          pendingReloadForServiceWorker = true;
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) {
            return;
          }
          installingWorker.addEventListener("statechange", () => {
            if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
              pendingReloadForServiceWorker = true;
            }
          });
        });
      })
      .catch(() => {});
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!pendingReloadForServiceWorker) {
      return;
    }
    pendingReloadForServiceWorker = false;
    window.location.reload();
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

fileInput.addEventListener("change", () => addRosterFiles(Array.from(fileInput.files)));
for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!isProcessing) dropzone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
}
dropzone.addEventListener("drop", (event) => addRosterFiles(Array.from(event.dataTransfer.files)));

crewList.addEventListener("change", (event) => {
  if (isProcessing) return;
  const domicileInput = event.target.closest("[data-domicile-index]");
  if (domicileInput) {
    const roster = loadedRosters[Number(domicileInput.dataset.domicileIndex)];
    const domicile = String(domicileInput.value).trim().toUpperCase();
    if (!roster || !Object.hasOwn(HOME_PORTS, domicile)) return;
    roster.domicile = domicile;
    roster.parsed.domicile = domicile;
    roster.parsed.requiresDomicile = false;
    prepareComparisons();
    renderCrewList();
    updateSelection();
    return;
  }
  const input = event.target.closest("[data-roster-index]");
  if (!input) return;
  loadedRosters[Number(input.dataset.rosterIndex)].selected = input.checked;
  updateSelection();
});
crewList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-index]");
  if (!button || isProcessing || emailBusy) return;
  const removed = loadedRosters.splice(Number(button.dataset.removeIndex), 1)[0];
  if (removed?.parsed.staffNumber) excludedSharedCrew.add(removed.parsed.staffNumber);
  emailConnections = emailConnections.filter(connection => connection.staffNumber !== removed?.parsed.staffNumber);
  renderEmailConnections();
  prepareComparisons();
  renderCrewList();
  updateSelection();
});

minOverlapInput.addEventListener("change", () => {
  persistState();
  if (!isProcessing) rerunComparison();
});

filterBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) {
    return;
  }
  activeFilter = button.dataset.filter;
  updateActiveFilterButton();
  persistState();
  if (currentPayload) {
    renderResults(currentPayload);
  }
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    return;
  }

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => {});
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

clearStorageButton.addEventListener("click", () => {
  if (isProcessing || emailBusy) return;
  clearPersistedState();
  loadedRosters = [];
  emailConnections = [];
  excludedSharedCrew.clear();
  emailCodeInput.value = "";
  emailStatus.textContent = "";
  renderEmailConnections();
  comparisonCache.clear();
  activeFilter = "all";
  preferredBidPeriod = "";
  activeBidPeriod = null;
  periodRosters = [];
  calendarPeriodControl.hidden = true;
  calendarMonth = null;
  calendarRange = "roster";
  calendarRangeInput.value = "roster";
  form.reset();
  minOverlapInput.value = "60";
  hideResults();
  renderCrewList();
  updateActiveFilterButton();
  uploadStatus.textContent = "";
  statusEl.textContent = "Saved rosters and comparison removed from this device.";
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!isProcessing) rerunComparison();
});

async function addRosterFiles(files) {
  if (isProcessing || emailBusy || !files.length) return;
  isProcessing = true;
  fileInput.disabled = true;
  clearStorageButton.disabled = true;
  renderCrewList();
  uploadStatus.textContent = "Reading and processing rosters…";
  const messages = [];
  let added = 0;
  const outcomes = await Promise.allSettled(files.map(async (file) => {
    if (!/\.txt$/i.test(file.name) && file.type !== "text/plain") {
      throw new Error("Choose an ARMS or webCIS .txt roster.");
    }
    const text = await readRosterFile(file);
    return { fileName: file.name, text, parsed: parseRosterText(file.name, text), selected: true };
  }));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      messages.push(`${files[index].name}: ${outcome.reason instanceof Error ? outcome.reason.message : "Could not read this roster."}`);
    } else if (loadedRosters.some((roster) => roster.files.some(file => file.text === outcome.value.text))) {
      messages.push(`${files[index].name}: this roster is already loaded.`);
    } else {
      try {
        includeRosterFile(outcome.value);
        added += 1;
      } catch (error) {
        messages.push(`${files[index].name}: ${error.message}`);
      }
    }
  });
  isProcessing = false;
  fileInput.disabled = false;
  clearStorageButton.disabled = false;
  fileInput.value = "";
  if (added) prepareComparisons();
  renderCrewList();
  renderEmailConnections();
  rerunComparison();
  persistState();
  uploadStatus.textContent = [`${added} roster file${added === 1 ? "" : "s"} added.`, ...messages].join(" ");
}

function includeRosterFile(file, settings = {}, restoring = false, replacingFiles = null) {
  const index = findRosterPilotIndex(loadedRosters.map(roster => roster.parsed), file.parsed);
  const existing = loadedRosters[index];
  if (!existing && loadedRosters.length >= MAX_ROSTERS) throw new Error(`You can load up to ${MAX_ROSTERS} pilots. Remove a pilot before adding another person.`);
  const files = replacingFiles || (existing ? [...existing.files, file] : [file]);
  const parsed = mergeRosterPeriods(files.map(period => period.parsed));
  const domicile = existing ? existing.domicile : capitalDomicile(settings.domicile, parsed.base);
  const colour = existing?.parsed.colour || (CREW_COLOURS.includes(settings.colour) ? settings.colour : CREW_COLOURS.find(colour => !loadedRosters.some(item => item.parsed.colour === colour)));
  parsed.domicile = domicile;
  parsed.requiresDomicile = !domicile;
  parsed.colour = colour;
  const selected = existing ? (restoring ? existing.selected || settings.selected !== false : existing.selected) : settings.selected !== false;
  const record = { files, fileName: files.map(period => period.fileName).join(" · "), text: files[0].text, parsed, domicile, selected };
  if (existing) loadedRosters[index] = record;
  else loadedRosters.push(record);
}

async function readRosterFile(file) {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read this roster file."));
    reader.readAsText(file);
  });
}

function selectedRosters() {
  return loadedRosters.filter((roster) => roster.selected);
}

function selectedPeriodRosters() {
  return periodRosters.filter((_, index) => loadedRosters[index].selected);
}

function hideResults() {
  currentPayload = null;
  calendarModel = null;
  calendarGrid.innerHTML = "";
  calendarDetails.hidden = true;
  resultsEl.classList.add("hidden");
  resultsHead.innerHTML = "";
  resultsBody.innerHTML = "";
  notesEl.innerHTML = "";
  summaryRow.innerHTML = "";
}

function updateSelection() {
  persistState();
  updateRosterControls();
  rerunComparison();
}

function updateRosterControls() {
  rosterCount.textContent = `${loadedRosters.length} / ${MAX_ROSTERS} loaded`;
  const count = selectedRosters().length;
  selectionCount.textContent = `${count} selected`;
  if (isProcessing) statusEl.textContent = "Processing roster files…";
  else if (count < 2) statusEl.textContent = loadedRosters.length < 2 ? "Add at least two rosters to begin." : "Select at least two crew to compare.";
  else if (!currentPayload) statusEl.textContent = `${count} crew selected. Updating comparison…`;
}

function renderCrewList() {
  updateRosterControls();
  crewList.innerHTML = loadedRosters.length ? loadedRosters.map((roster, index) => {
    const crew = roster.parsed;
    const name = crew.crewName !== "Unknown" ? crew.crewName : roster.fileName;
    return `
      <div class="crew-row" style="--crew-colour: ${crew.colour}">
        <div class="crew-profile"><label class="crew-choice">
          <input type="checkbox" data-roster-index="${index}" ${roster.selected ? "checked" : ""} ${isProcessing ? "disabled" : ""} />
          <span class="crew-details">
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml([crew.staffNumber && `Staff ${crew.staffNumber}`, crew.base, crew.haul, crew.bidPeriod && `BP${crew.bidPeriod.replaceAll(" / ", " / BP")}`].filter(Boolean).join(" · ") || "Crew details unavailable")}</span>
            <span>${escapeHtml(crew.coverageStart.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))} – ${escapeHtml(crew.coverageEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</span>
            <span class="crew-filename">${roster.files.length > 1 ? `${roster.files.length} roster files · ` : ""}${escapeHtml(roster.fileName)}</span>
          </span>
        </label>
        <label class="domicile-control" for="domicile-${index}">Home city / domicile
          <select id="domicile-${index}" data-domicile-index="${index}" aria-describedby="domicile-help-${index}" ${isProcessing ? "disabled" : ""}>${domicileOptions(crew)}</select>
        </label>
        <p id="domicile-help-${index}" class="domicile-help">Days off: ${escapeHtml(crew.domicile ? crew.domicile : "choose a capital city")}. Roster base: ${escapeHtml(crew.base || "unknown")}.</p></div>
        <button type="button" class="secondary-button remove-roster" data-remove-index="${index}" aria-label="Remove ${escapeHtml(name)}" ${isProcessing || emailBusy ? "disabled" : ""}>Remove</button>
      </div>`;
  }).join("") : '<p class="empty-state">Your crew will appear here after you add rosters.</p>';
}

function capitalDomicile(value, base) {
  return Object.hasOwn(HOME_PORTS, value) ? value : Object.hasOwn(HOME_PORTS, base) ? base : null;
}

function domicileOptions(crew) {
  const placeholder = crew.domicile ? "" : '<option value="" selected disabled>Choose a capital city</option>';
  return placeholder + Object.entries(HOME_PORTS).map(([port, city]) => `<option value="${port}" ${port === crew.domicile ? "selected" : ""}>${port} — ${city}</option>`).join("");
}

function updateBidPeriod() {
  const periods = new Map();
  const other = [];
  for (const { parsed } of loadedRosters.flatMap(roster => roster.files)) {
    const period = parsed.period;
    if (!period) {
      other.push(parsed);
      continue;
    }
    const existing = periods.get(period.key);
    if (!existing) periods.set(period.key, { ...period });
    else {
      if (period.first < existing.first) { existing.first = period.first; existing.firstWeek = period.firstWeek; }
      if (period.last > existing.last) { existing.last = period.last; existing.lastWeek = period.lastWeek; }
    }
  }
  if (!periods.size) {
    activeBidPeriod = null;
    calendarPeriodControl.hidden = true;
    return;
  }
  const choices = [...periods.values()].sort((a, b) => b.cycleStart - a.cycleStart);
  for (const period of choices) {
    period.label = `BP${period.number}${period.lastWeek - period.firstWeek === 3 ? period.firstWeek : ""}`;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const defaultPeriod = choices.find(period => period.first <= today && today <= period.last) ?? choices[0];
  if (other.length) choices.push({
    key: "other",
    label: "Other rosters",
    first: new Date(Math.min(...other.map(roster => +roster.coverageStart))),
    last: new Date(Math.max(...other.map(roster => +roster.coverageEnd))),
  });
  activeBidPeriod = choices.find(period => period.key === preferredBidPeriod) ?? defaultPeriod;
  calendarPeriodControl.hidden = choices.length < 2;
  calendarPeriodInput.innerHTML = choices.map(period => {
    const date = period.cycleStart && period.first.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return `<option value="${period.key}">${period.label}${date ? ` · ${date}` : ""}</option>`;
  }).join("");
  calendarPeriodInput.value = activeBidPeriod.key;
}

function rosterInBidPeriod(roster, period) {
  if (!period) return roster.parsed;
  const identified = roster.files.filter(({ parsed }) => parsed.period?.key === period.key);
  const files = identified.length ? identified : roster.files.filter(({ parsed }) =>
    !parsed.period && parsed.coverageStart <= period.last && parsed.coverageEnd >= period.first);
  if (!files.length) return {
    ...roster.parsed, bidPeriod: null, haul: null, coverageStart: null, coverageEnd: null,
    calendar: [], trips: [], offDays: [], reserveDays: [], portWindows: [], homeBoundaryWindows: [], unresolvedDuties: [],
  };
  const parsed = mergeRosterPeriods(files.map(file => file.parsed), {
    carryoverContext: roster.files.map(file => file.parsed),
  });
  return { ...parsed, domicile: roster.domicile, requiresDomicile: !roster.domicile, colour: roster.parsed.colour };
}

function compareBidPeriod(rosters, minutes) {
  const payload = compareRosterGroup(rosters, { minPortOverlapMinutes: minutes });
  if (activeBidPeriod) {
    const first = dateKey(activeBidPeriod.first), last = dateKey(activeBidPeriod.last);
    payload.matches = payload.matches.filter(match => first <= match.sort_date && match.sort_date <= last);
  }
  return payload;
}

function prepareComparisons() {
  updateBidPeriod();
  periodRosters = loadedRosters.map(roster => rosterInBidPeriod(roster, activeBidPeriod));
  comparisonCache.clear();
  if (!minOverlapInput.checkValidity()) return;
  const minutes = Number(minOverlapInput.value || 60);
  for (let mask = 1; mask < (1 << loadedRosters.length); mask += 1) {
    const rosters = periodRosters.filter((_, index) => mask & (1 << index));
    if (rosters.length < 2) continue;
    comparisonCache.set(`${minutes}:${mask}`, compareBidPeriod(rosters, minutes));
  }
}

function rerunComparison() {
  const rosters = selectedPeriodRosters();
  if (rosters.length < 2) {
    hideResults();
    renderCrewList();
    return;
  }
  if (!minOverlapInput.reportValidity()) {
    hideResults();
    statusEl.textContent = "Enter a port match window between 1 and 1440 minutes.";
    return;
  }
  try {
    const minutes = Number(minOverlapInput.value || 60);
    const mask = loadedRosters.reduce((value, roster, index) => value | (roster.selected ? 1 << index : 0), 0);
    const key = `${minutes}:${mask}`;
    if (!comparisonCache.has(key)) {
      comparisonCache.set(key, compareBidPeriod(rosters, minutes));
    }
    const payload = comparisonCache.get(key);
    currentPayload = payload;
    renderResults(payload);
    persistState();
  } catch (error) {
    hideResults();
    statusEl.textContent = error instanceof Error ? error.message : "Comparison failed.";
  }
}

function renderResults(payload) {
  resultsEl.classList.remove("hidden");
  renderCalendar();
  renderSummaries(payload.crews);
  updateResultsTableHeaders(payload.crews);

  const filteredMatches = payload.matches.filter((match) => activeFilter === "all" || match.match_key === activeFilter);
  resultsBody.innerHTML = "";
  if (!filteredMatches.length) {
    resultsBody.innerHTML = `<tr><td colspan="${4 + payload.crews.length * 2}" class="empty-state">${payload.crews.length > 2 ? "No whole-group matches under this filter." : "No matches found under the current rules."}</td></tr>`;
  }

  for (const match of filteredMatches) {
    const row = document.createElement("tr");
    row.className = match.visual_group === "away_port" ? "away-port-row" : "home-match-row";
    const participantCells = match.participants
      .map(
        (participant) => `
          <td>${escapeHtml(participant.label)}</td>
          <td>${escapeHtml(participant.window)}</td>
        `
      )
      .join("");

    row.innerHTML = `
      <td>${escapeHtml(match.date)}</td>
      <td>${escapeHtml(match.port)}</td>
      <td>${escapeHtml(match.match_type)}</td>
      <td>${escapeHtml(match.overlap_window)}</td>
      ${participantCells}
    `;
    resultsBody.appendChild(row);
  }

  notesEl.innerHTML = "";
  for (const note of payload.notes) {
    const item = document.createElement("li");
    item.textContent = note;
    notesEl.appendChild(item);
  }

  statusEl.textContent = `Comparison complete. ${filteredMatches.length} displayed ${payload.crews.length > 2 ? "whole-group " : ""}match(es) of ${payload.matches.length} total.`;
}

function renderSummaries(crews) {
  summaryRow.innerHTML = crews.map((summary, index) => renderSummaryCard(index, summary)).join("");
}

function renderSummaryCard(index, summary) {
  const label = `Crew ${String.fromCharCode(65 + index)}`;
  const uncertainMarkup = summary.unresolved_duties.length
    ? `
      <ul class="uncertain-list">
        ${summary.unresolved_duties
          .map(
            (item) => `
              <li>
                <span>${escapeHtml(item.date)}</span>
                <span><span class="duty-code">${escapeHtml(item.label || item.duty_code)}</span><small class="uncertain-reason">${escapeHtml(item.reason || "Duty details are incomplete.")}</small></span>
              </li>
            `
          )
          .join("")}
      </ul>
    `
    : `<p class="empty-state">No uncertain duties.</p>`;

  return `
    <article class="summary-card">
    <p class="eyebrow">${label}</p>
    <h3>${escapeHtml(summary.display_name || summary.crew_name)}</h3>
    <ul class="summary-meta">
      <li>Staff number: ${escapeHtml(summary.staff_number || "Unknown")}</li>
      <li>Base: ${escapeHtml(summary.base || "Unknown")}</li>
      <li>Domicile: ${escapeHtml(summary.domicile || summary.base || "Unknown")}</li>
      <li>${escapeHtml(summary.bid_period ? `BP${summary.bid_period.replaceAll(" / ", " / BP")}${summary.haul ? ` · ${summary.haul}` : ""}` : summary.coverage_start ? "Bid period unknown" : "No roster for this bid period")}</li>
      <li>Dates: ${escapeHtml(summary.coverage_start || "Unknown")} – ${escapeHtml(summary.coverage_end || "Unknown")}</li>
      <li>Uncertain duties: ${escapeHtml(String(summary.unresolved_duties.length))}</li>
    </ul>
    ${uncertainMarkup}
    </article>
  `;
}

function updateActiveFilterButton() {
  for (const button of filterBar.querySelectorAll("[data-filter]")) {
    button.classList.toggle("is-active", button.dataset.filter === activeFilter);
  }
}

function updateResultsTableHeaders(crews) {
  const participantHeaders = crews
    .map((crew) => {
      const label = crew.display_name || crew.crew_name || "Crew";
      return `<th>${escapeHtml(label)}</th><th>Window</th>`;
    })
    .join("");

  resultsHead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Port</th>
      <th>Match Type</th>
      <th>Overlap</th>
      ${participantHeaders}
    </tr>
  `;
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeFilter,
        calendarMonth: calendarMonth ? dateKey(calendarMonth) : null,
        calendarRange,
        preferredBidPeriod,
        minOverlapMinutes: Number(minOverlapInput.value || 60),
        emailConnections: emailConnections.map(({ code, staffNumber, name, checkedAtUtc, updatedAtUtc }) => ({ code, staffNumber, name, checkedAtUtc, updatedAtUtc })),
        excludedSharedCrew: [...excludedSharedCrew],
        currentInputs: {
          rosters: loadedRosters.map(({ files, fileName, text, selected, domicile, parsed }) => ({ fileName, text, files: files.map(({ fileName, text, emailSource }) => ({ fileName, text, ...(emailSource ? { emailSource } : {}) })), selected, domicile, colour: parsed.colour })),
        },
      })
    );
  } catch {
    // Ignore storage failures; comparison still works in-memory.
  }
}

function clearPersistedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; this only affects persistence.
  }
}

function restorePersistedState() {
  const savedState = loadPersistedState();
  if (!savedState) {
    return;
  }

  emailConnections = Array.isArray(savedState.emailConnections) ? savedState.emailConnections.slice(0, MAX_ROSTERS).filter(connection => {
    try { connectionToken(connection.code); return /^\d{4,}$/.test(connection.staffNumber || ""); } catch { return false; }
  }) : [];
  for (const staffNumber of Array.isArray(savedState.excludedSharedCrew) ? savedState.excludedSharedCrew : []) {
    if (typeof staffNumber === "string" && /^\d{4,}$/.test(staffNumber)) excludedSharedCrew.add(staffNumber);
  }
  renderEmailConnections();
  const minOverlapMinutes =
    savedState.minOverlapMinutes != null
      ? Number(savedState.minOverlapMinutes)
      : savedState.minOverlapHours != null
        ? Number(savedState.minOverlapHours) * 60
        : null;
  if (Number.isInteger(minOverlapMinutes) && minOverlapMinutes >= 1 && minOverlapMinutes <= 1440) {
    minOverlapInput.value = String(minOverlapMinutes);
  }

  if (VALID_FILTERS.has(savedState.activeFilter)) {
    activeFilter = savedState.activeFilter;
    updateActiveFilterButton();
  }

  if (!isPersistedInputs(savedState.currentInputs)) {
    return;
  }

  if (/^\d{4}-(0[1-9]|1[0-2])-01$/.test(savedState.calendarMonth || "")) {
    const [year, month] = savedState.calendarMonth.split("-").map(Number);
    calendarMonth = new Date(year, month - 1, 1);
  }

  calendarRange = savedState.calendarRange === "month" ? "month" : "roster";
  preferredBidPeriod = typeof savedState.preferredBidPeriod === "string" ? savedState.preferredBidPeriod : "";
  calendarRangeInput.value = calendarRange;

  for (const roster of savedState.currentInputs.rosters) {
    for (const file of Array.isArray(roster.files) ? roster.files : [roster]) {
      try {
        if (loadedRosters.some(item => item.files.some(period => period.text === file.text))) continue;
        includeRosterFile({ ...file, parsed: parseRosterText(file.fileName, file.text) }, roster, true);
      } catch {
        uploadStatus.textContent = "Some saved rosters could not be read. Add those files again.";
      }
    }
  }
  renderCrewList();
  prepareComparisons();
  rerunComparison();
  if (currentPayload) {
    statusEl.textContent = `Restored saved rosters and crew selection. ${statusEl.textContent}`;
  }
}

function isPersistedInputs(value) {
  return Boolean(
    value &&
      Array.isArray(value.rosters) &&
      value.rosters.length <= MAX_ROSTERS &&
      value.rosters.every((roster) => roster && (Array.isArray(roster.files) || (typeof roster.fileName === "string" && typeof roster.text === "string")))
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function applyTheme(theme, save = false) {
  const dark = theme !== "light";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeToggle.setAttribute("aria-checked", String(dark));
  themeLabel.textContent = dark ? "Dark mode" : "Light mode";
  themeColour.setAttribute("content", dark ? "#080b10" : "#f3f6fa");
  if (save) {
    try { localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light"); } catch { /* Appearance still works without storage. */ }
  }
}

let savedTheme = "dark";
try { if (localStorage.getItem(THEME_STORAGE_KEY) === "light") savedTheme = "light"; } catch { /* Keep the default appearance. */ }
applyTheme(savedTheme);
themeToggle.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true));

renderCrewList();
updateActiveFilterButton();
restorePersistedState();
renderEmailConnections();
// One check on opening; no background polling while the app is closed.
if (emailConnections.length) refreshEmailConnections();


function renderEmailConnections() {
  fileInput.disabled = emailBusy || isProcessing;
  clearStorageButton.disabled = emailBusy || isProcessing;
  emailRefreshButton.disabled = emailBusy || isProcessing || !emailConnections.length;
  emailConnectButton.disabled = emailBusy || isProcessing;
  emailCodeInput.disabled = emailBusy || isProcessing;
  for (const button of crewList.querySelectorAll("[data-remove-index]")) {
    button.disabled = emailBusy || isProcessing;
  }
  emailConnectionList.innerHTML = emailConnections.map((connection, index) => `
    <div class="email-connection">
      <div><strong>${escapeHtml(connection.name || `Staff ${connection.staffNumber}`)}</strong>
      <span>${escapeHtml(connection.error || (connection.checkedAtUtc ? `Last checked ${new Date(connection.checkedAtUtc).toLocaleString("en-GB")}` : "Waiting for first refresh"))}</span>
      <span>${escapeHtml(connection.updatedAtUtc ? `Roster updated ${new Date(connection.updatedAtUtc).toLocaleString("en-GB")}` : "No emailed roster loaded yet")}</span></div>
      <button type="button" class="secondary-button" data-disconnect-email="${index}" ${emailBusy || isProcessing ? "disabled" : ""}>Disconnect</button>
    </div>`).join("");
  const available = [...availableSharedCrew().values()].filter(pilot => !hasLoadedPilot(pilot.staffNumber));
  sharedCrewList.hidden = !available.length;
  sharedCrewList.innerHTML = available.map(pilot => `
    <div class="email-connection">
      <strong>${escapeHtml(pilot.name || `Staff ${pilot.staffNumber}`)}</strong>
      <button type="button" class="secondary-button" data-add-shared-crew="${pilot.staffNumber}" ${emailBusy || isProcessing || !hasRoomForSharedPilot() ? "disabled" : ""}>Add roster</button>
    </div>`).join("");
}

function availableSharedCrew() {
  const available = new Map();
  const connected = new Set(emailConnections.map(connection => connection.staffNumber));
  for (const connection of emailConnections) {
    for (const pilot of connection.crew || []) {
      if (!connected.has(pilot.staffNumber) && !available.has(pilot.staffNumber)) available.set(pilot.staffNumber, { ...pilot, connection });
    }
  }
  return available;
}

function hasLoadedPilot(staffNumber) {
  return loadedRosters.some(roster => roster.parsed.staffNumber === staffNumber);
}

function hasRoomForSharedPilot() {
  const pending = emailConnections.filter(connection => !hasLoadedPilot(connection.staffNumber)).length;
  return loadedRosters.length + pending < MAX_ROSTERS;
}

async function syncSharedPilot(pilot) {
  const data = await fetchEmailRosters({ ...pilot.connection, crewStaffNumber: pilot.staffNumber }, knownEmailPeriods(loadedRosters, pilot.staffNumber));
  return { changed: applyEmailRosterData(data), message: data.message || (data.unavailable.length ? "Some periods are still becoming available; refresh shortly." : "") };
}

async function refreshSharedCrew(messages) {
  let changed = 0;
  for (const pilot of availableSharedCrew().values()) {
    if (!hasLoadedPilot(pilot.staffNumber) && (excludedSharedCrew.has(pilot.staffNumber) || !hasRoomForSharedPilot())) continue;
    try {
      const result = await syncSharedPilot(pilot);
      changed += result.changed;
      if (result.message) messages.push(`${pilot.name}: ${result.message}`);
    } catch (error) {
      messages.push(`${pilot.name}: ${error.message}`);
    }
  }
  return changed;
}

function applyEmailRosterData(data) {
  if (!data.changed.length) return 0;
  const candidate = parseRosterText(data.changed[0].fileName, data.changed[0].rosterText);
  const existing = loadedRosters[findRosterPilotIndex(loadedRosters.map(roster => roster.parsed), candidate)];
  const files = prepareEmailFiles(data, existing?.files || [], parseRosterText);
  // includeRosterFile merges once, retaining the crew's domicile, colour and selection.
  includeRosterFile(files.at(-1), {}, false, files);
  return data.changed.length;
}

async function connectEmailRoster() {
  if (emailBusy || isProcessing) return;
  emailBusy = true;
  renderEmailConnections();
  emailStatus.textContent = "Connecting to emailed roster…";
  try {
    const code = `roster-overlap:${connectionToken(emailCodeInput.value)}`;
    const already = emailConnections.find(connection => connection.code === code);
    if (already) throw new Error("This roster is already connected. Use Refresh emailed rosters to check it.");
    const candidate = { code };
    const data = await fetchEmailRosters(candidate);
    const existing = emailConnections.find(connection => connection.staffNumber === data.staffNumber);
    if (!existing && emailConnections.length >= MAX_ROSTERS) throw new Error("You can connect up to five pilots. Disconnect one before adding another.");
    const people = new Set([...loadedRosters.map((roster, index) => roster.parsed.staffNumber || `manual-${index}`), ...emailConnections.map(connection => connection.staffNumber)]);
    if (!people.has(data.staffNumber) && people.size >= MAX_ROSTERS) throw new Error("You can load up to 5 pilots. Remove or disconnect a pilot before connecting another.");
    applyEmailRosterData(data);
    const connection = { code, staffNumber: data.staffNumber, name: data.name, crew: data.crew || [], checkedAtUtc: data.checkedAtUtc,
      updatedAtUtc: data.periods.map(period => period.storedAtUtc).sort().at(-1) || "" };
    if (existing) emailConnections[emailConnections.indexOf(existing)] = connection;
    else emailConnections.push(connection);
    excludedSharedCrew.delete(data.staffNumber);
    emailCodeInput.value = "";
    persistState();
    const messages = [data.message || (data.unavailable.length ? "Connected. Some periods are still becoming available; refresh shortly." : "Connected. Emailed rosters will refresh when you open the app.")];
    if (data.crewSharing === false) messages.push("Crew sharing can be enabled in Roster Export iCal.");
    const shared = await refreshSharedCrew(messages);
    if (shared) messages.push(`${shared} shared roster period${shared === 1 ? "" : "s"} loaded.`);
    emailStatus.textContent = messages.join(" ");
    emailRostersChanged();
  } catch (error) { emailStatus.textContent = error.message || "Could not connect to the roster service."; }
  finally { emailBusy = false; renderEmailConnections(); }
}

async function refreshEmailConnections() {
  if (emailBusy || isProcessing || !emailConnections.length) return;
  emailBusy = true;
  renderEmailConnections();
  emailStatus.textContent = "Checking emailed rosters…";
  let changed = 0;
  const messages = [];
  try {
    for (const connection of emailConnections) {
      try {
        const data = await fetchEmailRosters(connection, knownEmailPeriods(loadedRosters, connection.staffNumber));
        changed += applyEmailRosterData(data);
        connection.name = data.name;
        connection.crew = data.crew || [];
        connection.checkedAtUtc = data.checkedAtUtc;
        connection.updatedAtUtc = data.periods.map(period => period.storedAtUtc).sort().at(-1) || connection.updatedAtUtc || "";
        connection.error = data.unavailable.length ? "Some periods are still becoming available; refresh shortly." : data.message || "";
        if (connection.error) messages.push(`${connection.name || connection.staffNumber}: ${connection.error}`);
      } catch (error) {
        connection.crew = [];
        connection.error = error.message || "Could not refresh. Last saved roster retained.";
        messages.push(`${connection.name || connection.staffNumber}: ${connection.error}`);
      }
    }
    changed += await refreshSharedCrew(messages);
    if (changed) emailRostersChanged();
    else persistState();
    emailStatus.textContent = [`${changed} roster period${changed === 1 ? "" : "s"} updated.`, ...messages].join(" ");
  } finally {
    emailBusy = false;
    renderEmailConnections();
  }
}

function emailRostersChanged() {
  prepareComparisons();
  renderCrewList();
  rerunComparison();
  persistState();
}

emailConnectButton.addEventListener("click", connectEmailRoster);
emailCodeInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); connectEmailRoster(); }
});
emailRefreshButton.addEventListener("click", refreshEmailConnections);
sharedCrewList.addEventListener("click", async event => {
  const button = event.target.closest("[data-add-shared-crew]");
  if (!button || emailBusy || isProcessing || !hasRoomForSharedPilot()) return;
  const pilot = availableSharedCrew().get(button.dataset.addSharedCrew);
  if (!pilot) return;
  emailBusy = true;
  renderEmailConnections();
  emailStatus.textContent = `Loading ${pilot.name}’s roster…`;
  try {
    const { changed, message } = await syncSharedPilot(pilot);
    if (changed) {
      excludedSharedCrew.delete(pilot.staffNumber);
      emailRostersChanged();
    }
    emailStatus.textContent = message || (changed ? `${pilot.name}’s roster is ready to compare.` : "No emailed roster available yet.");
  } catch (error) { emailStatus.textContent = error.message; }
  finally { emailBusy = false; renderEmailConnections(); }
});
emailConnectionList.addEventListener("click", event => {
  const button = event.target.closest("[data-disconnect-email]");
  if (!button || emailBusy || isProcessing) return;
  emailConnections.splice(Number(button.dataset.disconnectEmail), 1);
  renderEmailConnections();
  persistState();
  emailStatus.textContent = "Disconnected. Downloaded rosters remain on this device; use Remove or Clear saved data to delete them.";
});
