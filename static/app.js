const form = document.getElementById("compare-form");
const compareButton = document.getElementById("compare-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const resultsBody = document.getElementById("results-body");
const notesEl = document.getElementById("notes");
const summaryA = document.getElementById("summary-a");
const summaryB = document.getElementById("summary-b");

for (const input of form.querySelectorAll('input[type="file"]')) {
  input.addEventListener("change", () => renderFileList(input));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  compareButton.disabled = true;
  statusEl.textContent = "Parsing rosters and comparing overlap...";

  try {
    const response = await fetch("/compare", {
      method: "POST",
      body: new FormData(form),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Comparison failed.");
    }

    renderResults(payload);
    statusEl.textContent = `Comparison complete. ${payload.matches.length} match(es) found.`;
  } catch (error) {
    resultsEl.classList.add("hidden");
    statusEl.textContent = error.message;
  } finally {
    compareButton.disabled = false;
  }
});

function renderFileList(input) {
  const list = document.querySelector(`[data-file-list="${input.name}"]`);
  list.innerHTML = "";

  if (!input.files.length) {
    list.innerHTML = "<li>No files selected.</li>";
    return;
  }

  for (const file of input.files) {
    const item = document.createElement("li");
    item.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
    list.appendChild(item);
  }
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
  const notes = [...(payload.notes || [])];
  for (const parseError of payload.parse_errors || []) {
    notes.push(`Parse fallback: ${parseError}`);
  }

  if (!notes.length) {
    notes.push("No additional caveats.");
  }

  for (const note of notes) {
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
      <li>Selected source: ${escapeHtml(summary.source)}</li>
      <li>Selected file: ${escapeHtml(summary.file_name)}</li>
      <li>Off days parsed: ${escapeHtml(String(summary.off_days))}</li>
      <li>Resolved port windows: ${escapeHtml(String(summary.resolved_patterns))}</li>
      <li>Unresolved duties: ${escapeHtml(String(summary.unresolved_duties.length))}</li>
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
