# xhttp-northflank

VLESS + XHTTP 节点，跑在 Northflank 上，前面挂 Cloudflare Worker 做 CDN、鉴权和伪装。

```
客户端 Xray (packet-up)
   │  TLS, SNI = 你的 CF 域名,  头 x-auth: 密钥A
   ▼
Cloudflare Worker ── 密钥A 不对 ──► 返回伪装网站（不碰回源）
   │  密钥A 正确：删掉密钥A，加上 x-origin-auth: 密钥B
   ▼
Northflank 边缘（终结 TLS + 校验密钥B）
   │  明文 HTTP / h2c
   ▼
容器内 Xray：VLESS + XHTTP，不做 TLS
```

**两道独立鉴权**：密钥A 只有客户端知道（Worker 校验），密钥B 只有 Worker 知道（Northflank 校验）。别人拿到你的客户端配置，也无法直连回源。容器里没有 TLS、没有 nginx —— 这是它内存小的原因。

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 构建容器镜像（Alpine + Xray v26.3.27） |
| `docker/entrypoint.sh` | 启动时用环境变量生成 Xray 配置并校验 |
| `.github/workflows/build.yml` | GitHub 自动构建并推送镜像到 ghcr.io |
| `worker/src/index.js` | **Worker 单文件**（隧道代理 + 多页英文镜像站伪装） |
| `worker/wrangler.toml` | 只有用 wrangler 命令行部署时才需要 |
| `client/config.example.json` | 客户端 Xray 配置示例 |
| `.env.example` | Northflank 要填的所有环境变量 |

把整个仓库上传到 GitHub 即可。

---

## 第一步：让 GitHub 构建镜像

1. 把仓库推到 GitHub（`main` 分支）。
2. 打开仓库的 **Actions** 页，`build-and-push` 会自动运行，约 2-4 分钟。
3. 成功后，镜像地址是：

   ```
   ghcr.io/<你的用户名>/<仓库名>:latest
   ```

   （ghcr 要求全小写，用户名有大小写时以 Actions 日志里打印的为准）
4. **重要**：ghcr 的包默认是私有的。到 GitHub → 你的头像 → **Packages** → 找到这个包 → **Package settings** → **Change visibility** → **Public**。
   （不想公开的话，就在 Northflank 添加 registry 凭据：用户名填 GitHub 用户名，密码填一个有 `read:packages` 权限的 Personal Access Token。）

想换 Xray 版本：改 `build.yml` 里的 `XRAY_VERSION`，push 一下即可。

---

## 第二步：在 Northflank 部署

新建 **Service**（Deployment service）。

1. **镜像**：Registry 选 `ghcr.io`，镜像路径填 `<用户名>/<仓库名>`，tag `latest`。
2. **端口**：加一个端口
   - Port：`8080`
   - Protocol：`HTTP`（选 `HTTP/2` 也行，两种都能跑）
   - Public：**打开**
   - 记下 Northflank 给的那个域名，形如 `https://p01--xxx--abc123.code.run` —— 这个就是 Worker 的 `UPSTREAM_ORIGIN`。
3. **健康检查**（Observe → Health checks）：加一个 **TCP** 探针，端口 `8080`。
   > 不要用 HTTP 探针。以下是在真实 Xray v26.3.27 上实测的行为：
   > `GET /` → 404（路径不匹配）；`GET /你的path` → 404（服务端内部路径带了尾斜杠）；`GET /你的path/` 和 `GET /你的path/任意session` → 400（不带合法 padding 的请求一律拒绝）。
   > 就算补上合法 padding，下行请求也会一直挂着不结束 —— 三种都会被探针判失败。
4. **环境变量**：照 `.env.example` 填。最少要改这几个：

   | 变量 | 说明 |
   |---|---|
   | `UUID` | 你的 VLESS id，随便生成一个 UUID v4 |
   | `PORT` | `8080`，必须和上面的端口一致 |
   | `XHTTP_PATH` | 改成一长串随机字符，例如 `/a7f3k9q2m5x8` |
   | `XHTTP_MODE` | `packet-up` |
   | `LOG_LEVEL` | `warning` |

   `GOMEMLIMIT` 不用管，启动脚本会按容器内存上限自动算。

---

## 第三步：加第二道鉴权（别跳过）

现在 Northflank 那个域名是**公网可直连**的。必须在平台上再加一道头校验，否则别人绕过 Worker 就能白嫖你的回源。

在 Northflank 服务的 **Run → Networking** → 该端口的 **Custom domains & security rules** 里：

- 添加 **HTTP header** 安全策略（allow 模式）
- Key：`x-origin-auth`
- Value：**密钥B**（自己生成一长串随机值，和密钥A 必须不同）

如果界面支持按路径配置，路径用 **Prefix** 填你的 `XHTTP_PATH`；不支持就整端口生效，效果一样。

做完后，直接用浏览器访问 Northflank 域名应该被拒绝，而走 Worker 正常 —— 这就对了。

---

## 第四步：部署 Worker

Worker 是**一个文件**：`worker/src/index.js`。

1. Cloudflare 控制台 → **Workers & Pages** → **Create** → 起个名字 → **Deploy**。
2. 进入 **Edit code**，把 `worker/src/index.js` 的内容整份粘贴进去 → **Deploy**。
3. 打开文件**最顶部**的 `CONFIG` 块，改这三行（也可以不改文件，改成在 Settings → Variables 里配同名变量，**环境变量优先级更高**）：

   | 字段 | 填什么 |
   |---|---|
   | `UPSTREAM_ORIGIN` | 第二步拿到的 Northflank 域名，如 `https://p01--xxx--abc123.code.run` |
   | `XHTTP_PATH` | **必须和 Northflank 的 `XHTTP_PATH` 一模一样** |
   | `CLIENT_AUTH_VALUE` | 密钥A（长随机串） |
   | `ORIGIN_AUTH_VALUE` | 密钥B（和第三步填的完全一致） |

   > 密钥留空时 Worker **拒绝代理任何请求**（fail-closed），只会返回伪装网站。这是故意的，防止忘配置就裸奔。

4. （推荐）在 **Settings → Domains & Routes** 里绑定你自己的域名。`workers.dev` 域名在国内通常很慢。
5. 部署完访问 `https://你的域名/`，应该看到一个正常的英文镜像站首页 —— 伪装生效了。

**伪装网站**自带 15 个页面：首页、镜像列表（带搜索）、文档、FAQ、状态页、新闻列表 + 3 篇正文、关于、联系、隐私、使用条款，外加 `robots.txt`、`sitemap.xml`、favicon、CSS/JS。品牌名等可在 `CONFIG` 里改（`SITE_NAME` / `ORG_NAME` / `CONTACT_EMAIL` / `SITE_DOMAIN` …）。

---

## 第五步：客户端

用 `client/config.example.json` 作模板，把 4 个占位符换掉：

| 占位符 | 填什么 |
|---|---|
| `YOUR-WORKER-DOMAIN.example.com` | 你的 Worker 域名（address 和 serverName 都填它） |
| `PASTE-YOUR-UUID-HERE` | 第一步的 `UUID` |
| `/PASTE-YOUR-RANDOM-PATH` | `XHTTP_PATH` |
| `PASTE-YOUR-CLIENT-SECRET` | 密钥A |

关键点：
- 传输方式必须是 **Xray 内核**（v2rayN/v2rayNG 里选 Xray），sing-box / v2ray-core 不支持 XHTTP。
- `flow` **必须留空**。
- `alpn` 保持 `h2` + `http/1.1`，**不要只填 http/1.1**（会让每个上行包都重新握手，经 CF 会非常慢）。
- 客户端的 `scMaxEachPostBytes` 不能超过服务器的值。

**如果客户端面板没有"自定义请求头"输入框**：把 Worker 的 `CLIENT_AUTH_QUERY` 设成 `k`，然后把客户端 path 写成 `/你的path?k=密钥A`。Worker 会用查询参数鉴权。多数客户端也可以把 `{"headers":{"x-auth":"密钥A"}}` 填进 XHTTP 的 `extra`（JSON）框。

---

## 验证清单

| 检查 | 期望结果 |
|---|---|
| 浏览器打开 Worker 域名 | 正常镜像站 |
| 浏览器打开 `Worker域名/你的path` | 正常 404 页面（伪装），**不是** 403/502 |
| 浏览器直连 Northflank 域名 | 被拒绝 |
| 客户端连上后访问 ip.sb | 显示 Northflank 所在地区的 IP |
| `curl -N` 挂一个长连接 | 能撑住不立刻断 |

## 排障

| 现象 | 原因 |
|---|---|
| Worker 返回 502 | `UPSTREAM_ORIGIN` 写错，或回源被 Northflank 头策略挡住（密钥B 不一致） |
| 一直连不上，日志说 400 | 客户端和服务端的 `XHTTP_PATH` 不一致，或客户端的 `scMaxEachPostBytes` 大于服务端 |
| 直接 404 | 客户端 `headers` 里的密钥A 和 Worker 的 `CLIENT_AUTH_VALUE` 不一致 |
| 容器反复重启 | 健康检查用了 HTTP 探针；改成 TCP |
| 每天固定时间连不上 | Workers 免费版每天 10 万请求用完了（错误码 1027） |
| 一周断几次 | Cloudflare 每周会更新 Workers 运行时，正在进行的请求给 30 秒宽限期后终止 —— 平台行为，客户端会自动重连 |

## 安全须知

1. **密钥A 和密钥B 必须不同**，都别提交到 git（尤其别写进 `wrangler.toml`）。
2. 密钥是静态的：客户端配置一旦泄露就要轮换。轮换时 Worker 可以先同时接受新旧两个值，改完客户端再删旧的。
3. Worker 免费版每个请求只有 **10 毫秒 CPU**，所以隧道代码**必须流式透传**。不要在任何地方写 `await request.text()` / `arrayBuffer()` —— 那会把整个数据读进内存，直接崩。
4. 本项目的定位是自用代理。请遵守你所在地区的法律法规。

## 本地自测（可选）

```bash
node worker/test/smoke.mjs     # 57 项检查：伪装站路由、鉴权、头部改写、流式转发
```

---

# 附：原理与限制（感兴趣再看）

**为什么是 packet-up。** XHTTP 有三种模式：`packet-up`、`stream-up`、`stream-one`。`stream-one` 需要真正的全双工，Worker 这层做不到；`stream-up` 需要流式上行请求体，Cloudflare 官方文档没有承诺支持。`packet-up` 把上行拆成一个个 POST、下行用一个长 GET 流，是唯一能稳定穿过 Worker + 平台入口的组合。

**超时数字（Cloudflare 官方）。** 客户端↔CF 的 HTTP/2 空闲上限是 400 秒；CF↔回源是 Proxy Idle 900 秒、Proxy Read 125 秒；而 Worker 的 HTTP 请求**时长无上限**。网上流传的"100 秒"是旧说法。客户端的 `xmux.hKeepAlivePeriod`（示例里是 40 秒）用 HTTP/2 PING 把第一段保活。

**不会被压缩。** Cloudflare 默认压缩的 content type 清单里没有 `text/event-stream`，而且 Xray 客户端根本不发 `Accept-Encoding`。所以 `noSSEHeader` 保持默认即可。Worker 另外强制了回源 `accept-encoding: identity`，保证隧道字节不被中间层改动。

**缓冲。** Xray 的下载通道响应自带 `X-Accel-Buffering: no` 和 `Cache-Control: no-store`，主流网关不会攒数据。

**缓存安全。** 所有"伪装答案"都带 `Cache-Control: no-store`，避免伪装页被边缘缓存后喂给真实客户端。

**内存。** 启动脚本读取容器 cgroup 内存上限，自动设 `GOMEMLIMIT` 为 70%；日志默认只到 warning，访问日志关闭（packet-up 请求量很大）。
