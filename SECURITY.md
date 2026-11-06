# ChatGPT2API Native v0.6.2 安全说明

跨平台版本与 v0.5.0 一样：**用户不必输入任何管理员密码**。DSH 已认证的管理会话访问 Host 的精确路由，由 Host 使用随机内部凭据与 Python 后端通信；网页端与其他插件不会获取管理凭据。第三方 HTTP API 仍需要单独创建的用户 Key。

- 后端仅监听 `127.0.0.1`，禁止将此监听地址随意映射到公网、配置无鉴权反向代理或跨用户共享其数据目录。
- 首次运行从固定的 GitHub 上游提交下载源码，下载各 OS/CPU 适配的 uv；uv 官方发行文件使用固定 SHA256 校验，并用内置有限制的 ZIP/tar.gz 解压器处理归档。
- 用户数据位于当前执行 DSH Host 的**操作系统账户**主目录中；不同用户或容器身份会对应不同的数据目录，务必明确管理数据所在账户。
- `pending-credentials.enc.json` 使用 AES-256-GCM，加密密钥来源于本地 Host 私有密钥；不同设备迁移加密暂存数据时，必须谨慎处理密钥，不能只复制加密文件。
- 对浏览器的号池列表只显示脱敏账号引用，不返回 `access_token`、`refresh_token`、原密码或第三字段。错误信息避免携带原始敏感值。
- 外部用户 API Key 可在插件「API 接入」创建、吊销；不要分享给陌生软件，也不要在日志中输出。
- 邮箱、密码与 2FA 密钥可用于 OAuth + PKCE + TOTP 自动换取 `access_token`；也可先用「仅加密暂存」保存，再由用户显式触发授权。换取的 Token 只进入本机号池，密码与 2FA 密钥不会回显给浏览器。
- 复用系统 Python 时只绑定解释器，依赖仍安装在隔离 venv 中；`DSH_CHATGPT2API_SYSTEM_SITE_PACKAGES=1` 会显式继承全局包，属用户主动选择的取舍。
- 运行时源代码仍由上游 GitHub 分发；非官方逆向接口可能变化或导致账号受限。上游 README 限制商业和自动化滥用。
- 升级前备份号池。Windows：`%USERPROFILE%\.dsh\chatgpt2api-native\`；macOS/Linux：`~/.dsh/chatgpt2api-native/`。切勿公开备份。

此构建已通过本地测试，**尚未通过真实 Windows/macOS/Linux + DSH + 外部服务的端到端兼容性验收**。
