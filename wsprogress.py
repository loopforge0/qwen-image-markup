"""A minimal WebSocket client, so the page can show real generation progress.

ComfyUI reports step-by-step progress on its `/ws` endpoint and nowhere else. `/history` only
exists once a prompt has finished, and `/queue` reports position, not steps. So a progress bar
that is not a websocket client is a progress bar that is guessing — an animation timed against an
assumed seconds-per-step. That is a lie on screen, and this project does not put those up.

The stdlib has no websocket client and the app's "no packages to install" claim is load-bearing,
so this is the handshake plus frame parsing and nothing else. It reads text frames, answers pings,
and ignores the binary preview frames ComfyUI sends when previews are on.

Only the client-to-server direction needs masking (RFC 6455 §5.3), which is why sending is the
fiddly half and receiving is not.
"""
import base64
import json
import os
import socket
import struct
import threading
import time
import urllib.parse

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("websocket closed by peer")
        buf += chunk
    return buf


def _read_frame(sock):
    b1, b2 = _recv_exact(sock, 2)
    fin, opcode = b1 & 0x80, b1 & 0x0F
    masked, length = b2 & 0x80, b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    mask = _recv_exact(sock, 4) if masked else None
    payload = _recv_exact(sock, length) if length else b""
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return fin, opcode, payload


def _send_frame(sock, opcode, payload=b""):
    mask = os.urandom(4)
    n = len(payload)
    header = bytes([0x80 | opcode])
    if n < 126:
        header += bytes([0x80 | n])
    elif n < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", n)
    sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def _handshake(base, client_id, timeout):
    u = urllib.parse.urlparse(base)
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 80)
    if u.scheme == "https":
        raise RuntimeError("wss is not supported; point Markup at a plain-http ComfyUI")

    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    path = f"{u.path.rstrip('/')}/ws?clientId={urllib.parse.quote(client_id)}"
    sock.sendall(
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n".encode()
    )
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("no handshake response")
        head += chunk
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if "101" not in status:
        sock.close()
        raise ConnectionError(f"websocket upgrade refused: {status}")
    return sock


class ProgressWatcher:
    """Follows one ComfyUI's websocket and keeps the latest progress per prompt id.

    Runs as a daemon thread and reconnects on its own. Everything it touches is guarded, because
    the HTTP handler threads read it while it writes.

    `client_id` matters: ComfyUI addresses progress messages to the client that submitted the
    prompt, so the same id has to go out with POST /prompt or nothing arrives here.
    """

    def __init__(self, base, client_id):
        self.base = base
        self.client_id = client_id
        self._lock = threading.Lock()
        self._progress = {}          # prompt_id -> {"value", "max", "node"}
        self._connected = False
        self._stop = threading.Event()
        self._thread = None

    # -------------------------------------------------------------- lifecycle
    def start(self):
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()

    @property
    def connected(self):
        with self._lock:
            return self._connected

    # -------------------------------------------------------------- reading
    def get(self, prompt_id):
        with self._lock:
            p = self._progress.get(prompt_id)
            return dict(p) if p else None

    def forget(self, prompt_id):
        with self._lock:
            self._progress.pop(prompt_id, None)

    def _record(self, prompt_id, value, maximum, node=None):
        if not prompt_id or not maximum:
            return
        with self._lock:
            self._progress[prompt_id] = {"value": int(value), "max": int(maximum),
                                         "node": node}

    # -------------------------------------------------------------- the loop
    def _handle(self, msg):
        kind, data = msg.get("type"), msg.get("data") or {}

        if kind == "progress":
            self._record(data.get("prompt_id"), data.get("value", 0), data.get("max", 0),
                         data.get("node"))

        elif kind == "progress_state":
            # Newer ComfyUI reports every running node at once. The sampler is the one worth
            # showing, and it is identified by being the node with the most steps rather than by
            # name, since the node id is whatever the graph called it.
            nodes = data.get("nodes") or {}
            best = None
            for node_id, n in nodes.items():
                if not isinstance(n, dict) or not n.get("max"):
                    continue
                if best is None or n["max"] > best[1].get("max", 0):
                    best = (node_id, n)
            if best:
                self._record(data.get("prompt_id"), best[1].get("value", 0),
                             best[1].get("max", 0), best[0])

        elif kind in ("execution_success", "execution_error", "execution_interrupted"):
            self.forget(data.get("prompt_id"))

    def _loop(self):
        backoff = 1.0
        while not self._stop.is_set():
            sock = None
            try:
                sock = _handshake(self.base, self.client_id, timeout=20)
                with self._lock:
                    self._connected = True
                backoff = 1.0
                buf = b""
                while not self._stop.is_set():
                    try:
                        fin, opcode, payload = _read_frame(sock)
                    except socket.timeout:
                        continue
                    if opcode == OP_PING:
                        _send_frame(sock, OP_PONG, payload)
                        continue
                    if opcode == OP_CLOSE:
                        break
                    if opcode == OP_BIN:
                        continue          # preview images; not wanted here
                    if opcode in (OP_TEXT, OP_CONT):
                        buf += payload
                        if not fin:
                            continue
                        text, buf = buf, b""
                        try:
                            self._handle(json.loads(text.decode("utf-8", "replace")))
                        except (json.JSONDecodeError, AttributeError, TypeError):
                            pass
            except Exception:  # noqa: BLE001 - a dead socket must not take the server with it
                pass
            finally:
                with self._lock:
                    self._connected = False
                if sock:
                    try:
                        sock.close()
                    except OSError:
                        pass
            if self._stop.wait(backoff):
                break
            backoff = min(backoff * 2, 15.0)
