# Roster Compare

Browser-only web app for loading up to five crew roster text files and comparing selected crew.

## Current Scope

- Add up to five TXT rosters through one multi-file picker or drag-and-drop area
- Process files immediately and show crew names, staff numbers, bases and bid periods
- Compare automatically on upload and retain results for every crew selection
- Resolve short-haul calendar dates from printed period dates or matching dated flight details, checking weekdays and month/year rollovers
- Select any two to five loaded crew for a comparison of overlap shared by everyone selected
- Add or remove rosters without reloading the other files
- Report unreadable files individually and skip duplicate roster contents
- Works directly in desktop browsers plus Safari on iPhone and iPad
- Installable PWA with an offline app shell
- Saves loaded rosters, crew selection, filter and threshold locally on the device; restores existing two/three-roster saves
- Compares shared days off: `A`, `X`, `AL`, `GL`, `LSL`
- Compares same-port shared time using a configurable minutes-in-port threshold
- Marks unresolved duties as uncertain
- Displays a Monday-first month calendar with coloured pilot rows, multi-day trip bars and shared-port highlights
- Opens the month containing most of the common roster period, with previous/next navigation and a saved month selection
- Shows exact flight and overlap times when a calendar bar is clicked; smaller screens can scroll the calendar horizontally

PDF support is intentionally out of scope for this version. Two-crew comparisons retain reserve-at-base matching; comparisons of three to five crew show shared days off and common port windows.

## Use

Open the hosted web app and add up to five text rosters. The app parses them once, prepares and retains comparisons for every crew selection, and displays the selected crew immediately. Tick or untick crew to switch results without pressing `Compare rosters`. Results also update when files are added or removed. At least two selected crew are required; reducing the selection below two hides results but retains the comparisons for the next valid selection.

If you want to run it locally without deploying, serve the repository as a static site with any simple file server.

## Calendar

The calendar appears above the comparison table. It updates with the selected crew and the port-match threshold. Green bars indicate a shared port that is everyone's base, purple indicates one or more crew's bases, and blue indicates an away port for everyone. Every selected pilot must share the highlighted port window.

A day off is assumed to be spent at the pilot's roster base and marked with `*`; actual home location is not separately configured. Unknown duties and missing roster dates never imply a location. Reserve windows are labelled **on call** and do not mean free time. Days off at different bases remain in the comparison table but do not create a shared-port calendar bar.

The calendar uses the existing parser's roster-local wall dates and times; it does not add time-zone conversion or turn the times into UTC instants. Bars cover each touched calendar date; click to see their exact times.

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
- `roster-calendar.js`: calendar model, shared-port windows and month rendering
- `styles.css`: mobile-first styling
- `manifest.json`: installable web app metadata
- `service-worker.js`: offline asset caching

## Validation

Run `node --test tests/*.test.mjs` for comparison and upload/state regression checks. Upload/state checks use a small DOM adapter; they do not replace browser layout and interaction checks.

Application scripts and styles use matching release URLs to prevent a refreshed upload screen from reusing an older comparison engine. The service worker revalidates network requests and retains an offline copy of the current release. When updating these files, keep their release values aligned in `index.html`, `app.js` and `service-worker.js`.
