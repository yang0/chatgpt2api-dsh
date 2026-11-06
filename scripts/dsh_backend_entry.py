"""DSH-managed ASGI entrypoint: apply saved defaults to third-party image API calls.

This wraps the pinned upstream app without modifying upstream source files.
Only /v1/images/generations and /v1/images/edits are modified; all other
requests are passed through unchanged. Explicit size and model win.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from main import app as upstream_app

PRESET_SIZES = {
    "1:1": {"1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096"},
    "16:9": {"1k": "1920x1088", "2k": "2560x1440", "4k": "3840x2160"},
    "9:16": {"1k": "1088x1920", "2k": "1440x2560", "4k": "2160x3840"},
    "3:2": {"1k": "1536x1024", "2k": "2400x1600", "4k": "3600x2400"},
    "2:3": {"1k": "1024x1536", "2k": "1600x2400", "4k": "2400x3600"},
    "4:3": {"1k": "1365x1024", "2k": "2560x1920", "4k": "3840x2880"},
    "3:4": {"1k": "1024x1365", "2k": "1920x2560", "4k": "2880x3840"},
}
RATIO_RE = re.compile(
    r"(?:^|[^\d])(?:比例|画幅|aspect\s*ratio)?\s*"
    r"(1\s*:\s*1|16\s*:\s*9|9\s*:\s*16|3\s*:\s*2|2\s*:\s*3|4\s*:\s*3|3\s*:\s*4)(?!\d)",
    re.IGNORECASE,
)
MAX_BUFFER_BYTES = 72 * 1024 * 1024


def preferences() -> dict[str, str]:
    defaults = {"defaultModel": "gpt-image-2", "defaultImageTier": "auto"}
    filename = os.environ.get("DSH_IMAGE_PREFERENCES_FILE", "")
    if not filename:
        return defaults
    try:
        doc = json.loads(Path(filename).read_text(encoding="utf-8"))
        model = doc.get("defaultModel")
        tier = doc.get("defaultImageTier")
        if isinstance(model, str) and re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model):
            defaults["defaultModel"] = model
        if isinstance(tier, str) and tier.lower() in ("auto", "1k", "2k", "4k"):
            defaults["defaultImageTier"] = tier.lower()
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return defaults


def choose_size(fields: dict[str, Any], prefs: dict[str, str]) -> str | None:
    # 'size' is always authoritative, including auto.
    if fields.get("size") is not None and str(fields["size"]).strip():
        return None
    tier = str(fields.get("resolution") or fields.get("imageTier") or prefs["defaultImageTier"]).lower()
    if tier not in ("1k", "2k", "4k"):
        return None
    ratio = fields.get("aspect_ratio") or fields.get("aspectRatio") or ""
    ratio = str(ratio).strip()
    if not ratio:
        match = RATIO_RE.search(str(fields.get("prompt") or ""))
        ratio = re.sub(r"\s", "", match.group(1)) if match else ""
    return PRESET_SIZES.get(ratio, {}).get(tier)


def apply_json_defaults(body: bytes, prefs: dict[str, str]) -> bytes:
    try:
        fields = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(fields, dict):
        return body
    changed = False
    if not fields.get("model"):
        fields["model"] = prefs["defaultModel"]
        changed = True
    size = choose_size(fields, prefs)
    if size:
        fields["size"] = size
        changed = True
    return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if changed else body


def apply_multipart_defaults(body: bytes, content_type: str, prefs: dict[str, str]) -> bytes:
    match = re.search(r"(?:^|;)\s*boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.IGNORECASE)
    if not match:
        return body
    boundary = (match.group(1) or match.group(2)).encode("ascii", "ignore")
    if not boundary or len(boundary) > 200:
        return body
    marker = b"--" + boundary
    closing = marker + b"--"
    pos = body.rfind(closing)
    if pos < 0:
        return body
    # Inspect form part headers only, never search binary image payloads.
    parts = body[:pos].split(marker)
    fields: dict[str, str] = {}
    for part in parts:
        if not part.startswith(b"\r\n"):
            continue
        head, sep, value = part[2:].partition(b"\r\n\r\n")
        if not sep or len(head) > 8192:
            continue
        found = re.search(rb'(?im)^Content-Disposition:\s*form-data;\s*name="([a-zA-Z_]+)"', head)
        if not found or b"filename=" in head.lower():
            continue
        name = found.group(1).decode("ascii")
        if name in ("prompt", "size", "model", "resolution", "imageTier", "aspect_ratio", "aspectRatio"):
            fields[name] = value.rstrip(b"\r\n").decode("utf-8", "replace")[:12000]
    additions = {}
    if not fields.get("model"):
        additions["model"] = prefs["defaultModel"]
    size = choose_size(fields, prefs)
    if size:
        additions["size"] = size
    if not additions:
        return body
    encoded = bytearray()
    for key, value in additions.items():
        encoded.extend(marker + b'\r\nContent-Disposition: form-data; name="' + key.encode() + b'"\r\n\r\n')
        encoded.extend(value.encode() + b"\r\n")
    return body[:pos] + bytes(encoded) + body[pos:]


class ApplyImagePreferences:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") not in (
            "/v1/images/generations", "/v1/images/edits"
        ):
            return await self.app(scope, receive, send)
        prefs = preferences()
        headers = list(scope.get("headers", []))
        content_type = next((v.decode("latin1") for k, v in headers if k.lower() == b"content-type"), "")
        is_json = content_type.split(";", 1)[0].strip().lower() == "application/json"
        is_form = content_type.split(";", 1)[0].strip().lower() == "multipart/form-data"
        if not is_json and not is_form:
            return await self.app(scope, receive, send)
        chunks = []
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > MAX_BUFFER_BYTES:
                payload = b'{"detail":{"error":"image upload exceeds 72MB limit"}}'
                await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]})
                await send({"type": "http.response.body", "body": payload})
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        original = b"".join(chunks)
        updated = apply_json_defaults(original, prefs) if is_json else apply_multipart_defaults(original, content_type, prefs)
        if updated != original:
            headers = [(k, v) for k, v in headers if k.lower() != b"content-length"]
            headers.append((b"content-length", str(len(updated)).encode()))
            scope = dict(scope, headers=headers)
        handed = False

        async def single_receive():
            nonlocal handed
            if not handed:
                handed = True
                return {"type": "http.request", "body": updated, "more_body": False}
            return await receive()

        await self.app(scope, single_receive, send)


app = ApplyImagePreferences(upstream_app)
