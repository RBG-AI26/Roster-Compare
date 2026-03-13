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

## Manual Run

```bash
python3 server.py
```

The app uses only the Python standard library for the server. PDF parsing uses macOS native frameworks via `clang`, so this project is intended for macOS.

## Files

- `server.py`: HTTP server and upload endpoint
- `roster_logic.py`: roster parsing and overlap comparison
- `pdf_extract.m`: native PDF extraction with OCR fallback
- `run.sh`: simple launcher
- `static/`: browser UI
