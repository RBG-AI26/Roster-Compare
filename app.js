import { compareRosterGroup, parseRosterText } from "./roster-browser.js?v=20261114-4";
import { buildRosterCalendar, calendarBounds, initialCalendarMonth, dateKey, renderCalendarMarkup } from "./roster-calendar.js?v=20261114-4";

const STORAGE_KEY = "roster-compare-state-v2";
const VALID_FILTERS = new Set(["all", "port_match", "shared_day_off"]);

const form = document.getElementById("compare-form");
const compareButton = document.getElementById("compare-button");
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
let calendarMonth = null;
let calendarModel = null;

let loadedRosters = [];
let isProcessing = false;
let currentPayload = null;
const comparisonCache = new Map();
let activeFilter = "all";
let deferredInstallPrompt = null;
let pendingReloadForServiceWorker = false;

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

function moveCalendarMonth(offset) {
  if (!calendarMonth || !currentPayload) return;
  const calendarRosters = selectedRosters().map((roster) => roster.parsed);
  const bounds = calendarBounds(calendarRosters);
  const next = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
  if (next < bounds.first || next > bounds.last) return;
  calendarMonth = next;
  renderCalendar();
  persistState();
}

function renderCalendar() {
  const calendarRosters = selectedRosters().map((roster) => roster.parsed);
  const bounds = calendarBounds(calendarRosters);
  if (!calendarMonth || calendarMonth < bounds.first || calendarMonth > bounds.last) {
    calendarMonth = initialCalendarMonth(calendarRosters);
  }
  calendarModel = buildRosterCalendar(calendarRosters, calendarMonth, { minOverlapMinutes: Number(minOverlapInput.value || 60) });
  calendarTitle.textContent = calendarModel.title;
  calendarPrevious.disabled = calendarMonth <= bounds.first;
  calendarNext.disabled = calendarMonth >= bounds.last;
  calendarLegend.innerHTML = calendarModel.crews.map((crew) => `<span style="--crew-colour: ${crew.colour}"><strong>${escapeHtml(crew.name)}</strong><span>Base ${escapeHtml(crew.base || "unknown")}</span></span>`).join("");
  calendarGrid.innerHTML = renderCalendarMarkup(calendarModel);
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
  const input = event.target.closest("[data-roster-index]");
  if (!input || isProcessing) return;
  loadedRosters[Number(input.dataset.rosterIndex)].selected = input.checked;
  updateSelection();
});
crewList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-index]");
  if (!button || isProcessing) return;
  loadedRosters.splice(Number(button.dataset.removeIndex), 1);
  comparisonCache.clear();
  prepareComparisons();
  renderCrewList();
  updateSelection();
});

minOverlapInput.addEventListener("change", () => {
  persistState();
  if (currentPayload && minOverlapInput.checkValidity()) rerunComparison();
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
  if (isProcessing) return;
  clearPersistedState();
  loadedRosters = [];
  comparisonCache.clear();
  activeFilter = "all";
  calendarMonth = null;
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
  if (isProcessing || !files.length) return;
  if (loadedRosters.length + files.length > MAX_ROSTERS) {
    uploadStatus.textContent = `You can load up to ${MAX_ROSTERS} rosters. Remove a loaded roster or choose fewer files.`;
    fileInput.value = "";
    return;
  }
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
    const text = await file.text();
    return { fileName: file.name, text, parsed: parseRosterText(file.name, text), selected: true };
  }));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      messages.push(`${files[index].name}: ${outcome.reason instanceof Error ? outcome.reason.message : "Could not read this roster."}`);
    } else if (loadedRosters.some((roster) => roster.text === outcome.value.text)) {
      messages.push(`${files[index].name}: this roster is already loaded.`);
    } else {
      loadedRosters.push(outcome.value);
      added += 1;
    }
  });
  isProcessing = false;
  fileInput.disabled = false;
  clearStorageButton.disabled = false;
  fileInput.value = "";
  if (added) {
    comparisonCache.clear();
    prepareComparisons();
  }
  renderCrewList();
  rerunComparison();
  persistState();
  uploadStatus.textContent = [`${added} roster${added === 1 ? "" : "s"} added.`, ...messages].join(" ");
}

function selectedRosters() {
  return loadedRosters.filter((roster) => roster.selected);
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
  compareButton.disabled = isProcessing || count < 2;
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
      <div class="crew-row">
        <label class="crew-choice">
          <input type="checkbox" data-roster-index="${index}" ${roster.selected ? "checked" : ""} ${isProcessing ? "disabled" : ""} />
          <span class="crew-details">
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml([crew.staffNumber && `Staff ${crew.staffNumber}`, crew.base, crew.bidPeriod && `BP ${crew.bidPeriod}`].filter(Boolean).join(" · ") || "Crew details unavailable")}</span>
            <span>${escapeHtml(crew.coverageStart.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))} – ${escapeHtml(crew.coverageEnd.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))}</span>
            <span class="crew-filename">${escapeHtml(roster.fileName)}</span>
          </span>
        </label>
        <button type="button" class="secondary-button remove-roster" data-remove-index="${index}" aria-label="Remove ${escapeHtml(name)}" ${isProcessing ? "disabled" : ""}>Remove</button>
      </div>`;
  }).join("") : '<p class="empty-state">Your crew will appear here after you add rosters.</p>';
}

function prepareComparisons() {
  if (!minOverlapInput.checkValidity()) return;
  const minutes = Number(minOverlapInput.value || 60);
  for (let mask = 1; mask < (1 << loadedRosters.length); mask += 1) {
    const rosters = loadedRosters.filter((_, index) => mask & (1 << index));
    if (rosters.length < 2) continue;
    comparisonCache.set(`${minutes}:${mask}`, compareRosterGroup(rosters.map((roster) => roster.parsed), { minPortOverlapMinutes: minutes }));
  }
}

function rerunComparison() {
  const rosters = selectedRosters();
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
      comparisonCache.set(key, compareRosterGroup(rosters.map((roster) => roster.parsed), { minPortOverlapMinutes: minutes }));
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
    resultsBody.innerHTML = `<tr><td colspan="${4 + payload.crews.length * 2}" class="empty-state">No matches found under the current rules.</td></tr>`;
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

  statusEl.textContent = `Comparison complete. ${filteredMatches.length} displayed match(es) of ${payload.matches.length} total.`;
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
                <span class="duty-code">${escapeHtml(item.duty_code)}</span>
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
      <li>Bid period: ${escapeHtml(summary.bid_period || "Unknown")}</li>
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
        minOverlapMinutes: Number(minOverlapInput.value || 60),
        currentInputs: {
          rosters: loadedRosters.map(({ fileName, text, selected }) => ({ fileName, text, selected })),
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

  for (const roster of savedState.currentInputs.rosters) {
    try {
      loadedRosters.push({ ...roster, selected: roster.selected !== false, parsed: parseRosterText(roster.fileName, roster.text) });
    } catch {
      uploadStatus.textContent = "Some saved rosters could not be read. Add those files again.";
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
      value.rosters.every((roster) => roster && typeof roster.fileName === "string" && typeof roster.text === "string")
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

renderCrewList();
updateActiveFilterButton();
restorePersistedState();
