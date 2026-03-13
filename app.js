import { compareRosterTexts } from "./roster-browser.js";

const form = document.getElementById("compare-form");
const compareButton = document.getElementById("compare-button");
const minOverlapInput = document.getElementById("min-overlap-hours");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const resultsBody = document.getElementById("results-body");
const notesEl = document.getElementById("notes");
const summaryA = document.getElementById("summary-a");
const summaryB = document.getElementById("summary-b");
const filterBar = document.getElementById("match-filters");

let currentInputs = null;
let currentPayload = null;
let activeFilter = "all";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

for (const input of form.querySelectorAll('input[type="file"]')) {
  input.addEventListener("change", () => renderFileList(input));
}

minOverlapInput.addEventListener("change", () => {
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
  if (currentPayload) {
    renderResults(currentPayload);
  }
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

  const payload = compareRosterTexts(
    currentInputs.crewAFileName,
    currentInputs.crewAText,
    currentInputs.crewBFileName,
    currentInputs.crewBText,
    { minPortOverlapHours: Number(minOverlapInput.value || 1) }
  );
  currentPayload = payload;
  renderResults(payload);
}

function renderFileList(input) {
  const list = document.querySelector(`[data-file-list="${input.name}"]`);
  list.innerHTML = "";

  if (!input.files.length) {
    list.innerHTML = "<li>No file selected.</li>";
    return;
  }

  const file = input.files[0];
  const item = document.createElement("li");
  item.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
  list.appendChild(item);
}

function renderResults(payload) {
  resultsEl.classList.remove("hidden");
  renderSummary(summaryA, "Crew A", payload.crew_a);
  renderSummary(summaryB, "Crew B", payload.crew_b);

  const filteredMatches = payload.matches.filter((match) => activeFilter === "all" || match.match_key === activeFilter);
  resultsBody.innerHTML = "";
  if (!filteredMatches.length) {
    resultsBody.innerHTML = '<tr><td colspan="7" class="empty-state">No matches found under the current rules.</td></tr>';
  }

  for (const match of filteredMatches) {
    const row = document.createElement("tr");
    row.className = match.visual_group === "away_port" ? "away-port-row" : "home-match-row";
    row.innerHTML = `
      <td>${escapeHtml(match.date)}</td>
      <td>${escapeHtml(match.port)}</td>
      <td>${escapeHtml(match.match_type)}</td>
      <td>${escapeHtml(match.crew_a)}</td>
      <td>${escapeHtml(match.crew_b)}</td>
      <td>${escapeHtml(match.window_a)}</td>
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

function updateActiveFilterButton() {
  for (const button of filterBar.querySelectorAll("[data-filter]")) {
    button.classList.toggle("is-active", button.dataset.filter === activeFilter);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
