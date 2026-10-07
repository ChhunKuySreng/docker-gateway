const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function getTailscaleDomain(containerName, fallbackHost) {
  try {
    const status = execSync(`docker exec ${containerName} tailscale status --json`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const json = JSON.parse(status);
    if (json.Self && json.Self.DNSName) {
      return `https://${json.Self.DNSName.replace(/\.$/, "")}`;
    }
  } catch (e) {}
  return `https://${fallbackHost}.<your-tailnet>.ts.net`;
}

function getRunningContainers() {
  try {
    const ps = execSync("docker ps --format '{{.Names}}'", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(
      ps
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch (e) {
    return new Set();
  }
}

function updateGlobalDashboard() {
  try {
    const globalDir = path.resolve(__dirname, "..");
    const globalProjectsDir = path.join(globalDir, "projects");
    const globalWebappsDir = path.join(globalDir, "webapps");
    const globalHtmlDir = path.join(globalDir, "html");

    fs.mkdirSync(globalHtmlDir, { recursive: true });

    const appDomain = getTailscaleDomain("tailscale-app", "local-app");
    const qaDomain = getTailscaleDomain("tailscale-qa", "local-qa");
    const runningContainers = getRunningContainers();
    const isTomcatRunning = runningContainers.has("global-tomcat");

    // 1. Discover Web Frontend Projects
    const webProjects = [];
    if (fs.existsSync(globalProjectsDir)) {
      const dirs = fs
        .readdirSync(globalProjectsDir)
        .filter((d) => fs.statSync(path.join(globalProjectsDir, d)).isDirectory());

      for (const p of dirs) {
        const pDir = path.join(globalProjectsDir, p);
        const pStat = fs.statSync(pDir);
        const cName = `app-${p}`;
        const isRunning = runningContainers.has(cName);

        let version = "1.0.0";
        const metaFile = path.join(pDir, "meta.json");
        if (fs.existsSync(metaFile)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
            if (meta.version) version = meta.version;
          } catch (e) {}
        }

        webProjects.push({
          id: p,
          name: p,
          version: version,
          type: "web",
          url: `/${p}/`,
          fullUrl: `${appDomain}/${p}/`,
          containerName: cName,
          isRunning: isRunning,
          status: isRunning ? "online" : "offline",
          badge: isRunning ? "Web Container" : "Container Stopped",
          icon: "⚡",
          updatedAt: pStat.mtime.toISOString(),
        });
      }
    }

    // 2. Discover Tomcat Webapps
    const systemTomcatApps = new Set(["ROOT", "docs", "examples", "host-manager"]);
    const tomcatApps = [];
    if (fs.existsSync(globalWebappsDir)) {
      const items = fs.readdirSync(globalWebappsDir);
      const uniqueApps = items
        .filter((item) => {
          if (systemTomcatApps.has(item)) return false;
          if (
            item === "manager" ||
            item.endsWith(".war") ||
            fs.statSync(path.join(globalWebappsDir, item)).isDirectory()
          ) {
            return true;
          }
          return false;
        })
        .map((item) => item.replace(/\.war$/, ""))
        .filter((v, i, a) => a.indexOf(v) === i && !systemTomcatApps.has(v));

      for (const app of uniqueApps) {
        const isManager = app === "manager";
        const appPath = isManager ? "manager/html" : `${app}/`;
        const appTitle = isManager ? "Tomcat Web Manager" : app;
        const icon = isManager ? "⚙️" : "☕";
        const badge = isManager ? "System Tool" : "Tomcat WAR";

        let version = isManager ? "9.0" : "1.0.0";
        const metaFile = path.join(globalWebappsDir, `${app}.meta.json`);
        if (fs.existsSync(metaFile)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
            if (meta.version) version = meta.version;
          } catch (e) {}
        }

        let mtime = new Date().toISOString();
        try {
          const warFile = path.join(globalWebappsDir, `${app}.war`);
          const folder = path.join(globalWebappsDir, app);
          if (fs.existsSync(warFile)) {
            mtime = fs.statSync(warFile).mtime.toISOString();
          } else if (fs.existsSync(folder)) {
            mtime = fs.statSync(folder).mtime.toISOString();
          }
        } catch (e) {}

        tomcatApps.push({
          id: app,
          name: appTitle,
          version: version,
          type: "tomcat",
          url: `${qaDomain}/${appPath}`,
          fullUrl: `${qaDomain}/${appPath}`,
          containerName: "global-tomcat",
          isRunning: isTomcatRunning,
          status: isTomcatRunning ? "online" : "offline",
          badge: isTomcatRunning ? badge : "Tomcat Offline",
          icon: icon,
          isManager: isManager,
          updatedAt: mtime,
        });
      }
    }

    // 3. Write status.json for Real-Time Client Synchronization
    const statusData = {
      appDomain,
      qaDomain,
      lastUpdated: new Date().toISOString(),
      counts: {
        web: webProjects.length,
        webRunning: webProjects.filter((p) => p.isRunning).length,
        tomcat: tomcatApps.length,
        tomcatRunning: tomcatApps.filter((p) => p.isRunning).length,
        total: webProjects.length + tomcatApps.length,
      },
      webProjects,
      tomcatApps,
    };

    fs.writeFileSync(
      path.join(globalHtmlDir, "status.json"),
      JSON.stringify(statusData, null, 2)
    );

    // 4. Generate Dynamic Real-Time Client App HTML
    const dashboardHtml = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Global Gateway - Live Control Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-main: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    [data-theme="dark"] {
      --bg: #070a12;
      --surface: rgba(17, 24, 39, 0.75);
      --surface-elevated: #1f293d;
      --navbar-bg: rgba(7, 10, 18, 0.85);
      --footer-bg: rgba(7, 10, 18, 0.88);
      --border: rgba(31, 41, 61, 0.8);
      --border-focus: #38bdf8;
      --text-main: #f8fafc;
      --text-sub: #94a3b8;
      --text-dim: #64748b;
      --input-bg: rgba(9, 13, 22, 0.85);
      --code-bg: #0b0f19;
      --shadow-color: rgba(0, 0, 0, 0.5);
      --card-hover-border: #38bdf8;
      --cyan: #38bdf8;
      --cyan-bg: rgba(56, 189, 248, 0.12);
      --cyan-border: rgba(56, 189, 248, 0.25);
      --amber: #fbbf24;
      --amber-bg: rgba(251, 191, 36, 0.12);
      --amber-border: rgba(251, 191, 36, 0.25);
      --emerald: #10b981;
      --emerald-bg: rgba(16, 185, 129, 0.12);
      --emerald-border: rgba(16, 185, 129, 0.25);
      --rose: #f43f5e;
      --rose-bg: rgba(244, 63, 94, 0.12);
      --purple: #c084fc;
      --purple-bg: rgba(168, 85, 247, 0.15);
      --purple-border: rgba(168, 85, 247, 0.3);
      --title-gradient: linear-gradient(135deg, #ffffff 35%, #94a3b8 100%);
      --grid-dot: rgba(255, 255, 255, 0.07);
      --orb-opacity: 0.32;
    }

    [data-theme="light"] {
      --bg: #f8fafc;
      --surface: rgba(255, 255, 255, 0.85);
      --surface-elevated: #f1f5f9;
      --navbar-bg: rgba(248, 250, 252, 0.88);
      --footer-bg: rgba(248, 250, 252, 0.92);
      --border: rgba(226, 232, 240, 0.9);
      --border-focus: #0284c7;
      --text-main: #0f172a;
      --text-sub: #475569;
      --text-dim: #94a3b8;
      --input-bg: rgba(248, 250, 252, 0.9);
      --code-bg: #f1f5f9;
      --shadow-color: rgba(0, 0, 0, 0.06);
      --card-hover-border: #0284c7;
      --cyan: #0284c7;
      --cyan-bg: rgba(2, 132, 199, 0.1);
      --cyan-border: rgba(2, 132, 199, 0.25);
      --amber: #d97706;
      --amber-bg: rgba(217, 119, 6, 0.1);
      --amber-border: rgba(217, 119, 6, 0.25);
      --emerald: #059669;
      --emerald-bg: rgba(5, 150, 105, 0.1);
      --emerald-border: rgba(5, 150, 105, 0.25);
      --rose: #e11d48;
      --rose-bg: rgba(225, 29, 72, 0.1);
      --purple: #9333ea;
      --purple-bg: rgba(147, 51, 234, 0.1);
      --purple-border: rgba(147, 51, 234, 0.25);
      --title-gradient: linear-gradient(135deg, #0f172a 35%, #334155 100%);
      --grid-dot: rgba(15, 23, 42, 0.05);
      --orb-opacity: 0.18;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-main);
      background: var(--bg);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      transition: background 0.4s ease, color 0.4s ease;
      position: relative;
      overflow-x: hidden;
    }

    /* Animated Aurora Glow Orbs */
    .bg-glow-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      pointer-events: none;
      z-index: 0;
    }
    .glow-orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(60px);
      opacity: var(--orb-opacity);
      will-change: transform;
      pointer-events: none;
      transition: opacity 0.4s ease;
      transform: translateZ(0);
    }
    .orb-1 {
      width: 580px;
      height: 580px;
      top: -100px;
      left: -80px;
      background: radial-gradient(circle, var(--cyan) 0%, rgba(56, 189, 248, 0) 70%);
      animation: driftOrb1 6s ease-in-out infinite alternate;
    }
    .orb-2 {
      width: 680px;
      height: 680px;
      top: 5%;
      right: -150px;
      background: radial-gradient(circle, var(--purple) 0%, rgba(168, 85, 247, 0) 70%);
      animation: driftOrb2 7.5s ease-in-out infinite alternate;
    }
    .orb-3 {
      width: 520px;
      height: 520px;
      bottom: -60px;
      right: 15%;
      background: radial-gradient(circle, var(--amber) 0%, rgba(251, 191, 36, 0) 70%);
      animation: driftOrb3 7s ease-in-out infinite alternate;
    }
    .orb-4 {
      width: 500px;
      height: 500px;
      bottom: 5%;
      left: 10%;
      background: radial-gradient(circle, var(--emerald) 0%, rgba(16, 185, 129, 0) 70%);
      animation: driftOrb4 5.5s ease-in-out infinite alternate;
    }

    @keyframes driftOrb1 {
      0% { transform: translate3d(0, 0, 0) scale(1); }
      33% { transform: translate3d(120px, 90px, 0) scale(1.18); }
      66% { transform: translate3d(60px, 160px, 0) scale(0.92); }
      100% { transform: translate3d(-60px, 110px, 0) scale(1.08); }
    }
    @keyframes driftOrb2 {
      0% { transform: translate3d(0, 0, 0) scale(1); }
      33% { transform: translate3d(-140px, 100px, 0) scale(1.15); }
      66% { transform: translate3d(-80px, 160px, 0) scale(0.9); }
      100% { transform: translate3d(-50px, -80px, 0) scale(1.22); }
    }
    @keyframes driftOrb3 {
      0% { transform: translate3d(0, 0, 0) scale(1); }
      33% { transform: translate3d(-110px, -90px, 0) scale(1.2); }
      66% { transform: translate3d(-40px, -150px, 0) scale(0.95); }
      100% { transform: translate3d(100px, -60px, 0) scale(1.1); }
    }
    @keyframes driftOrb4 {
      0% { transform: translate3d(0, 0, 0) scale(1); }
      33% { transform: translate3d(90px, -80px, 0) scale(1.16); }
      66% { transform: translate3d(140px, 20px, 0) scale(0.9); }
      100% { transform: translate3d(50px, 90px, 0) scale(1.1); }
    }

    /* Ambient Tech Grid Overlay */
    .bg-grid-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: radial-gradient(var(--grid-dot) 1.2px, transparent 1.2px);
      background-size: 32px 32px;
      pointer-events: none;
      z-index: 0;
    }

    /* ====================================================
       1. STICKY HEADER & NAVBAR
       ==================================================== */
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 100;
      width: 100%;
      background: var(--navbar-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border);
      box-shadow: 0 4px 20px -4px var(--shadow-color);
      transition: background 0.4s ease, border-color 0.4s ease;
    }

    .header-inner {
      width: 100%;
      max-width: 1800px;
      margin: 0 auto;
      padding: 0.85rem clamp(1rem, 2.5vw, 2.5rem);
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }

    .navbar-top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      flex-wrap: wrap;
    }
    .brand-title {
      font-size: clamp(1.15rem, 2.5vw, 1.45rem);
      font-weight: 700;
      letter-spacing: -0.025em;
      background: var(--title-gradient);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      white-space: nowrap;
    }

    .live-indicator {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      background: var(--emerald-bg);
      border: 1px solid var(--emerald-border);
      padding: 0.28rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.74rem;
      font-weight: 600;
      color: var(--emerald);
      white-space: nowrap;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    .navbar-actions {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      flex-wrap: wrap;
    }

    .gateways-bar {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .gateway-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.78rem;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .chip-app {
      background: var(--cyan-bg);
      color: var(--cyan);
      border: 1px solid var(--cyan-border);
    }
    .chip-qa {
      background: var(--amber-bg);
      color: var(--amber);
      border: 1px solid var(--amber-border);
    }
    .gateway-chip:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px var(--shadow-color);
    }

    .theme-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 2px 6px var(--shadow-color);
      white-space: nowrap;
    }
    .theme-toggle-btn:hover {
      background: var(--surface-elevated);
      transform: translateY(-1px);
    }

    /* Controls Bar (Search + Tabs + Sync Button) */
    .navbar-controls-row {
      display: flex;
      gap: 0.75rem;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
    }

    .search-box {
      flex: 1;
      min-width: 240px;
      position: relative;
    }
    .search-input {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      padding: 0.55rem 1rem 0.55rem 2.25rem;
      color: var(--text-main);
      font-size: 0.88rem;
      outline: none;
      transition: border-color 0.2s ease, background 0.3s ease;
    }
    .search-input:focus {
      border-color: var(--border-focus);
    }
    .search-icon {
      position: absolute;
      left: 0.8rem;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      font-size: 0.88rem;
      pointer-events: none;
    }

    .tabs-actions-group {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      flex-wrap: wrap;
    }

    .tabs {
      display: flex;
      gap: 0.25rem;
      background: var(--input-bg);
      padding: 0.25rem;
      border-radius: 0.65rem;
      border: 1px solid var(--border);
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-sub);
      padding: 0.4rem 0.8rem;
      border-radius: 0.45rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .tab-btn.active {
      background: var(--surface-elevated);
      color: var(--text-main);
      box-shadow: 0 1px 3px var(--shadow-color);
    }
    .tab-btn:hover:not(.active) {
      color: var(--text-main);
    }

    .sync-btn {
      background: var(--cyan-bg);
      border: 1px solid var(--cyan-border);
      color: var(--cyan);
      padding: 0.48rem 0.85rem;
      border-radius: 0.65rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .sync-btn:hover {
      transform: translateY(-1px);
    }
    .sync-icon.spinning {
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { 100% { transform: rotate(360deg); } }

    /* ====================================================
       2. SCROLLABLE MAIN CONTENT AREA
       ==================================================== */
    .main-content {
      flex: 1;
      width: 100%;
      max-width: 1800px;
      margin: 0 auto;
      padding: 1.5rem clamp(0.75rem, 2.5vw, 2.5rem) 2.5rem;
      position: relative;
      z-index: 1;
    }

    /* Section Headers */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 1.75rem 0 1rem;
      padding-bottom: 0.65rem;
      border-bottom: 1px solid var(--border);
    }
    .section-title {
      font-size: clamp(1.05rem, 2.5vw, 1.2rem);
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .section-count {
      font-size: 0.75rem;
      background: var(--surface-elevated);
      padding: 0.18rem 0.6rem;
      border-radius: 9999px;
      color: var(--text-sub);
      font-family: var(--font-mono);
      font-weight: 600;
      border: 1px solid var(--border);
    }

    /* Cards Grid - Dynamic Multi-Card Fitting Left to Right */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1.25rem;
      width: 100%;
    }

    /* Premium Modern Card UI */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 1.15rem;
      padding: 1.25rem 1.35rem;
      text-decoration: none;
      color: inherit;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 16px -2px var(--shadow-color);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .card-glow-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    .web-card .card-glow-bar {
      background: linear-gradient(90deg, var(--cyan), transparent);
    }
    .tomcat-card .card-glow-bar {
      background: linear-gradient(90deg, var(--amber), transparent);
    }

    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 16px 32px -4px var(--shadow-color);
    }
    .card:hover .card-glow-bar {
      opacity: 1;
    }
    .web-card:hover {
      border-color: var(--cyan);
    }
    .tomcat-card:hover {
      border-color: var(--amber);
    }
    .card:active {
      transform: scale(0.99);
    }
    .card-offline {
      opacity: 0.75;
      border-color: rgba(244, 63, 94, 0.35) !important;
    }

    /* Card Top Header */
    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.85rem;
      gap: 0.6rem;
    }
    .card-icon-box {
      width: 44px;
      height: 44px;
      border-radius: 0.85rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.4rem;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      flex-shrink: 0;
      box-shadow: 0 2px 6px var(--shadow-color);
    }
    .web-card .card-icon-box {
      background: var(--cyan-bg);
      border-color: var(--cyan-border);
    }
    .tomcat-card .card-icon-box {
      background: var(--amber-bg);
      border-color: var(--amber-border);
    }

    .badges-group {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .version-pill {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: 9999px;
      background: var(--purple-bg);
      color: var(--purple);
      border: 1px solid var(--purple-border);
      white-space: nowrap;
    }
    .card-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.2rem 0.55rem;
      border-radius: 9999px;
      white-space: nowrap;
    }
    .badge-online {
      background: var(--emerald-bg);
      color: var(--emerald);
      border: 1px solid var(--emerald-border);
    }
    .badge-offline {
      background: var(--rose-bg);
      color: var(--rose);
      border: 1px solid rgba(244, 63, 94, 0.25);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--emerald);
      display: inline-block;
      box-shadow: 0 0 6px var(--emerald);
    }
    .status-dot.dot-error {
      background: var(--rose);
      box-shadow: 0 0 6px var(--rose);
    }
    .status-dot.dot-warn {
      background: var(--amber);
      box-shadow: 0 0 6px var(--amber);
    }

    /* Card Content */
    .card-content {
      margin-bottom: 1rem;
    }
    .card-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 0.35rem;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-route {
      display: inline-block;
      max-width: 100%;
    }
    .card-route code {
      font-family: var(--font-mono);
      font-size: 0.78rem;
      font-weight: 500;
      padding: 0.2rem 0.5rem;
      border-radius: 0.4rem;
      display: inline-block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--border);
    }
    .web-card .card-route code {
      color: var(--cyan);
      border-color: var(--cyan-border);
    }
    .tomcat-card .card-route code {
      color: var(--amber);
      border-color: var(--amber-border);
    }

    /* Card Footer & Action */
    .card-footer {
      font-size: 0.78rem;
      color: var(--text-sub);
      margin-top: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
      font-family: var(--font-mono);
    }
    .container-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.74rem;
      color: var(--text-sub);
      max-width: 70%;
      overflow: hidden;
    }
    .container-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-launch {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--text-dim);
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .open-icon {
      font-size: 0.95rem;
      transition: transform 0.2s ease;
    }
    .card:hover .card-launch {
      color: var(--text-main);
    }
    .card:hover .open-icon {
      transform: translate(2px, -2px);
    }
    .web-card:hover .card-launch {
      color: var(--cyan);
    }
    .tomcat-card:hover .card-launch {
      color: var(--amber);
    }

    .empty-state {
      grid-column: 1/-1;
      text-align: center;
      padding: 2.5rem;
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: 1rem;
      color: var(--text-dim);
    }

    /* ====================================================
       3. NON-STICKY FOOTER
       ==================================================== */
    .site-footer {
      position: static;
      margin-top: auto;
      width: 100%;
      background: var(--footer-bg);
      border-top: 1px solid var(--border);
      transition: background 0.4s ease, border-color 0.4s ease;
    }

    .footer-inner {
      width: 100%;
      max-width: 1800px;
      margin: 0 auto;
      padding: 1.25rem clamp(0.75rem, 2.5vw, 2.5rem);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.5rem;
      font-size: 0.8rem;
      color: var(--text-dim);
    }
    .footer-inner span.time { color: var(--text-sub); font-family: var(--font-mono); }

    /* Responsive Adjustments for Mobile & Tablets */
    @media (max-width: 768px) {
      .bg-glow-container {
        display: none !important; /* Disables heavy blur animation to prevent phone browser layer crashes */
      }
      .header-inner {
        padding: 0.65rem 0.75rem;
        gap: 0.6rem;
      }
      .navbar-top-row {
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
      }
      .brand-title {
        font-size: 1.12rem;
      }
      .sidebar-toggle-btn {
        display: inline-flex !important;
      }
      .navbar-actions {
        display: none !important; /* Move to mobile drawer on small screens */
      }
      .navbar-controls-row {
        flex-direction: column;
        align-items: stretch;
        gap: 0.5rem;
      }
      .search-box {
        width: 100%;
        min-width: 100%;
      }
      .tabs-actions-group {
        display: flex;
        width: 100%;
        gap: 0.4rem;
        align-items: center;
      }
      .tabs {
        flex: 1;
        display: flex;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .tabs::-webkit-scrollbar {
        display: none;
      }
      .tab-btn {
        flex: 1;
        text-align: center;
        padding: 0.45rem 0.35rem;
        font-size: 0.75rem;
      }
      .sync-btn {
        padding: 0.45rem 0.65rem;
        font-size: 0.75rem;
      }
      .main-content {
        padding: 1rem 0.75rem 2rem;
      }
      .grid {
        grid-template-columns: 1fr;
        gap: 0.85rem;
      }
      .footer-inner {
        flex-direction: column;
        text-align: center;
        gap: 0.35rem;
        padding: 1rem 0.75rem;
      }
    }

    @media (max-width: 480px) {
      .auth-card {
        padding: 1.75rem 1.25rem;
      }
      #theme-text {
        display: none;
      }
    }

    /* ====================================================
       AUTHENTICATION & LOGIN OVERLAY
       ==================================================== */
    .dashboard-app-wrapper {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      transition: filter 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease;
    }
    .dashboard-app-wrapper.locked {
      filter: blur(16px);
      opacity: 0.15;
      pointer-events: none;
      user-select: none;
    }

    .auth-overlay {
      position: fixed;
      inset: 0;
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.25rem;
      background: rgba(10, 15, 30, 0.7);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: opacity 0.35s ease, visibility 0.35s ease;
    }
    .auth-overlay.hidden {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    .auth-card {
      width: 100%;
      max-width: 440px;
      background: var(--surface);
      border: 1px solid var(--border-glow);
      border-radius: 1.25rem;
      padding: 2.25rem 2rem;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 35px var(--cyan-glow);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      position: relative;
      animation: authCardPop 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes authCardPop {
      0% { opacity: 0; transform: scale(0.92) translateY(14px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }

    .auth-header {
      text-align: center;
      margin-bottom: 1.75rem;
    }
    .auth-logo-badge {
      width: 56px;
      height: 56px;
      margin: 0 auto 0.85rem;
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(129, 140, 248, 0.25));
      border: 1px solid var(--cyan-border);
      border-radius: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.8rem;
      box-shadow: 0 0 20px var(--cyan-glow);
    }
    .auth-title {
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 0.35rem;
      background: linear-gradient(135deg, var(--text-main), var(--cyan));
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .auth-subtitle {
      font-size: 0.82rem;
      color: var(--text-muted);
      line-height: 1.45;
    }

    .auth-form {
      display: flex;
      flex-direction: column;
      gap: 1.05rem;
    }

    .auth-field-group {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .auth-label {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--text-muted);
    }

    .auth-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }
    .auth-input-icon {
      position: absolute;
      left: 0.9rem;
      font-size: 0.95rem;
      color: var(--text-muted);
      pointer-events: none;
    }
    .auth-input {
      width: 100%;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 0.72rem 2.5rem 0.72rem 2.6rem;
      border-radius: 0.75rem;
      font-size: 0.9rem;
      outline: none;
      transition: all 0.2s ease;
    }
    .auth-input:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 3px var(--cyan-border);
    }
    .toggle-pwd-btn {
      position: absolute;
      right: 0.85rem;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 1.15rem;
      padding: 0.35rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
      user-select: none;
      transition: color 0.2s ease, transform 0.15s ease;
    }
    .toggle-pwd-btn:hover {
      color: var(--cyan);
      transform: translateY(-50%) scale(1.1);
    }
    .toggle-pwd-btn:active {
      transform: translateY(-50%) scale(0.95);
    }

    .auth-options-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: -0.1rem;
    }
    .auth-checkbox-label {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      cursor: pointer;
      user-select: none;
    }
    .auth-checkbox-label input {
      accent-color: var(--cyan);
      cursor: pointer;
    }

    .auth-error-banner {
      background: var(--rose-bg);
      border: 1px solid var(--rose-border);
      color: var(--rose);
      padding: 0.6rem 0.85rem;
      border-radius: 0.65rem;
      font-size: 0.82rem;
      font-weight: 500;
      display: none;
      align-items: center;
      gap: 0.45rem;
      animation: authShake 0.35s ease;
    }
    @keyframes authShake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-6px); }
      40%, 80% { transform: translateX(6px); }
    }

    .auth-submit-btn {
      background: linear-gradient(135deg, var(--cyan) 0%, #0284c7 100%);
      color: #ffffff;
      border: none;
      padding: 0.8rem 1.25rem;
      border-radius: 0.75rem;
      font-size: 0.92rem;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: all 0.25s ease;
      box-shadow: 0 4px 15px var(--cyan-glow);
      margin-top: 0.35rem;
    }
    .auth-submit-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px var(--cyan-glow);
    }
    .auth-submit-btn:active {
      transform: translateY(0);
    }

    .auth-hint {
      text-align: center;
      font-size: 0.76rem;
      color: var(--text-muted);
      margin-top: 1.25rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }
    .auth-hint code {
      background: var(--surface-elevated);
      padding: 0.15rem 0.4rem;
      border-radius: 0.35rem;
      color: var(--cyan);
      font-weight: 600;
    }

    /* Navbar User Pill */
    .user-profile-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .user-badge {
      font-size: 0.8rem;
      font-weight: 600;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 0.45rem 0.75rem;
      border-radius: 0.65rem;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }
    .logout-btn {
      background: var(--rose-bg);
      border: 1px solid var(--rose-border);
      color: var(--rose);
      padding: 0.45rem 0.75rem;
      border-radius: 0.65rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }
    .logout-btn:hover {
      transform: translateY(-1px);
      background: rgba(244, 63, 94, 0.25);
    }

    /* ====================================================
       RESPONSIVE SIDEBAR DRAWER
       ==================================================== */
    .sidebar-toggle-btn {
      display: none;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-main);
      width: 38px;
      height: 38px;
      border-radius: 0.65rem;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1.25rem;
      transition: all 0.2s ease;
      box-shadow: 0 2px 6px var(--shadow-color);
      flex-shrink: 0;
    }
    .sidebar-toggle-btn:hover {
      background: var(--surface-elevated);
      color: var(--cyan);
      transform: translateY(-1px);
    }

    .sidebar-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(10, 15, 30, 0.65);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 2000;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.3s ease;
    }
    .sidebar-backdrop.active {
      opacity: 1;
      visibility: visible;
    }

    .mobile-sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: 320px;
      max-width: 86vw;
      background: var(--surface);
      border-right: 1px solid var(--border-glow);
      box-shadow: 12px 0 40px rgba(0, 0, 0, 0.5);
      z-index: 2010;
      display: flex;
      flex-direction: column;
      transform: translateX(-100%);
      transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .mobile-sidebar.active {
      transform: translateX(0);
    }

    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.15rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      font-weight: 700;
      font-size: 1.1rem;
      color: var(--text-main);
    }
    .sidebar-close-btn {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text-muted);
      width: 32px;
      height: 32px;
      border-radius: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1.1rem;
      transition: all 0.2s ease;
    }
    .sidebar-close-btn:hover {
      color: var(--rose);
      border-color: var(--rose-border);
    }

    .sidebar-content {
      padding: 1.25rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 1.35rem;
      flex: 1;
    }

    .sidebar-section {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .sidebar-section-title {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      padding: 0 0.25rem;
    }

    /* Sidebar User Card */
    .sidebar-user-card {
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .sidebar-user-info {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }
    .sidebar-user-avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: var(--cyan-bg);
      border: 1px solid var(--cyan-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.15rem;
      flex-shrink: 0;
    }
    .sidebar-user-name {
      font-size: 0.88rem;
      font-weight: 700;
      color: var(--text-main);
    }
    .sidebar-user-status {
      font-size: 0.72rem;
      color: var(--emerald);
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-weight: 600;
    }
    .sidebar-logout-btn {
      width: 100%;
      background: var(--rose-bg);
      border: 1px solid var(--rose-border);
      color: var(--rose);
      padding: 0.55rem;
      border-radius: 0.55rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.35rem;
      transition: all 0.2s ease;
    }
    .sidebar-logout-btn:hover {
      background: rgba(244, 63, 94, 0.25);
    }

    /* Sidebar Links */
    .sidebar-links-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .sidebar-link-item {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.65rem 0.75rem;
      border-radius: 0.75rem;
      text-decoration: none;
      transition: all 0.2s ease;
    }
    .sidebar-link-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .sidebar-link-title {
      font-size: 0.84rem;
      font-weight: 700;
    }
    .sidebar-link-sub {
      font-size: 0.72rem;
      opacity: 0.8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
    }
    .sidebar-link-arrow {
      font-size: 0.85rem;
      opacity: 0.7;
    }

    /* Sidebar Theme Switch Button */
    .sidebar-theme-toggle-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 0.75rem 0.95rem;
      border-radius: 0.75rem;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 2px 6px var(--shadow-color);
    }
    .sidebar-theme-toggle-btn:hover {
      border-color: var(--cyan);
      color: var(--cyan);
      transform: translateY(-1px);
    }
    .sidebar-theme-left {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .sidebar-theme-badge {
      font-size: 0.72rem;
      background: var(--surface);
      border: 1px solid var(--border);
      padding: 0.2rem 0.55rem;
      border-radius: 9999px;
      color: var(--text-sub);
    }

    /* Sidebar Toggle Button (Hidden on PC view, shown on mobile only) */
    .sidebar-toggle-btn {
      display: none;
    }

    /* Authenticated State Instant Overrides (Zero Flash on Page Refresh) */
    html.authenticated #auth-overlay {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }
    html.authenticated #dashboard-app-wrapper {
      filter: none !important;
      pointer-events: auto !important;
      user-select: auto !important;
    }
    html.authenticated #user-profile-bar {
      display: flex !important;
    }
  </style>

  <!-- Early Global Auth Scripts -->
  <script>
    const AUTH_SESSION_KEY = "gateway_auth_session";
    const AUTH_CREDS_KEY = "gateway_auth_credentials";

    // Immediate synchronous check before paint to ensure login state persists on refresh
    try {
      const savedSession = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY);
      if (savedSession) {
        const parsedSession = JSON.parse(savedSession);
        if (parsedSession && parsedSession.authenticated) {
          document.documentElement.classList.add("authenticated");
        }
      }
    } catch (e) {}

    window.togglePasswordVisibility = function(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pInput = document.getElementById("auth-password");
      const pBtn = document.getElementById("toggle-pwd-btn");
      if (!pInput) return;
      const isPwd = pInput.type === "password" || pInput.getAttribute("type") === "password";
      const next = isPwd ? "text" : "password";
      pInput.type = next;
      pInput.setAttribute("type", next);
      if (pBtn) {
        pBtn.textContent = isPwd ? "🙈" : "👁️";
        pBtn.title = isPwd ? "Hide password" : "Show password";
      }
      pInput.focus();
    };

    window.unlockDashboard = function(username) {
      document.documentElement.classList.add("authenticated");
      const authOverlay = document.getElementById("auth-overlay");
      const appWrapper = document.getElementById("dashboard-app-wrapper");
      const userProfileBar = document.getElementById("user-profile-bar");
      const authUsernameDisplay = document.getElementById("auth-username-display");
      const sidebarUsernameDisplay = document.getElementById("sidebar-username-display");
      const authErrorBanner = document.getElementById("auth-error");

      if (authOverlay) authOverlay.classList.add("hidden");
      if (appWrapper) appWrapper.classList.remove("locked");
      if (userProfileBar) userProfileBar.style.display = "flex";
      if (authUsernameDisplay) authUsernameDisplay.textContent = username || "admin";
      if (sidebarUsernameDisplay) sidebarUsernameDisplay.textContent = username || "admin";
      if (authErrorBanner) authErrorBanner.style.display = "none";
    };

    window.lockDashboard = function() {
      document.documentElement.classList.remove("authenticated");
      const authOverlay = document.getElementById("auth-overlay");
      const appWrapper = document.getElementById("dashboard-app-wrapper");
      const userProfileBar = document.getElementById("user-profile-bar");
      const authPassInput = document.getElementById("auth-password");

      if (authOverlay) authOverlay.classList.remove("hidden");
      if (appWrapper) appWrapper.classList.add("locked");
      if (userProfileBar) userProfileBar.style.display = "none";
      if (authPassInput) {
        authPassInput.value = "";
      }
    };

    window.handleLogin = function(e) {
      if (e && e.preventDefault) e.preventDefault();
      const authUserInput = document.getElementById("auth-username");
      const authPassInput = document.getElementById("auth-password");
      const authErrorBanner = document.getElementById("auth-error");
      const authErrorText = document.getElementById("auth-error-text");

      const user = (authUserInput && authUserInput.value ? authUserInput.value : "admin").trim();
      const pass = (authPassInput && authPassInput.value ? authPassInput.value : "").trim();

      // Allow any non-empty password
      if (pass.length > 0) {
        const sessionData = JSON.stringify({ authenticated: true, username: user || "admin", timestamp: Date.now() });
        localStorage.setItem(AUTH_SESSION_KEY, sessionData);
        sessionStorage.setItem(AUTH_SESSION_KEY, sessionData);
        window.unlockDashboard(user || "admin");
        return;
      }

      if (authErrorBanner) {
        authErrorBanner.style.display = "flex";
        if (authErrorText) authErrorText.textContent = "Please enter your password to sign in.";
        authErrorBanner.classList.remove("shake");
        void authErrorBanner.offsetWidth;
        authErrorBanner.classList.add("shake");
      }
      if (authPassInput) authPassInput.focus();
    };

    window.handleLogout = function() {
      localStorage.removeItem(AUTH_SESSION_KEY);
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      localStorage.removeItem(AUTH_CREDS_KEY);
      window.closeSidebar();
      window.lockDashboard();
    };

    window.checkAuth = function() {
      const session = localStorage.getItem(AUTH_SESSION_KEY) || sessionStorage.getItem(AUTH_SESSION_KEY);
      if (session) {
        try {
          const parsed = JSON.parse(session);
          if (parsed && parsed.authenticated) {
            window.unlockDashboard(parsed.username || "admin");
            return true;
          }
        } catch (e) {}
      }
      window.lockDashboard();
      return false;
    };

    window.openSidebar = function() {
      const sb = document.getElementById("mobile-sidebar");
      const bd = document.getElementById("sidebar-backdrop");
      if (sb) sb.classList.add("active");
      if (bd) bd.classList.add("active");
      document.body.style.overflow = "hidden";
    };

    window.closeSidebar = function() {
      const sb = document.getElementById("mobile-sidebar");
      const bd = document.getElementById("sidebar-backdrop");
      if (sb) sb.classList.remove("active");
      if (bd) bd.classList.remove("active");
      document.body.style.overflow = "";
    };

    window.toggleThemeFromSidebar = function() {
      const root = document.documentElement;
      const current = root.getAttribute("data-theme") === "light" ? "light" : "dark";
      if (window.applyThemeGlobal) {
        window.applyThemeGlobal(current === "light" ? "dark" : "light");
      }
    };
  </script>
</head>
<body>
  <!-- Dynamic Animated Ambient Background -->
  <div class="bg-glow-container">
    <div class="glow-orb orb-1"></div>
    <div class="glow-orb orb-2"></div>
    <div class="glow-orb orb-3"></div>
    <div class="glow-orb orb-4"></div>
  </div>
  <div class="bg-grid-overlay"></div>

  <!-- Responsive Slide-out Sidebar Drawer -->
  <div id="sidebar-backdrop" class="sidebar-backdrop" onclick="closeSidebar()"></div>
  <aside id="mobile-sidebar" class="mobile-sidebar" aria-label="Sidebar Menu">
    <div class="sidebar-header">
      <div class="sidebar-brand">
        <span>🐳</span>
        <span>Gateway Menu</span>
      </div>
      <button id="sidebar-close-btn" class="sidebar-close-btn" onclick="closeSidebar()" aria-label="Close Sidebar">✕</button>
    </div>

    <div class="sidebar-content">
      <!-- User Card Section -->
      <div class="sidebar-section">
        <div class="sidebar-user-card" id="sidebar-user-card">
          <div class="sidebar-user-info">
            <div class="sidebar-user-avatar">👤</div>
            <div>
              <div class="sidebar-user-name" id="sidebar-username-display">admin</div>
              <div class="sidebar-user-status"><span class="pulse-dot"></span> Active Session</div>
            </div>
          </div>
          <button class="sidebar-logout-btn" onclick="handleLogout()">
            <span>🚪 Logout of Gateway</span>
          </button>
        </div>
      </div>

      <!-- Gateways Direct Links -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">Gateways & Tooling</div>
        <div class="sidebar-links-list">
          <a href="${appDomain}" target="_blank" rel="noopener noreferrer" class="sidebar-link-item chip-app">
            <div class="sidebar-link-icon">🌐</div>
            <div class="sidebar-link-info">
              <span class="sidebar-link-title">Web Frontend Gateway</span>
              <span class="sidebar-link-sub">${appDomain}</span>
            </div>
            <span class="sidebar-link-arrow">↗</span>
          </a>
          <a href="${qaDomain}" target="_blank" rel="noopener noreferrer" class="sidebar-link-item chip-qa">
            <div class="sidebar-link-icon">☕</div>
            <div class="sidebar-link-info">
              <span class="sidebar-link-title">Tomcat QA Gateway</span>
              <span class="sidebar-link-sub">${qaDomain}</span>
            </div>
            <span class="sidebar-link-arrow">↗</span>
          </a>
        </div>
      </div>

      <!-- Theme Switch Section -->
      <div class="sidebar-section">
        <div class="sidebar-section-title">Appearance</div>
        <button id="sidebar-theme-btn" class="sidebar-theme-toggle-btn" onclick="toggleThemeFromSidebar()">
          <div class="sidebar-theme-left">
            <span id="sidebar-theme-icon">🌙</span>
            <span id="sidebar-theme-text">Dark Mode</span>
          </div>
          <span class="sidebar-theme-badge">Toggle ☀️/🌙</span>
        </button>
      </div>
    </div>
  </aside>

  <!-- Auth Login Screen Overlay -->
  <div id="auth-overlay" class="auth-overlay">
    <div class="auth-card">
      <div class="auth-header">
        <div class="auth-logo-badge">🛡️</div>
        <div class="auth-title">Global Docker Gateway</div>
        <div class="auth-subtitle">Authentication required to access deployed projects and live control dashboard.</div>
      </div>

      <form id="auth-form" class="auth-form" autocomplete="off" onsubmit="event.preventDefault(); handleLogin(event); return false;">
        <div class="auth-field-group">
          <label class="auth-label" for="auth-username">Username</label>
          <div class="auth-input-wrapper">
            <span class="auth-input-icon">👤</span>
            <input type="text" id="auth-username" class="auth-input" placeholder="Enter username" autocomplete="off" required>
          </div>
        </div>

        <div class="auth-field-group">
          <label class="auth-label" for="auth-password">Password</label>
          <div class="auth-input-wrapper">
            <span class="auth-input-icon">🔑</span>
            <input type="password" id="auth-password" class="auth-input" placeholder="Enter password" autocomplete="new-password" required>
            <button type="button" id="toggle-pwd-btn" class="toggle-pwd-btn" onclick="togglePasswordVisibility(event)" title="Toggle password visibility">👁️</button>
          </div>
        </div>

        <div id="auth-error" class="auth-error-banner">
          <span>⚠️</span>
          <span id="auth-error-text">Invalid credentials.</span>
        </div>

        <button type="button" id="auth-submit-btn" class="auth-submit-btn" onclick="handleLogin(event)">
          <span>Sign In to Gateway</span>
          <span>➔</span>
        </button>
      </form>
    </div>
  </div>

  <!-- Main Dashboard App Container (Protected) -->
  <div id="dashboard-app-wrapper" class="dashboard-app-wrapper locked">
    <!-- 1. Sticky Top Navigation Header -->
    <header class="sticky-header">
      <div class="header-inner">
        <div class="navbar-top-row">
          <div class="brand-group">
            <button id="sidebar-toggle-btn" class="sidebar-toggle-btn" onclick="openSidebar()" aria-label="Open Navigation Sidebar" title="Open Navigation Menu">
              <span>☰</span>
            </button>
            <span class="brand-title">Global Docker Gateway</span>
            <div class="live-indicator">
              <span class="pulse-dot"></span>
              <span>Live Sync Active</span>
            </div>
          </div>

          <!-- PC Desktop Actions (Always Visible on PC / Larger Screens) -->
          <div class="navbar-actions">
            <!-- Direct Gateway Links -->
            <div class="gateways-bar">
              <a href="${appDomain}" target="_blank" rel="noopener noreferrer" class="gateway-chip chip-app">
                <span>🌐</span>
                <span>Web Gateway</span>
                <span>↗</span>
              </a>
              <a href="${qaDomain}" target="_blank" rel="noopener noreferrer" class="gateway-chip chip-qa">
                <span>☕</span>
                <span>Tomcat QA</span>
                <span>↗</span>
              </a>
            </div>

            <!-- Theme Toggle Button -->
            <button id="theme-toggle-btn" class="theme-toggle-btn" title="Toggle Theme (Light / Dark)">
              <span id="theme-icon">🌙</span>
              <span id="theme-text">Dark Mode</span>
            </button>

            <!-- User Status & Logout -->
            <div class="user-profile-bar" id="user-profile-bar">
              <div class="user-badge">
                <span>👤</span>
                <span id="auth-username-display">admin</span>
              </div>
              <button class="logout-btn" id="logout-btn" onclick="handleLogout()" title="Logout of Gateway">
                <span>🚪</span>
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Controls Row: Search + Filter Tabs + Sync Button in Same Row -->
        <div class="navbar-controls-row">
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="search-input" class="search-input" placeholder="Search applications, versions, containers...">
          </div>

          <div class="tabs-actions-group">
            <div class="tabs">
              <button class="tab-btn active" data-filter="all">All (<span id="count-all">${
                webProjects.length + tomcatApps.length
              }</span>)</button>
              <button class="tab-btn" data-filter="web">⚡ Web (<span id="count-web">${
                webProjects.length
              }</span>)</button>
              <button class="tab-btn" data-filter="tomcat">☕ Tomcat (<span id="count-tomcat">${
                tomcatApps.length
              }</span>)</button>
            </div>

            <button id="sync-btn" class="sync-btn" title="Force Sync Status Now">
              <span class="sync-icon" id="sync-icon">🔄</span>
              <span>Sync</span>
            </button>
          </div>
        </div>
      </div>
    </header>

    <!-- 2. Scrollable Main Content Area -->
    <main class="main-content">
      <!-- Web Apps Section -->
      <div id="section-web-container">
        <div class="section-header">
          <div class="section-title">
            <span>⚡ Web Frontend Applications (Nginx Containers)</span>
            <span class="section-count" id="badge-count-web">${webProjects.length}</span>
          </div>
        </div>
        <div class="grid" id="grid-web"></div>
      </div>

      <!-- Tomcat Apps Section -->
      <div id="section-tomcat-container">
        <div class="section-header">
          <div class="section-title">
            <span>☕ Tomcat Backend Applications & Tools</span>
            <span class="section-count" id="badge-count-tomcat">${tomcatApps.length}</span>
          </div>
        </div>
        <div class="grid" id="grid-tomcat"></div>
      </div>
    </main>

    <!-- 3. Non-Sticky Footer -->
    <footer class="site-footer">
      <div class="footer-inner">
        <div>Global Docker Gateway • Dynamic Per-Project Containers</div>
        <div>Last synchronized: <span id="last-synced-time" class="time">Just now</span></div>
      </div>
    </footer>
  </div>

  <script>
    // Theme Management (Dark / Light Mode)
    const rootEl = document.documentElement;
    const themeBtn = document.getElementById("theme-toggle-btn");
    const themeIcon = document.getElementById("theme-icon");
    const themeText = document.getElementById("theme-text");

    function getPreferredTheme() {
      const saved = localStorage.getItem("gateway_theme");
      if (saved) return saved;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }

    function applyTheme(theme) {
      rootEl.setAttribute("data-theme", theme);
      localStorage.setItem("gateway_theme", theme);
      const isLight = theme === "light";
      if (themeIcon) themeIcon.textContent = isLight ? "☀️" : "🌙";
      if (themeText) themeText.textContent = isLight ? "Light Mode" : "Dark Mode";

      const sbThemeIcon = document.getElementById("sidebar-theme-icon");
      const sbThemeText = document.getElementById("sidebar-theme-text");
      if (sbThemeIcon) sbThemeIcon.textContent = isLight ? "☀️" : "🌙";
      if (sbThemeText) sbThemeText.textContent = isLight ? "Light Mode" : "Dark Mode";
    }
    window.applyThemeGlobal = applyTheme;

    applyTheme(getPreferredTheme());

    if (themeBtn) {
      themeBtn.addEventListener("click", () => {
        const current = rootEl.getAttribute("data-theme") === "light" ? "light" : "dark";
        applyTheme(current === "light" ? "dark" : "light");
      });
    }

    const logoutBtnEl = document.getElementById("logout-btn");
    if (logoutBtnEl) {
      logoutBtnEl.addEventListener("click", () => {
        if (window.handleLogout) window.handleLogout();
      });
    }

    window.checkAuth();

    let lastKnownUpdated = "${statusData.lastUpdated}";

    let state = {
      appDomain: "${appDomain}",
      qaDomain: "${qaDomain}",
      webProjects: ${JSON.stringify(webProjects)},
      tomcatApps: ${JSON.stringify(tomcatApps)},
      filter: "all",
      search: "",
    };

    const searchInput = document.getElementById("search-input");
    const syncBtn = document.getElementById("sync-btn");
    const syncIcon = document.getElementById("sync-icon");
    const tabBtns = document.querySelectorAll(".tab-btn");

    function setFilter(filterName) {
      state.filter = filterName;
      if (tabBtns) {
        tabBtns.forEach((b) => {
          if (b.dataset.filter === filterName) b.classList.add("active");
          else b.classList.remove("active");
        });
      }
      renderCards();
    }
    window.setFilter = setFilter;

    function renderCards() {
      const q = state.search.toLowerCase().trim();

      // Filter Web
      const filteredWeb = state.webProjects.filter((p) => {
        if (state.filter === "tomcat") return false;
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          (p.version && p.version.toLowerCase().includes(q)) ||
          p.containerName.toLowerCase().includes(q) ||
          p.url.toLowerCase().includes(q)
        );
      });

      // Filter Tomcat
      const filteredTomcat = state.tomcatApps.filter((p) => {
        if (state.filter === "web") return false;
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          (p.version && p.version.toLowerCase().includes(q)) ||
          p.containerName.toLowerCase().includes(q) ||
          p.url.toLowerCase().includes(q)
        );
      });

      const gridWeb = document.getElementById("grid-web");
      const gridTomcat = document.getElementById("grid-tomcat");
      const secWeb = document.getElementById("section-web-container");
      const secTomcat = document.getElementById("section-tomcat-container");

      if (secWeb) secWeb.style.display = state.filter === "tomcat" || (filteredWeb.length === 0 && q) ? "none" : "block";
      if (secTomcat) secTomcat.style.display = state.filter === "web" || (filteredTomcat.length === 0 && q) ? "none" : "block";

      if (gridWeb) {
        gridWeb.innerHTML = filteredWeb.length
          ? filteredWeb
              .map((p) => {
                const isOnline = p.isRunning !== false;
                const cardClass = isOnline ? "card web-card" : "card web-card card-offline";
                const dotClass = isOnline ? "status-dot" : "status-dot dot-error";
                const versionTag = p.version ? \`<span class="version-pill">v\${p.version}</span>\` : "";

                return \`
              <a href="\${p.url}" target="_blank" rel="noopener noreferrer" class="\${cardClass}" id="card-\${p.id}">
                <div class="card-glow-bar"></div>
                <div class="card-top">
                  <div class="card-icon-box">
                    <span class="card-icon">\${p.icon}</span>
                  </div>
                  <div class="badges-group">
                    \${versionTag}
                    <span class="card-status-badge \${isOnline ? "badge-online" : "badge-offline"}">
                      <span class="\${dotClass}"></span>
                      <span>\${isOnline ? "Live" : "Stopped"}</span>
                    </span>
                  </div>
                </div>
                <div class="card-content">
                  <div class="card-title">\${p.name}</div>
                  <div class="card-route">
                    <code>\${p.url}</code>
                  </div>
                </div>
                <div class="card-footer">
                  <div class="container-tag">
                    <span>🐳</span>
                    <span class="container-name">\${p.containerName}</span>
                  </div>
                  <div class="card-launch">
                    <span>Launch</span>
                    <span class="open-icon">↗</span>
                  </div>
                </div>
              </a>\`;
              })
              .join("")
          : '<div class="empty-state">No matching web containers found.</div>';
      }

      if (gridTomcat) {
        gridTomcat.innerHTML = filteredTomcat.length
          ? filteredTomcat
              .map((p) => {
                const isOnline = p.isRunning !== false;
                const cardClass = isOnline ? "card tomcat-card" : "card tomcat-card card-offline";
                const dotClass = isOnline ? "status-dot dot-warn" : "status-dot dot-error";
                const versionTag = p.version ? \`<span class="version-pill">v\${p.version}</span>\` : "";

                return \`
              <a href="\${p.url}" target="_blank" rel="noopener noreferrer" class="\${cardClass}" id="card-\${p.id}">
                <div class="card-glow-bar"></div>
                <div class="card-top">
                  <div class="card-icon-box">
                    <span class="card-icon">\${p.icon}</span>
                  </div>
                  <div class="badges-group">
                    \${versionTag}
                    <span class="card-status-badge \${isOnline ? "badge-online" : "badge-offline"}">
                      <span class="\${dotClass}"></span>
                      <span>\${isOnline ? "Live" : "Stopped"}</span>
                    </span>
                  </div>
                </div>
                <div class="card-content">
                  <div class="card-title">\${p.name}</div>
                  <div class="card-route">
                    <code>\${p.url}</code>
                  </div>
                </div>
                <div class="card-footer">
                  <div class="container-tag">
                    <span>☕</span>
                    <span class="container-name">\${p.containerName}</span>
                  </div>
                  <div class="card-launch">
                    <span>Launch</span>
                    <span class="open-icon">↗</span>
                  </div>
                </div>
              </a>\`;
              })
              .join("")
          : '<div class="empty-state">No matching Tomcat applications found.</div>';
      }

      // Update counters
      const totalCount = state.webProjects.length + state.tomcatApps.length;
      const cntAll = document.getElementById("count-all");
      const cntWeb = document.getElementById("count-web");
      const cntTomcat = document.getElementById("count-tomcat");
      const badgeWeb = document.getElementById("badge-count-web");
      const badgeTomcat = document.getElementById("badge-count-tomcat");

      if (cntAll) cntAll.textContent = totalCount;
      if (cntWeb) cntWeb.textContent = state.webProjects.length;
      if (cntTomcat) cntTomcat.textContent = state.tomcatApps.length;
      if (badgeWeb) badgeWeb.textContent = state.webProjects.length;
      if (badgeTomcat) badgeTomcat.textContent = state.tomcatApps.length;
    }

    async function fetchStatus(isManual = false) {
      if (isManual && syncIcon) {
        syncIcon.classList.add("spinning");
      }
      try {
        const res = await fetch("/status.json?t=" + Date.now(), { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const hasChanged = isManual || (data.lastUpdated && data.lastUpdated !== lastKnownUpdated);

          if (hasChanged) {
            lastKnownUpdated = data.lastUpdated || lastKnownUpdated;
            state.appDomain = data.appDomain || state.appDomain;
            state.qaDomain = data.qaDomain || state.qaDomain;
            state.webProjects = data.webProjects || [];
            state.tomcatApps = data.tomcatApps || [];

            const appDomEl = document.getElementById("text-app-domain");
            const qaDomEl = document.getElementById("text-qa-domain");
            const chipApp = document.getElementById("chip-app");
            const chipQa = document.getElementById("chip-qa");

            if (appDomEl) appDomEl.textContent = state.appDomain;
            if (qaDomEl) qaDomEl.textContent = state.qaDomain;
            if (chipApp) chipApp.href = state.appDomain;
            if (chipQa) chipQa.href = state.qaDomain;
            
            const displayTime = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : new Date().toLocaleTimeString();
            const timeEl = document.getElementById("last-synced-time");
            if (timeEl) timeEl.textContent = displayTime;

            renderCards();
          }
        }
      } catch (e) {
        console.warn("Status fetch failed:", e);
      } finally {
        if (isManual && syncIcon) {
          setTimeout(() => {
            syncIcon.classList.remove("spinning");
          }, 400);
        }
      }
    }
    window.fetchStatusGlobal = fetchStatus;
    window.fetchStatusGlobal = fetchStatus;

    // Event Listeners
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        state.search = e.target.value;
        renderCards();
      });
    }

    if (tabBtns) {
      tabBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          setFilter(btn.dataset.filter);
        });
      });
    }

    if (syncBtn) {
      syncBtn.addEventListener("click", () => {
        fetchStatus(true);
      });
    }

    // Initial render & silent background check every 5 seconds
    renderCards();
    setInterval(() => fetchStatus(false), 5000);
    window.addEventListener("focus", () => fetchStatus(false));
  </script>
</body>
</html>`;

    fs.writeFileSync(path.join(globalHtmlDir, "index.html"), dashboardHtml);
    return true;
  } catch (e) {
    console.error("Failed to generate dashboard:", e);
    return false;
  }
}

module.exports = {
  updateGlobalDashboard,
  getTailscaleDomain,
};
