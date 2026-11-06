"""Standalone tests: python3 -m unittest discover -s tests -p 'test_dsh_backend_entry.py'."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


fake_main = types.ModuleType("main")

async def upstream_app(scope, receive, send):
    chunks = []
    while True:
        item = await receive()
        if item["type"] == "http.request":
            chunks.append(item.get("body", b""))
            if not item.get("more_body", False):
                break
    data = b"".join(chunks)
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": data})

fake_main.app = upstream_app
sys.modules["main"] = fake_main
file_path = Path(__file__).resolve().parents[1] / "scripts" / "dsh_backend_entry.py"
spec = importlib.util.spec_from_file_location("dsh_backend_entry", file_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PREFS = {"defaultModel": "gpt-image-2", "defaultImageTier": "4k"}


class ImageDefaultsTest(unittest.TestCase):
    def test_size_precedence_and_ratio(self):
        self.assertEqual(module.choose_size({"prompt": "一张16:9的风景"}, PREFS), "3840x2160")
        self.assertEqual(module.choose_size({"aspect_ratio": "9:16"}, PREFS), "2160x3840")
        self.assertIsNone(module.choose_size({"size": "1024x1024", "prompt": "16:9"}, PREFS))
        self.assertIsNone(module.choose_size({"prompt": "没有比例的风景"}, PREFS))

    def test_json_respects_size(self):
        body = b'{"prompt":"a 16:9 scene"}'
        result = json.loads(module.apply_json_defaults(body, PREFS))
        self.assertEqual(result["size"], "3840x2160")
        result = json.loads(module.apply_json_defaults(b'{"size":"auto","prompt":"16:9"}', PREFS))
        self.assertEqual(result["size"], "auto")

    def test_responses_image_tool(self):
        body = json.dumps({"input": "16:9 forest", "tools": [{"type": "image_generation"}]}).encode()
        result = json.loads(module.apply_responses_defaults(body, PREFS))
        self.assertEqual(result["tools"][0]["size"], "3840x2160")
        body = json.dumps({"input": "16:9 forest", "tools": [{"type": "web_search"}]}).encode()
        self.assertEqual(module.apply_responses_defaults(body, PREFS), body)

    def test_multipart_preserves_uploaded_image(self):
        boundary = "testBoundary"
        data = (b'--testBoundary\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n16:9 photo\r\n'
                b'--testBoundary\r\nContent-Disposition: form-data; name="image"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n\x89PNGbytes\r\n'
                b'--testBoundary--\r\n')
        output = module.apply_multipart_defaults(data, "multipart/form-data; boundary=testBoundary", PREFS)
        self.assertIn(b"3840x2160", output)
        self.assertIn(b"\x89PNGbytes", output)
        explicit = data.replace(b'--testBoundary--', b'--testBoundary\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024\r\n--testBoundary--')
        explicit_result = module.apply_multipart_defaults(explicit, "multipart/form-data; boundary=testBoundary", PREFS)
        self.assertEqual(explicit_result.count(b'name="size"'), 1)
        self.assertIn(b"1024x1024", explicit_result)
        self.assertNotIn(b"3840x2160", explicit_result)
        self.assertIn(b"\x89PNGbytes", explicit_result)

    def test_asgi_wrapper_changes_external_json(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "image-preferences.json"
            filename.write_text(json.dumps(PREFS), encoding="utf-8")
            old = os.environ.get("DSH_IMAGE_PREFERENCES_FILE")
            os.environ["DSH_IMAGE_PREFERENCES_FILE"] = str(filename)
            try:
                async def simulate():
                    sent = []
                    received = False
                    async def receive():
                        nonlocal received
                        if not received:
                            received = True
                            return {"type": "http.request", "body": b'{"prompt":"16:9 landscape"}', "more_body": False}
                        return {"type": "http.disconnect"}
                    async def send(value):
                        sent.append(value)
                    await module.app({"type": "http", "method": "POST", "path": "/v1/images/generations",
                                      "headers": [(b"content-type", b"application/json")]}, receive, send)
                    return sent
                result = asyncio.run(simulate())
                self.assertEqual(json.loads(result[-1]["body"])["size"], "3840x2160")
            finally:
                if old is None:
                    os.environ.pop("DSH_IMAGE_PREFERENCES_FILE", None)
                else:
                    os.environ["DSH_IMAGE_PREFERENCES_FILE"] = old


if __name__ == "__main__":
    unittest.main()
