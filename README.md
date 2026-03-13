# Roster Overlap

Local app for comparing two crew rosters.

## Features

- Upload multiple TXT and PDF roster files for each crew member
- Prefer `ARMS` sources over `webCIS`, then PDF email exports
- Compare shared days off: `A`, `X`, `AL`, `GL`, `LSL`
- Compare same-port overlap of at least one hour
- Flag brief same-port arrival/departure crossovers
- Mark unresolved pattern parsing as uncertain instead of silently assuming a match

## Run

```bash
python3 server.py
```

Open `http://127.0.0.1:8000`.

## Files

- `server.py`: HTTP server and upload endpoint
- `roster_logic.py`: roster parsing and overlap comparison
- `pdf_extract.m`: native PDF extraction with OCR fallback
- `static/`: browser UI
