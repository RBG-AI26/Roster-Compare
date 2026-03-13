# Roster Overlap

Local app for comparing two crew rosters.

## Features

- Upload multiple TXT and PDF roster files for each crew member
- Prefer `ARMS` sources over `webCIS`, then PDF email exports
- Compare shared days off: `A`, `X`, `AL`, `GL`, `LSL`
- Compare same-port overlap of at least one hour
- Flag brief same-port arrival/departure crossovers
- Mark unresolved pattern parsing as uncertain instead of silently assuming a match

## Quick Start

```bash
git clone https://github.com/RBG-AI26/Roster-Compare.git
cd Roster-Compare
./run.sh
```

Open `http://127.0.0.1:8000`.

To use it on an iPad or iPhone, keep the Mac running on the same Wi‑Fi network and open the LAN URL printed by the server in Safari.

## Manual Run

```bash
python3 server.py
```

The app uses only the Python standard library for the server. PDF parsing uses macOS native frameworks via `clang`, so this project is intended for macOS.

## iPad And iPhone

- Start the server on your Mac with `./run.sh`
- Look for the printed line `Open on iPhone/iPad at http://...`
- Open that address in Safari on the iPad or iPhone
- Optional: use Safari `Share` -> `Add to Home Screen`

The comparison still runs on the Mac, which is why PDF handling continues to work on mobile browsers.

## Files

- `server.py`: HTTP server and upload endpoint
- `roster_logic.py`: roster parsing and overlap comparison
- `pdf_extract.m`: native PDF extraction with OCR fallback
- `run.sh`: simple launcher
- `static/`: browser UI
