# Roster Compare

Browser-only web app for loading roster text files for up to five pilots and comparing selected crew.

## Current Scope

- Add TXT rosters for up to five pilots through one multi-file picker or drag-and-drop area
- Process files immediately and show crew names, staff numbers, bases and bid periods
- Compare automatically on upload and retain results for every crew selection
- Resolve short-haul calendar dates from printed period dates or matching dated flight details, checking weekdays and month/year rollovers
- Select any two to five loaded crew; the Together timeline shows matching pairs and larger groups, while the table retains matches shared by all selected crew
- Add or remove rosters without reloading the other files
- Report unreadable files individually and skip duplicate roster contents
- Works directly in desktop browsers plus Safari on iPhone and iPad
- Installable PWA with an offline app shell
- Saves loaded rosters, crew selection, filter and threshold locally on the device; restores existing two/three-roster saves
- Compares shared days off: `A`, `X`, `RX`, `BL`, `AL`, `GL`, `HL`, `LSL`, `LD` (plus short-haul `D/O`, `LA`, `AV`, `A/V`)
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

Open the hosted web app and add text rosters for up to five pilots. The app parses them once, prepares and retains comparisons for every crew selection, and displays the selected crew immediately. Tick or untick crew to switch results. There is no manual Compare button. Results also update when files are added or removed. At least two selected crew are required; reducing the selection below two hides results but retains the comparisons for the next valid selection.

If you want to run it locally without deploying, serve the repository as a static site with any simple file server.

## Multiple periods for one pilot

Upload each roster period normally. Files with the same staff number combine into one pilot, one calendar row and one comparison participant. A unique matching name is used only when a staff number is missing; different staff numbers remain separate. More than five files are allowed when they belong to no more than five pilots. Adding a period preserves that pilot’s domicile, colour and selection. Removing a pilot removes all their periods. Existing saved imports are combined automatically on reload.

The calendar retains actual period coverage and real gaps. Overlapping revisions replace whole dates, retaining multiple duties on each winning date. The later printed issue timestamp takes priority; without reliable timestamps, the later import takes priority.

When adjacent long-haul rosters for the same pilot list the same trip across their boundary, the app uses the original dated flight sectors and any printed release time from the continuation. The calendar details show **Carry-in** or **Carry-out**. Load the roster containing the original flight sectors to resolve an otherwise uncertain carry-in.

## Calendar

The calendar and comparison table open on one bid period. Use the **Bid period** picker to switch between saved periods. For example, BP378 covers weeks 1–8, and short-haul BP3781 and BP3785 align to its weeks 1–4 and 5–8. When only one short-haul half is available, **Full roster** shows those four weeks. **Month** shows the selected period's dates within that month and keeps the bid-period week numbers. The chosen period, range and month are saved on the device.

Together highlights any two or more selected pilots sharing a port. Green indicates home for all pilots in that matching group, purple indicates home for some of them, and blue indicates away for all of them. An unavailable pilot does not hide another pair's overlap.

Each crew card has a Home city / domicile selector limited to Adelaide, Brisbane, Canberra, Darwin, Hobart, Melbourne, Perth and Sydney. It defaults to the roster base when that is an Australian capital. A saved non-capital domicile falls back to a capital-city base; otherwise choose a capital before any home presence is assumed. Days off use the selected domicile. Changing domicile immediately recalculates both the calendar and comparison table and saves the setting with that roster. Reserve / standby duties use their explicit roster port where supplied, otherwise the roster base. Duty start and finish days also include their free portions at the selected domicile. Commute time is not included. Unknown duties and missing roster dates never imply a location. Reserve windows are labelled **on call** and do not mean free time. Days off at different domiciles remain in the comparison table but do not create a shared-port calendar bar.

The calendar uses the existing parser's roster-local wall dates and times; it does not add time-zone conversion or turn the times into UTC instants. Bars cover each touched calendar date; click to see their exact times.

Today's date uses the viewing device's local date. Its column has a subtle shade across the date, pilot rows and Together timelines in both light and dark mode, including across multi-day trip bars.

## Duty start and finish days

The calendar and comparison table include assumed domicile presence before report and after release, as well as full days off. For example, a duty landing at 05:00 and releasing at **05:30 on 15 December** becomes available from **05:30**, not midnight the next day and not the landing time. A following duty starting at 07:45 ends the shared window at 07:45. The timeline qualifies pairs using the minimum-overlap threshold and combines coincident pairs into larger groups. The table continues to require all selected pilots to overlap.

ARMS calendar columns retain separate report-only and end-only fields. Short-haul calendar report/release times and printed `Rpt` / `Rls` pattern detail times are supported. Known training and reserve duties use their resolved location and valid times; a single known start or finish can supply availability on that side only. No release is invented from landing, credit or a standard post-flight allowance.

Duty intervals cover complete trips, including layovers and interleaved training. Multiple separate duties on a date expose only the gaps between them; overnight duties trim the following day's day-off assumption. Unknown duties, missing dates and unresolved locations do not become inferred home time. A partial interval is assigned to the selected domicile only when its neighbouring duty endpoints are at the roster base or that domicile. Changing domicile recalculates the matches without changing the roster base. Domicile presence is an assumption and includes no commute allowance or time-zone conversion.

Click a pilot's start/finish-day bar to see its home-availability intervals. The Together section has a separate weekly row for each matching crew combination, with a 24-hour strip in each day. A combination keeps the same row throughout that week, including when its location or duty status changes; only combinations with a match that week are listed. Segments fill only the shared hours, with gaps retained. Adjacent intervals merge when their ports, matching pilots and duty status agree; continuous periods join across date cells. Port codes label the segments, while the row headers list the matching pilots when more than two pilots are selected. Clicking lists only the pilots in that group. Membership changes split the period so a joining or departing pilot cannot appear in the wrong interval. Simultaneous pairs with different pilots occupy separate rows, even if their times overlap. Unrelated groups' changes do not split an otherwise continuous period in another row. Solid segments mean free time, stripes mean on call, and dots mean on duty. Duplicate representations are consolidated; duty/on-call status takes priority over a simultaneous free representation. If source data gives conflicting ports for the very same crew combination, those port alternatives remain in that combination's row. Clicking any daily segment shows the complete continuous overlap period, location and participating pilots, with on-duty/on-call status where relevant. Assumption annotations and asterisks are omitted from the interface; location and interval calculations are unchanged. The table labels partial-day home intersections **Shared time off**, under the existing Port match filter; full shared days off retain their separate rows.

## Non-flying duties

Short-haul `EP` followed by digits (for example `EP29`) is EPC emergency-procedures training. Pattern-detail `C` course rows are parsed alongside PAX sectors. A matching same-port course sector supplies its location and printed port-local times, including when calendar clocks are in roster-base time. Without a course sector, enclosing inbound/outbound PAX sectors in the same pattern can establish the training port when they agree. A base or domicile alone does not establish an EPC location. EPC time is on duty and is removed from free layover windows.

Duty recognition follows the sibling **Roster Export iCal** app's `public/shared/roster-parser.mjs`, `public/shared/roster-analysis.mjs` and smoke fixtures:

| Roster code | Treatment |
| --- | --- |
| `RX` | X-style day off at the selected domicile |
| `BL` | Day off at the selected domicile |
| Short-haul `AV`, `A/V` | Full day off at the selected domicile |
| Short-haul `MS` | Duty at the roster base, using printed report/end times; distinct from a day off or reserve |
| `EPA` / `EPC` | Emergency procedures; `SY` → SYD, `ML` → MEL, `BN` → BNE, `PH` → PER |
| `TSPD` | Training in MEL, matching the export app's Melbourne rule |
| `SIM…` | Simulator; retain the exercise code. Explicit ports, same-port sectors/patterns and airport detail take priority, followed by associated positioning / flight sectors. Without associated travel, use the roster base (not domicile). |
| `EPE`, `TPA`, `TPAX`, `TNR`, `PMI`, `EBT`, `TRAIN…`, `TRG` | Recognised ground / training duties; require location evidence rather than assuming base |
| `SR`, `R`, numbered reserve, `RSV`, `RES`, `RESERVE` | Standby / reserve, on call, at the explicit roster port or base |
| `AL`, `GL`, `HL`, `LSL`, `LD`, short-haul `LA` | Named leave with the existing assumed-home treatment |
| `SL` | Sick leave at the selected domicile |
| `UL` | Upline sick leave with an unresolved location |

Timed ground duties use valid report/end times, including overnight finishes; matched same-port sector times are a fallback. Credit (including the export analyser's derived 330-minute credit) never supplies elapsed duty time. Missing times create a named calendar marker, not a full-day presence window. Explicit roster ports take priority over decoded defaults. Generic training codes without a reliable port retain a specific location warning.

Consecutive SIM sessions form one visit when checking associated travel, including positioning on the day before or after the visit. Conflicting travel ports or a missing base stay unresolved; unrelated trips elsewhere in the roster do not prevent the base default. SIM rows interleaved with travel remain within one trip occurrence. Same-port SIM sectors show ground duties rather than flight routes. Ground windows take precedence over overlapping layover windows and are labelled **on duty** in the calendar and comparisons. A day-off marker alongside a duty cannot create assumed home presence; a known overnight duty also trims the following day's assumed home window. Remaining uncertainties show the recognised duty name and the exact missing detail.

## Mobile

- Open the site in Safari on iPhone or iPad
- Select roster text files for up to five pilots from Files
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

## Emailed roster connections

A pilot can opt in to Overlap through the **Roster Export iCal** administrator. Enable Overlap for an active approved staff member and give the pilot their private `roster-overlap:` code. For pilots who also agree to share rosters with other crew, choose **Share with crew** after publishing their subscribed calendar. Crew sharing works between pilots who have both opted in. Calendar subscription URLs and staff numbers do not grant Overlap access.

In Overlap, paste your code into **Emailed rosters → Private connection code** and choose **Connect emailed roster**. Overlap loads your roster and available shared rosters, up to five pilots. Additional shared rosters are listed under **Emailed rosters**. Remove a loaded roster to make room and choose **Add roster** for the pilot you want to compare. Connections refresh once when opening the app, or through **Refresh emailed rosters**. Emailed periods combine with manual uploads and preserve domicile, colours and selection. Changed source text is parsed locally and a pilot's update is applied only after all its changed periods validate. A failed or revoked refresh retains the last downloaded roster.

Codes and downloaded text are saved in this browser's local storage. **Disconnect** stops future refreshes but keeps downloaded rosters. **Remove** deletes a pilot's loaded rosters and disconnects them; **Clear saved data** removes all roster data and connection codes on this device. Revoking or replacing a code in Export stops future downloads after KV propagation; it cannot withdraw copies already downloaded. Share codes only with people authorised by the pilot.

The fixed API is `https://roster-export-ical.rosterical.workers.dev/api/overlap/sync`. A bearer code authorises access to the pilot's recent and future periods. Crew sharing also lets the app list other eligible crew and request a shared roster, with eligibility checked on every download. Only changed text is downloaded. The service worker does not cache private API responses. Comparisons remain on the device.

Deploy the Export API before this frontend. Export's CORS allow-list includes `https://rbg-ai26.github.io`; configure `OVERLAP_ALLOWED_ORIGINS` in that Worker if this app moves to another origin. Roster Compare can remain on GitHub Pages: no additional Cloudflare Worker or account is required.
