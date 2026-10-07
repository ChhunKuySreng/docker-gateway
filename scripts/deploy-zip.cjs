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
    const ps = execSync("docker ps --format '{{.Names}}'", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return ps.includes("global-nginx");
  } catch (e) {
    return false;
  }
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
      // Fallback to tar if unzip is not installed
      execSync(`tar -xf "${srcZip}" -C "${destDir}"`, { stdio: "inherit" });
    }
  }
};

const createZipArchive = (sourceDir, outputZipPath) => {
  const zipDir = path.dirname(outputZipPath);
  if (!fs.existsSync(zipDir)) {
    fs.mkdirSync(zipDir, { recursive: true });
  }
  if (fs.existsSync(outputZipPath)) {
    fs.rmSync(outputZipPath, { force: true });
  }

  if (isWin) {
    execSync(
      `powershell -Command "Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${outputZipPath}' -Force"`,
      { stdio: "inherit" }
    );
  } else {
    const zipName = path.basename(outputZipPath);
    try {
      execSync(`zip -q -r "${zipName}" .`, { cwd: sourceDir, stdio: "inherit" });
      fs.renameSync(path.join(sourceDir, zipName), outputZipPath);
    } catch (err) {
      execSync(`tar -a -cf "${outputZipPath}" *`, { cwd: sourceDir, stdio: "inherit" });
    }
  }
};

const stat = fs.statSync(resolvedInput);
let zipFilePath = "";
let contextName = process.argv[3] || "";
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

  const searchDirs = [
    path.join(resolvedInput, "release"),
    path.join(resolvedInput, "dist"),
    resolvedInput,
  ];

  const findZip = () => {
    for (const dir of searchDirs) {
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

  const hasZipScript =
    (pkg && pkg.scripts && pkg.scripts.zip) ||
    fs.existsSync(path.join(resolvedInput, "scripts/build-prod.cjs"));

  const hasBuildScript =
    pkg && pkg.scripts && (pkg.scripts.build || pkg.scripts["build:prod"]);

  if (!hasZipScript && !hasBuildScript && !findZip()) {
    console.error(
      `❌ Cannot build ZIP: No 'yarn zip', 'yarn build' script, or existing .zip release in:\n   ${resolvedInput}`
    );
    process.exit(1);
  }

  console.log(`🔨 Building ZIP release for [${contextName}] (Context: /${contextName}/)...`);
  try {
    const buildEnv = {
      ...process.env,
      PUBLIC_URL: `/${contextName}/`,
      REACT_APP_ROUTER_BASE: `/${contextName}/`,
    };

    if (pkg && pkg.scripts && pkg.scripts.zip) {
      execSync(hasYarn ? "yarn zip" : "npm run zip", {
        cwd: resolvedInput,
        stdio: "inherit",
        env: buildEnv,
      });
      zipFilePath = findZip();
    } else if (fs.existsSync(path.join(resolvedInput, "scripts/build-prod.cjs"))) {
      execSync("node scripts/build-prod.cjs", {
        cwd: resolvedInput,
        stdio: "inherit",
        env: buildEnv,
      });
      zipFilePath = findZip();
    } else if (hasBuildScript) {
      // Standard project build -> auto package into release/*.zip
      const buildCmd = pkg.scripts.build
        ? (hasYarn ? "yarn build" : "npm run build")
        : "npm run build:prod";
      execSync(buildCmd, { cwd: resolvedInput, stdio: "inherit", env: buildEnv });

      const possibleBuildDirs = [
        path.join(resolvedInput, "dist"),
        path.join(resolvedInput, "build"),
      ];

      let buildOutputDir = "";
      for (const bDir of possibleBuildDirs) {
        if (fs.existsSync(bDir) && fs.existsSync(path.join(bDir, "index.html"))) {
          buildOutputDir = bDir;
          break;
        }
      }

      if (buildOutputDir) {
        const generatedZip = path.join(
          resolvedInput,
          "release",
          `${contextName}##V${version}.zip`
        );
        console.log(`📦 Auto-creating ZIP archive: ${generatedZip}...`);
        createZipArchive(buildOutputDir, generatedZip);
        zipFilePath = generatedZip;
      } else {
        zipFilePath = findZip();
      }
    } else {
      zipFilePath = findZip();
    }
  } catch (err) {
    console.error(`❌ Build failed:`, err.message);
    process.exit(1);
  }

  if (!zipFilePath) {
    console.error(`❌ Error: ZIP release file could not be found after build in ${resolvedInput}`);
    process.exit(1);
  }
} else if (stat.isFile() && resolvedInput.endsWith(".zip")) {
  zipFilePath = resolvedInput;
  if (!contextName) {
    const baseName = path.basename(zipFilePath, ".zip");
    contextName = baseName.split("##")[0];
  }
} else {
  console.error(`❌ Error: '${resolvedInput}' is not a valid project or .zip file.`);
  process.exit(1);
}

console.log(`\n✅ ZIP release ready: ${zipFilePath}`);

// Check if Docker is running
if (!isDockerRunning()) {
  console.log(`\nℹ️  Docker (global-nginx) is NOT running.`);
  console.log(`📦 Release ZIP completed and saved in project release folder:`);
  console.log(`   ${zipFilePath}`);
  console.log(`💡 Tip: Run 'd-up' to start Docker and auto-deploy.`);
  process.exit(0);
}

// 1. Prepare per-project directory
const targetProjectDir = path.join(globalProjectsDir, contextName);
const targetHtmlDir = path.join(targetProjectDir, "html");
fs.mkdirSync(targetHtmlDir, { recursive: true });

console.log(`\n🐳 Deploying to dedicated container: app-${contextName}...`);

// 2. Clean old files and extract zip
try {
  fs.readdirSync(targetHtmlDir).forEach((file) => {
    fs.rmSync(path.join(targetHtmlDir, file), { recursive: true, force: true });
  });
} catch (e) {}

try {
  extractZip(zipFilePath, targetHtmlDir);
} catch (err) {
  console.error("❌ Failed to extract ZIP:", err.message);
  process.exit(1);
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
  execSync(`docker rm -f ${containerName} 2>/dev/null || true`, { stdio: "ignore" });

  const runCmd = `docker run -d \
    --name ${containerName} \
    --network docker-global_default \
    --restart unless-stopped \
    -v "${targetHtmlDir}:/usr/share/nginx/html:ro" \
    -v "${path.join(targetProjectDir, "nginx.conf")}:/etc/nginx/conf.d/default.conf:ro" \
    nginx:alpine`;

  execSync(runCmd, { stdio: "ignore" });
} catch (err) {
  console.error(`❌ Failed to start container ${containerName}:`, err.message);
  process.exit(1);
}

const { updateGlobalDashboard, getTailscaleDomain } = require("./dashboard-generator.cjs");

// 5. Update central dashboard
updateGlobalDashboard();

const baseDomain = getTailscaleDomain("tailscale-app", "local-app");
console.log(`\n🎉 Project container [${containerName}] is running!`);
console.log(`🌐 Public URL: ${baseDomain}/${contextName}/`);


