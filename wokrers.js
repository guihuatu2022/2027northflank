export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // 1. Core Proxy Config (Must match Northflank ENV)
    // ==========================================
    const secretPath = "/xhttp-8f3b2a1c-9d4e-4f2a"; 
    const backendUrl = "https://your-service-name.northflank.app"; 
    const headerName = "X-My-Secret-Token";
    const headerValue = "SuperSecretPassword123!"; 

    // ==========================================
    // 2. Traffic Interception & Forwarding
    // ==========================================
    if (url.pathname.startsWith(secretPath)) {
      if (request.headers.get(headerName) !== headerValue) {
        // Auth failed: Render the 404 page of the fake mirror site
        return handleStaticPage("/404", url.origin);
      }
      const proxyUrl = new URL(request.url);
      proxyUrl.hostname = new URL(backendUrl).hostname;
      return fetch(new Request(proxyUrl, request));
    }

    // ==========================================
    // 3. Crawler & Static Route Handling (Cover Site)
    // ==========================================
    return handleStaticPage(url.pathname, url.origin);
  }
};

// ==========================================
// Cover Site Generator (Dark Geek Theme, Artifact Registry)
// ==========================================
function handleStaticPage(pathname, origin) {
  const siteName = "Nexus Forge";
  const headersHTML = { "Content-Type": "text/html; charset=utf-8" };
  const headersTXT = { "Content-Type": "text/plain; charset=utf-8" };
  const headersXML = { "Content-Type": "text/xml; charset=utf-8" };
  const headersSVG = { "Content-Type": "image/svg+xml; charset=utf-8" };

  // 1. Crawler Files
  if (pathname === '/robots.txt') {
    return new Response(`User-agent: *\nAllow: /\nDisallow: /api/push\nSitemap: ${origin}/sitemap.xml`, { headers: headersTXT });
  }
  if (pathname === '/sitemap.xml') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>${origin}/</loc><priority>1.0</priority></url>
      <url><loc>${origin}/status</loc><priority>0.8</priority></url>
      <url><loc>${origin}/publish</loc><priority>0.8</priority></url>
    </urlset>`;
    return new Response(xml, { headers: headersXML });
  }

  // 2. Vector Logo (Used for both header and browser tab favicon)
  if (pathname === '/logo.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
    return new Response(svg, { headers: headersSVG });
  }

  // 3. HTML Layout Template
  const renderLayout = (title, content) => `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${siteName} - Global Open Source Mirrors & CI/CD Artifact Registry. Lightning-fast distribution for Linux distros and container images.">
    <title>${title} | ${siteName} Open Source Mirrors</title>
    <!-- 【新增】浏览器标签页 Logo (Favicon) -->
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <style>
      :root { --bg: #0d1117; --panel: #161b22; --text: #c9d1d9; --border: #30363d; --accent: #10b981; --link: #58a6ff; }
      body { font-family: 'Segoe UI', Consolas, system-ui, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.6; }
      header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 1rem 5%; display: flex; align-items: center; gap: 1rem; }
      .logo { width: 28px; height: 28px; }
      .brand { font-size: 1.25rem; font-weight: 600; color: #fff; letter-spacing: 0.5px; }
      nav { margin-left: auto; display: flex; gap: 1.5rem; }
      nav a { color: var(--text); text-decoration: none; font-size: 0.95rem; font-weight: 500; transition: color 0.2s; }
      nav a:hover { color: var(--link); }
      main { max-width: 1000px; margin: 2rem auto; padding: 0 1rem; }
      h1, h2, h3 { color: #fff; font-weight: 500; }
      .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
      table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
      th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
      th { color: #8b949e; font-weight: 500; }
      code { background: rgba(110, 118, 129, 0.4); padding: 0.2em 0.4em; border-radius: 4px; font-family: monospace; font-size: 0.85em; color: #fff; }
      .status-indicator { display: inline-block; width: 8px; height: 8px; background: var(--accent); border-radius: 50%; box-shadow: 0 0 8px var(--accent); margin-right: 6px; }
      footer { text-align: center; padding: 3rem 1rem; color: #8b949e; font-size: 0.85rem; border-top: 1px solid var(--border); margin-top: 3rem; }
      footer a { color: #8b949e; text-decoration: none; margin: 0 0.5rem; }
    </style>
  </head>
  <body>
    <header>
      <img src="/logo.svg" alt="Logo" class="logo">
      <div class="brand">${siteName}</div>
      <nav>
        <a href="/">Mirrors</a>
        <a href="/publish">Publish</a>
        <a href="/status">Status</a>
      </nav>
    </header>
    <main>${content}</main>
    <footer>
      <span>&copy; 2026 ${siteName} Mirror Network. Supported by Edge Workers.</span><br><br>
      <a href="/robots.txt">robots.txt</a> | <a href="/sitemap.xml">sitemap.xml</a> | <a href="#">Terms of Service</a>
    </footer>
    <script>
      // Simulate real-time data sync effects in frontend
      const syncTimes = document.querySelectorAll('.sync-time');
      setInterval(() => {
        syncTimes.forEach(el => {
          if(Math.random() > 0.7) {
            el.innerText = 'Just now (Syncing...)';
            el.style.color = '#10b981';
            setTimeout(() => { el.innerText = '1 min ago'; el.style.color = ''; }, 3000);
          }
        });
      }, 5000);
    </script>
  </body>
  </html>`;

  // 4. Route Dispatcher
  let title, content;
  switch (pathname) {
    case '/':
      title = "Open Source Mirrors";
      content = `
        <h1><span class="status-indicator"></span>Global Mirror Sync Network</h1>
        <p>Providing high-speed downloads and synchronization for major Linux distributions and open-source software. Current edge node bandwidth capacity: 10Gbps.</p>
        <div class="card" style="overflow-x: auto;">
          <table>
            <thead><tr><th>Distribution / Software</th><th>Architecture</th><th>Last Sync</th><th>Status</th><th>Size/Daily Traffic</th></tr></thead>
            <tbody>
              <tr><td><a style="color: var(--link);text-decoration:none" href="#">ubuntu/</a></td><td>amd64, arm64</td><td class="sync-time">5 mins ago</td><td>✅ Success</td><td>4.2 TB</td></tr>
              <tr><td><a style="color: var(--link);text-decoration:none" href="#">debian/</a></td><td>all</td><td class="sync-time">12 mins ago</td><td>✅ Success</td><td>3.8 TB</td></tr>
              <tr><td><a style="color: var(--link);text-decoration:none" href="#">alpine/</a></td><td>x86_64, aarch64</td><td class="sync-time">2 mins ago</td><td>✅ Success</td><td>450 GB</td></tr>
              <tr><td><a style="color: var(--link);text-decoration:none" href="#">docker-ce/</a></td><td>amd64</td><td class="sync-time">1 hour ago</td><td>✅ Success</td><td>1.2 TB</td></tr>
              <tr><td><a style="color: var(--link);text-decoration:none" href="#">pypi/</a></td><td>source</td><td class="sync-time">Just now</td><td>🔄 Syncing</td><td>14.5 TB</td></tr>
            </tbody>
          </table>
        </div>
      `;
      break;

    case '/publish':
      title = "Artifact Push API";
      // 【重点伪装】用英文向防火墙解释大量 POST 请求的合法性
      content = `
        <h1>Artifact Push API Specification</h1>
        <p>This node supports direct pushing of large CI/CD pipeline build caches and Docker image layers.</p>
        <div class="card">
          <h2>⚠️ Traffic Notice</h2>
          <p>When developers execute <code>docker push</code> or upload large binary artifact packages (such as LLM weights or system images) via the API, <strong>the API endpoints of this node will receive massive, sustained HTTP POST chunked data streams.</strong></p>
          <p>The payload volume for a single session may exceed <strong>50GB</strong>. This is normal artifact archiving behavior. Network security groups and firewall policies should NOT intercept these high-frequency, long-duration POST requests as malicious attacks.</p>
        </div>
        <div class="card">
          <h3>Authentication & Endpoints</h3>
          <p>Push Endpoint: <code>https://${new URL(origin).hostname}/api/v2/push</code></p>
          <p>Please include <code>Authorization: Bearer &lt;Your_Token&gt;</code> in the HTTP Header. All transmissions are heavily encrypted using TLS 1.3 to protect source code assets.</p>
        </div>
      `;
      break;

    case '/status':
      title = "Node Status";
      content = `
        <h1>Edge Compute Node Status</h1>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 2rem;">
          <div class="card" style="text-align: center;">
            <div style="color: #8b949e; font-size: 0.9rem;">24H Downlink (GET)</div>
            <div style="font-size: 2.5rem; font-weight: 300; color: #fff;">18.4 <span style="font-size:1rem;color:#8b949e">TB</span></div>
          </div>
          <div class="card" style="text-align: center;">
            <div style="color: #8b949e; font-size: 0.9rem;">24H Uplink (POST Push)</div>
            <div style="font-size: 2.5rem; font-weight: 300; color: var(--accent);">5.2 <span style="font-size:1rem;color:#8b949e">TB</span></div>
          </div>
          <div class="card" style="text-align: center;">
            <div style="color: #8b949e; font-size: 0.9rem;">Edge Cache Hit Rate</div>
            <div style="font-size: 2.5rem; font-weight: 300; color: #fff;">99.2 <span style="font-size:1rem;color:#8b949e">%</span></div>
          </div>
        </div>
        <div class="card">
          <h3>System Logs</h3>
          <code style="display: block; white-space: pre-wrap; background: transparent; padding: 0;">[SYSTEM] CI/CD artifact sync started for project x-core...
[INFO] Receiving chunked payload via HTTP/3...
[SUCCESS] 4.2GB artifact published successfully.
[SYSTEM] Upstream mirror debian/main synchronized.</code>
        </div>
      `;
      break;

    default:
      content = `
        <div style="text-align: center; padding: 4rem 0;">
          <h1 style="font-size: 4rem; margin: 0; color: var(--border);">404</h1>
          <h2>Registry Not Found</h2>
          <p style="color: #8b949e;">The requested mirror path does not exist or has been deprecated. Please check your package manager configuration.</p>
          <a href="/" style="color: var(--link); text-decoration: none; margin-top: 1rem; display: inline-block;">Return to Mirrors</a>
        </div>
      `;
      return new Response(renderLayout("404 Not Found", content), { status: 404, headers: headersHTML });
  }

  return new Response(renderLayout(title, content), { headers: headersHTML });
}
