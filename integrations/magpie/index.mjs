/**
 * Magpie/OpenCode-style provider for the owner's locally running DSH account pool.
 * No email, password, TOTP seed, session cookie, or upstream ChatGPT token is
 * read or stored here. The DSH User API Key is managed by Magpie's plugin auth.
 *
 * Only loopback port 38650 is supported. Never turn this into an open proxy.
 */
const ID = "dsh-pool";
const ORIGIN = "http://127.0.0.1:38650";
const BASE = ORIGIN + "/v1";
const MAX_MODELS = 256;
const MODEL_ID = /^[a-zA-Z0-9._:-]{1,128}$/;

function cleanKey(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string") return "";
  // Accept users pasting either the bare DSH user key or "Bearer <key>".
  const key = auth.key.trim().replace(/^Bearer\s+/i, "");
  if (!key || /[\r\n]/.test(key) || key.length > 8192) return "";
  return key;
}

function apiURL(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("DSH: invalid request URL"); }
  // Even an incorrectly configured model may not send the DSH user key outside localhost.
  if (url.origin !== ORIGIN || !url.pathname.startsWith("/v1/") ||
      url.username || url.password || url.hash) {
    throw new Error("DSH: request rejected (only http://127.0.0.1:38650/v1/ is permitted)");
  }
  return url;
}

async function readModels(auth, fetcher = fetch) {
  const key = cleanKey(auth);
  if (!key) throw new Error("DSH: create a user API Key in DSH → API 接入, then log in to the plugin");
  let response;
  try {
    response = await fetcher(BASE + "/models", {
      method: "GET",
      redirect: "error",
      headers: { authorization: "Bearer " + key, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error("DSH: cannot reach the local pool at http://127.0.0.1:38650 (is DSH running?)");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error("DSH: the user API Key was refused; reset it in DSH → API 接入"), { signIn: "expired" });
    }
    throw new Error("DSH: /v1/models returned HTTP " + response.status);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("DSH: /v1/models did not return JSON"); }
  if (!Array.isArray(payload?.data)) throw new Error("DSH: /v1/models returned an invalid model list");
  const models = {};
  for (const item of payload.data.slice(0, MAX_MODELS)) {
    const name = typeof item?.id === "string" ? item.id : "";
    if (!MODEL_ID.test(name)) continue;
    models[name] = {
      id: name,
      name: typeof item?.name === "string" && item.name.trim() ? item.name.slice(0, 128) : name,
      tool_call: true,
    };
  }
  if (!Object.keys(models).length) throw new Error("DSH: no valid models are exposed by the local pool");
  return models;
}

async function forward(input, init, auth, fetcher = fetch) {
  const key = cleanKey(auth);
  if (!key) throw Object.assign(new Error("DSH: sign in with your DSH user API Key"), { signIn: "expired" });
  const target = apiURL(input);
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer " + key);
  // Prevent unrelated gateway/user secrets or hop-by-hop headers crossing the boundary.
  for (const h of ["cookie", "host", "proxy-authorization", "connection"]) headers.delete(h);
  return fetcher(target.toString(), {
    ...init,
    headers,
    redirect: "error",
  });
}

// Magpie invokes every exported function as a plugin, so keep helpers private.
export const DshPoolPlugin = async () => ({
  config: async (config) => {
    config.provider ??= {};
    config.provider[ID] ??= {
      name: "DSH ChatGPT Pool (local)",
      npm: "@ai-sdk/openai-compatible",
      api: BASE,
      models: {},
    };
  },
  auth: {
    provider: ID,
    methods: [{
      type: "api",
      label: "DSH 用户 API Key（在 DSH → API 接入创建）",
      placeholder: "本机 DSH User API Key（不是 ChatGPT 密码或 Token）",
    }],
    async loader(getAuth) {
      const auth = await getAuth();
      const key = cleanKey(auth);
      if (!key) return {};
      return {
        baseURL: BASE,
        apiKey: key,
        fetch: (input, init) => forward(input, init, auth),
      };
    },
  },
  provider: {
    id: ID,
    async models(provider, { auth } = {}) {
      // Magpie uses this list for model discovery after plugin login.
      if (!auth || auth.type !== "api") return provider.models ?? {};
      return readModels(auth);
    },
  },
});
