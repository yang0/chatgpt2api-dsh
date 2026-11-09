import assert from "node:assert/strict";
import { test } from "node:test";
import { DshPoolPlugin } from "../index.mjs";

const credentials = { type: "api", key: "Bearer local-test-key" };
const modelPayload = { data: [{ id: "gpt-image-2.6" }, { id: "gpt-6", name: "Text model" }] };

async function plugin() {
  return DshPoolPlugin();
}

function withMockFetch(mock, run) {
  const old = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = old; });
}

test("registers a separate local provider, without changing Codex", async () => {
  const hooks = await plugin();
  const config = { provider: { codex: { name: "Other" } } };
  await hooks.config(config);
  assert.equal(config.provider.codex.name, "Other");
  assert.equal(config.provider["dsh-pool"].api, "http://127.0.0.1:38650/v1");
  assert.equal(config.provider["dsh-pool"].npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(config.provider["dsh-pool"].models, {});
});

test("requires a DSH user key; does not ask for a password or TOTP", async () => {
  const hooks = await plugin();
  assert.equal(hooks.auth.provider, "dsh-pool");
  assert.equal(hooks.auth.methods.length, 1);
  assert.equal(hooks.auth.methods[0].type, "api");
  const empty = await hooks.auth.loader(async () => null);
  assert.deepEqual(empty, {});
  const load = await hooks.auth.loader(async () => credentials);
  assert.equal(load.baseURL, "http://127.0.0.1:38650/v1");
  assert.equal(load.apiKey, "local-test-key");
});

test("discovers real models using the saved user key, not a hardcoded catalog", async () => {
  await withMockFetch(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:38650/v1/models");
    assert.equal(init.headers.authorization, "Bearer local-test-key");
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify(modelPayload), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const hooks = await plugin();
    const models = await hooks.provider.models({ models: {} }, { auth: credentials });
    assert.deepEqual(Object.keys(models), ["gpt-image-2.6", "gpt-6"]);
    assert.equal(models["gpt-6"].name, "Text model");
  });
});

test("forwards only to local DSH with the DSH key and preserves stream body", async () => {
  await withMockFetch(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:38650/v1/chat/completions");
    const h = new Headers(init.headers);
    assert.equal(h.get("authorization"), "Bearer local-test-key");
    assert.equal(h.has("cookie"), false);
    assert.equal(h.get("content-type"), "application/json");
    assert.equal(init.body, '{"model":"gpt-6","stream":true}');
    assert.equal(init.redirect, "error");
    return new Response('data: {"delta":"hello"}\n\n', { status: 200 });
  }, async () => {
    const hooks = await plugin();
    const load = await hooks.auth.loader(async () => credentials);
    const response = await load.fetch("http://127.0.0.1:38650/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer other-secret", Cookie: "secret-cookie", "Content-Type": "application/json" },
      body: '{"model":"gpt-6","stream":true}',
    });
    assert.equal(await response.text(), 'data: {"delta":"hello"}\n\n');
  });
});

test("rejects external hosts, changed ports, and paths outside /v1 before fetch", async () => {
  await withMockFetch(() => { throw new Error("fetch must not run"); }, async () => {
    const hooks = await plugin();
    const load = await hooks.auth.loader(async () => credentials);
    for (const url of [
      "https://evil.example/v1/chat/completions",
      "http://127.0.0.1:38651/v1/chat/completions",
      "http://localhost:38650/v1/chat/completions",
      "http://127.0.0.1:38650/admin",
      "http://127.0.0.1:38650/v1/../../admin",
      "http://local-test-key@127.0.0.1:38650/v1/chat/completions",
    ]) {
      await assert.rejects(load.fetch(url, { method: "POST" }), /request rejected/);
    }
  });
});

test("401 error is marked as invalid sign-in, without leaking key", async () => {
  await withMockFetch(async () => new Response('{"detail":"invalid"}', { status: 401 }), async () => {
    const hooks = await plugin();
    await assert.rejects(hooks.provider.models({ models: {} }, { auth: credentials }),
      (err) => err.signIn === "expired" && !err.message.includes("local-test-key"));
  });
});

test("invalid catalog and disconnected gateway produce diagnostic errors", async () => {
  const hooks = await plugin();
  await withMockFetch(async () => new Response('{"data":"invalid"}', { status: 200 }), async () => {
    await assert.rejects(hooks.provider.models({ models: {} }, { auth: credentials }), /invalid model list/);
  });
  await withMockFetch(async () => { throw new Error("dial refused secret"); }, async () => {
    await assert.rejects(hooks.provider.models({ models: {} }, { auth: credentials }),
      (err) => /cannot reach the local pool/.test(err.message) && !err.message.includes("secret"));
  });
});

test("validates model identifiers and never trusts upstream control characters", async () => {
  const hooks = await plugin();
  await withMockFetch(async () => new Response(JSON.stringify({
    data: [{ id: "valid-model" }, { id: "x\nInjected" }, { id: "with/slash" }, { id: "" }],
  }), { status: 200 }), async () => {
    const result = await hooks.provider.models({ models: {} }, { auth: credentials });
    assert.deepEqual(Object.keys(result), ["valid-model"]);
  });
});
