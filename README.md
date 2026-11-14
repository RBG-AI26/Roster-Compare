# Roster Compare

Browser-only web app for loading up to five crew roster text files and comparing selected crew.

## Current Scope

- Add up to five TXT rosters through one multi-file picker or drag-and-drop area
- Process files immediately and show crew names, staff numbers, bases and bid periods
- Select any two to five loaded crew for a comparison of overlap shared by everyone selected
- Add or remove rosters without reloading the other files
- Report unreadable files individually and skip duplicate roster contents
- Works directly in desktop browsers plus Safari on iPhone and iPad
- Installable PWA with an offline app shell
- Saves loaded rosters, crew selection, filter and threshold locally on the device; restores existing two/three-roster saves
- Compares shared days off: `A`, `X`, `AL`, `GL`, `LSL`
- Compares same-port shared time using a configurable minutes-in-port threshold
- Marks unresolved duties as uncertain

PDF support is intentionally out of scope for this version. Two-crew comparisons retain reserve-at-base matching; comparisons of three to five crew show shared days off and common port windows.

## Use

Open the hosted web app, add up to five text rosters, select the crew you want to compare and tap `Compare rosters`. Changing the selected crew refreshes an existing comparison. Uploading more files hides old results until you compare again. At least two selected crew are required.

If you want to run it locally without deploying, serve the repository as a static site with any simple file server.

## Mobile

- Open the site in Safari on iPhone or iPad
- Select up to five roster text files from Files
- Optional: use `Share` -> `Add to Home Screen`

## Deploy

This repo now includes a root `index.html`, so it can be hosted directly as a static site, including GitHub Pages.

## Main Files

- `index.html`: app entry page
- `app.js`: browser UI logic
- `roster-browser.js`: client-side roster parsing and comparison
- `styles.css`: mobile-first styling
- `manifest.json`: installable web app metadata
- `service-worker.js`: offline asset caching

## Validation

Run `node --test tests/*.test.mjs` for comparison and upload/state regression checks. Upload/state checks use a small DOM adapter; they do not replace browser layout and interaction checks.
