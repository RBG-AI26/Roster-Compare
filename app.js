import { compareRosterTexts } from "./roster-browser.js";

const form = document.getElementById("compare-form");
const compareButton = document.getElementById("compare-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const resultsBody = document.getElementById("results-body");
const notesEl = document.getElementById("notes");
const summaryA = document.getElementById("summary-a");
const summaryB = document.getElementById("summary-b");

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

for (const input of form.querySelectorAll('input[type="file"]')) {
  input.addEventListener("change", () => renderFileList(input));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const crewAFile = form.elements.crew_a.files[0];
  const crewBFile = form.elements.crew_b.files[0];
  if (!crewAFile || !crewBFile) {
    statusEl.textContent = "Choose one text roster for each crew member.";
    return;
  }

  compareButton.disabled = true;
  statusEl.textContent = "Reading rosters and comparing overlap...";

  try {
    const [crewAText, crewBText] = await Promise.all([crewAFile.text(), crewBFile.text()]);
    const payload = compareRosterTexts(crewAFile.name, crewAText, crewBFile.name, crewBText);
    renderResults(payload);
    statusEl.textContent = `Comparison complete. ${payload.matches.length} match(es) found.`;
  } catch (error) {
    resultsEl.classList.add("hidden");
    statusEl.textContent = error instanceof Error ? error.message : "Comparison failed.";
  } finally {
    compareButton.disabled = false;
  }
});

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

  resultsBody.innerHTML = "";
  if (!payload.matches.length) {
    resultsBody.innerHTML = '<tr><td colspan="8" class="empty-state">No matches found under the current rules.</td></tr>';
  }

  for (const match of payload.matches) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(match.date)}</td>
      <td>${escapeHtml(match.port)}</td>
      <td>${escapeHtml(match.match_type)}</td>
      <td>${escapeHtml(match.crew_a)}</td>
      <td>${escapeHtml(match.crew_b)}</td>
      <td>${escapeHtml(match.window_a)}</td>
      <td>${escapeHtml(match.window_b)}</td>
      <td><span class="pill">${escapeHtml(match.confidence)}</span></td>
    `;
    resultsBody.appendChild(row);
  }

  notesEl.innerHTML = "";
  for (const note of payload.notes) {
    const item = document.createElement("li");
    item.textContent = note;
    notesEl.appendChild(item);
  }
}

function renderSummary(target, label, summary) {
  target.innerHTML = `
    <p class="eyebrow">${label}</p>
    <h3>${escapeHtml(summary.crew_name)}</h3>
    <ul class="summary-meta">
      <li>Staff number: ${escapeHtml(summary.staff_number || "Unknown")}</li>
      <li>Base: ${escapeHtml(summary.base || "Unknown")}</li>
      <li>Bid period: ${escapeHtml(summary.bid_period || "Unknown")}</li>
      <li>Roster type: ${escapeHtml(summary.source)}</li>
      <li>Selected file: ${escapeHtml(summary.file_name)}</li>
      <li>Off days parsed: ${escapeHtml(String(summary.off_days))}</li>
      <li>Resolved port windows: ${escapeHtml(String(summary.resolved_patterns))}</li>
      <li>Uncertain duties: ${escapeHtml(String(summary.unresolved_duties.length))}</li>
    </ul>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
