"""Static server for the table, with caching turned off and the API alongside.

`python -m http.server` sends Last-Modified and no Cache-Control, which lets a
browser reuse a script without asking whether it changed. On a site that is
edited between reloads that is the wrong default: the page keeps running the
previous version of a file the server is already serving correctly, and the
edit looks like it did nothing.

    python serve.py            # port 8090
    python serve.py 8091
    python serve.py 8090 http://127.0.0.1:8001    # a backend somewhere else

Everything the table needs is on this one port: the launcher, the display, the
controller, and - proxied from the dashboard backend - /api. That matters twice
over. The display and the controller talk over BroadcastChannel, which does not
cross origins, so they have to share an address; and with /api on that same
address the controller's calls are same-origin too, so there is no CORS to
configure and one port to remember.

The proxy is only a forwarder. The table still serves its exported GeoJSON from
disk and animates perfectly well with no backend running at all - only the
parameter controls need it - so the static side never waits on the API.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = 8090

# Where the dashboard backend is actually listening.
DEFAULT_API = os.environ.get("ECOM_API", "http://127.0.0.1:8000")
API_PREFIX = "/api"

# A dispatch of the whole campus takes a few seconds, and an optimisation run
# can take minutes. The proxy waits as long as the backend is willing to work.
API_TIMEOUT = 600

# Hop-by-hop headers: they describe this connection, not the response, and
# passing them on is how a proxy ends up claiming a chunked body it has
# already assembled.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-encoding",
    "content-length",
}


# Local assets referenced from an HTML page, so their URLs can be stamped.
# Images included: the Chalmers mark went stale the same way a script does,
# and an <img> is no less cacheable for being easy to overlook.
ASSET_REF = re.compile(
    r'(?P<attr>(?:src|href)=")'
    r'(?P<url>(?!https?:|//|data:)[^"?#]+[.](?:js|css|png|jpg|jpeg|gif|svg|webp))'
    r'(?P<tail>[^"]*)"'
)


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serves the current file, every time.

    HTML responses get their local script and stylesheet URLs stamped with the
    file's modification time. no-store only helps once the browser asks; a copy
    cached earlier under a plain `python -m http.server` - which sends
    Last-Modified and no Cache-Control, so it is heuristically cacheable - is
    reused without asking at all. Stamping the URL is the only thing a cache
    cannot answer from its existing entry, and doing it here means every asset
    is covered rather than the handful anyone remembered to version by hand.
    """

    def stamp(self, match: "re.Match") -> str:
        url = match.group("url")
        target = Path(self.translate_path("/" + url.lstrip("/")))
        if not target.is_file():
            # Relative to the page rather than the root; leave it be.
            return match.group(0)
        version = int(target.stat().st_mtime)
        tail = match.group("tail")
        joiner = "&" if tail.startswith("?") else "?"
        return f'{match.group("attr")}{url}{tail}{joiner}v={version}"'

    # ------------------------------------------------------------ the API

    def is_api(self) -> bool:
        return self.path == API_PREFIX or self.path.startswith(API_PREFIX + "/")

    def do_GET(self) -> None:          # noqa: N802 - the base class spells it so
        if self.is_api():
            self.proxy()
            return
        super().do_GET()

    def do_HEAD(self) -> None:         # noqa: N802
        if self.is_api():
            self.proxy()
            return
        super().do_HEAD()

    def do_POST(self) -> None:         # noqa: N802
        self.proxy() if self.is_api() else self.send_error(501, "Unsupported method")

    def do_PUT(self) -> None:          # noqa: N802
        self.proxy() if self.is_api() else self.send_error(501, "Unsupported method")

    def do_DELETE(self) -> None:       # noqa: N802
        self.proxy() if self.is_api() else self.send_error(501, "Unsupported method")

    def proxy(self) -> None:
        """Forward one request to the backend and return what it says."""
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        request = urllib.request.Request(
            self.server.api_base + self.path, data=body, method=self.command)
        for name in ("Content-Type", "Accept"):
            value = self.headers.get(name)
            if value:
                request.add_header(name, value)

        try:
            with urllib.request.urlopen(request, timeout=API_TIMEOUT) as response:
                self.relay(response.status, response.headers, response.read())
        except urllib.error.HTTPError as err:
            # A 422 from the backend is an answer, not a failure: the panel
            # reads the detail out of it and shows what was wrong with a value.
            self.relay(err.code, err.headers, err.read())
        except Exception as err:
            # Nothing listening, or it gave up. Said in the shape the panel
            # already knows how to read, so it reports a missing backend
            # rather than a parse error.
            self.relay(502, None, json.dumps({
                "detail": f"No backend at {self.server.api_base}: {err}"
            }).encode("utf-8"), content_type="application/json")

    def relay(self, status, headers, body, content_type=None) -> None:
        self.send_response(status)
        if content_type is None and headers is not None:
            content_type = headers.get("Content-Type")
        self.send_header("Content-Type", content_type or "application/json")
        self.send_header("Content-Length", str(len(body)))
        if headers is not None:
            for name, value in headers.items():
                if name.lower() not in HOP_BY_HOP and name.lower() != "content-type":
                    self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # --------------------------------------------------------- static files

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if path.suffix.lower() not in (".html", ".htm") or not path.is_file():
            return super().send_head()

        body = ASSET_REF.sub(self.stamp, path.read_text(encoding="utf-8")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_header(self, keyword: str, value: str) -> None:
        # SimpleHTTPRequestHandler adds Last-Modified, which is enough on its
        # own for a browser to serve a cached copy heuristically. Dropped so
        # no-store is the only instruction it gets.
        if keyword == "Last-Modified":
            return
        super().send_header(keyword, value)

    # Every request is logged, successes included. Silencing them saved a few
    # lines of noise and cost the ability to answer "did the browser actually
    # ask for this file?", which is the only question that matters when a page
    # looks unchanged.


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    api_base = sys.argv[2].rstrip("/") if len(sys.argv) > 2 else DEFAULT_API
    handler = partial(NoCacheHandler, directory=str(HERE))
    server = ThreadingHTTPServer(("", port), handler)
    # Threaded, so a dispatch that takes ten seconds does not hold up the page
    # that asked for it or anything else being served meanwhile.
    server.api_base = api_base
    print(f"MR table on http://localhost:{port}  (no-store, edits show on reload)")
    print(f"  launcher   http://localhost:{port}/launcher.html")
    print(f"  display    http://localhost:{port}/index.html")
    print(f"  controller http://localhost:{port}/controller.html")
    print(f"  authoring  http://localhost:{port}/authoring.html")
    print(f"  api        http://localhost:{port}/api  ->  {api_base}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
