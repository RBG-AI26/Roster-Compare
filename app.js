import { compareRosterTexts } from "./roster-browser.js";

const STORAGE_KEY = "roster-compare-state-v2";
const VALID_FILTERS = new Set(["all", "port_match", "shared_day_off"]);

const form = document.getElementById("compare-form");
const compareButton = document.getElementById("compare-button");
const installButton = document.getElementById("install-button");
const clearStorageButton = document.getElementById("clear-storage-button");
const minOverlapInput = document.getElementById("min-overlap-hours");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const resultsBody = document.getElementById("results-body");
const resultsCrewAHeader = document.getElementById("results-crew-a-header");
const resultsCrewAWindowHeader = document.getElementById("results-crew-a-window-header");
const resultsCrewBHeader = document.getElementById("results-crew-b-header");
const resultsCrewBWindowHeader = document.getElementById("results-crew-b-window-header");
const notesEl = document.getElementById("notes");
const summaryA = document.getElementById("summary-a");
const summaryB = document.getElementById("summary-b");
const filterBar = document.getElementById("match-filters");
const fileInputs = Array.from(form.querySelectorAll('input[type="file"]'));

let currentInputs = null;
let currentPayload = null;
let activeFilter = "all";
let deferredInstallPrompt = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
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

for (const input of fileInputs) {
  input.addEventListener("change", () => renderFileList(input));
}

minOverlapInput.addEventListener("change", () => {
  persistState();
  if (currentInputs) {
    rerunComparison();
  }
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
  clearPersistedState();
  currentInputs = null;
  currentPayload = null;
  activeFilter = "all";
  form.reset();
  minOverlapInput.value = "1";
  resultsEl.classList.add("hidden");
  resultsBody.innerHTML = "";
  notesEl.innerHTML = "";
  renderSummary(summaryA, "Crew A", emptySummary());
  renderSummary(summaryB, "Crew B", emptySummary());
  updateResultsTableHeaders(emptySummary(), emptySummary());
  for (const input of fileInputs) {
    renderFileList(input);
  }
  updateActiveFilterButton();
  statusEl.textContent = "Saved comparison removed from this device.";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const crewAFile = form.elements.crew_a.files[0];
  const crewBFile = form.elements.crew_b.files[0];
  if (!crewAFile || !crewBFile) {
    statusEl.textContent = "Choose one text roster for each crew member.";
    return;
  }

  compareButton.disabled = true;
  statusEl.textContent = "Reading rosters and comparing port matches...";

  try {
    const [crewAText, crewBText] = await Promise.all([crewAFile.text(), crewBFile.text()]);
    currentInputs = {
      crewAFileName: crewAFile.name,
      crewAText,
      crewBFileName: crewBFile.name,
      crewBText,
    };
    rerunComparison();
  } catch (error) {
    resultsEl.classList.add("hidden");
    statusEl.textContent = error instanceof Error ? error.message : "Comparison failed.";
  } finally {
    compareButton.disabled = false;
  }
});

function rerunComparison() {
  if (!currentInputs) {
    return;
  }

  try {
    const payload = compareRosterTexts(
      currentInputs.crewAFileName,
      currentInputs.crewAText,
      currentInputs.crewBFileName,
      currentInputs.crewBText,
      { minPortOverlapHours: Number(minOverlapInput.value || 1) }
    );
    currentPayload = payload;
    renderResults(payload);
    persistState();
  } catch (error) {
    currentPayload = null;
    resultsEl.classList.add("hidden");
    statusEl.textContent = error instanceof Error ? error.message : "Comparison failed.";
  }
}

function renderFileList(input) {
  const list = document.querySelector(`[data-file-list="${input.name}"]`);
  const message = input.files.length
    ? `${input.files[0].name} (${Math.round(input.files[0].size / 1024)} KB)`
    : "No file selected.";
  renderFileListMessage(list, message);
}

function renderResults(payload) {
  resultsEl.classList.remove("hidden");
  renderSummary(summaryA, "Crew A", payload.crew_a);
  renderSummary(summaryB, "Crew B", payload.crew_b);
  updateResultsTableHeaders(payload.crew_a, payload.crew_b);

  const filteredMatches = payload.matches.filter((match) => activeFilter === "all" || match.match_key === activeFilter);
  resultsBody.innerHTML = "";
  if (!filteredMatches.length) {
    resultsBody.innerHTML = '<tr><td colspan="8" class="empty-state">No matches found under the current rules.</td></tr>';
  }

  for (const match of filteredMatches) {
    const row = document.createElement("tr");
    row.className = match.visual_group === "away_port" ? "away-port-row" : "home-match-row";
    row.innerHTML = `
      <td>${escapeHtml(match.date)}</td>
      <td>${escapeHtml(match.port)}</td>
      <td>${escapeHtml(match.match_type)}</td>
      <td>${escapeHtml(match.overlap_window)}</td>
      <td>${escapeHtml(match.crew_a)}</td>
      <td>${escapeHtml(match.window_a)}</td>
      <td>${escapeHtml(match.crew_b)}</td>
      <td>${escapeHtml(match.window_b)}</td>
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

function renderSummary(target, label, summary) {
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

  target.innerHTML = `
    <p class="eyebrow">${label}</p>
    <h3>${escapeHtml(summary.crew_name)}</h3>
    <ul class="summary-meta">
      <li>Staff number: ${escapeHtml(summary.staff_number || "Unknown")}</li>
      <li>Base: ${escapeHtml(summary.base || "Unknown")}</li>
      <li>Bid period: ${escapeHtml(summary.bid_period || "Unknown")}</li>
      <li>Uncertain duties: ${escapeHtml(String(summary.unresolved_duties.length))}</li>
    </ul>
    ${uncertainMarkup}
  `;
}

function emptySummary() {
  return {
    crew_name: "No roster loaded",
    staff_number: null,
    base: null,
    bid_period: null,
    unresolved_duties: [],
  };
}

function renderFileListMessage(list, message) {
  list.innerHTML = "";
  const item = document.createElement("li");
  item.textContent = message;
  list.appendChild(item);
}

function updateActiveFilterButton() {
  for (const button of filterBar.querySelectorAll("[data-filter]")) {
    button.classList.toggle("is-active", button.dataset.filter === activeFilter);
  }
}

function updateResultsTableHeaders(crewA, crewB) {
  const crewAFirstName = getFirstName(crewA.crew_name) || "Crew A";
  const crewBFirstName = getFirstName(crewB.crew_name) || "Crew B";

  resultsCrewAHeader.textContent = crewAFirstName;
  resultsCrewAWindowHeader.textContent = "Window";
  resultsCrewBHeader.textContent = crewBFirstName;
  resultsCrewBWindowHeader.textContent = "Window";
}

function getFirstName(fullName) {
  if (!fullName || fullName === "No roster loaded") {
    return "";
  }

  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
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
        minOverlapHours: Number(minOverlapInput.value || 1),
        currentInputs,
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

  const minOverlapHours = Number(savedState.minOverlapHours);
  if (Number.isFinite(minOverlapHours) && minOverlapHours >= 1 && minOverlapHours <= 24) {
    minOverlapInput.value = String(minOverlapHours);
  }

  if (VALID_FILTERS.has(savedState.activeFilter)) {
    activeFilter = savedState.activeFilter;
  }

  if (!isPersistedInputs(savedState.currentInputs)) {
    return;
  }

  currentInputs = savedState.currentInputs;
  renderFileListMessage(
    document.querySelector('[data-file-list="crew_a"]'),
    `${currentInputs.crewAFileName} (saved on this device)`
  );
  renderFileListMessage(
    document.querySelector('[data-file-list="crew_b"]'),
    `${currentInputs.crewBFileName} (saved on this device)`
  );
  rerunComparison();
  if (currentPayload) {
    statusEl.textContent = `Restored saved comparison from this device. ${statusEl.textContent}`;
  }
}

function isPersistedInputs(value) {
  return Boolean(
    value &&
      typeof value.crewAFileName === "string" &&
      typeof value.crewAText === "string" &&
      typeof value.crewBFileName === "string" &&
      typeof value.crewBText === "string"
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

for (const input of fileInputs) {
  renderFileList(input);
}

renderSummary(summaryA, "Crew A", emptySummary());
renderSummary(summaryB, "Crew B", emptySummary());
updateResultsTableHeaders(emptySummary(), emptySummary());
updateActiveFilterButton();
restorePersistedState();
