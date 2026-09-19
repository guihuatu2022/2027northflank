# xhttp-northflank — 服务端

VLESS + XHTTP 节点，跑在 Northflank 上；Cloudflare Worker 在前面做 CDN、双密钥鉴权和伪装。

```
客户端 Xray (packet-up)
   │  TLS, SNI = 你的 Worker 域名,  请求头 x-auth: 密钥A
   ▼
Cloudflare Worker ── 密钥A 不对 ──► 返回伪装网站（不碰回源）
   │  密钥A 正确：删掉密钥A，加上 x-origin-auth: 密钥B
   ▼
Northflank 边缘（终结 TLS + 校验密钥B）
   │  明文 HTTP / h2c
   ▼
容器内 Xray：VLESS + XHTTP，不做 TLS
```

**两道独立鉴权**：密钥A 只有客户端知道（Worker 校验），密钥B 只有 Worker 知道（Northflank 校验）。别人即使拿到你的客户端配置，也无法直连回源。容器里没有 TLS、没有 nginx —— 这是它内存小的原因。

---

## ⚠️ 先看这个：仓库文件必须齐全

上一轮构建失败的原因就是**少上传了文件**。这个仓库必须长成这样（`entrypoint.sh` 和 `Dockerfile` 在**根目录**，没有子目录）：

```
你的仓库/
├── Dockerfile                          ← 必需
├── entrypoint.sh                       ← 必需（少了它构建必失败）
├── .dockerignore                       ← 建议
├── .env.example                        ← 参考用，可选
├── server-config.reference.json        ← 参考用，可选
├── README.md                           ← 本文件
└── .github/
    └── workflows/
        └── build.yml                   ← 必需（GitHub 只认这个路径）
```

只有 `.github/workflows/build.yml` 必须在子目录里（GitHub 的硬性规定），其他文件全在根目录。

**用网页上传时正确的做法**：不要拖文件夹，用 **Add file → Create new file**，在文件名框里直接输入带斜杠的完整路径（例如 `entrypoint.sh`，或者 `.github/workflows/build.yml`），GitHub 会自动建目录，然后把内容粘进去。

工作流里已经加了**上传检查**：文件不齐会给出明确提示（`Missing required file: entrypoint.sh`），而不是难懂的 buildx 报错。

---

## 第一步：让 GitHub 构建镜像

1. 按上面的结构把文件放进仓库，推送到 `main` 分支。
2. 打开仓库 **Actions** 页，`build-and-push` 会自动运行，约 3-5 分钟。
3. 成功后镜像地址：`ghcr.io/<你的用户名>/<仓库名>:latest`
4. **重要**：ghcr 的包默认私有。去 GitHub → 头像 → **Packages** → 该包 → **Package settings** → **Change visibility** → **Public**。
   （不想公开就在 Northflank 加 registry 凭据：用户名填 GitHub 用户名，密码填有 `read:packages` 权限的 PAT。）

---

## 第二步：在 Northflank 部署

新建 **Service**（Deployment service）。

**1. 镜像**：Registry `ghcr.io`，镜像路径 `<用户名>/<仓库名>`，tag `latest`。

**2. 端口**：加一个端口
- Port：`8080`
- Protocol：`HTTP`（选 `HTTP/2` 也行，两种都能跑）
- Public：**打开**
- 记下 Northflank 给的域名，形如 `https://p01--xxx--abc123.code.run` —— 这就是 Worker 的 `UPSTREAM_ORIGIN`。

**3. 健康检查**（Observe → Health checks）：加一个 **TCP** 探针，端口 `8080`。

> 不要用 HTTP 探针。这是真实 Xray v26.3.27 上实测的行为：
> `GET /` → 404（路径不匹配）；`GET /你的path` → 404（服务端内部路径带尾斜杠）；`GET /你的path/` 和 `GET /你的path/任意session` → 400（不带合法 padding 的请求一律拒绝）。
> 就算补上合法 padding，下行请求也会一直挂着不结束。三种都会被探针判失败。

**4. 环境变量**：必填只有 3 个。

| 变量 | 填什么 |
|---|---|
| `UUID` | 你的 VLESS id，随便生成一个 UUID v4 |
| `PORT` | `8080`，**必须和上面配的容器端口一致** |
| `XHTTP_PATH` | 一长串随机字符，例如 `/a7f3k9q2m5x8`（**要和 Worker 里填的一模一样**） |

其余全部有合理默认值，一个都不用填（详见 `.env.example`）：`XHTTP_MODE=packet-up`、`XHTTP_HOST=`（**保持空**）、`SC_MAX_EACH_POST_BYTES_*`、`SC_MAX_BUFFERED_POSTS`、`X_PADDING_*`、`NO_SSE_HEADER=false`、`LOG_LEVEL=warning`、`DNS_SERVERS`、`DOMAIN_STRATEGY`、`ENABLE_SNIFFING=false`、`BLOCK_BITTORRENT=false`。

`GOMEMLIMIT` **不要填**，启动脚本会读容器内存上限自动设成 70%。

**5. 安全策略（别跳过）**：Northflank 的公网域名是任何人都能直连的。去 **Run → Networking** → 该端口的 **Custom domains & security rules**：

- 添加 **HTTP header** 安全策略（allow 模式）
- Key：`x-origin-auth`
- Value：**密钥B**（自己生成一长串随机值，和密钥A 必须不同）

界面支持按路径配置的话，路径用 **Prefix** 填 `XHTTP_PATH`；不支持就整端口生效，效果一样。

做完后浏览器直接访问 Northflank 域名应该被拒绝，走 Worker 正常 —— 这就对了。

---

## 关于服务端配置文件

**镜像里没有、也不需要配置文件。** 构建阶段只做两件事：下载 Xray 二进制、把 `entrypoint.sh` 放进镜像。真正的配置在**容器启动时**由 `entrypoint.sh` 根据环境变量生成到 `/etc/xray/config.json`，并先用 `xray run -test` 校验；校验不通过容器会立刻退出并打印原因。

`server-config.reference.json` 是**默认参数下的生成结果**（示例 UUID 和 path），给你看配置长什么样用的，**不参与构建**。

想完全自己写配置的话，把整份 JSON 塞进一个环境变量即可，此时上面所有变量都被忽略：

```
XRAY_CONFIG_JSON={"log":{"loglevel":"warning"},"inbounds":[...],"outbounds":[...]}
```

---

## 排障

| 现象 | 原因 |
|---|---|
| Actions 报 `Missing required file` | 有文件没上传，看报错里的路径 |
| Actions 报 `"/entrypoint.sh": not found` | `entrypoint.sh` 没放在仓库根目录 |
| 容器反复重启 | 健康检查用了 HTTP 探针；改成 TCP |
| 浏览器打开 Worker 域名是 404 | 正常，试试 `/about` 或 `/mirrors` |
| Worker 返回 502 | `UPSTREAM_ORIGIN` 写错，或回源被 Northflank 头策略挡住（密钥B 不一致） |
| 一直连不上，日志说 400 | 客户端和服务端的 `XHTTP_PATH` 不一致，或客户端的 `scMaxEachPostBytes` 大于服务端 |
| 直接 404 | 客户端请求头里的密钥A 和 Worker 的 `CLIENT_AUTH_VALUE` 不一致 |
| 每天固定时间连不上 | Workers 免费版每天 10 万请求用完了（错误码 1027） |
| 一周断几次 | Cloudflare 每周更新 Workers 运行时，进行中的请求给 30 秒宽限期后终止 —— 平台行为，客户端会自动重连 |

## 安全须知

1. **密钥A 和密钥B 必须不同**，都别提交进 git。
2. 密钥是静态的：客户端配置一旦泄露就要轮换（Worker 可先同时接受新旧两个值，改完客户端再删旧的）。
3. Worker 免费版每请求只有 **10 毫秒 CPU**，隧道代码**必须流式透传**。任何地方出现 `await request.text()` / `arrayBuffer()` 都会把整个数据读进内存，直接崩。
4. 请遵守你所在地区的法律法规。

## 本地自测（可选，需要本机有 Node 18+）

```bash
cd ..                       # 回到 xhttp 目录
node worker/smoke-test.mjs  # 57 项检查
```
