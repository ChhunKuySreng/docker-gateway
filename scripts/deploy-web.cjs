const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const globalDir = path.resolve(__dirname, "..");
const globalProjectsDir = path.join(globalDir, "projects");
const inputPath = process.argv[2] || process.cwd();
const resolvedInput = path.resolve(process.cwd(), inputPath);

if (!fs.existsSync(resolvedInput)) {
  console.error(`❌ Error: Path not found: ${resolvedInput}`);
  process.exit(1);
}

const isWin = process.platform === "win32";

// Ensure Docker is in PATH on Windows
if (isWin) {
  const possibleDockerPaths = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "DockerDesktop", "resources", "bin"),
    "C:\\Program Files\\Docker\\Docker\\resources\\bin",
    "C:\\Program Files (x86)\\Docker\\Docker\\resources\\bin",
  ];
  for (const p of possibleDockerPaths) {
    if (p && fs.existsSync(p) && !process.env.PATH.includes(p)) {
      process.env.PATH = `${p};${process.env.PATH}`;
    }
  }
}

const hasCommand = (cmd) => {
  try {
    execSync(isWin ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
};

const hasYarn = hasCommand("yarn");

const isDockerRunning = () => {
  try {
    const ps = execSync('docker ps --format "{{.Names}}"', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return ps.includes("global-nginx");
  } catch (e) {
    return false;
  }
};

const getDockerNetwork = () => {
  try {
    const raw = execSync('docker inspect tailscale-app --format "{{json .NetworkSettings.Networks}}"', {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed);
    if (keys.length > 0) return keys[0];
  } catch (e) {}
  return "docker-global_default";
};

const extractZip = (srcZip, destDir) => {
  fs.mkdirSync(destDir, { recursive: true });
  if (isWin) {
    execSync(
      `powershell -Command "Expand-Archive -Path '${srcZip}' -DestinationPath '${destDir}' -Force"`,
      { stdio: "inherit" }
    );
  } else {
    try {
      execSync(`unzip -o -q "${srcZip}" -d "${destDir}"`, { stdio: "inherit" });
    } catch (err) {
      execSync(`tar -xf "${srcZip}" -C "${destDir}"`, { stdio: "inherit" });
    }
  }
};

const stat = fs.statSync(resolvedInput);
let sourceDir = "";
let zipFallbackPath = "";
let contextName = process.argv[3] || "";
let projectDir = stat.isDirectory() ? resolvedInput : path.dirname(resolvedInput);

let version = "1.0.0";

if (stat.isDirectory()) {
  const pkgPath = path.join(resolvedInput, "package.json");
  let pkg = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!contextName && pkg.name) contextName = pkg.name;
      if (pkg.version) version = pkg.version;
    } catch (e) {}
  }

  if (!contextName) {
    contextName = path.basename(resolvedInput);
  }


  const possibleDirs = [
    path.join(resolvedInput, "build"),
    path.join(resolvedInput, "dist"),
  ];

  const searchZipDirs = [
    path.join(resolvedInput, "release"),
    path.join(resolvedInput, "dist"),
    resolvedInput,
  ];

  const findZip = () => {
    for (const dir of searchZipDirs) {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const zipFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".zip"));
        if (zipFiles.length > 0) {
          zipFiles.sort(
            (a, b) =>
              fs.statSync(path.join(dir, b)).mtimeMs -
              fs.statSync(path.join(dir, a)).mtimeMs
          );
          return path.join(dir, zipFiles[0]);
        }
      }
    }
    return "";
  };

  const canBuild =
    (pkg && pkg.scripts && (pkg.scripts.build || pkg.scripts["build:prod"] || pkg.scripts.zip)) ||
    fs.existsSync(path.join(resolvedInput, "scripts/build-prod.cjs"));

  if (!canBuild && !fs.existsSync(path.join(resolvedInput, "index.html")) && !findZip()) {
    console.error(
      `❌ Cannot build Web Frontend: No 'yarn build' script or index.html found in:\n   ${resolvedInput}`
    );
    process.exit(1);
  }

  console.log(`🔨 Building Web Frontend for [${contextName}] (Context: /${contextName}/)...`);
  try {
    const buildEnv = {
      ...process.env,
      PUBLIC_URL: `/${contextName}/`,
      REACT_APP_ROUTER_BASE: `/${contextName}/`,
    };

    if (pkg && pkg.scripts && pkg.scripts.build) {
      execSync(hasYarn ? "yarn build" : "npm run build", {
        cwd: resolvedInput,
        stdio: "inherit",
        env: buildEnv,
      });
    } else if (pkg && pkg.scripts && pkg.scripts["build:prod"]) {
      execSync("npm run build:prod", {
        cwd: resolvedInput,
        stdio: "inherit",
        env: buildEnv,
      });
    } else if (pkg && pkg.scripts && pkg.scripts.zip) {
      execSync(hasYarn ? "yarn zip" : "npm run zip", {
        cwd: resolvedInput,
        stdio: "inherit",
        env: buildEnv,
      });
    } else if (fs.existsSync(path.join(resolvedInput, "scripts/build-prod.cjs"))) {
      execSync("node scripts/build-prod.cjs", {
        cwd: resolvedInput,
        stdio: "inherit",
        env: buildEnv,
      });
    }

    for (const dir of possibleDirs) {
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, "index.html"))) {
        sourceDir = dir;
        break;
      }
    }

    if (!sourceDir) {
      zipFallbackPath = findZip();
    }
  } catch (err) {
    console.error(`❌ Build failed:`, err.message);
    process.exit(1);
  }

  if (!sourceDir && fs.existsSync(path.join(resolvedInput, "index.html"))) {
    sourceDir = resolvedInput;
  }

  if (!sourceDir && !zipFallbackPath) {
    console.error(`❌ Error: Build output directory (build/dist) or .zip release not found in ${resolvedInput}`);
    process.exit(1);
  }
} else {
  console.error(`❌ Error: '${resolvedInput}' is not a directory.`);
  process.exit(1);
}

console.log(
  `\n✅ Web build artifact ready: ${sourceDir || zipFallbackPath}`
);

// Check if Docker is running
if (!isDockerRunning()) {
  console.log(`\nℹ️  Docker (global-nginx) is NOT running.`);
  console.log(`📦 Build completed and kept in project directory:`);
  console.log(`   ${sourceDir || zipFallbackPath}`);
  console.log(`💡 Tip: Run 'd-up' to start Docker and auto-deploy.`);
  process.exit(0);
}

// 1. Prepare per-project directory
const targetProjectDir = path.join(globalProjectsDir, contextName);
const targetHtmlDir = path.join(targetProjectDir, "html");
fs.mkdirSync(targetHtmlDir, { recursive: true });

console.log(`\n🐳 Deploying to dedicated container: app-${contextName}...`);
console.log(`📁 Project files: ${targetHtmlDir}`);

// 2. Clean old files and copy new build (or extract zip)
if (path.resolve(sourceDir || "") !== path.resolve(targetHtmlDir)) {
  try {
    fs.readdirSync(targetHtmlDir).forEach((file) => {
      fs.rmSync(path.join(targetHtmlDir, file), { recursive: true, force: true });
    });
  } catch (e) {}

  if (sourceDir) {
    fs.cpSync(sourceDir, targetHtmlDir, { recursive: true });
  } else if (zipFallbackPath) {
    extractZip(zipFallbackPath, targetHtmlDir);
  }
}

// 3. Write internal project nginx.conf and meta.json
const projectNginxConf = `server {
    listen 80;
    server_name _;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/x-javascript application/javascript application/json application/xml;

    client_max_body_size 200M;
    absolute_redirect off;
    port_in_redirect off;

    root /usr/share/nginx/html;
    index index.html;

    # Match context path with alias and SPA fallback
    location ^~ /${contextName}/ {
        alias /usr/share/nginx/html/;
        try_files $uri $uri/ /index.html;
    }

    # Match root path with SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
fs.writeFileSync(path.join(targetProjectDir, "nginx.conf"), projectNginxConf);
fs.writeFileSync(
  path.join(targetProjectDir, "meta.json"),
  JSON.stringify({ name: contextName, version, deployedAt: new Date().toISOString() }, null, 2)
);


// 4. Spin up or update dedicated container for this project
const containerName = `app-${contextName}`;
try {
  console.log(`🔄 Updating container [${containerName}]...`);
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch (e) {}

  const targetNetwork = getDockerNetwork();
  const runCmd = `docker run -d --name ${containerName} --network ${targetNetwork} --restart unless-stopped -v "${targetHtmlDir}:/usr/share/nginx/html:ro" -v "${path.join(targetProjectDir, "nginx.conf")}:/etc/nginx/conf.d/default.conf:ro" nginx:alpine`;

  execSync(runCmd, { stdio: "ignore" });
} catch (err) {
  console.error(`❌ Failed to start container ${containerName}:`, err.message);
  process.exit(1);
}

const { updateGlobalDashboard, getTailscaleDomain } = require("./dashboard-generator.cjs");

// 5. Update central dashboard index.html
updateGlobalDashboard();

const baseDomain = getTailscaleDomain("tailscale-app", "local-app");
console.log(`\n🎉 Project container [${containerName}] is running!`);
console.log(`🌐 Public URL: ${baseDomain}/${contextName}/`);


