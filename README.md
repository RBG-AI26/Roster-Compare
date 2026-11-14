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
- Compares shared days off: `A`, `X`, `RX`, `AL`, `GL`, `HL`, `LSL` (plus short-haul `D/O`, `LA`, `A/V`)
- Compares same-port shared time using a configurable minutes-in-port threshold
- Includes partial days before duty report and after release, with the exact overlap times
- Marks unresolved duties as uncertain
- Displays a Monday-first month calendar with coloured pilot rows, multi-day trip bars and shared-port highlights
- Opens the complete roster period, including all eight weeks of a 56-day roster; optional month view retains previous/next navigation
- Set a home city / domicile for each pilot; days off use that port and reserve duties use an explicit roster port or the roster base
- Switch between light and dark appearances using the header switch; the device remembers the choice independently of saved rosters
- Shows exact flight and overlap times when a calendar bar is clicked; smaller screens can scroll the calendar horizontally

PDF support is intentionally out of scope for this version. Two-crew comparisons retain reserve-at-base matching; comparisons of three to five crew show shared days off and common port windows.

## Use

Open the hosted web app and add up to five text rosters. The app parses them once, prepares and retains comparisons for every crew selection, and displays the selected crew immediately. Tick or untick crew to switch results. There is no manual Compare button. Results also update when files are added or removed. At least two selected crew are required; reducing the selection below two hides results but retains the comparisons for the next valid selection.

If you want to run it locally without deploying, serve the repository as a static site with any simple file server.

## Calendar

The calendar appears above the comparison table. Full roster is the default and covers the union of the selected rosters' dates, with no six-week limit. Use Calendar range to switch to Month view. The range and displayed month are saved on the device. It updates with the selected crew and the port-match threshold. Green bars indicate a shared port that is everyone's domicile, purple indicates one or more crew's domiciles, and blue indicates an away port for everyone. Every selected pilot must share the highlighted port window.

Each crew card has a Home city / domicile selector limited to Adelaide, Brisbane, Canberra, Darwin, Hobart, Melbourne, Perth and Sydney. It defaults to the roster base when that is an Australian capital. A saved non-capital domicile falls back to a capital-city base; otherwise choose a capital before any home presence is assumed. A day off is assumed to be spent at the selected domicile and marked with `*`. Changing domicile immediately recalculates both the calendar and comparison table and saves the setting with that roster. Reserve / standby duties use their explicit roster port where supplied, otherwise the roster base. Duty start and finish days also include their free portions, marked as assumed at the selected domicile. Commute time is not included. Unknown duties and missing roster dates never imply a location. Reserve windows are labelled **on call** and do not mean free time. Days off at different domiciles remain in the comparison table but do not create a shared-port calendar bar.

The calendar uses the existing parser's roster-local wall dates and times; it does not add time-zone conversion or turn the times into UTC instants. Bars cover each touched calendar date; click to see their exact times.

## Duty start and finish days

The calendar and comparison table include assumed domicile presence before report and after release, as well as full days off. For example, a duty landing at 05:00 and releasing at **05:30 on 15 December** becomes available from **05:30**, not midnight the next day and not the landing time. A following duty starting at 07:45 ends the shared window at 07:45. These intersections apply to any two to five selected pilots and use the same minimum-overlap threshold.

ARMS calendar columns retain separate report-only and end-only fields. Short-haul calendar report/release times and printed `Rpt` / `Rls` pattern detail times are supported. Known training and reserve duties use their resolved location and valid times; a single known start or finish can supply availability on that side only. No release is invented from landing, credit or a standard post-flight allowance.

Duty intervals cover complete trips, including layovers and interleaved training. Multiple separate duties on a date expose only the gaps between them; overnight duties trim the following day's day-off assumption. Unknown duties, missing dates and unresolved locations do not become inferred home time. A partial interval is assigned to the selected domicile only when its neighbouring duty endpoints are at the roster base or that domicile. Changing domicile recalculates the matches without changing the roster base. Domicile presence is an assumption and includes no commute allowance or time-zone conversion.

Click a pilot's start/finish-day bar to see its home-availability intervals. Shared calendar highlights merge consecutive compatible home intervals and show exact start/end times in their details. The table labels partial-day home intersections **Shared time off**, under the existing Port match filter; full shared days off retain their separate rows.

## Non-flying duties

Duty recognition follows the sibling **Roster Export iCal** app's `public/shared/roster-parser.mjs`, `public/shared/roster-analysis.mjs` and smoke fixtures:

| Roster code | Treatment |
| --- | --- |
| `RX` | X-style day off at the selected domicile, marked as assumed |
| `EPA` / `EPC` | Emergency procedures; `SY` → SYD, `ML` → MEL, `BN` → BNE, `PH` → PER |
| `TSPD` | Training in MEL, matching the export app's Melbourne rule |
| `SIM…` | Simulator; retain the exercise code and resolve the port from the roster column, matching same-port sector/pattern or an explicit known airport in the detail |
| `EPE`, `TPA`, `TPAX`, `TNR`, `PMI`, `EBT`, `TRAIN…`, `TRG` | Recognised ground / training duties; require location evidence rather than assuming base |
| `SR`, `R`, numbered reserve, `RSV`, `RES`, `RESERVE` | Standby / reserve, on call, at the explicit roster port or base |
| `AL`, `GL`, `HL`, `LSL`, short-haul `LA` | Named leave with the existing assumed-home treatment |
| `SL`, `UL` | Sick / upline sick leave, recognised but no home presence or free time inferred |

Timed ground duties use valid report/end times, including overnight finishes; matched same-port sector times are a fallback. Credit (including the export analyser's derived 330-minute credit) never supplies elapsed duty time. Missing times create a named calendar marker, not a full-day presence window. Explicit roster ports take priority over decoded defaults. Generic training codes without a reliable port retain a specific location warning.

SIM rows interleaved with travel remain within one trip occurrence. Same-port SIM sectors show ground duties rather than flight routes. Ground windows take precedence over overlapping layover windows and are labelled **on duty** in the calendar and comparisons. A day-off marker alongside a duty cannot create assumed home presence; a known overnight duty also trims the following day's assumed home window. Remaining uncertainties show the recognised duty name and the exact missing detail.

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

Run `node --test tests/*.test.mjs` for module-export, comparison, date-resolution, duty-boundary, calendar and upload/state regression checks. The module-startup check verifies that every named browser import is actually exported, preventing the startup failure that left import and Compare inactive. Upload/state checks use a small DOM adapter; they do not replace browser layout and interaction checks.

Application scripts and styles use matching release URLs to prevent a refreshed upload screen from reusing an older comparison engine. The service worker revalidates network requests and retains an offline copy of the current release. When updating these files, keep their release values aligned in `index.html`, `app.js` and `service-worker.js`.
