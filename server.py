"""Markup — a local circle-and-annotate editor for Qwen-Image 2.1.

Run it next to a stock ComfyUI. It serves the page, uploads the marked-up image to ComfyUI,
submits an edit graph over the HTTP API, and hands the result back.

    python server.py                     # http://127.0.0.1:8765
    python server.py --comfy 127.0.0.1:8188 --port 8765

The server exists for three reasons and does nothing else:

1. It hands the marked-up image to ComfyUI, which a browser cannot do across origins.
2. It proxies ComfyUI, so there is no CORS configuration for anyone to get wrong.
3. It assembles the graph, so the node wiring lives in one place rather than being retyped by
   every user.

The image goes in through ComfyUI's own `/upload/image` endpoint rather than by writing into its
`input/` directory, so a ComfyUI on another machine works the same as a local one and there is no
path to configure.

Nothing about the page requires a build step, a package manager or a framework.
"""
import argparse
import base64
import json
import mimetypes
import pathlib
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from wsprogress import ProgressWatcher

# A PyInstaller one-file build unpacks its bundled files into a temporary directory and says where
# in sys._MEIPASS. Running from source, the page sits next to this file.
HERE = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))

__version__ = "1.0.0"

# The Qwen-Image 2.1 nodes this graph needs. Older ComfyUI builds lack them, and without this check
# the first sign would be an opaque "invalid prompt" on the first Generate.
REQUIRED_NODES = ("TextEncodeQwenImage21", "QwenImage21Cache")
MODELS_URL = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1"

# Filled in from argv at startup, and changeable at runtime from the UI's address field.
CFG = {
    "comfy": "http://127.0.0.1:8188",
}
CFG_LOCK = threading.Lock()


def comfy_base():
    with CFG_LOCK:
        return CFG["comfy"]


def normalise_addr(addr):
    addr = (addr or "").strip()
    if not addr:
        raise ValueError("empty address")
    if not addr.startswith(("http://", "https://")):
        addr = "http://" + addr
    parsed = urllib.parse.urlparse(addr)
    if not parsed.hostname:
        raise ValueError(f"cannot read a host out of {addr!r}")
    return addr.rstrip("/")

JOBS = {}
JOBS_LOCK = threading.Lock()

# ComfyUI addresses progress messages to whichever client submitted the prompt, so this id has to
# travel with POST /prompt and with the websocket or no progress arrives.
CLIENT_ID = uuid.uuid4().hex
WATCHER = None
WATCHER_LOCK = threading.Lock()


def start_watcher(base):
    """Point the progress websocket at `base`, replacing any existing one."""
    global WATCHER
    with WATCHER_LOCK:
        if WATCHER is not None:
            WATCHER.stop()
        WATCHER = ProgressWatcher(base, CLIENT_ID).start()


def watcher():
    with WATCHER_LOCK:
        return WATCHER


# --------------------------------------------------------------------------- comfy

def comfy_get(path, timeout=30):
    with urllib.request.urlopen(f"{comfy_base()}{path}", timeout=timeout) as r:
        return json.loads(r.read())


def comfy_post(path, payload, timeout=60):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{comfy_base()}{path}", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def comfy_upload(raw, name, timeout=120):
    """Put the flattened image into ComfyUI's input store and return the name LoadImage needs.

    Multipart is hand-built because the stdlib has no multipart encoder and this is the only
    place the app needs one. `overwrite` is on: each job already carries a unique name, and
    without it ComfyUI silently renames a collision to `name (1).png` and returns *that*, which
    would leave the graph loading a stale image.

    The returned name may carry a subfolder, so it is joined here rather than assumed empty.
    """
    crlf = "\r\n"
    boundary = f"----markup{uuid.uuid4().hex}"
    head = []
    for field, value in (("type", "input"), ("overwrite", "true")):
        head.append(f'--{boundary}{crlf}'
                    f'Content-Disposition: form-data; name="{field}"{crlf}{crlf}'
                    f'{value}{crlf}')
    head.append(f'--{boundary}{crlf}'
                f'Content-Disposition: form-data; name="image"; filename="{name}"{crlf}'
                f'Content-Type: image/png{crlf}{crlf}')
    body = "".join(head).encode() + raw + f"{crlf}--{boundary}--{crlf}".encode()

    req = urllib.request.Request(
        f"{comfy_base()}/upload/image", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Content-Length": str(len(body))})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        info = json.loads(r.read())
    sub = info.get("subfolder") or ""
    return f"{sub}/{info['name']}" if sub else info["name"]


def build_graph(image_name, prompt, negative, seed, steps, resolution, models,
                cache_device="auto", cache_dtype="default"):
    """The Qwen-Image 2.1 edit graph, in API form.

    The reference image goes in under the dotted autogrow key `images.image_1`. Any other
    spelling is accepted by ComfyUI and silently ignored, and the graph then runs as plain
    text-to-image while still reporting success. See HANDOVER §7.
    """
    return {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": models["unet"], "weight_dtype": "default"}},
        "cache": {"class_type": "QwenImage21Cache",
                  "inputs": {"model": ["unet", 0], "device": cache_device, "dtype": cache_dtype}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": models["clip"], "type": "qwen_image",
                            "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": models["vae"]}},
        "load1": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "encode": {"class_type": "TextEncodeQwenImage21",
                   "inputs": {"clip": ["clip", 0], "prompt": prompt,
                              "negative_prompt": negative, "vae": ["vae", 0],
                              "resolution": resolution, "images.image_1": ["load1", 0]}},
        "sampler": {"class_type": "KSampler",
                    "inputs": {"model": ["cache", 0], "positive": ["encode", 0],
                               "negative": ["encode", 1], "latent_image": ["encode", 2],
                               "seed": seed, "steps": steps, "cfg": 1.0,
                               "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "decode": {"class_type": "VAEDecode",
                   "inputs": {"samples": ["sampler", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage",
                 "inputs": {"images": ["decode", 0], "filename_prefix": "markup/edit"}},
    }


def run_job(job_id, payload):
    def fail(msg):
        with JOBS_LOCK:
            JOBS[job_id].update(status="error", error=msg)

    try:
        raw = base64.b64decode(payload["image"].split(",", 1)[-1])
        name = comfy_upload(raw, f"markup_{job_id[:8]}.png")

        graph = build_graph(
            name, payload["prompt"], payload.get("negative", ""),
            int(payload.get("seed", 0)), int(payload.get("steps", 25)),
            int(payload.get("resolution", 0)), payload["models"],
            payload.get("cache_device", "auto"), payload.get("cache_dtype", "default"),
        )
        resp = comfy_post("/prompt", {"prompt": graph, "client_id": CLIENT_ID})
        pid = resp["prompt_id"]
        with JOBS_LOCK:
            JOBS[job_id].update(status="running", prompt_id=pid, step=0, max_step=0,
                                progress=0.0, queued=True)

        t0 = time.time()
        w = watcher()
        while time.time() - t0 < 3600:
            q = comfy_get("/queue")
            running = [p[1] for p in q.get("queue_running", [])]
            pending = [p[1] for p in q.get("queue_pending", [])]
            if pid not in running and pid not in pending:
                break

            # Step progress comes off the websocket; the queue only says whether it has started.
            # `queued` distinguishes "waiting behind another job" from "running at 0%", which are
            # very different things to look at for eight minutes.
            prog = w.get(pid) if w else None
            with JOBS_LOCK:
                job = JOBS[job_id]
                job["queued"] = pid in pending
                job["elapsed"] = round(time.time() - t0, 1)
                # A node reporting max=1 is not the sampler. ComfyUI emits exactly that while
                # the model loads and the plate is VAE-encoded — which on a 2K edit is seven
                # minutes — and 1/1 computed as 100%, so the dial sat full for the whole load
                # and then jumped back to 4%. Only a node with real steps drives the number.
                if prog and prog.get("max", 0) > 1:
                    job["step"] = prog["value"]
                    job["max_step"] = prog["max"]
                    # Sampling is not the whole job: VAE decode and save follow it and take real
                    # time. Sampling maps onto 0-92% so the bar has somewhere to go afterwards
                    # rather than sitting at 100% while work is still happening.
                    job["progress"] = round(92.0 * prog["value"] / prog["max"], 1)
                    job["phase"] = "sampling"
                else:
                    job["phase"] = "loading" 
            time.sleep(0.4)

        with JOBS_LOCK:
            JOBS[job_id]["queued"] = False
            JOBS[job_id]["phase"] = "decoding"
            JOBS[job_id]["progress"] = max(JOBS[job_id].get("progress", 0), 94.0)

        # ComfyUI writes outputs into history slightly after the queue clears, so this retries
        # rather than reading once.
        for _ in range(15):
            hist = comfy_get(f"/history/{pid}")
            entry = hist.get(pid)
            if entry and entry.get("outputs"):
                for node_out in entry["outputs"].values():
                    for img in node_out.get("images", []):
                        q = urllib.parse.urlencode({
                            "filename": img["filename"],
                            "subfolder": img.get("subfolder", ""),
                            "type": img.get("type", "output"),
                        })
                        with JOBS_LOCK:
                            JOBS[job_id].update(status="done", image=f"/api/image?{q}",
                                                elapsed=round(time.time() - t0, 1),
                                                progress=100.0, queued=False,
                                                input_name=name, prompt=payload["prompt"])
                        if w:
                            w.forget(pid)
                        return
            time.sleep(1)

        entry = comfy_get(f"/history/{pid}").get(pid, {})
        fail(f"no output from ComfyUI. status: {json.dumps(entry.get('status', {}))[:500]}")
    except urllib.error.HTTPError as e:
        fail(f"ComfyUI rejected the request ({e.code}). {e.read()[:500].decode(errors='replace')}")
    except Exception as e:  # noqa: BLE001 - surfaced to the page, not swallowed
        fail(f"{type(e).__name__}: {e}")


# --------------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local_only(self, check_origin):
        """Refuse requests that did not come from this app's own page.

        The server listens on loopback, but any website open in the same browser can still send
        requests to it. The Host check stops DNS rebinding (a hostile name re-pointed at
        127.0.0.1); the Origin check stops another site POSTing jobs or re-pointing the ComfyUI
        address. Requests with no Origin at all (curl, scripts) are let through, since they
        cannot come from a page.
        """
        local = ("127.0.0.1", "localhost", "[::1]")
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
        if host not in local:
            self._send(403, {"error": "forbidden host"})
            return False
        if check_origin:
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlparse(origin).netloc.rsplit(":", 1)[0].lower() \
                    not in local:
                self._send(403, {"error": "forbidden origin"})
                return False
        return True

    def do_GET(self):
        if not self._local_only(check_origin=False):
            return
        url = urllib.parse.urlparse(self.path)

        if url.path in ("/", "/index.html"):
            return self._send(200, (HERE / "index.html").read_text(encoding="utf-8"),
                              "text/html; charset=utf-8")

        if url.path == "/app.js":
            return self._send(200, (HERE / "app.js").read_text(encoding="utf-8"),
                              "application/javascript; charset=utf-8")

        if url.path == "/api/config":
            w = watcher()
            return self._send(200, {"comfy": comfy_base(),
                                    "progress_ws": bool(w and w.connected)})

        if url.path == "/api/models":
            try:
                info = comfy_get("/object_info")
                missing = [n for n in REQUIRED_NODES if n not in info]
                if missing:
                    return self._send(409, {
                        "error": f"ComfyUI at {comfy_base()} has no {', '.join(missing)} node. "
                                 "Qwen-Image 2.1 needs ComfyUI 0.37.0 or newer. Update it "
                                 "and restart.",
                        "kind": "nodes"})
                return self._send(200, {
                    "unet": info["UNETLoader"]["input"]["required"]["unet_name"][0],
                    "clip": info["CLIPLoader"]["input"]["required"]["clip_name"][0],
                    "vae": info["VAELoader"]["input"]["required"]["vae_name"][0],
                    "comfy": comfy_base(),
                })
            except Exception as e:  # noqa: BLE001
                return self._send(502, {"error": f"cannot reach ComfyUI at {comfy_base()}: {e}"})

        if url.path == "/api/status":
            jid = urllib.parse.parse_qs(url.query).get("id", [""])[0]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            return self._send(200 if job else 404, job or {"error": "no such job"})

        if url.path == "/api/image":
            try:
                with urllib.request.urlopen(f"{comfy_base()}/view?{url.query}", timeout=60) as r:
                    data = r.read()
                    ctype = r.headers.get("Content-Type", "image/png")
                return self._send(200, data, ctype)
            except Exception as e:  # noqa: BLE001
                return self._send(502, {"error": str(e)})

        for cand in (HERE / url.path.lstrip("/"),):
            if cand.is_file() and HERE in cand.resolve().parents:
                ctype = mimetypes.guess_type(cand.name)[0] or "application/octet-stream"
                return self._send(200, cand.read_bytes(), ctype)

        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._local_only(check_origin=True):
            return
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/api/generate", "/api/config"):
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as e:
            return self._send(400, {"error": f"bad JSON: {e}"})

        if path == "/api/config":
            # The new address is proved before it is kept. Accepting one that does not answer
            # would leave the app pointed at nothing with the old, working address already gone.
            try:
                addr = normalise_addr(payload.get("comfy"))
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            previous = comfy_base()
            with CFG_LOCK:
                CFG["comfy"] = addr
            try:
                comfy_get("/system_stats", timeout=10)
            except Exception as e:  # noqa: BLE001
                with CFG_LOCK:
                    CFG["comfy"] = previous
                return self._send(502, {"error": f"no ComfyUI at {addr}: {e}",
                                        "comfy": previous})
            start_watcher(addr)
            return self._send(200, {"comfy": addr})

        jid = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[jid] = {"id": jid, "status": "queued"}
        threading.Thread(target=run_job, args=(jid, payload), daemon=True).start()
        self._send(200, {"id": jid})


class Server(ThreadingHTTPServer):
    """HTTPServer turns on SO_REUSEADDR, which on Windows lets a second process bind a port that
    is already taken — so a second copy of Markup would start "successfully" and never get a
    request. Exclusive binding there makes a busy port fail loudly instead."""
    daemon_threads = True

    if sys.platform == "win32":
        allow_reuse_address = False

        def server_bind(self):
            import socket
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()


def bail(msg):
    """Exit with a message that stays on screen.

    Double-clicking the .exe opens a console that closes the moment the process ends, which would
    take the error with it. Running from source, the terminal is already there.
    """
    print(f"\n{msg}")
    if getattr(sys, "frozen", False):
        try:
            input("\nPress Enter to close.")
        except EOFError:
            pass
    raise SystemExit(1)


def main():
    ap = argparse.ArgumentParser(description="Markup: circle-and-annotate editor for Qwen-Image 2.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--comfy", default="127.0.0.1:8188",
                    help="host:port of a running ComfyUI")
    ap.add_argument("--no-browser", action="store_true",
                    help="do not open the page in a browser on startup")
    ap.add_argument("--version", action="version", version=f"Markup {__version__}")
    a = ap.parse_args()

    try:
        CFG["comfy"] = normalise_addr(a.comfy)
    except ValueError as e:
        bail(f"--comfy: {e}")

    try:
        server = Server(("127.0.0.1", a.port), Handler)
    except OSError as e:
        bail(f"Cannot listen on port {a.port}: {e}\n"
             f"Markup may already be running (try http://127.0.0.1:{a.port}), "
             f"or start it on another port with --port.")

    start_watcher(CFG["comfy"])

    url = f"http://127.0.0.1:{a.port}"
    print(f"Markup {__version__}")
    print(f"  page    ->  {url}")
    print(f"  ComfyUI ->  {CFG['comfy']}")
    print("Leave this window open while you use it. Ctrl+C to stop.")
    if not a.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
