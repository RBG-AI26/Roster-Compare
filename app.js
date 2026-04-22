import { compareRosterGroupTexts } from "./roster-browser.js";

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
const fileInputs = Array.from(form.querySelectorAll('input[type="file"]'));

let currentInputs = null;
let currentPayload = null;
let activeFilter = "all";
let deferredInstallPrompt = null;
let pendingReloadForServiceWorker = false;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
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
  minOverlapInput.value = "60";
  resultsEl.classList.add("hidden");
  resultsHead.innerHTML = "";
  resultsBody.innerHTML = "";
  notesEl.innerHTML = "";
  renderSummaries([emptySummary("Crew A"), emptySummary("Crew B"), emptySummary("Crew C")]);
  updateResultsTableHeaders([emptySummary("Crew A"), emptySummary("Crew B")]);
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
  const crewCFile = form.elements.crew_c.files[0];
  if (!crewAFile || !crewBFile) {
    statusEl.textContent = "Choose one text roster for each crew member.";
    return;
  }

  compareButton.disabled = true;
  statusEl.textContent = crewCFile
    ? "Reading 3 rosters and comparing shared overlap..."
    : "Reading rosters and comparing port matches...";

  try {
    const rosterFiles = [crewAFile, crewBFile, crewCFile].filter(Boolean);
    const rosterTexts = await Promise.all(rosterFiles.map((file) => file.text()));
    currentInputs = {
      rosters: rosterFiles.map((file, index) => ({
        fileName: file.name,
        text: rosterTexts[index],
      })),
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
    const payload = compareRosterGroupTexts(currentInputs.rosters, {
      minPortOverlapMinutes: Number(minOverlapInput.value || 60),
    });
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
      <li>Uncertain duties: ${escapeHtml(String(summary.unresolved_duties.length))}</li>
    </ul>
    ${uncertainMarkup}
    </article>
  `;
}

function emptySummary(label = "No roster loaded") {
  return {
    crew_name: label,
    display_name: label,
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
        minOverlapMinutes: Number(minOverlapInput.value || 60),
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

  const minOverlapMinutes =
    savedState.minOverlapMinutes != null
      ? Number(savedState.minOverlapMinutes)
      : savedState.minOverlapHours != null
        ? Number(savedState.minOverlapHours) * 60
        : null;
  if (Number.isFinite(minOverlapMinutes) && minOverlapMinutes >= 1) {
    minOverlapInput.value = String(minOverlapMinutes);
  }

  if (VALID_FILTERS.has(savedState.activeFilter)) {
    activeFilter = savedState.activeFilter;
  }

  if (!isPersistedInputs(savedState.currentInputs)) {
    return;
  }

  currentInputs = savedState.currentInputs;
  currentInputs.rosters.forEach((roster, index) => {
    renderFileListMessage(
      document.querySelector(`[data-file-list="crew_${String.fromCharCode(97 + index)}"]`),
      `${roster.fileName} (saved on this device)`
    );
  });
  rerunComparison();
  if (currentPayload) {
    statusEl.textContent = `Restored saved comparison from this device. ${statusEl.textContent}`;
  }
}

function isPersistedInputs(value) {
  return Boolean(
    value &&
      Array.isArray(value.rosters) &&
      value.rosters.length >= 2 &&
      value.rosters.length <= 3 &&
      value.rosters.every((roster) => typeof roster.fileName === "string" && typeof roster.text === "string")
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

renderSummaries([emptySummary("Crew A"), emptySummary("Crew B"), emptySummary("Crew C")]);
updateResultsTableHeaders([emptySummary("Crew A"), emptySummary("Crew B")]);
updateActiveFilterButton();
restorePersistedState();
