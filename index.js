/**
 * =============================================================================
 *  Cloudflare Worker - single file, no build step, no dependencies
 * =============================================================================
 *
 *  Two jobs, decided per request:
 *
 *   1. TUNNEL  - a request whose path matches XHTTP_PATH *and* that carries the
 *                correct client secret is streamed straight to the Northflank
 *                origin (which hosts VLESS + XHTTP).
 *
 *   2. DECOY   - everything else is answered with a normal-looking, multi-page
 *                English "open-source software mirror" website. Unknown paths
 *                get a normal 404 page.
 *
 *  Security notes:
 *   - The client secret is replaced by a *different* origin secret before the
 *     request leaves for Northflank, so the client secret never reaches the
 *     platform and the origin secret never reaches the client.
 *   - Client IP headers are stripped, so the platform does not learn the real
 *     client address.
 *   - Decoy answers for tunnel paths are sent with `Cache-Control: no-store`
 *     so a decoy can never be cached and then served to a real client.
 *   - The tunnel body is passed through as a stream. NEVER read it into memory:
 *     the Workers free plan allows only 10 ms of CPU per request, and reading
 *     the body would blow both CPU and the 128 MB isolate memory limit.
 *
 *  Deployment: paste this whole file into the Cloudflare dashboard worker
 *  editor, or deploy it with wrangler. Config lives in CONFIG below, and can be
 *  overridden by Worker environment variables of the same name.
 * =============================================================================
 */

// ===========================================================================
//  CONFIG - EDIT THESE FOUR LINES AND YOU ARE DONE
// ===========================================================================
//
//  You can either edit the values below directly, or leave them alone and set
//  the same names as Worker variables / secrets in the dashboard.
//  An environment variable always wins over the value written here.
// ---------------------------------------------------------------------------
const CONFIG = {
  // 1. Your Northflank public HTTPS endpoint, no trailing slash, e.g.
  //    "https://p01--xhttp--abc123.code.run"
  UPSTREAM_ORIGIN: "https://CHANGE-ME.code.run",

  // 2. Must be byte-for-byte identical to XHTTP_PATH in the Northflank env.
  //    Use a long random string, e.g. "/a7f3k9q2m5x8"
  XHTTP_PATH: "/CHANGE-ME-RANDOM-PATH",

  // 3. Two DIFFERENT secrets. Leave them empty and the tunnel refuses to proxy
  //    anything (fail-closed) - fill them in before you deploy.
  //    CLIENT_AUTH_VALUE is what your Xray client sends.
  //    ORIGIN_AUTH_VALUE is what this Worker sends to Northflank; the
  //                      Northflank port header policy must require it.
  CLIENT_AUTH_HEADER: "x-auth",
  CLIENT_AUTH_VALUE: "",
  ORIGIN_AUTH_HEADER: "x-origin-auth",
  ORIGIN_AUTH_VALUE: "",

  // Optional fallback for clients whose GUI cannot set a custom request
  // header: set this to a short parameter name such as "k", then put the
  // secret in the client's path instead, e.g. "/your-path?k=THE-SECRET".
  // Leave empty to disable.
  CLIENT_AUTH_QUERY: "",

  // 4. Remove client IP headers before forwarding to Northflank.
  STRIP_CLIENT_IP: "true",

  // debug | info | warn | error | none
  LOG_LEVEL: "warn",

  // ---- decoy website identity (all optional) ------------------------------
  SITE_NAME: "Meridian Mirror",
  SITE_TAGLINE: "An open package mirror for research and education networks.",
  ORG_NAME: "Meridian Open Source Collective",
  CONTACT_EMAIL: "ops@example.org",
  SITE_DOMAIN: "",
  SITE_SINCE: "2016",
  SITE_LOCATION: "Zurich, Switzerland",
};
// ===========================================================================

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CLIENT_IP_HEADERS = new Set([
  "x-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-pseudo-ipv4",
  "forwarded",
]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
};

// ---------------------------------------------------------------------------
// decoy site content
// ---------------------------------------------------------------------------

const MIRRORS = [
  { id: "alpine", name: "Alpine Linux", path: "/alpine/", size: "62 GB", sync: "11 minutes ago", status: "ok", proto: "rsync, https" },
  { id: "debian", name: "Debian GNU/Linux", path: "/debian/", size: "1.9 TB", sync: "4 minutes ago", status: "ok", proto: "rsync, https" },
  { id: "ubuntu", name: "Ubuntu Archive", path: "/ubuntu/", size: "1.4 TB", sync: "7 minutes ago", status: "ok", proto: "rsync, https" },
  { id: "rocky", name: "Rocky Linux", path: "/rocky/", size: "486 GB", sync: "23 minutes ago", status: "ok", proto: "rsync, https" },
  { id: "fedora", name: "Fedora Linux", path: "/fedora/", size: "312 GB", sync: "38 minutes ago", status: "ok", proto: "rsync, https" },
  { id: "arch", name: "Arch Linux", path: "/archlinux/", size: "78 GB", sync: "6 minutes ago", status: "ok", proto: "rsync, https" },
  { id: "pypi", name: "PyPI (pip)", path: "/pypi/web/simple/", size: "21 TB", sync: "2 minutes ago", status: "ok", proto: "https" },
  { id: "npm", name: "npm Registry", path: "/npm/", size: "9.4 TB", sync: "3 minutes ago", status: "ok", proto: "https" },
  { id: "crates", name: "crates.io (Rust)", path: "/crates/", size: "740 GB", sync: "15 minutes ago", status: "ok", proto: "https" },
  { id: "golang", name: "Go Module Proxy", path: "/goproxy/", size: "3.1 TB", sync: "5 minutes ago", status: "ok", proto: "https" },
  { id: "maven", name: "Maven Central", path: "/maven/", size: "2.7 TB", sync: "31 minutes ago", status: "degraded", proto: "https" },
  { id: "docker", name: "Container Registry", path: "/registry/", size: "5.8 TB", sync: "9 minutes ago", status: "ok", proto: "https" },
];

const SERVICES = [
  { name: "HTTPS edge", region: "global", uptime: "99.99%", latency: "38 ms", status: "ok" },
  { name: "rsync endpoint", region: "eu-central", uptime: "99.97%", latency: "44 ms", status: "ok" },
  { name: "apt / deb pool", region: "eu-central", uptime: "99.98%", latency: "41 ms", status: "ok" },
  { name: "PyPI simple index", region: "global", uptime: "99.95%", latency: "52 ms", status: "ok" },
  { name: "npm registry", region: "global", uptime: "99.96%", latency: "49 ms", status: "ok" },
  { name: "Go module proxy", region: "global", uptime: "99.92%", latency: "61 ms", status: "ok" },
  { name: "Maven Central", region: "us-east", uptime: "98.71%", latency: "188 ms", status: "degraded" },
  { name: "Resolver (DNS)", region: "global", uptime: "99.99%", latency: "12 ms", status: "ok" },
];

const INCIDENTS = [
  { date: "2026-03-19", title: "Maven Central sync backlog", state: "monitoring", body: "Upstream rsync is delivering new artifacts with a delay of roughly 40 minutes. Mirrored content remains available; only freshness is affected." },
  { date: "2026-03-04", title: "Scheduled index rebuild", state: "resolved", body: "The PyPI simple index was rebuilt between 02:00 and 02:35 UTC. A small number of requests returned 503 during the rebuild." },
  { date: "2026-02-11", title: "Increased latency from APAC", state: "resolved", body: "A peering session with one APAC transit provider flapped for about 50 minutes, raising median latency to 210 ms. Traffic was re-routed automatically." },
];

const POSTS = [
  {
    slug: "pypi-and-crates-mirrors",
    title: "Two new mirrors: PyPI and crates.io",
    date: "2026-02-26",
    author: "Mirror Operations",
    excerpt: "Both ecosystems are now served from the same edge, with on-demand fetching for packages that have not been pre-seeded yet.",
    body: `
      <p>We have added two new mirrors to the index: the Python Package Index and crates.io. Both are served over HTTPS from the same edge as the rest of the collection, and both support on-demand fetching, which means a package that has not been pre-seeded yet is pulled from upstream the first time somebody asks for it.</p>
      <h2>Why these two</h2>
      <p>Our users asked for them more often than for anything else. Package installs sit in the critical path of a build, and a slow or unreachable index turns a two-minute build into a twenty-minute one. Keeping a copy close to the build machines removes that dependency almost entirely.</p>
      <h2>How to use them</h2>
      <p>Point your tooling at the mirror the same way you would point it at the upstream service. For pip, the index URL is enough. For cargo, a source replacement entry is needed, and the documentation has a ready-to-paste example.</p>
      <h2>What is next</h2>
      <p>The next candidates are a Conda channel and a second container registry endpoint. If you depend on either of them, tell us - the request list is what drives the roadmap.</p>
    `,
  },
  {
    slug: "edge-caching-improvements",
    title: "Faster metadata: edge caching for index files",
    date: "2026-01-30",
    author: "Platform Team",
    excerpt: "Index and metadata files are now cached at the edge for up to five minutes, cutting median metadata latency roughly in half.",
    body: `
      <p>Metadata requests - the small index files a package manager reads before it downloads anything - outnumber artifact downloads by roughly nine to one. They are also the requests where latency is felt most directly, because nothing else can start until they finish.</p>
      <h2>What changed</h2>
      <p>Index and metadata responses are now cached at the edge for up to five minutes. Large artifacts keep their previous behaviour, since they are streamed straight from storage and do not benefit from a short-lived cache entry.</p>
      <h2>Results</h2>
      <p>Median metadata latency dropped from 96 ms to 44 ms in our own measurements, and the origin sees about 60 percent fewer metadata requests. Cache hit ratios are published on the status page.</p>
      <h2>Behaviour to be aware of</h2>
      <p>A freshly published package can take up to five minutes to appear on the edge. If you need it immediately, add a cache-busting query parameter, or use the rsync endpoint to pull the index directly.</p>
    `,
  },
  {
    slug: "scheduled-maintenance-window",
    title: "Scheduled maintenance window in April",
    date: "2026-01-12",
    author: "Mirror Operations",
    excerpt: "Storage expansion on the primary node. Expect brief read-only windows, no data loss, and no action required on your side.",
    body: `
      <p>We will expand the storage pool on the primary node during a maintenance window in April. The work is scheduled outside of working hours in both of our main regions, and mirrors stay readable throughout.</p>
      <h2>What to expect</h2>
      <p>Two windows of roughly ten minutes each, during which new artifacts may not be fetched on demand and the index may be a few minutes stale. Serving of already-mirrored content continues without interruption.</p>
      <h2>What you need to do</h2>
      <p>Nothing. Package managers retry transparently, and no configuration change is required. If your build pipeline treats mirror errors as fatal, consider adding a single retry - that is good practice regardless of maintenance.</p>
      <h2>Notifications</h2>
      <p>Status updates are posted on the status page and to the announce mailing list. Both are linked from the contact page.</p>
    `,
  },
];

const FAQ = [
  { q: "Is the mirror free to use?", a: "Yes. The service is operated for research and education networks and is free of charge. There is no account and no API key." },
  { q: "Is there a bandwidth limit?", a: "No hard limit, but we ask that you do not run unattended bulk crawlers. Automated full-archive pulls should use the rsync endpoint, which is designed for that." },
  { q: "How often is content synchronised?", a: "Most distributions are synchronised every five to fifteen minutes. Large package ecosystems are fetched on demand, so untagged content appears within a couple of minutes of the first request." },
  { q: "Can I use the mirror in a commercial product?", a: "Yes. All mirrored content keeps its original licence. You are responsible for complying with the licence of whatever you download." },
  { q: "Do you keep access logs?", a: "Aggregate counters are kept for capacity planning. Per-request logs are retained for a short period for abuse handling only, and are not shared. See the privacy page for details." },
  { q: "Can I get a dedicated endpoint?", a: "For labs and campuses with very high sustained traffic we can set up a separate endpoint. Write to the address on the contact page and describe your expected volume." },
  { q: "How do I report a broken or stale package?", a: "Email the operations address with the full URL and the timestamp of the failure. Most issues are upstream sync delays and are resolved by the next sync cycle." },
  { q: "Is IPv6 supported?", a: "Yes, all endpoints are dual-stacked. If you see unexpected behaviour over IPv6, send us a traceroute - it usually points at a routing issue rather than the mirror itself." },
];

const DOC_RECIPES = [
  { name: "Debian / Ubuntu (apt)", code: "deb https://MIRROR/debian/ stable main contrib\ndeb https://MIRROR/ubuntu/ noble main universe" },
  { name: "Fedora / Rocky (dnf)", code: "metalink=https://MIRROR/fedora/repodata/repomd.xml\nbaseurl=https://MIRROR/rocky/$releasever/BaseOS/$basearch/os/" },
  { name: "Python (pip)", code: "pip config set global.index-url https://MIRROR/pypi/web/simple/" },
  { name: "Node.js (npm)", code: "npm config set registry https://MIRROR/npm/" },
  { name: "Rust (cargo)", code: "[source.crates-io]\nreplace-with = \"mirror\"\n\n[source.mirror]\nregistry = \"https://MIRROR/crates/\"" },
  { name: "Go modules", code: "go env -w GOPROXY=https://MIRROR/goproxy/,direct" },
  { name: "Maven", code: "<mirror><id>mirror</id><url>https://MIRROR/maven/</url><mirrorOf>*</mirrorOf></mirror>" },
  { name: "Containers (docker)", code: "docker pull MIRROR/registry/library/alpine:latest" },
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Constant-time-ish comparison so a wrong secret does not leak its prefix. */
function secretEquals(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (y.length === 0) return false;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function normalizePath(value) {
  let p = String(value == null || value === "" ? "/" : value).trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

function toBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readConfig(env) {
  const e = env || {};
  // A Worker environment variable wins over the CONFIG block above. An empty
  // string counts as "explicitly empty" (used for fail-closed secrets).
  const v = (key) => (Object.prototype.hasOwnProperty.call(e, key) && e[key] !== null && e[key] !== undefined ? e[key] : CONFIG[key]);
  const s = (key) => String(v(key) == null ? "" : v(key)).trim();

  return {
    origin: s("UPSTREAM_ORIGIN").replace(/\/+$/, ""),
    tunnelPath: normalizePath(s("XHTTP_PATH")),
    clientAuthHeader: (s("CLIENT_AUTH_HEADER") || "x-auth").toLowerCase(),
    clientAuthValue: String(v("CLIENT_AUTH_VALUE") == null ? "" : v("CLIENT_AUTH_VALUE")),
    clientAuthQuery: s("CLIENT_AUTH_QUERY"),
    originAuthHeader: (s("ORIGIN_AUTH_HEADER") || "x-origin-auth").toLowerCase(),
    originAuthValue: String(v("ORIGIN_AUTH_VALUE") == null ? "" : v("ORIGIN_AUTH_VALUE")),
    stripClientIp: toBool(v("STRIP_CLIENT_IP"), true),
    logLevel: (s("LOG_LEVEL") || "warn").toLowerCase(),
    site: {
      name: s("SITE_NAME") || "Meridian Mirror",
      tagline: s("SITE_TAGLINE") || "An open package mirror for research and education networks.",
      org: s("ORG_NAME") || "Meridian Open Source Collective",
      email: s("CONTACT_EMAIL") || "ops@example.org",
      domain: s("SITE_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
      since: s("SITE_SINCE") || "2016",
      location: s("SITE_LOCATION") || "Zurich, Switzerland",
    },
  };
}

function logAt(cfg, level, message, extra) {
  const order = { debug: 10, info: 20, warn: 30, error: 40, none: 99 };
  const threshold = order[cfg.logLevel] == null ? 30 : order[cfg.logLevel];
  if ((order[level] || 20) < threshold) return;
  const line = extra ? message + " " + JSON.stringify(extra) : message;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// tunnel
// ---------------------------------------------------------------------------

function isTunnelPath(pathname, tunnelPath) {
  if (tunnelPath === "/") return true;
  return pathname === tunnelPath || pathname.startsWith(tunnelPath + "/");
}

function tunnelAuthorized(request, url, cfg) {
  if (!cfg.clientAuthValue) return false;
  // Preferred: the secret travels in a request header.
  if (secretEquals(request.headers.get(cfg.clientAuthHeader) || "", cfg.clientAuthValue)) {
    return true;
  }
  // Fallback: the secret travels in the query string, for clients whose GUI
  // cannot set a custom header (set CLIENT_AUTH_QUERY to enable).
  if (cfg.clientAuthQuery) {
    return secretEquals(url.searchParams.get(cfg.clientAuthQuery) || "", cfg.clientAuthValue);
  }
  return false;
}

async function proxyTunnel(request, url, cfg) {
  const target = cfg.origin + url.pathname + url.search;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === cfg.clientAuthHeader) continue;
    if (lower === "host") continue;
    if (cfg.stripClientIp && CLIENT_IP_HEADERS.has(lower)) continue;
    headers.set(name, value);
  }
  // Never let the origin leg negotiate compression: the tunnel body is opaque
  // binary and must arrive byte-for-byte.
  headers.set("accept-encoding", "identity");
  if (cfg.originAuthValue) headers.set(cfg.originAuthHeader, cfg.originAuthValue);

  const method = request.method.toUpperCase();
  const sendBody = method !== "GET" && method !== "HEAD";
  // The body is forwarded as a stream, so let the runtime pick the framing
  // (chunked) instead of trusting a length header that could go stale.
  if (sendBody) headers.delete("content-length");

  // `duplex: "half"` is required by Node/undici when the request body is a
  // stream (this is what `wrangler dev` and the local smoke test use). The
  // Workers runtime does not define this option at all and ignores unknown
  // RequestInit members, so passing it is safe in production too.
  const upstream = await fetch(target, {
    method,
    headers,
    body: sendBody ? request.body : undefined,
    duplex: "half",
    redirect: "manual",
  });

  const outHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    outHeaders.set(name, value);
  }
  outHeaders.set("cache-control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

// ---------------------------------------------------------------------------
// decoy site: presentation
// ---------------------------------------------------------------------------

const SITE_CSS = `
:root{
  --bg:#0f1115;--panel:#161a21;--panel-2:#1c212a;--line:#262c37;
  --text:#e7ecf3;--muted:#9aa6b8;--accent:#4f9cf9;--accent-2:#3ddc97;
  --warn:#f2b544;--radius:12px;--max:1080px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:var(--max);margin:0 auto;padding:0 20px}
header.site{position:sticky;top:0;z-index:20;background:rgba(15,17,21,.86);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header.site .bar{display:flex;align-items:center;gap:18px;height:62px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;color:var(--text);white-space:nowrap}
.brand:hover{text-decoration:none}
.brand .dot{width:12px;height:12px;border-radius:3px;background:linear-gradient(135deg,var(--accent),var(--accent-2))}
nav.main{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
nav.main a{color:var(--muted);padding:7px 11px;border-radius:8px;font-size:14.5px}
nav.main a:hover{background:var(--panel);color:var(--text);text-decoration:none}
nav.main a[aria-current="page"]{color:var(--text);background:var(--panel)}
main{padding:44px 0 64px;min-height:60vh}
h1{font-size:2.05rem;line-height:1.25;margin:0 0 12px}
h2{font-size:1.32rem;margin:34px 0 12px}
h3{font-size:1.06rem;margin:22px 0 8px}
p{margin:0 0 14px}
.lead{font-size:1.1rem;color:var(--muted);max-width:70ch}
.grid{display:grid;gap:16px}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.cols-3{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.cols-4{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px}
.card h3{margin-top:0}
.muted{color:var(--muted)}
.small{font-size:13.5px}
.btns{display:flex;gap:12px;flex-wrap:wrap;margin:22px 0 0}
.btn{display:inline-block;padding:10px 18px;border-radius:9px;background:var(--accent);
  color:#08111d;font-weight:600;font-size:14.5px}
.btn:hover{text-decoration:none;filter:brightness(1.08)}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.stat .v{font-size:1.5rem;font-weight:650}
.stat .k{color:var(--muted);font-size:13px;margin-top:2px}
table{width:100%;border-collapse:collapse;margin:18px 0;font-size:14.5px}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
tbody tr:hover{background:var(--panel)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--panel-2);padding:2px 6px;border-radius:6px;font-size:13.5px}
pre{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px 16px;overflow:auto;font-size:13.5px;line-height:1.55}
pre code{background:none;padding:0}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;
  border:1px solid var(--line);color:var(--muted)}
.pill.ok{color:var(--accent-2);border-color:rgba(61,220,151,.35);background:rgba(61,220,151,.08)}
.pill.warn{color:var(--warn);border-color:rgba(242,181,68,.35);background:rgba(242,181,68,.08)}
input[type=search]{width:100%;max-width:380px;padding:10px 13px;border-radius:9px;
  border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:14.5px}
details{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);
  padding:14px 16px;margin:10px 0}
details summary{cursor:pointer;font-weight:600}
details p{margin:12px 0 0;color:var(--muted)}
footer.site{border-top:1px solid var(--line);padding:30px 0 44px;color:var(--muted);font-size:14px}
footer.site .cols{display:grid;gap:26px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
footer.site h4{margin:0 0 10px;font-size:13px;color:var(--text);text-transform:uppercase;letter-spacing:.05em}
footer.site a{display:block;color:var(--muted);padding:3px 0}
.note{border-left:3px solid var(--accent);padding:10px 0 10px 15px;color:var(--muted);margin:18px 0}
`.trim();

const SITE_JS = `
(function () {
  var box = document.getElementById('mirror-filter');
  if (box) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr[data-name]'));
    box.addEventListener('input', function () {
      var q = box.value.trim().toLowerCase();
      rows.forEach(function (row) {
        var hay = (row.getAttribute('data-name') || '').toLowerCase();
        row.style.display = hay.indexOf(q) === -1 ? 'none' : '';
      });
    });
  }
  document.querySelectorAll('pre').forEach(function (pre) {
    if (pre.querySelector('button')) return;
    var btn = document.createElement('button');
    btn.textContent = 'Copy';
    btn.className = 'pill';
    btn.style.cssText = 'float:right;margin-left:12px;cursor:pointer;background:none';
    btn.addEventListener('click', function () {
      var text = pre.innerText.replace(/^Copy\\s*/, '');
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1200);
    });
    pre.insertBefore(btn, pre.firstChild);
  });
})();
`.trim();

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f9cf9"/><stop offset="1" stop-color="#3ddc97"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#0f1115"/><rect x="8" y="8" width="48" height="48" rx="11" fill="url(#g)"/><path d="M18 44V20h7l7 12 7-12h7v24h-6V30l-8 13-8-13v14z" fill="#0f1115"/></svg>`;

const NAV = [
  ["/", "Home"],
  ["/mirrors", "Mirrors"],
  ["/docs", "Docs"],
  ["/status", "Status"],
  ["/blog", "News"],
  ["/about", "About"],
  ["/contact", "Contact"],
];

function layout(cfg, opts) {
  const s = cfg.site;
  const canonical = s.domain ? "https://" + s.domain + opts.path : "";
  const nav = NAV.map(function (item) {
    const current = item[0] === opts.path ? ' aria-current="page"' : "";
    return '<a href="' + item[0] + '"' + current + ">" + esc(item[1]) + "</a>";
  }).join("");
  const year = new Date().getUTCFullYear();
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + esc(opts.title) + "</title>",
    '<meta name="description" content="' + esc(opts.description) + '">',
    canonical ? '<link rel="canonical" href="' + esc(canonical) + '">' : "",
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="stylesheet" href="/assets/style.css">',
    "</head>",
    "<body>",
    '<header class="site"><div class="wrap bar">',
    '<a class="brand" href="/"><span class="dot"></span>' + esc(s.name) + "</a>",
    '<nav class="main">' + nav + "</nav>",
    "</div></header>",
    '<main><div class="wrap">',
    opts.body,
    "</div></main>",
    '<footer class="site"><div class="wrap">',
    '<div class="cols">',
    "<div><h4>Service</h4>" +
      '<a href="/mirrors">Mirror index</a><a href="/status">Status</a><a href="/docs">Documentation</a><a href="/faq">FAQ</a></div>',
    "<div><h4>Project</h4>" +
      '<a href="/about">About</a><a href="/blog">News</a><a href="/contact">Contact</a></div>',
    "<div><h4>Legal</h4>" +
      '<a href="/privacy">Privacy</a><a href="/terms">Acceptable use</a><a href="/robots.txt">robots.txt</a></div>',
    "<div><h4>Operator</h4>" +
      "<span>" + esc(s.org) + "</span><br><span>" + esc(s.location) + "</span><br>" +
      '<a href="mailto:' + esc(s.email) + '">' + esc(s.email) + "</a></div>",
    "</div>",
    '<p class="small" style="margin-top:26px">© ' + s.since + "-" + year + " " + esc(s.org) +
      ". Mirrored content remains under its original licence. All services are provided on a best-effort basis.</p>",
    "</div></footer>",
    '<script src="/assets/app.js" defer></script>',
    "</body></html>",
  ].join("");
}

function mirrorRows() {
  return MIRRORS.map(function (m) {
    const cls = m.status === "ok" ? "ok" : "warn";
    const label = m.status === "ok" ? "in sync" : "catching up";
    return (
      '<tr data-name="' + esc(m.name + " " + m.id + " " + m.path) + '">' +
      "<td><strong>" + esc(m.name) + "</strong><br><span class=\"small muted\">" + esc(m.path) + "</span></td>" +
      '<td class="small">' + esc(m.proto) + "</td>" +
      '<td class="small">' + esc(m.size) + "</td>" +
      '<td class="small">' + esc(m.sync) + "</td>" +
      '<td><span class="pill ' + cls + '">' + label + "</span></td>" +
      "</tr>"
    );
  }).join("");
}

function statCards() {
  const stats = [
    ["12", "mirrored projects"],
    ["99.96%", "30-day uptime"],
    ["44 ms", "median latency"],
    ["31 TB", "served content"],
  ];
  return stats.map(function (s) {
    return '<div class="stat"><div class="v">' + s[0] + '</div><div class="k">' + s[1] + "</div></div>";
  }).join("");
}

function postCards(limit) {
  return POSTS.slice(0, limit || POSTS.length).map(function (p) {
    return (
      '<div class="card"><h3><a href="/blog/' + esc(p.slug) + '">' + esc(p.title) + "</a></h3>" +
      '<p class="small muted">' + esc(p.date) + " · " + esc(p.author) + "</p>" +
      "<p>" + esc(p.excerpt) + "</p></div>"
    );
  }).join("");
}

// ---------------------------------------------------------------------------
// decoy site: pages
// ---------------------------------------------------------------------------

function pageHome(cfg) {
  const featured = MIRRORS.slice(0, 6).map(function (m) {
    return '<div class="card"><h3>' + esc(m.name) + '</h3><p class="small muted">' + esc(m.path) +
      '</p><p class="small">' + esc(m.size) + " · synced " + esc(m.sync) + "</p></div>";
  }).join("");

  const body = [
    "<h1>" + esc(cfg.site.name) + "</h1>",
    '<p class="lead">' + esc(cfg.site.tagline) + "</p>",
    '<div class="btns"><a class="btn" href="/mirrors">Browse the mirror index</a>' +
      '<a class="btn ghost" href="/docs">Configuration recipes</a></div>',
    '<div class="grid cols-4" style="margin-top:34px">' + statCards() + "</div>",
    "<h2>Featured mirrors</h2>",
    '<div class="grid cols-3">' + featured + "</div>",
    "<h2>Quick start</h2>",
    "<p>Replace <code>MIRROR</code> with this hostname. Every recipe on the documentation page is ready to paste.</p>",
    "<pre><code># Debian / Ubuntu\nsed -i 's|deb.debian.org|MIRROR|g' /etc/apt/sources.list\n\n# Python\npip config set global.index-url https://MIRROR/pypi/web/simple/\n\n# Node.js\nnpm config set registry https://MIRROR/npm/</code></pre>",
    '<div class="note">Synchronisation runs continuously. Averages are published on the ' +
      '<a href="/status">status page</a> together with any ongoing incidents.</div>',
    "<h2>Latest updates</h2>",
    '<div class="grid cols-3">' + postCards(3) + "</div>",
  ].join("");

  return layout(cfg, {
    title: cfg.site.name + " · open package mirror",
    description: cfg.site.tagline,
    path: "/",
    body: body,
  });
}

function pageMirrors(cfg) {
  const body = [
    "<h1>Mirror index</h1>",
    '<p class="lead">All projects currently mirrored. Sizes are the on-disk footprint, not traffic.</p>',
    '<p><input type="search" id="mirror-filter" placeholder="Filter by name or path…" aria-label="Filter mirrors"></p>',
    "<table><thead><tr><th>Project</th><th>Protocols</th><th>Size</th><th>Last sync</th><th>State</th></tr></thead>",
    "<tbody>" + mirrorRows() + "</tbody></table>",
    '<p class="small muted">A project marked <em>catching up</em> is still serving content; only the newest files may be missing.</p>',
    "<h2>Requesting a new mirror</h2>",
    "<p>Send the project name, the upstream URL and the approximate size to the operations address. Requests that are useful to more than one institution are usually accepted within a week.</p>",
  ].join("");

  return layout(cfg, {
    title: "Mirror index · " + cfg.site.name,
    description: "Every project currently mirrored, with size, protocol and last synchronisation time.",
    path: "/mirrors",
    body: body,
  });
}

function pageDocs(cfg) {
  const recipes = DOC_RECIPES.map(function (r) {
    return "<h3>" + esc(r.name) + "</h3><pre><code>" + esc(r.code) + "</code></pre>";
  }).join("");

  const body = [
    "<h1>Documentation</h1>",
    '<p class="lead">Point your tooling at the mirror. Nothing needs to be installed and no credentials are required.</p>',
    "<h2>Hostname</h2>",
    "<p>Use this hostname wherever a recipe below says <code>MIRROR</code>:</p>",
    "<pre><code>" + esc(cfg.site.domain || "this hostname") + "</code></pre>",
    '<div class="note">Prefer <code>rsync</code> for full-archive pulls. It is significantly cheaper for both sides than walking the HTTP tree.</div>',
    "<h2>Recipes</h2>",
    recipes,
    "<h2>Verifying content</h2>",
    "<p>Release signatures and checksums are mirrored unchanged. Verify them exactly as you would against the upstream server - the mirror never re-signs anything.</p>",
    "<h2>Troubleshooting</h2>",
    "<p>If a request fails, retry once before reporting it: on-demand fetching can return a transient error while an artifact is being pulled. Persistent failures should include the full URL and a timestamp.</p>",
  ].join("");

  return layout(cfg, {
    title: "Documentation · " + cfg.site.name,
    description: "Ready-to-paste configuration recipes for apt, dnf, pip, npm, cargo, Go, Maven and containers.",
    path: "/docs",
    body: body,
  });
}

function pageFaq(cfg) {
  const items = FAQ.map(function (f) {
    return "<details><summary>" + esc(f.q) + "</summary><p>" + esc(f.a) + "</p></details>";
  }).join("");
  const body = [
    "<h1>Frequently asked questions</h1>",
    '<p class="lead">Short answers to the questions we receive most often.</p>',
    items,
    '<p style="margin-top:26px">Something missing? Send it to <a href="mailto:' + esc(cfg.site.email) + '">' +
      esc(cfg.site.email) + "</a> and it will be added here.</p>",
  ].join("");
  return layout(cfg, {
    title: "FAQ · " + cfg.site.name,
    description: "Answers about usage, bandwidth, synchronisation, logging and support.",
    path: "/faq",
    body: body,
  });
}

function pageStatus(cfg) {
  const rows = SERVICES.map(function (s) {
    const cls = s.status === "ok" ? "ok" : "warn";
    const label = s.status === "ok" ? "operational" : "degraded";
    return (
      "<tr><td><strong>" + esc(s.name) + "</strong></td>" +
      '<td class="small">' + esc(s.region) + "</td>" +
      '<td class="small">' + esc(s.uptime) + "</td>" +
      '<td class="small">' + esc(s.latency) + "</td>" +
      '<td><span class="pill ' + cls + '">' + label + "</span></td></tr>"
    );
  }).join("");

  const incidents = INCIDENTS.map(function (i) {
    return (
      '<div class="card"><h3>' + esc(i.title) + '</h3><p class="small muted">' + esc(i.date) + " · " +
      esc(i.state) + "</p><p>" + esc(i.body) + "</p></div>"
    );
  }).join("");

  const body = [
    "<h1>Service status</h1>",
    '<p class="lead">Live state of the mirrored endpoints. Updates are posted here first.</p>',
    "<table><thead><tr><th>Service</th><th>Region</th><th>30-day uptime</th><th>Median latency</th><th>State</th></tr></thead><tbody>",
    rows,
    "</tbody></table>",
    "<h2>Incident history</h2>",
    incidents,
  ].join("");

  return layout(cfg, {
    title: "Status · " + cfg.site.name,
    description: "Uptime, latency and incident history for every mirrored endpoint.",
    path: "/status",
    body: body,
  });
}

function pageBlog(cfg) {
  const body = [
    "<h1>News</h1>",
    '<p class="lead">Maintenance windows, new mirrors and changes to the service.</p>',
    '<div class="grid cols-3">' + postCards(0) + "</div>",
  ].join("");
  return layout(cfg, {
    title: "News · " + cfg.site.name,
    description: "Announcements about maintenance, new mirrors and platform changes.",
    path: "/blog",
    body: body,
  });
}

function pagePost(cfg, post) {
  const body = [
    '<p class="small muted"><a href="/blog">← All news</a></p>',
    "<h1>" + esc(post.title) + "</h1>",
    '<p class="small muted">' + esc(post.date) + " · " + esc(post.author) + "</p>",
    post.body,
    '<p class="small muted" style="margin-top:30px"><a href="/blog">← All news</a></p>',
  ].join("");
  return layout(cfg, {
    title: post.title + " · " + cfg.site.name,
    description: post.excerpt,
    path: "/blog",
    body: body,
  });
}

function pageAbout(cfg) {
  const s = cfg.site;
  const body = [
    "<h1>About</h1>",
    '<p class="lead">' + esc(s.name) + " has been operated since " + esc(s.since) + " for research and education networks.</p>",
    "<h2>What we do</h2>",
    "<p>We keep a copy of the software that people install most often, close to the networks that need it. That removes a long-haul dependency from the critical path of a build and makes software installation predictable even when upstream connectivity is not.</p>",
    "<h2>How it is run</h2>",
    "<p>Two operators maintain the service part-time, with a shared on-call rotation. Storage is provided by contributing institutions; the network is donated by transit partners. Nothing about the service is commercial: there is no advertising, no tracking and no account system.</p>",
    "<h2>Principles</h2>",
    '<div class="grid cols-3">' +
      '<div class="card"><h3>Neutral</h3><p class="small">We mirror software, not opinions. Every project that can be redistributed is welcome.</p></div>' +
      '<div class="card"><h3>Predictable</h3><p class="small">Maintenance is announced in advance and scheduled outside working hours where possible.</p></div>' +
      '<div class="card"><h3>Private</h3><p class="small">Requests are not profiled and per-request logs are kept only briefly, for abuse handling.</p></div>' +
      "</div>",
    "<h2>Contact</h2>",
    "<p>Operational questions: <a href=\"mailto:" + esc(s.email) + "\">" + esc(s.email) + "</a>. Security reports are welcome at the same address and are answered within two working days.</p>",
    "<h2>Acknowledgements</h2>",
    "<p>The service depends on the maintainers of every mirrored project, and on the institutions that contribute storage and bandwidth. Mirrored content remains under its original licence.</p>",
  ].join("");
  return layout(cfg, {
    title: "About · " + cfg.site.name,
    description: "Who operates the mirror, how it is funded and what it stands for.",
    path: "/about",
    body: body,
  });
}

function pageContact(cfg) {
  const s = cfg.site;
  const body = [
    "<h1>Contact</h1>",
    '<p class="lead">Reach the operators directly. There is no ticket system.</p>',
    '<div class="grid cols-2">' +
      '<div class="card"><h3>Operations</h3><p class="small">Mirror requests, broken files, capacity questions.</p><p><a href="mailto:' +
      esc(s.email) + '">' + esc(s.email) + "</a></p></div>" +
      '<div class="card"><h3>Security</h3><p class="small">Vulnerability reports and abuse complaints. Please include logs and timestamps.</p><p><a href="mailto:' +
      esc(s.email) + '">' + esc(s.email) + "</a></p></div>" +
      '<div class="card"><h3>Mailing list</h3><p class="small">Low-volume announcements about maintenance and new mirrors.</p><p class="small muted">announce@' +
      esc(s.domain || "example.org") + "</p></div>" +
      '<div class="card"><h3>Office hours</h3><p class="small">Tuesday and Thursday, 14:00-16:00 CET. Drop in without an appointment.</p><p class="small muted">' +
      esc(s.location) + "</p></div>" +
      "</div>",
    "<h2>Before you write</h2>",
    "<p>Most reports turn out to be transient upstream delays. Checking the <a href=\"/status\">status page</a> and retrying once usually resolves them, and saves you a round trip.</p>",
  ].join("");
  return layout(cfg, {
    title: "Contact · " + cfg.site.name,
    description: "How to reach the mirror operators for support, security reports and mirror requests.",
    path: "/contact",
    body: body,
  });
}

function pagePrivacy(cfg) {
  const body = [
    "<h1>Privacy</h1>",
    '<p class="lead">What is recorded when you use this service, and for how long.</p>',
    "<h2>What we record</h2>",
    "<p>Aggregate counters - requests per mirror, bytes served, response codes - are kept for capacity planning. These counters do not identify individual visitors.</p>",
    "<p>Per-request information such as IP address, timestamp, requested path and user agent is retained for a short period for abuse handling only, and is then deleted.</p>",
    "<h2>What we do not do</h2>",
    "<p>No advertising, no third-party analytics, no profiling, no selling of data, and no sharing with anybody except where legally required.</p>",
    "<h2>Cookies</h2>",
    "<p>This site sets no cookies and no local storage entries.</p>",
    "<h2>Questions</h2>",
    '<p>Write to <a href="mailto:' + esc(cfg.site.email) + '">' + esc(cfg.site.email) + "</a>.</p>",
  ].join("");
  return layout(cfg, {
    title: "Privacy · " + cfg.site.name,
    description: "What is logged by this mirror and how long it is kept.",
    path: "/privacy",
    body: body,
  });
}

function pageTerms(cfg) {
  const body = [
    "<h1>Acceptable use</h1>",
    '<p class="lead">The short version: use the mirror for software, be considerate, and do not make it somebody else\'s problem.</p>',
    "<h2>Permitted</h2>",
    "<p>Downloading mirrored software, automating installs and updates, and mirroring the content further, provided you do not present yourself as the origin of the service.</p>",
    "<h2>Not permitted</h2>",
    "<p>Bulk crawling outside the rsync endpoint, attempts to bypass rate handling, using the service as a general-purpose proxy or relay, and any use that is unlawful in the operator's jurisdiction.</p>",
    "<h2>No warranty</h2>",
    "<p>The service is provided on a best-effort basis, without warranty of any kind. Verify checksums and signatures before relying on any downloaded file.</p>",
    "<h2>Enforcement</h2>",
    "<p>Access may be limited temporarily to protect the service. Persistent abuse is reported to the responsible network operator.</p>",
    "<h2>Contact</h2>",
    '<p>Questions about this policy: <a href="mailto:' + esc(cfg.site.email) + '">' + esc(cfg.site.email) + "</a>.</p>",
  ].join("");
  return layout(cfg, {
    title: "Acceptable use · " + cfg.site.name,
    description: "Terms of use for the mirror service.",
    path: "/terms",
    body: body,
  });
}

function pageNotFound(cfg, path) {
  const body = [
    "<h1>404 - page not found</h1>",
    '<p class="lead">There is nothing at <code>' + esc(path) + "</code>.</p>",
    "<p>It may have been moved, or the link that brought you here may be out of date. The mirror index and the documentation are the usual places to look next.</p>",
    '<div class="btns"><a class="btn" href="/mirrors">Mirror index</a><a class="btn ghost" href="/docs">Documentation</a></div>',
  ].join("");
  return layout(cfg, {
    title: "404 - page not found · " + cfg.site.name,
    description: "The requested page does not exist.",
    path: "/",
    body: body,
  });
}

function sitemap(cfg, origin) {
  const base = cfg.site.domain ? "https://" + cfg.site.domain : origin;
  const paths = ["/", "/mirrors", "/docs", "/faq", "/status", "/blog", "/about", "/contact", "/privacy", "/terms"]
    .concat(POSTS.map(function (p) { return "/blog/" + p.slug; }));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    paths.map(function (p) {
      return "  <url><loc>" + esc(base + p) + "</loc><changefreq>weekly</changefreq></url>";
    }).join("\n") +
    "\n</urlset>\n"
  );
}

// ---------------------------------------------------------------------------
// decoy site: router
// ---------------------------------------------------------------------------

function htmlResponse(cfg, body, status, cacheControl) {
  const h = new Headers(SECURITY_HEADERS);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", cacheControl || "public, max-age=300");
  return new Response(body, { status: status || 200, headers: h });
}

/**
 * The 404 page. `noStore` is used for tunnel-path misses so that a decoy
 * response can never be cached and later served to a real client.
 */
function notFoundResponse(cfg, path, noStore) {
  return htmlResponse(cfg, pageNotFound(cfg, path), 404, noStore ? "no-store" : "public, max-age=60");
}

function serveSite(request, url, cfg) {
  const path = normalizePath(url.pathname);
  const method = request.method.toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    // A normal website does not accept a POST to a content page.
    return notFoundResponse(cfg, path, true);
  }

  switch (path) {
    case "/":
      return htmlResponse(cfg, pageHome(cfg), 200);
    case "/mirrors":
      return htmlResponse(cfg, pageMirrors(cfg), 200);
    case "/docs":
      return htmlResponse(cfg, pageDocs(cfg), 200);
    case "/faq":
      return htmlResponse(cfg, pageFaq(cfg), 200);
    case "/status":
      return htmlResponse(cfg, pageStatus(cfg), 200);
    case "/blog":
      return htmlResponse(cfg, pageBlog(cfg), 200);
    case "/about":
      return htmlResponse(cfg, pageAbout(cfg), 200);
    case "/contact":
      return htmlResponse(cfg, pageContact(cfg), 200);
    case "/privacy":
      return htmlResponse(cfg, pagePrivacy(cfg), 200);
    case "/terms":
      return htmlResponse(cfg, pageTerms(cfg), 200);

    case "/assets/style.css": {
      const h = new Headers(SECURITY_HEADERS);
      h.set("content-type", "text/css; charset=utf-8");
      h.set("cache-control", "public, max-age=86400");
      return new Response(SITE_CSS, { status: 200, headers: h });
    }
    case "/assets/app.js": {
      const h = new Headers(SECURITY_HEADERS);
      h.set("content-type", "application/javascript; charset=utf-8");
      h.set("cache-control", "public, max-age=86400");
      return new Response(SITE_JS, { status: 200, headers: h });
    }
    case "/favicon.svg": {
      const h = new Headers(SECURITY_HEADERS);
      h.set("content-type", "image/svg+xml");
      h.set("cache-control", "public, max-age=86400");
      return new Response(FAVICON_SVG, { status: 200, headers: h });
    }
    case "/robots.txt": {
      const h = new Headers(SECURITY_HEADERS);
      h.set("content-type", "text/plain; charset=utf-8");
      h.set("cache-control", "public, max-age=3600");
      const base = cfg.site.domain ? "https://" + cfg.site.domain : url.origin;
      return new Response(
        "User-agent: *\nAllow: /\nDisallow: /assets/\n\nSitemap: " + base + "/sitemap.xml\n",
        { status: 200, headers: h }
      );
    }
    case "/sitemap.xml": {
      const h = new Headers(SECURITY_HEADERS);
      h.set("content-type", "application/xml; charset=utf-8");
      h.set("cache-control", "public, max-age=3600");
      return new Response(sitemap(cfg, url.origin), { status: 200, headers: h });
    }
    default:
      break;
  }

  if (path.startsWith("/blog/")) {
    const slug = path.slice("/blog/".length);
    const post = POSTS.find(function (p) { return p.slug === slug; });
    if (post) return htmlResponse(cfg, pagePost(cfg, post), 200);
  }

  return notFoundResponse(cfg, path, false);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const cfg = readConfig(env);
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }

    if (isTunnelPath(url.pathname, cfg.tunnelPath)) {
      if (!cfg.origin) {
        logAt(cfg, "error", "UPSTREAM_ORIGIN is not configured; refusing to proxy");
        return notFoundResponse(cfg, url.pathname, true);
      }
      if (!cfg.clientAuthValue) {
        logAt(cfg, "error", "CLIENT_AUTH_VALUE is not configured; refusing to proxy");
        return notFoundResponse(cfg, url.pathname, true);
      }
      if (tunnelAuthorized(request, url, cfg)) {
        logAt(cfg, "debug", "tunnel request", { method: request.method, path: url.pathname });
        try {
          return await proxyTunnel(request, url, cfg);
        } catch (err) {
          logAt(cfg, "error", "tunnel upstream failed: " + (err && err.message ? err.message : String(err)));
          return new Response("Bad Gateway", { status: 502 });
        }
      }
      logAt(cfg, "warn", "tunnel path without valid credentials", { path: url.pathname });
      return notFoundResponse(cfg, url.pathname, true);
    }

    return serveSite(request, url, cfg);
  },
};
