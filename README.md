# Roster Compare

Browser-only web app for comparing two crew roster text files.

## Current Scope

- Upload one TXT roster for each crew member
- Works directly in Safari on iPhone and iPad
- Runs entirely in the browser with no server dependency
- Compares shared days off: `A`, `X`, `AL`, `GL`, `LSL`
- Compares same-port overlap of at least one hour
- Flags brief same-port arrival/departure crossovers
- Marks unresolved duties as uncertain

PDF support is intentionally out of scope for this version.

## Use

Open the hosted web app in a browser, then choose one text roster for each crew member and tap `Compare rosters`.

If you want to run it locally without deploying, serve the repository as a static site with any simple file server.

## Mobile

- Open the site in Safari on iPhone or iPad
- Select the two roster text files from Files
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
