# Changelog

## 未发布

- **新增账号自动换取 Token 并直接入池功能**：原生支持 `邮箱----密码----2FA密钥` 账号格式，集成 OpenAI Platform OAuth + PKCE + TOTP 2FA 认证工作进程（`scripts/auth-worker.py`），自动登录换取 `access_token`、`refresh_token` 与 `id_token`，并实时注册至本机号池服务（`/api/accounts`）生效。
- **一键导入与暂存管理增强**：界面提供「导入并授权入池」（直接转换并加入可用 Token 号池）与「仅加密暂存」，暂存列表新增「全部授权入池」及单条「授权入池」操作；授权失败条目保留在暂存区并清晰标记错误原因，已授权条目自动清理。
- **安全保障**：所有 OAuth、密码验证与 TOTP 计算均在 Host 本地隔离 Python 运行时中执行，密码、2FA 密钥与 Access Token 绝不回显或返回给浏览器端。
- 修复 `link:` 安装时插件整体无法导入的问题：Host 入口不再直接写
  `import {Service} from '@deepseek-ai/cordis'`。`link:` 安装的插件目录在 DSH 安装树之外，
  该裸说明符会以 `ERR_MODULE_NOT_FOUND` 失败，DSH 随即跳过整条插件行（左侧没有入口、
  服务未注册、后端不启动）。
- 新增 `lib/cordis-service.js`：优先从运行中的 DSH 宿主入口解析并复用**同一份** Cordis
  模块（同一 file URL，ESM 缓存即同一实例，`Service` 身份一致）；找不到宿主时回退到兼容
  基类，通过 `ctx.reflect.provide` 注册服务。
- 新增 `tests/cordis-service.test.mjs`；`tests/archive.test.mjs` 的可执行位断言改为只在
  非 Windows 平台生效。

## v0.6.0 — 2026-11-04

- 升级为 Windows / macOS / Linux 单 ZIP 包；根据平台/架构自动选择官方 uv 0.9.13 发布物（含 x64、ARM64、Linux GNU/musl），内置 SHA256 校验。
- 使用 Node.js 内置 ZIP/tar.gz 解压，无需 Docker、全局 Python 或 unzip/tar 命令。隔离安装 Python 3.13。
- Windows v0.5 数据根路径、内部 Host 密钥、号池数据库与凭据暂存保持兼容。
- 保留独立的 DSH Cordis 服务与本机 OpenAI 兼容 HTTP API，不与写真工作台耦合。
- 新增 8 组合系统架构选择及启动/停止模拟测试、归档解压与路径穿越测试。
- 说明：Windows/macOS/Linux 真机部署、账户登录、CPA/sub2api 和生图仍待联调。


## v0.5.0 — 2026-11-04

- 新增邮箱----密码----第三字段逐行批量导入（支持 TXT、错误行号、去重、上限校验）。
- 创建本地 AES-256-GCM 加密“待授权账号”暂存库，独立于可用 access_token 号池。
- DSH 原生界面显示待授权条目，允许按条删除，不展示或返回密码与辅助字段。
- 所有暂存操作均在 DSH 受保护 Host 管理路由内部完成，不请求上游账号登录接口。
- 保留免管理密码和第三方独立用户 API Key 机制；旧账号与本机数据目录不变。


## v0.4.0 — 2026-11-04

- 管理页面完全免输入密码：移除管理员密钥表单、连接按钮、退出管理会话及查看管理员密钥脚本。
- 管理请求改为通过 DSH 受认证同源 `/api/chatgpt2api-native/manage` 路由，由 Host 自动附带上游内部认证。
- 限制 Host 管理请求路径和操作方法，拒绝任意管理 API 代理。
- 账号列表只返回脱敏状态与匿名账号引用；原始账号凭据仅由 Host 解析和操作。
- API 接入页仍可自行创建、复制和吊销面向第三方的用户调用密钥。
- 图片生成测试改走 DSH 内部管理通道，不再从浏览器直接调用带管理员密钥的上游。
- 保留旧的 Python 运行时、账号数据库及所有已创建的用户调用密钥，不需要重新导入。
- 需要 DSH Web profile 的认证 Connection 服务；不支持无身份的公网管理网页。

## v0.3.0

- Windows x64 无 Docker、本地 Python 自动部署与统一 OpenAI 兼容 API。
- DSH Host 通用 `ctx.chatgpt2api` 接口和原生管理界面。
