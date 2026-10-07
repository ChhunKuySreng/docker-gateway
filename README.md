# 🚀 Global Multi-Project Docker Stack (Tailscale + Nginx + Apache Tomcat)

A unified, centralized Docker development and deployment environment featuring:

- **Dual Tailscale HTTPS Funnels**: Public HTTPS domains for both Web Apps and Java WARs.
- **Dynamic Multi-Container Web Gateway (Nginx)**: Automatically spins up dedicated, isolated containers for each web project (`1 Project = 1 Container = 1 Context Path`).
- **Real-Time Live Dashboard**: Interactive Web & Tomcat catalog with live container health monitoring, instant search, filters, and auto-synchronization.
- **Apache Tomcat 9 (Java 11)**: Independent QA server for Java WAR webapps.

---

## 🏗️ Architecture Overview

```mermaid
flowchart TD
    User([Public Internet / Tailnet]) -->|HTTPS :443| TS_APP[Tailscale Funnel: local-app]
    User -->|HTTPS :443| TS_QA[Tailscale Funnel: local-qa]

    subgraph "Nginx Web Gateway (local-app)"
        TS_APP -->|:80| MainNginx[global-nginx Gateway]
        MainNginx -->|/| Dashboard[Live Sync Dashboard]
        MainNginx -->|/status.json| StatusAPI[Live Status Metadata API]
        MainNginx -->|/project-one/*| App1[Container: app-project-one]
        MainNginx -->|/project-two/*| App2[Container: app-project-two]
        MainNginx -->|/{any-project}/*| AppN[Container: app-{any-project}]
    end

    subgraph "Apache Tomcat Stack (local-qa)"
        TS_QA -->|:8080| TomcatServer[global-tomcat :8080]
        TomcatServer -->|/app-one/*| War1[webapps/app-one.war]
        TomcatServer -->|/app-two/*| War2[webapps/app-two.war]
        TomcatServer -->|/manager/html| Manager[Tomcat Web Manager]
    end
```

---

## 🌐 Public Endpoints

| Domain | Destination | Description |
| :--- | :--- | :--- |
| **`https://<your-app-domain>.ts.net/`** | **Live Gateway Dashboard** | Real-time interactive dashboard tracking all Web & Tomcat apps. |
| **`https://<your-app-domain>.ts.net/<project>/`** | **Project Container (`app-<project>`)** | Dedicated SPA container (e.g. `/my-web-app/`, `/customer-portal/`, `/ecommerce-frontend/`). |
| **`https://<your-qa-domain>.ts.net/<app>/`** | **Tomcat Webapps** | Direct Java WAR deployments without any prefix required. |
| **`https://<your-qa-domain>.ts.net/manager/html`** | **Tomcat Manager UI** | Inspect, hot-reload, and manage WAR deployments. |

> [!NOTE]
> All application cards and links on the central dashboard open in a **new browser tab** (`target="_blank"`).

---

## 💻 New Device Quick Setup

Setting up on a new machine is completely automated with a single command:

### 🍏 For macOS / Linux

Open your terminal and run:

```bash
cd ~/Sites/docker-global
./setup.sh
# or: npm run setup
```

Then reload your terminal profile:

```bash
source ~/.zshrc    # or: source ~/.bashrc
```

---

### 🪟 For Windows (PowerShell / Command Prompt)

Open PowerShell as Administrator (or standard user) and run:

```powershell
cd $env:USERPROFILE\Sites\docker-global
.\setup.ps1
# or: npm run setup
# or double-click: setup.bat
```

Then reload your PowerShell profile:

```powershell
. $PROFILE
```

---

### ⚙️ What the Setup Script Does Automatically:

1. **Verifies Prerequisites**: Checks Docker, Docker daemon, Node.js (v18+), and Yarn/npm.
2. **Generates `.env`**: Creates `.env` from `.env.example` if not already present.
3. **Creates Directories**: Initializes `html/`, `webapps/`, and `projects/`.
4. **Installs Global Terminal Shortcuts**:
   - In macOS/Linux: Injects `dweb`, `dwar`, `dzip`, `dall`, `dstop`, `dstart`, `drm`, `d-up`, `d-down`, `d-ps`, `d-logs` into `~/.zshrc` / `~/.bashrc`.
   - In Windows: Injects PowerShell helper functions into `$PROFILE`.
5. **Starts All Containers**: Boots up the Tailscale Funnels, Nginx Gateway, and Tomcat stack.

---

### 🔑 Environment Configuration (`.env`)

Make sure your `.env` contains your active Tailscale Auth Key:

```env
# Tailscale Configuration (from Tailscale Admin Console -> Settings -> Keys)
TS_AUTHKEY=tskey-auth-your-key-here
TS_HOSTNAME_APP=my-app-gateway
TS_HOSTNAME_QA=my-qa-tomcat

# Local Host Port Bindings
PORT_APP=8080
PORT_QA=8081

# Tomcat Configuration
TOMCAT_IMAGE=tomcat:9.0.16-jre11
TOMCAT_ADMIN_USER=your_admin_user
TOMCAT_ADMIN_PASSWORD=your_secure_password
```

Verify that all base containers are healthy:

```bash
d-ps
```

You should see:

- `tailscale-app` (Tailscale Node for Web Gateway)
- `global-nginx` (Nginx Gateway Router)
- `tailscale-qa` (Tailscale Node for Tomcat QA)
- `global-tomcat` (Apache Tomcat 9 Server)

---

## 🚀 How to Deploy Projects

### 🗜️ 1. Deploy ZIP Release (`dzip`) *(Recommended for Production)*

Run `dzip` from inside any web repository:

```bash
cd /path/to/my-web-app
dzip
```

**What happens automatically:**
1. Compiles production assets and packages `<project>/release/${name}##V${version}.zip`.
2. Extracts the ZIP into `projects/<project-name>/html/`.
3. Creates or updates container `app-<project-name>`.
4. Auto-syncs live dashboard in real time (`https://<your-app-domain>.ts.net/`).

---

### 📦 2. Deploy Web Frontend (`dweb`)

```bash
cd /path/to/my-web-app
dweb
```

Builds raw `dist/` or `build/` assets and deploys directly into container `app-<project-name>`.

---

### ☕ 3. Deploy Java WAR (`dwar`)

Run `dwar` from inside any Maven, Gradle, or WAR-based project:

```bash
cd /path/to/my-java-app
dwar
```

**What happens automatically:**
1. Builds Java WAR artifact (`release/*.war` or `target/*.war`).
2. Cleans previous versions in `webapps/` and copies the new `.war`.
3. Live immediately on Tomcat QA at `https://<your-qa-domain>.ts.net/<app>/`.

---

### ⚡ 4. Deploy Both WAR & ZIP (`dall`)

```bash
cd /path/to/my-project
dall
```

Runs **`dwar && dzip`** in sequence to build both the WAR archive (Tomcat) and ZIP release (Nginx Web Container).

---

## 🎛️ Container & Project Management

You can manage individual containers without touching `docker-compose`:

| Command | Action | Example |
| :--- | :--- | :--- |
| **`dstop <project>`** / **`d-stop`** | Stops the project container & marks it 🔴 **Stopped** on the live dashboard | `dstop my-web-app` |
| **`dstart <project>`** / **`d-start`** | Starts the project container & restores status to 🟢 **Live** | `dstart my-web-app` |
| **`drm <project>`** / **`d-rm`** | Stops container, deletes project files, and removes card from dashboard | `drm my-web-app` |

*(If you omit `<project>`, the commands automatically detect the project in your current working directory).*

---

## 📊 Live Dashboard Features (`/`)

The central dashboard (`https://<your-app-domain>.ts.net/`) includes:

- **⚡ Real-Time Synchronization**: Polling every 3 seconds; updates when containers deploy, stop, or start without page reloads.
- **🔍 Instant Search**: Filter applications across Web & Tomcat in real time as you type.
- **🏷️ Category Filter Tabs**: Switch between `All`, `⚡ Web Frontend Containers`, and `☕ Tomcat Apps`.
- **🟢 Live Status Dots**: Shows real-time container states (🟢 Online / 🔴 Stopped).
- **🖥️ Responsive Adaptive Layout**:
  - **PC / Desktop**: Direct top navigation bar with gateway shortcuts, dark/light theme switch, and user profile pill with logout.
  - **Mobile / Tablet**: Clean compact header with slide-out sidebar drawer (`☰`) for touch devices.
- **🌓 Appearance Controls**: Instant Dark & Light mode toggle with local storage persistence and system preference detection.
- **🛡️ Secure Gateway Authentication**: Protected login overlay with seamless session persistence and zero-flash refresh.
- **↗️ New-Tab Links**: Opens all apps in separate browser tabs.

---

## 📂 Repository Directory Structure

```text
docker-global/
├── docker-compose.yml           # Central orchestration for Tailscale, Nginx, & Tomcat
├── Dockerfile.tomcat            # Custom Tomcat 9 image with auto-configured manager
├── entrypoint-tomcat.sh         # Configures Tomcat users, valves, and webapp templates
├── nginx.conf                   # Gateway router with dynamic DNS resolver to project containers
├── ts-serve-app.json            # Tailscale HTTPS Funnel config for local-app (:80)
├── ts-serve-qa.json             # Tailscale HTTPS Funnel config for local-qa (:8080)
├── .env                         # Local environment settings & secrets (ignored by Git)
├── .env.example                 # Template environment file (committed to Git)
├── .gitignore                   # Ignores .env, node_modules, and deployed builds
├── package.json                 # NPM helper commands
├── README.md                    # Stack documentation and setup guide
│
├── html/                        # Central Dashboard UI (https://<your-app-domain>.ts.net/)
│   ├── index.html               # Real-time interactive dashboard application
│   └── status.json              # Dynamic metadata API polled by the dashboard
│
├── projects/                    # Per-project isolated container storage & configs
│   ├── <project-one>/
│   │   ├── html/                # Production SPA build assets
│   │   └── nginx.conf           # Project-specific SPA Nginx routing
│   └── <project-two>/
│       ├── html/
│       └── nginx.conf
│
├── webapps/                     # Central volume for Tomcat WARs (e.g. <app-name>.war)
│
└── scripts/
    ├── dashboard-generator.cjs  # Shared real-time dashboard & status.json generator
    ├── deploy-war.cjs           # Smart WAR build & deploy to Tomcat QA
    ├── deploy-web.cjs           # Smart Web build & per-project container lifecycle
    ├── deploy-zip.cjs           # Smart ZIP build & per-project container deploy
    ├── manage-project.cjs       # Container stop / start / restart manager
    └── remove-project.cjs       # Complete project & container remover
```

---

## 🛠️ CLI Shortcut Reference

| Task | Command |
| :--- | :--- |
| **Deploy ZIP Release** | `dzip` |
| **Deploy Web Frontend** | `dweb` |
| **Deploy Java WAR** | `dwar` |
| **Deploy Both (WAR + ZIP)** | `dall` |
| **Stop Project Container** | `dstop <name>` or `d-stop` |
| **Start Project Container** | `dstart <name>` or `d-start` |
| **Remove Project & Container** | `drm <name>` or `d-rm` |
| **Start Global Stack** | `d-up` |
| **Stop Global Stack** | `d-down` |
| **Restart Global Stack** | `d-restart` |
| **View Running Containers** | `d-ps` |
| **View Live Stack Logs** | `d-logs` |
