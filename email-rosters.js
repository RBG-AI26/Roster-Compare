export const EMAIL_ROSTER_API = 'https://roster-export-ical.rosterical.workers.dev/api/overlap/sync';

export function connectionToken(value) {
  const match = String(value || '').trim().match(/^(?:roster-overlap:)?([a-f0-9]{48})$/i);
  if (!match) throw new Error('Paste the private Overlap connection code supplied by the roster owner or administrator.');
  return match[1].toLowerCase();
}

export function knownEmailPeriods(rosters, staffNumber) {
  const known = {};
  for (const roster of rosters) for (const file of roster.files) {
    if (file.emailSource?.staffNumber === staffNumber) known[file.emailSource.periodKey] = file.emailSource.contentHash;
  }
  return known;
}

export async function fetchEmailRosters(connection, known = {}, fetcher = globalThis.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetcher(EMAIL_ROSTER_API, {
      method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connectionToken(connection.code)}` },
      body: JSON.stringify({ known }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'Could not refresh emailed rosters.');
    if (!data || !/^\d{4,}$/.test(data.staffNumber || '') || !Array.isArray(data.changed) || !Array.isArray(data.periods) || !Array.isArray(data.unavailable)) throw new Error('The roster service returned an invalid response.');
    if (connection.staffNumber && connection.staffNumber !== data.staffNumber) throw new Error('This connection returned a different pilot. The saved roster was retained.');
    const listed = new Map(data.periods.map(period => [period.periodKey, period.contentHash]));
    if (data.changed.length > 64 || data.changed.some(period => typeof period.rosterText !== 'string' || !period.rosterText.trim() || period.rosterText.length > 2000000 || typeof period.fileName !== 'string' || !/^[a-f0-9]{64}$/.test(period.contentHash || '') || listed.get(period.periodKey) !== period.contentHash)) throw new Error('The roster service returned invalid roster periods.');
    for (const period of data.changed) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(period.rosterText));
      const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== period.contentHash) throw new Error('A roster download was incomplete. The saved roster was retained; refresh again.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The roster service took too long. The saved roster was retained; refresh again.');
    if (error instanceof TypeError) throw new Error('Could not reach the roster service. The saved roster was retained; check your connection and refresh again.');
    throw error;
  } finally { clearTimeout(timeout); }
}

// Validate and parse every changed period before replacing any of a pilot's files.
export function prepareEmailFiles(data, existingFiles, parse) {
  const updates = data.changed.map(period => {
    const parsed = parse(period.fileName, period.rosterText);
    if (String(parsed.staffNumber || '') !== data.staffNumber) throw new Error('A downloaded roster belongs to a different pilot. The saved roster was retained.');
    return { fileName: period.fileName, text: period.rosterText, parsed,
      emailSource: { staffNumber: data.staffNumber, periodKey: period.periodKey, contentHash: period.contentHash,
        storedAtUtc: period.storedAtUtc, issuedAt: period.issuedAt } };
  });
  const updatedKeys = new Set(updates.map(file => file.emailSource.periodKey));
  const files = existingFiles.filter(file => !(file.emailSource?.staffNumber === data.staffNumber && updatedKeys.has(file.emailSource.periodKey)) && !updates.some(update => update.text === file.text));
  return [...files, ...updates];
}
