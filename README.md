# README.md

# Sing-box XHTTP Serverless 极简部署方案

本项目专为 Northflank 等 PaaS 平台设计，结合 Cloudflare Worker 边缘计算，实现具有顶级抗审查能力、极低内存占用（适配 128MB 限制）且支持“缩放为零 (Scale-to-Zero)”的 VLESS-XHTTP 代理节点。

## 架构优势

*   **容器零负载伪装**：主动探测防御与路径分流全部由前置的 CF Worker 完成。探测者只会看到用于防主动探测的 `index.html` 伪装页面，恶意流量不会唤醒后端容器。
*   **平台规范适配**：通过 `PORT` 环境变量动态对齐应用监听端口与 Northflank 平台期望规范，无需修改系统级宿主机端口。
*   **内存极度克制**：卸载 TLS 和路由规则，纯粹处理数据转发；注入 `GOMEMLIMIT=100MiB` 和 `GOGC=50` 环境变量，死死压制 Go 运行时的内存激增，杜绝 128MB 容器 OOM 重启。
*   **四重安全防御**：CF WAF (国内 IP 白名单) ➡️ 自定义 Header 暗号 ➡️ 复杂请求路径 ➡️ VLESS UUID 强认证。

## 部署准备

1. Fork 或新建一个私有 GitHub 仓库，包含本项目的四个文件：`Dockerfile`、`config.json.template`、`entrypoint.sh` 和 `README.md`。
2. 准备一个 Cloudflare 账号，并托管一个自定义域名。

## Northflank 部署指南

1. 在 Northflank 控制台创建新的 **Service**，类型选择 **Deployment**，关联你的私有 GitHub 仓库。
2. **环境变量 (Environment Variables)**：手动添加以下变量，避免敏感信息硬编码：
   *   `MY_UUID`: 你的 VLESS UUID（如 `a1b2c3d4-e5f6-7a8b-9c0d-123456789abc`）
   *   `MY_PATH`: 你的隐秘 XHTTP 路径（必须以 `/` 开头，如 `/xhttp-8f3b2a1c`）
3. **网络与端口 (Networking)**：
   *   添加端口 `8080`，协议选择 **HTTP**。
   *   勾选 **Publicly expose this port to the internet**。平台将分配一个 `.northflank.app` 域名（此域名稍后需填入 CF Worker）。
4. **健康检查 (Health Checks) - 极其关键**：
   *   将 Liveness 和 Readiness 的检查类型从 HTTP 改为 **TCP**。
   *   *原因：纯净版代理核心无法响应平台默认的根目录 HTTP GET 探针，若不改为 TCP，平台会判定服务死亡并无限重启容器。*

## 客户端配置 (Sing-box / Xray / v2rayN)

通过绑定的 CF 自定义域名进行连接。以下为核心参数：

*   **传输协议 (Network)**: `xhttp`
*   **XHTTP 模式 (Mode)**: `packet-up`（必选，确保通过 Serverless 架构不断流）
*   **伪装域名 (Host/SNI)**: 你的 Cloudflare 自定义域名
*   **路径 (Path)**: 与 `MY_PATH` 环境变量保持一致
*   **自定义 Header**: `{"X-My-Secret-Token": "你的专属暗号"}` （需与 Worker 脚本对应）
