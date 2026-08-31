"""Static server for the table, with caching turned off.

`python -m http.server` sends Last-Modified and no Cache-Control, which lets a
browser reuse a script without asking whether it changed. On a site that is
edited between reloads that is the wrong default: the page keeps running the
previous version of a file the server is already serving correctly, and the
edit looks like it did nothing.

    python serve.py            # port 8090
    python serve.py 8091

The display and the controller must be opened from the SAME address as each
other - they talk over BroadcastChannel, which does not cross origins.
"""
from __future__ import annotations

import io
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = 8090


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
    handler = partial(NoCacheHandler, directory=str(HERE))
    server = ThreadingHTTPServer(("", port), handler)
    print(f"MR table on http://localhost:{port}  (no-store, edits show on reload)")
    print(f"  display    http://localhost:{port}/index.html")
    print(f"  controller http://localhost:{port}/controller.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
