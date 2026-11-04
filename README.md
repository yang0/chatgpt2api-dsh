# ChatGPT2API Native v0.6.0 — DSH 跨平台独立号池插件

**同一份插件 ZIP：Windows / Linux / macOS。无需 Docker，无需单独部署 chatgpt2api，也不要求预装 Python。** 插件在 DSH Host 内启动隔离的 Python 后端，暴露 DSH 内部 `ctx.chatgpt2api` 服务与本机 OpenAI 兼容 HTTP API。与 AIPoseStudio 或任何具体调用者没有依赖关系。

> 安装前必读：本包属于待实机联调的测试版本。已在 Linux 的 Node.js 22 环境下执行自动测试；Windows/macOS 的启动流程通过模拟测试，**尚未在真实 Windows/macOS + DSH 环境完成安装、生图或账号登录验证**。首次启动需要互联网访问 GitHub 和 Python 包源（可能下载数百 MB）；建议预留 ≥ 1 GB 磁盘空间。

## 支持的平台

| 系统 | CPU | 后端运行时选型 | 测试状况 |
|---|---|---|---|
| Windows 10/11 | x64 | uv Windows x64 + Python 3.13 | 启动模拟；旧版数据路径保留 |
| Windows 11 | ARM64 | uv Windows ARM64 + Python 3.13 | 启动模拟；Python 依赖需实机确认 |
| macOS | Intel x64 | uv macOS x64 + Python 3.13 | 启动模拟，待实机验证 |
| macOS | Apple Silicon ARM64 | uv macOS ARM64 + Python 3.13 | 启动模拟，待实机验证 |
| Linux | x64 / ARM64 | uv Linux GNU/musl + Python 3.13 | 启动模拟；发行版依赖需实机验证 |

运行要求：**DeepSeek Harness（DSH）Web Profile + Node.js 20 或更高版本**，推荐 Node 22；必须允许 DSH Host 在本机用户数据目录下写文件并监听回环端口。Linux 仅针对较新的主流发行版规划；使用旧 glibc、极简容器或有强执行限制的环境需额外兼容验证。

## 安装（所有平台是同一个 ZIP）

1. 停止 DSH，先备份已有号池数据。禁用旧版本 `dsh-plugin-chatgpt2api`，不要同时加载同名插件。
2. 解压此 ZIP 到一个固定目录；**保留全部 `lib/`、`demo/`、`scripts/` 与清单文件**。
3. 将目录使用 DSH Web Profile 注册，然后重新启动 DSH：

**Windows PowerShell：**

```powershell
dsh plugin --profile web add "link:C:/DSH/plugins/dsh-plugin-chatgpt2api"
dsh web
```

**macOS / Linux（shell）：**

```bash
dsh plugin --profile web add "link:/home/yourname/DSH/plugins/dsh-plugin-chatgpt2api"
dsh web
```

macOS 可将 `link:` 路径换为 `/Users/yourname/...`；Linux 换为实际绝对路径。上面是示例，不要原样复制不属于本机的目录。

4. 打开 DSH 左侧的「ChatGPT2API」菜单。**没有管理员登录密码**：管理请求通过 DSH 已认证的会话交给 Host 处理。
5. 首次启动插件自动下载并校验对应架构的 uv，下载固定提交的开源 chatgpt2api 源码，使用 uv 安装隔离的 Python 3.13 和依赖，然后自动在 `127.0.0.1:38650` 启动 API。无需额外运行服务命令。
6. 进入「号池管理」导入你有权使用的账号；进入「API 接入」可为第三方软件创建独立调用 Key。

首次初始化可能受网络、下载服务或 Python 依赖平台兼容性影响而失败；打开「插件设置」及 Host 日志查看错误。**安装成功不等于所有账号或模型必定可用。**

## 功能

- **号池总览**：账号总数、可用账号、额度和后端健康信息。
- **账号管理**：导入 Token / JSON，查看脱敏账号状态，刷新或删除；CPA、sub2api 管理入口基于上游相应接口。
- **邮箱行导入与自动授权入池**：支持每行 `邮箱----密码----2FA密钥`，支持粘贴与 TXT 文件。可直接点击「导入并授权入池」自动通过 OpenAI OAuth + 2FA 登录换取 Token 并注册至可用号池；亦可选择「仅加密暂存」由本地 AES-256-GCM 保护，并在需要时一键批量或单条授权入池。界面绝不回显密码、2FA 密钥或 Token 明文。
- **API 接入**：创建/查看/吊销第三方客户端 Key。浏览器不接收内部 Host 管理密钥。
- **生图接口**：文生图、编辑/多图参考（取决于上游实际支持情况），单张调试页面。
- **其他 DSH 插件调用**：Host 服务 `ctx.chatgpt2api` 与 DSH 插件通用兼容 API，不和任何业务工作台绑定。

邮箱行导入范例（纯示意，不含真实凭据）：

```text
sample1@example.invalid----demo-password-one----auxiliary-one
sample2@example.invalid----demo-password-two----auxiliary-two
```

## 第三方软件调用

- Base URL：`http://127.0.0.1:38650/v1`
- API Key：在 DSH 插件「API 接入」页面创建的**用户 API Key**，与内部管理密钥不同。
- 路径（非完整的官方 OpenAI API）：

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/images/generations
POST /v1/images/edits
```

例如：

```bash
curl http://127.0.0.1:38650/v1/models -H "Authorization: Bearer YOUR_CLIENT_API_KEY"
```

## 其他 DSH 插件调用

```ts
export const inject = ['chatgpt2api'];
export function apply(ctx) {
  // Host 服务；前端应通过自己的受保护 Host 桥接调用。
  void ctx.chatgpt2api.models().then(console.log);
  // 其他：health(), poolSummary(), chatCompletion(),
  // createResponse(), generateImage(), managedStatus()
}
```

## 跨平台数据与升级

保留旧版 Windows 用户数据（**安装升级不会主动清理或迁移已有数据**）：

- Windows：`%USERPROFILE%\.dsh\chatgpt2api-native\`
- macOS：`~/.dsh/chatgpt2api-native/`
- Linux：`~/.dsh/chatgpt2api-native/`

`source/data/` 保存上游号池、运行数据与第三方 API Key；`pending-credentials.enc.json` 保存加密待授权记录；`admin-key` 是 Host 私有的随机内部认证值，无须用户查找或输入。**不要删除这些文件。** 可通过环境变量 `DSH_CHATGPT2API_HOME` 指定固定数据根目录，但不要不小心将多个不同系统共用同一运行时/虚拟环境。

Windows x64 从 v0.5.0 升级时保留 `runtime/uv.exe`、`source/data/`、`admin-key` 和加密暂存文件；其他系统各自自动选择官方 uv 资产，且按架构区分可执行文件名。**在跨操作系统复制数据时，只迁移账号和密钥的所需文件，不要复制系统专属 `.venv/` 环境。**

源码锁定：`basketikun/chatgpt2api` 提交 `92dd80e91543157d36a4ddad60e765c5293760e9`（2026-10-25）；uv 版本 `0.9.13`，按平台使用官方 SHA256 校验。后端不是以 Python 源码形式嵌入 ZIP，而是**首次启动自动下载固定版本**。并不是离线解压即用。

## 排障命令

在解压目录下运行：

```bash
node scripts/manage-backend.mjs status
node scripts/manage-backend.mjs log
node scripts/check-backend.mjs
```

也可通过 `node scripts/manage-backend.mjs start` 前台调试（确保 DSH 没有启动同一端口的后端），但**正常使用无需手动启动**。

## 开发与测试

```bash
node scripts/build.mjs
node --test tests/*.test.mjs
```

`lib/client.js` 为 DSH 自定义浏览器加载器目标文件，`lib/index.js` 为 Cordis Host 插件入口；不需要运行 npm install 来构建 UI。原项目 Python 运行时则在用户电脑首次启动时下载。

## 安全与合规

- 只在 `127.0.0.1` 监听，不要把 DSH 管理接口或本地端口直接暴露公网。
- DSH 免管理员输入密码不代表无权限校验：管理操作依赖 DSH Host 的会话保护，上游 Python 服务仍有内部私有认证。第三方 API Key 可以独立吊销。
- 用户提供的邮箱/密码/第三字段属于敏感信息，切勿在公开聊天或日志中粘贴。静态加密文件不能抵御已经控制本机用户权限的恶意软件。
- 上游为 ChatGPT 官网接口的非官方逆向实现，不保证一直有效，可能引发账号风控。其 README 对商业用途、自动化批量和滥用有明确限制；请遵守相应服务条款和上游声明。

更多：`SECURITY.md`、`CHANGELOG.md`。上游源码：<https://github.com/basketikun/chatgpt2api>，采用 MIT License。
