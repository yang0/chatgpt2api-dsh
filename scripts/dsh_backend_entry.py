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


def apply_responses_defaults(body: bytes, prefs: dict[str, str]) -> bytes:
    """Apply image tier to Responses API image_generation tool, never text requests."""
    try:
        fields = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(fields, dict) or not isinstance(fields.get("tools"), list):
        return body
    changed = False
    tools = []
    for item in fields["tools"]:
        if not isinstance(item, dict) or item.get("type") != "image_generation":
            tools.append(item)
            continue
        tool = dict(item)
        prompt_input = fields.get("input")
        if isinstance(prompt_input, str):
            prompt = prompt_input
        else:
            # Use the last text-bearing input; leave unrelated fields untouched.
            prompt = str(prompt_input or "")[:12000]
        ratio_fields = {"prompt": prompt, "aspect_ratio": fields.get("aspect_ratio"),
                        "resolution": tool.get("resolution") or fields.get("resolution"),
                        "size": tool.get("size")}
        new_size = choose_size(ratio_fields, prefs)
        if new_size:
            tool["size"] = new_size
            changed = True
        tools.append(tool)
    if changed:
        fields["tools"] = tools
        return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return body


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



def validate_gif_request(fields: dict[str, Any]) -> dict[str, Any]:
    """Limit generated frame count, duration, output dimensions and payload cost."""
    if not isinstance(fields, dict) or fields.get("output_format") != "gif":
        raise ValueError("output_format must be gif")
    prompt = fields.get("prompt")
    model = str(fields.get("model") or "gpt-image-2")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError("GIF prompt length must be between 1 and 12000")
    if not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model):
        raise ValueError("invalid GIF model")
    if fields.get("n", 1) != 1:
        raise ValueError("GIF output supports n=1 only")
    try:
        count = int(fields.get("frame_count", 9))
        duration = int(fields.get("frame_duration_ms", 200))
    except (TypeError, ValueError) as exc:
        raise ValueError("frame_count/frame_duration_ms must be integers") from exc
    if count < 2 or count > 16:
        raise ValueError("frame_count must be between 2 and 16")
    if duration < 20 or duration > 2000 or duration % 10:
        raise ValueError("frame_duration_ms must be 20-2000, in 10ms steps")
    if fields.get("stream") or fields.get("partial_images"):
        raise ValueError("GIF does not support streaming or partial_images")
    size = str(fields.get("size") or "auto").strip().lower()
    if size != "auto":
        m = re.fullmatch(r"(\d+)x(\d+)", size)
        if not m:
            raise ValueError("invalid GIF size")
        w, h = int(m[1]), int(m[2])
        if w < 256 or h < 256 or w * h > 2048 * 2048 or max(w, h) > 2048:
            raise ValueError("composed GIF frames are limited to 2048px maximum side and 4MP")
    return {
        "prompt": prompt.strip(), "model": model, "n": 1,
        "size": size, "frame_count": count, "frame_duration_ms": duration
    }



def generate_native_gif(fields: dict[str, Any]) -> dict[str, Any]:
    """Forward GIF to the official OpenAI Images API; never synthesize frames.

    The website-backed chatgpt2api account pool does not implement the GIF
    protocol. The key is explicitly configured on the DSH host, not the caller.
    """
    import urllib.error
    import urllib.request

    key = os.environ.get("DSH_OPENAI_GIF_API_KEY", "").strip()
    if not key:
        raise RuntimeError("native GIF requires DSH_OPENAI_GIF_API_KEY; the bundled account-pool backend does not support GIF")
    options = validate_gif_request(fields)
    payload = {
        "model": options["model"], "prompt": options["prompt"], "n": 1,
        "output_format": "gif", "frame_count": options["frame_count"],
        "frame_duration_ms": options["frame_duration_ms"],
        "size": options["size"]
    }
    if fields.get("quality") in ("auto", "low", "medium", "high"):
        payload["quality"] = fields["quality"]
    request = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json", "Accept": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            content = response.read(70 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        raise RuntimeError("OpenAI GIF API returned HTTP " + str(exc.code)) from None
    except urllib.error.URLError:
        raise RuntimeError("OpenAI GIF API connection failed") from None
    if len(content) > 70 * 1024 * 1024:
        raise RuntimeError("OpenAI GIF response exceeds 70MB")
    result = json.loads(content)
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise RuntimeError("OpenAI GIF API returned an invalid response")
    return {**result, "output_format": "gif", "generation_mode": "official_api"}


async def handle_gif_api(scope, body: bytes, receive, send):
    from fastapi import HTTPException
    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import JSONResponse
    from api.support import require_identity
    from services.content_filter import check_request
    from services.log_service import LoggedCall

    headers = dict(scope.get("headers", []))
    authorization = headers.get(b"authorization", b"").decode("latin1")
    try:
        identity = require_identity(authorization)
        fields = json.loads(body)
        if not isinstance(fields, dict):
            raise ValueError("GIF request must be a JSON object")
        # Apply the same saved model/size defaults as the regular image endpoint.
        fields = json.loads(apply_json_defaults(json.dumps(fields).encode("utf-8"), preferences()))
        options = validate_gif_request(fields)
        await run_in_threadpool(check_request, options["prompt"])
        # Existing upstream logging and account-pool dispatch are reused.
        call = LoggedCall(identity, "/v1/images/generations", options["model"],
                          "GIF逐帧合成", request_text=options["prompt"])
        result = await call.run(generate_native_gif, fields)
        if isinstance(result, dict):
            response = JSONResponse(result)
        else:
            response = result
    except HTTPException as exc:
        response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    except (ValueError, TypeError) as exc:
        response = JSONResponse({"detail": {"error": str(exc)}}, status_code=400)
    except Exception:
        response = JSONResponse({"detail": {"error": "GIF generation failed; check backend logs"}}, status_code=502)
    await response(scope, receive, send)

class ApplyImagePreferences:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") not in (
            "/v1/images/generations", "/v1/images/edits", "/v1/responses"
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
        if scope["path"] == "/v1/images/generations" and is_json:
            try:
                image_request = json.loads(original)
            except (ValueError, UnicodeDecodeError):
                image_request = None
            if isinstance(image_request, dict) and image_request.get("output_format") == "gif":
                return await handle_gif_api(scope, original, receive, send)
        updated = (apply_responses_defaults(original, prefs) if scope["path"] == "/v1/responses"
                   else apply_json_defaults(original, prefs)) if is_json else apply_multipart_defaults(original, content_type, prefs)
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
