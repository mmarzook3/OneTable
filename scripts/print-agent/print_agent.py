#!/usr/bin/env python3
"""
LAN print agent for Scanaki (#317).

Polls the cloud backend for pending print jobs and sends ESC/POS text to a
network thermal printer (JetDirect :9100) or writes to a dry-run file.

Environment:
  PRINT_AGENT_API_BASE   Base URL including /api if behind HAProxy
                         (e.g. http://127.0.0.1:4202/api or https://scanaki.uk/api)
  PRINT_AGENT_TOKEN      Agent token from Settings → Printing (shown once at create)
  PRINT_AGENT_POLL_SEC   Poll interval seconds (default 2)
  KITCHEN_PRINTER_HOST   Host/IP for kitchen role (default 127.0.0.1)
  KITCHEN_PRINTER_PORT   Port (default 9100)
  RECEIPT_PRINTER_HOST   Host/IP for receipt role (default same as kitchen)
  RECEIPT_PRINTER_PORT   Port (default 9100)
  PRINT_AGENT_DRY_RUN    If 1/true, write bytes to tmp/print-agent-last.bin instead of TCP

Usage (from repo root):
  PRINT_AGENT_API_BASE=http://127.0.0.1:4202/api \\
  PRINT_AGENT_TOKEN=... PRINT_AGENT_DRY_RUN=1 \\
  python3 scripts/print-agent/print_agent.py
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ESC = b"\x1b"
GS = b"\x1d"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _truthy(val: str) -> bool:
    return val.lower() in ("1", "true", "yes", "on")


def _api_base() -> str:
    base = _env("PRINT_AGENT_API_BASE", "http://127.0.0.1:4202/api").rstrip("/")
    return base


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "satisfecho-print-agent/1.0",
    }


def _request(method: str, url: str, token: str, body: dict | None = None) -> object:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=_headers(token), method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            if not raw:
                return None
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {url}: {detail}") from e


def render_escpos(plain_text: str) -> bytes:
    """Minimal ESC/POS: init, text, feed, partial cut."""
    text = (plain_text or "").replace("\r\n", "\n").replace("\r", "\n")
    # Prefer CP437-safe ASCII; drop unsupported chars.
    payload = text.encode("cp437", errors="replace")
    out = bytearray()
    out.extend(ESC + b"@" )  # init
    out.extend(ESC + b"a\x00")  # left align
    out.extend(payload)
    if not payload.endswith(b"\n"):
        out.extend(b"\n")
    out.extend(b"\n\n\n")
    out.extend(GS + b"V\x00")  # full cut (many printers ignore if unsupported)
    return bytes(out)


def resolve_printer(role: str) -> tuple[str, int]:
    role = (role or "receipt").lower()
    if role == "kitchen":
        host = _env("KITCHEN_PRINTER_HOST", _env("RECEIPT_PRINTER_HOST", "127.0.0.1"))
        port = int(_env("KITCHEN_PRINTER_PORT", _env("RECEIPT_PRINTER_PORT", "9100")) or "9100")
    else:
        host = _env("RECEIPT_PRINTER_HOST", _env("KITCHEN_PRINTER_HOST", "127.0.0.1"))
        port = int(_env("RECEIPT_PRINTER_PORT", _env("KITCHEN_PRINTER_PORT", "9100")) or "9100")
    return host, port


def send_to_printer(role: str, data: bytes, *, dry_run: bool) -> None:
    if dry_run:
        out_dir = Path(__file__).resolve().parents[2] / "tmp"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "print-agent-last.bin"
        path.write_bytes(data)
        text_path = out_dir / "print-agent-last.txt"
        # Strip ESC/POS control for human-readable preview
        preview = data.decode("cp437", errors="replace")
        text_path.write_text(preview, encoding="utf-8")
        print(f"[dry-run] wrote {path} ({len(data)} bytes)", flush=True)
        return
    host, port = resolve_printer(role)
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(data)
    print(f"[ok] sent {len(data)} bytes to {host}:{port} role={role}", flush=True)


def process_job(token: str, base: str, job: dict, *, dry_run: bool) -> None:
    job_id = job["id"]
    role = job.get("printer_role") or job.get("job_type") or "receipt"
    payload = job.get("payload") or {}
    plain = payload.get("plain_text") or ""
    if not plain and payload.get("lines"):
        lines = [f"{ln.get('quantity', 1)}x {ln.get('name', '')}" for ln in payload["lines"]]
        plain = "\n".join(lines) + "\n"
    data = render_escpos(plain)
    try:
        send_to_printer(role, data, dry_run=dry_run)
        _request(
            "POST",
            f"{base}/print-agent/jobs/{job_id}/complete",
            token,
            {"status": "done"},
        )
        print(f"[done] job {job_id}", flush=True)
    except Exception as exc:
        print(f"[fail] job {job_id}: {exc}", flush=True)
        try:
            _request(
                "POST",
                f"{base}/print-agent/jobs/{job_id}/complete",
                token,
                {"status": "failed", "error_message": str(exc)[:480]},
            )
        except Exception as ack_exc:
            print(f"[warn] could not ack failure for job {job_id}: {ack_exc}", flush=True)


def main() -> int:
    token = _env("PRINT_AGENT_TOKEN")
    if not token:
        print("PRINT_AGENT_TOKEN is required", file=sys.stderr)
        return 2
    base = _api_base()
    dry_run = _truthy(_env("PRINT_AGENT_DRY_RUN", "0"))
    poll = float(_env("PRINT_AGENT_POLL_SEC", "2") or "2")
    print(f"print-agent starting base={base} dry_run={dry_run} poll={poll}s", flush=True)
    while True:
        try:
            _request("POST", f"{base}/print-agent/heartbeat", token, {})
            jobs = _request("GET", f"{base}/print-agent/jobs?limit=10", token)
            if isinstance(jobs, list):
                for job in jobs:
                    process_job(token, base, job, dry_run=dry_run)
        except Exception as exc:
            print(f"[poll-error] {exc}", flush=True)
        time.sleep(max(0.5, poll))


if __name__ == "__main__":
    raise SystemExit(main())
