# 🚀 Multi-Project Docker Gateway (Tailscale + Nginx + Apache Tomcat + Dev Hub + MySQL)

A unified, centralized Docker development and deployment gateway environment featuring:

- **5 Dedicated Tailscale HTTPS Funnels**: Public HTTPS domains for Web Apps, Java Tomcat, Local Dev Ports (3000-3999), Database (phpMyAdmin / MySQL), and Media Tools (YouTube Bot).
- **Dynamic Multi-Container Web Gateway (Nginx)**: Automatically spins up dedicated, isolated containers for each web project (`1 Project = 1 Container = 1 Context Path`).
- **Apache Tomcat 9 (Java 11)**: Independent QA server for Java WAR webapps with built-in MySQL Connector/J driver and pre-configured JNDI DataSources.
- **Local Dev Hub (Ports 3000–3999)**: Live reverse-proxy for host dev servers (Vite, Next.js, React, Express) over public Tailscale HTTPS with real-time SSE discovery, cookie-based root routing, and full WebSocket HMR support.
- **Database Stack (MySQL 8.0 & phpMyAdmin)**: Fully configured MySQL database with persistence and phpMyAdmin web interface with extended configuration storage.
- **Dynamic Social Media OpenGraph Previews (NJS)**: Automatically intercepts crawlers (Facebook, Telegram, WhatsApp, Twitter) to query live backend APIs for titles, images, and descriptions. Includes a standalone deployment package for production servers without Docker in `nginx-og-preview/`.
- **Real-Time Live Dashboard**: Interactive Web & Tomcat catalog with live container health monitoring, instant search, filters, and auto-synchronization.

---

## 🏗️ Architecture Overview

```mermaid
flowchart TD
    User(["Public Internet / Tailnet"]) -->|"HTTPS :443"| TS_APP["Tailscale: local-app"]
    User -->|"HTTPS :443"| TS_QA["Tailscale: local-qa"]
    User -->|"HTTPS :443"| TS_DEV["Tailscale: local-dev"]
    User -->|"HTTPS :443"| TS_DB["Tailscale: local-db"]
    User -->|"HTTPS :443"| TS_YTBOT["Tailscale: local-ytbot"]

    subgraph "1. Web Gateway (local-app)"
        TS_APP -->|":80"| MainNginx["gateway-nginx Gateway"]
        MainNginx -->|"/"| Dashboard["Live Sync Dashboard"]
        MainNginx -->|"/status.json"| StatusAPI["Status Metadata API"]
        MainNginx -->|"/project-one/*"| App1["Container: app-project-one"]
        MainNginx -->|"/project-two/*"| App2["Container: app-project-two"]
        MainNginx -->|"/project-n/*"| AppN["Container: app-project-n"]
    end

    subgraph "2. Tomcat QA Stack (local-qa)"
        TS_QA -->|":8080"| TomcatServer["gateway-tomcat :8080"]
        TomcatServer -->|"/app-one/*"| War1["webapps/app-one.war"]
        TomcatServer -->|"/app-two/*"| War2["webapps/app-two.war"]
        TomcatServer -->|"/manager/html"| Manager["Tomcat Web Manager"]
    end

    subgraph "3. Local Dev Hub (local-dev)"
        TS_DEV -->|":80"| DevNginx["gateway-dev :80"]
        DevNginx -->|"/hub"| DevDashboard["Dev Hub Live Inspector"]
        DevNginx -->|"/events"| SseServer["dev-sse Node Inspector"]
        DevNginx -->|"/:port -> /"| HostDevServers["Host Dev Servers (:3000-:3999)"]
    end

    subgraph "4. Database Service (local-db)"
        TS_DB -->|":80"| PMA["gateway-phpmyadmin :80"]
        TS_DB -->|":3306"| MySQL["gateway-mysql :3306"]
        TomcatServer -.->|"JDBC (local-db:3306)"| MySQL
    end

    subgraph "5. Media Bot (local-ytbot)"
        TS_YTBOT -->|":8080"| YtBot["ytbot Python Service"]
    end
```

---

## 🌐 Public Endpoints

| Service                      | Domain / URL                                           | Destination       | Description                                                                |
| :--------------------------- | :----------------------------------------------------- | :---------------- | :------------------------------------------------------------------------- |
| **Central Dashboard**  | `https://<your-app-domain>.ts.net/`                  | Gateway Dashboard | Real-time interactive dashboard tracking all deployed Web & Tomcat apps.   |
| **Web SPA Containers** | `https://<your-app-domain>.ts.net/<project>/`        | `app-<project>` | Dedicated isolated container for each web application.                     |
| **Tomcat QA Webapps**  | `https://<your-qa-domain>.ts.net/<app>/`             | Tomcat Webapps    | Direct Java WAR deployments without any context prefix.                    |
| **Tomcat Manager**     | `https://<your-qa-domain>.ts.net/manager/html`       | Tomcat Manager UI | Inspect, hot-reload, and manage WAR deployments.                           |
| **Local Dev Hub**      | `https://<your-dev-domain>.ts.net/hub`               | Dev Hub Dashboard | Live inspector dashboard auto-discovering active host ports (3000–3999).   |
| **Dev Port Activator** | `https://<your-dev-domain>.ts.net/<3000-3999>`       | Root Proxy Session| Activates dev port via cookie and proxies at `/` with WebSocket/HMR.       |
| **Dev Hub Reset**      | `https://<your-dev-domain>.ts.net/reset`             | Reset Session     | Clears active port cookie and returns to the Dev Hub dashboard.            |
| **phpMyAdmin**         | `https://<your-db-domain>.ts.net/`                   | phpMyAdmin Web UI | Manage MySQL databases with full configuration storage.                    |
| **MySQL Database**     | `<your-db-domain>.ts.net:3306`                       | MySQL 8.0 Server  | Direct MySQL connection for DBeaver, TablePlus, Navicat, or external apps. |
| **YouTube Bot**        | `https://<your-ytbot-domain>.ts.net/`                | YouTube Media Bot | Web API and Telegram bot for media downloads.                              |

---

## 🗄️ Database & Tomcat Connection Guide

### 1. Connecting from Java / Tomcat Applications

Tomcat is automatically linked with MySQL on the internal Docker network.

* **Database Host:** `local-db` *(or `127.0.0.1` / `tailscale-db`)*
* **Port:** `3306`
* **Default Database:** `app_db`
* **Application User:** `admin` / **Password:** `admin123`
* **Root Superadmin:** `root` / **Password:** `root`

#### Option A: Direct JDBC URL

```java
Class.forName("com.mysql.cj.jdbc.Driver");
String url = "jdbc:mysql://local-db:3306/app_db?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC";
Connection conn = DriverManager.getConnection(url, "admin", "admin123");
```

#### Option B: Global JNDI DataSource (`jdbc/app_db`)

Tomcat has pre-configured connection pools in `conf/context.xml`:

```java
Context initCtx = new InitialContext();
Context envCtx  = (Context) initCtx.lookup("java:comp/env");
DataSource ds   = (DataSource) envCtx.lookup("jdbc/app_db"); // or "jdbc/DefaultDB"
Connection conn = ds.getConnection();
```

#### Option C: Spring Boot WAR or Container

Tomcat automatically passes the following environment variables to all webapps:

* `SPRING_DATASOURCE_URL=jdbc:mysql://local-db:3306/app_db?useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=UTC`
* `SPRING_DATASOURCE_USERNAME=admin`
* `SPRING_DATASOURCE_PASSWORD=admin123`

---

## ⚡ Local Dev Hub (Ports 3000–3999)

The **Dev Hub** allows you to expose local development servers running on your host machine (Vite, Next.js, Create React App, Express, etc.) to your team, remote testers, or mobile devices over Tailscale HTTPS with **zero container restarts**.

### 🌟 Key Capabilities

- **Zero-Config Live Discovery**: The internal `dev-sse` runner continuously scans host ports `3000–3999` using low-latency TCP polling. When a dev server starts, it automatically scrapes its HTML `<title>` or `<meta name="application-name">` to display human-readable project cards with real-time status.
- **Root-Level Cookie Routing (`/<port>` → `/`)**: Traditional subpath proxies (like `/port/3000/`) often break client-side routing (React Router, Next.js) and asset bundles. Dev Hub solves this seamlessly: navigating to `/<port>` (e.g. `https://<your-dev-domain>.ts.net/3000`) sets a session cookie `dev_port=3000` and immediately redirects to root `/`. Your project runs at root level with 100% path compatibility!
- **Full WebSocket & HMR Support**: Out-of-the-box WebSocket proxying (`Upgrade: websocket`) ensures Vite Hot Module Reloading (HMR), Next.js Fast Refresh, and Socket.IO connections work smoothly across mobile phones and remote devices.
- **Instant Project Switching & Reset**: Visit `https://<your-dev-domain>.ts.net/hub` at any time to switch active projects, or navigate to `/reset` to clear the active session cookie and return to the Dev Hub catalog.

### 🚀 Usage Workflow

1. **Start your host project:** Run your normal dev command on your machine (e.g., `npm run dev` or `yarn start` on port 3000, 3001, 5173, etc.).
2. **Open the Dev Hub:** Navigate to `https://<your-dev-domain>.ts.net/hub` on your phone, tablet, or another workstation.
3. **Connect to your project:** Click the project card or visit `https://<your-dev-domain>.ts.net/<port>` (e.g. `/3000`).
4. **Switch or disconnect:** Navigate to `https://<your-dev-domain>.ts.net/reset` or `/hub` at any time.

---

## 📋 Pre-Setup Checklist

Before running the automated setup script, ensure you have:

### 1. 🐳 Install & Start Docker Desktop

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

### 2. 🟢 Install Node.js (18 LTS, 20 LTS, or 22+)

- Required: Node.js `>= 18.0.0`.
- Verify: `node -v`

### 3. 🔑 Tailscale Auth Key

1. Go to [Tailscale Admin Console → Settings → Keys](https://login.tailscale.com/admin/settings/keys).
2. Click **Generate Auth Key** with **Reusable: Yes** and **Pre-authorized: Yes**.
3. Copy your key (`tskey-auth-...`).

---

## 💻 Automated Setup Guide

### 🍏 For macOS / Linux

```bash
cd ~/Sites/docker-gateway
./setup.sh
# or: npm run setup
```

Reload your terminal profile:

```bash
source ~/.zshrc    # or: source ~/.bashrc
```

---

### 🪟 For Windows (PowerShell)

Open PowerShell and run:

```powershell
cd $env:USERPROFILE\Sites\docker-gateway
.\setup.ps1
# or: npm run setup
```

Reload your PowerShell profile:

```powershell
. $PROFILE
```

---

## 🔑 Environment Configuration (`.env`)

```env
# Tailscale Configuration
TS_AUTHKEY=tskey-auth-your-key-here
TS_HOSTNAME_APP=my-app-gateway
TS_HOSTNAME_QA=my-qa-tomcat
TS_HOSTNAME_DEV=my-dev
TS_HOSTNAME_DB=my-db
TS_HOSTNAME_YTBOT=my-ytbot

# Local Host Port Bindings
PORT_APP=8080
PORT_QA=8081
PORT_YTBOT=8082
PORT_DEV=8083
PORT_MYSQL=3306
PORT_PMA=8084

# Tomcat Configuration
TOMCAT_IMAGE=tomcat:9.0.16-jre11
TOMCAT_ADMIN_USER=admin
TOMCAT_ADMIN_PASSWORD=your_secure_password

# Dashboard Login Credentials
DASHBOARD_ADMIN_USER=admin
DASHBOARD_ADMIN_PASSWORD=your_dashboard_password

# YouTube Bot Configuration
YTBOT_API_KEY=your_ytbot_api_key
BOT_TOKEN=
ALLOWED_IDS=*

# MySQL Database & phpMyAdmin Configuration
MYSQL_IMAGE=mysql:8.0
MYSQL_ROOT_PASSWORD=your_root_password
MYSQL_DATABASE=app_db
MYSQL_USER=admin
MYSQL_PASSWORD=your_db_password
PMA_CONTROLUSER=pma
PMA_CONTROLPASS=your_secure_pma_control_password
```

Verify all running containers:

```bash
d-ps
```

---

## 🚀 Deployment Shortcuts

| Command                    | Action                      | Destination                                     |
| :------------------------- | :-------------------------- | :---------------------------------------------- |
| **`dzip`**         | Build & Deploy ZIP Release  | `https://<your-app-domain>.ts.net/<project>/` |
| **`dweb`**         | Build & Deploy Web Frontend | `https://<your-app-domain>.ts.net/<project>/` |
| **`dwar`**         | Build & Deploy Java WAR     | `https://<your-qa-domain>.ts.net/<app>/`      |
| **`dall`**         | Deploy both WAR and ZIP     | Sequence: `dwar && dzip`                      |
| **`dstop <app>`**  | Stop container              | Marks container 🔴 Stopped on dashboard         |
| **`dstart <app>`** | Start container             | Restores container to 🟢 Online                 |
| **`drm <app>`**    | Delete project & container  | Cleanly removes files and Docker container      |
| **`d-up`**         | Start entire stack          | `docker compose up -d`                        |
| **`d-down`**       | Stop entire stack           | `docker compose down`                         |
| **`d-restart`**    | Restart entire stack        | `docker compose restart`                      |
| **`d-logs`**       | Stream live logs            | `docker compose logs -f`                      |
| **`d-ps`**         | View running containers     | `docker ps` with clean table format           |

---

## 📂 Repository Directory Structure

```text
docker-gateway/
├── docker-compose.yml           # Central multi-service stack orchestration
├── Dockerfile.tomcat            # Custom Tomcat 9 image with MySQL driver & manager
├── Dockerfile.dev-hub           # Lightweight Node.js SSE runner for Dev Hub
├── entrypoint-tomcat.sh         # Dynamic Tomcat manager, MySQL JNDI, & context config
├── nginx-main.conf              # Nginx master configuration loading NJS module
├── nginx.conf                   # Main Web Gateway router with bot social previews
├── nginx-dev.conf               # Dev Hub reverse-proxy for ports 3000–3010
├── og_preview.js                # NGINX JavaScript (NJS) crawler bot preview generator
├── ts-serve-app.json            # Tailscale HTTPS Funnel config for Web Gateway (:80)
├── ts-serve-qa.json             # Tailscale HTTPS Funnel config for Tomcat QA (:8080)
├── ts-serve-dev.json            # Tailscale HTTPS Funnel config for Dev Hub (:80)
├── ts-serve-db.json             # Tailscale HTTPS Funnel config for phpMyAdmin (:80)
├── ts-serve-ytbot.json          # Tailscale HTTPS Funnel config for YouTube Bot (:8080)
├── .env                         # Local secrets & credentials (git-ignored)
├── .env.example                 # Template configuration file
├── .gitignore                   # Git ignore rules for builds, dumps, and media
├── setup.sh                     # macOS / Linux automated installer
├── setup.ps1                    # Windows PowerShell automated installer
├── setup.bat                    # Windows batch launcher
├── README.md                    # System documentation & reference
│
├── nginx-og-preview/            # Standalone package for production servers (No Docker required)
│   ├── DEPLOY_MANUAL.txt        # Fast plain-text deployment manual for your team
│   ├── architecture-flowchart.jpg # High-resolution architecture diagram
│   ├── og_preview.js            # Standalone NJS preview generator module
│   ├── og-preview.conf          # Nginx site configuration snippet
│   ├── robots.txt               # Permissive robots.txt allowing Facebook & social bots
│   ├── install.sh               # Automated 1-step installer for Debian/Ubuntu & RHEL/CentOS
│   ├── test-bot.sh              # CLI tool simulating Facebook, Telegram, WhatsApp bots
│   └── README.md                # Full documentation & configuration guide
│
├── html/                        # Central Web Dashboard (polled by local-app)
│   ├── index.html               # Live reactive catalog application
│   ├── robots.txt               # Search & social bot crawl rules
│   └── status.json              # Real-time container metadata
│
├── html-dev/                    # Dev Hub Frontend & Live Port Inspector
│   ├── index.html               # Real-time port discovery UI
│   └── sse-server.js            # Server-Sent Events daemon for active port scanning
│
├── mysql-init/                  # MySQL entrypoint initialization scripts
│   └── 01-phpmyadmin.sql        # Automated phpMyAdmin configuration storage schema
│
├── projects/                    # Per-project isolated container storage & configs
│   └── <project-name>/html/     # Production SPA build assets
│
├── webapps/                     # Tomcat QA deployment directory for .war files
│
├── ytbot/                       # Python YouTube Downloader & Telegram service
│   ├── Dockerfile
│   ├── bot.py
│   └── downloads/               # Temporary media cache (git-ignored)
│
└── scripts/
    ├── clean-ds-store.sh        # Workspace .DS_Store cleaner script
    ├── dashboard-generator.cjs  # Dynamic central dashboard generator
    ├── deploy-war.cjs           # Smart Java WAR deployment script
    ├── deploy-web.cjs           # Smart Web frontend deployment script
    ├── deploy-zip.cjs           # Smart ZIP archive deployment script
    ├── manage-project.cjs       # Container stop/start manager
    └── remove-project.cjs       # Complete project remover
```
