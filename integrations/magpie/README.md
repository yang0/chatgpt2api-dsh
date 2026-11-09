# DSH ChatGPT2API ↔ Magpie provider plugin

This plugin connects [Magpie](https://github.com/yetone/magpie) to the **existing local account pool** managed by [chatgpt2api-dsh](https://github.com/yang0/chatgpt2api-dsh). It needs **no fork of Magpie**, no Docker, and no duplicate password/2FA storage.

> **Scope:** This connects one DSH pool as one model provider (`dsh-pool`). It does **not** inject every DSH login into Magpie's built-in Codex provider, and it does not log into ChatGPT itself. The 2FA/TOTP batch import is performed by DSH. Successful DSH authentication is not a guarantee that all models/endpoints are available.

## 安装（Windows / macOS / Linux）

1. 在 DSH 中安装本仓库插件，打开 **号池管理**，使用 `邮箱----密码----2FA密钥` 或 TXT 批量导入你有权使用的账号，完成账号检测。
2. 保持 DSH 的本地后端运行（默认 `http://127.0.0.1:38650`）。在 **API 接入** 创建一枚 **用户 API Key**。注意：这里要用 DSH 的用户 Key，**不是** ChatGPT 密码、TOTP 密钥、access_token 或后端管理员 Key。
3. 在此仓库根目录运行：

   ```powershell
   magpie plugin add ./integrations/magpie
   magpie plugin login dsh-pool
   ```

   输入刚刚创建的 DSH 用户 API Key（支持直接粘贴 `Bearer <key>`）。
4. 检查模型与连接：

   ```powershell
   magpie plugin --json
   magpie provider dsh-pool
   magpie provider test dsh-pool
   ```

5. 到 Magpie **Agents** 页面给 Codex、OpenCode 或其他 Agent 选择 `dsh-pool/<model-id>`。可用模型从 DSH `GET /v1/models` 实时读取。

如果 Magpie 和 DSH 安装在不同设备上，此版本不会连接远程 IP；这是为了避免在未配置 TLS 的情况下泄露用户 Key。请在同一台电脑运行。

## 安装当前开发分支

在电脑上克隆分支，进入仓库目录后执行上述命令：

```powershell
git clone --branch feature/magpie-pool-provider --single-branch https://github.com/yang0/chatgpt2api-dsh.git
cd chatgpt2api-dsh
magpie plugin add ./integrations/magpie
```

Windows 可以直接在 PowerShell 执行；本插件本身只需 Magpie 自带的 Bun 插件宿主，不需要单独安装 Python。DSH 自己的依赖由原来的 DSH 插件维护。

## How it works

- Magpie stores only a DSH **user API Key** in its plugin auth store.
- The plugin exposes a dedicated `dsh-pool` provider on `http://127.0.0.1:38650/v1`.
- It lists models using `GET /v1/models` and forwards agent requests to the local DSH gateway with `Authorization: Bearer <DSH_USER_KEY>`.
- Account import, password-based authorization, refresh, quota, retries and pool routing remain inside DSH.
- The plugin refuses non-loopback or unexpected-port request URLs and follows no HTTP redirects.

### Limitations

- Magpie sees one DSH **pool**, not each ChatGPT account; per-account quota/failover status remains in DSH.
- `@ai-sdk/openai-compatible` uses the OpenAI-compatible chat-completions protocol; this does not guarantee all Codex Responses, image tools, GIF, or arbitrary Magpie capabilities work. Validate each model through `magpie provider test` and an actual call.
- DSH may expose image-generation-only models via `/v1/models`. Such models should be called through DSH's image API, not Magpie's chat-completions provider.
- Real account login and Magpie desktop end-to-end tests require the user's authorized environment; unit tests do not contact OpenAI.
- Never expose port 38650 to the public Internet or share account/2FA secrets. Do not use a third-party account without permission.

## Tests

```bash
cd integrations/magpie
npm test
```

Tests use a mocked local gateway, do not hit real accounts, and cover model discovery, auth, streaming, input URL restrictions, and errors.

### Diagnostics

| Symptom | Check |
| --- | --- |
| `cannot reach the local pool` | Start DSH; check `127.0.0.1:38650` |
| `user API Key was refused` | Recreate key in DSH → API 接入 and re-login to Magpie plugin |
| `no valid models` | Open DSH API endpoint `/v1/models` and check DSH backend health |
| Model appears but chat errors | Model may only support image or Responses; use a compatible endpoint |
| Pool accounts show zero quota | Diagnose proxy and actual quota in DSH, not this Magpie plugin |

Tracking: [Issue #4](https://github.com/yang0/chatgpt2api-dsh/issues/4).
