from __future__ import annotations

import cgi
import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from roster_logic import RosterParseError, process_uploads


PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = PROJECT_ROOT / "static"


class RosterHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0]
        if path == "/" or not path:
            return str(STATIC_ROOT / "index.html")
        return str(STATIC_ROOT / path.lstrip("/"))

    def do_POST(self) -> None:
        if self.path != "/compare":
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
            return

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type"),
            },
        )

        uploaded_files = {"crew_a": [], "crew_b": []}
        for side in uploaded_files:
            field = form[side] if side in form else []
            items = field if isinstance(field, list) else [field]
            for item in items:
                if getattr(item, "filename", None):
                    uploaded_files[side].append((item.filename, item.file.read()))

        try:
            result = process_uploads(uploaded_files, PROJECT_ROOT)
            self._write_json(HTTPStatus.OK, result)
        except RosterParseError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:
            self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Unexpected error: {exc}"})

    def _write_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8000), RosterHandler)
    print("Roster Overlap app running at http://127.0.0.1:8000")
    server.serve_forever()


if __name__ == "__main__":
    main()
