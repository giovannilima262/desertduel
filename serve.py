#!/usr/bin/env python3
"""Dev server for Desert Duel — multi-threaded + no-store headers.
   Threading is essential: browsers hold keep-alive connections, and a single-threaded
   server would deadlock while loading the page's images."""
import http.server, socketserver, sys, os, json, shutil, datetime

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8753
ROOT = os.path.dirname(os.path.abspath(__file__))
MAP_PATH = os.path.join(ROOT, "map.json")
BACKUP_DIR = os.path.join(ROOT, "map_backups")
MAX_BODY = 40 * 1024 * 1024        # reference images are embedded, so allow a big body

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_POST(self):
        """POST /save — write the editor's map to map.json (the only path we ever write)."""
        if self.path.rstrip("/") != "/save":
            self.send_error(404, "unknown endpoint")
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            self.send_error(413, "bad body size")
            return
        body = self.rfile.read(n)
        try:
            json.loads(body)                       # never write anything that isn't valid JSON
        except Exception as e:
            self.send_error(400, "invalid JSON: %s" % e)
            return
        # keep the previous map around — a bad overwrite shouldn't lose the work
        if os.path.exists(MAP_PATH):
            os.makedirs(BACKUP_DIR, exist_ok=True)
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            shutil.copy2(MAP_PATH, os.path.join(BACKUP_DIR, "map-%s.json" % stamp))
            backups = sorted(os.listdir(BACKUP_DIR))
            for old in backups[:-20]:              # keep the 20 most recent
                try: os.remove(os.path.join(BACKUP_DIR, old))
                except OSError: pass
        tmp = MAP_PATH + ".tmp"                    # write-then-rename = never a half-written map
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, MAP_PATH)
        out = json.dumps({"ok": True, "path": MAP_PATH, "bytes": n}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, *a):
        pass

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

with Server(("", PORT), Handler) as httpd:
    print(f"Desert Duel serving (threaded) on http://localhost:{PORT}")
    httpd.serve_forever()
