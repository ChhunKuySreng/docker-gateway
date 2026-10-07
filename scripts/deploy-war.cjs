const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const globalDir = path.resolve(__dirname, "..");
const globalWebappsDir = path.join(globalDir, "webapps");
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
    return ps.includes("gateway-tomcat") || ps.includes("global-tomcat");
  } catch (e) {
    return false;
  }
};

const stat = fs.statSync(resolvedInput);
let warFilePath = "";
let contextName = process.argv[3] || "";
let projectDir = stat.isDirectory() ? resolvedInput : path.dirname(resolvedInput);

let version = "1.0.0";

if (stat.isDirectory()) {
  const pkgPath = path.join(resolvedInput, "package.json");
  const pomPath = path.join(resolvedInput, "pom.xml");
  const gradlePath = path.join(resolvedInput, "build.gradle");
  const scriptBuildQa = path.join(resolvedInput, "scripts/build-qa.cjs");
  let pkg = null;

  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!contextName && pkg.name) contextName = pkg.name;
      if (pkg.version) version = pkg.version;
    } catch (e) {}
  }


  const searchDirs = [
    path.join(resolvedInput, "release"),
    path.join(resolvedInput, "target"),
    path.join(resolvedInput, "build/libs"),
    resolvedInput,
  ];

  const findWar = () => {
    for (const dir of searchDirs) {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const warFiles = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".war") && !f.endsWith(".original"));
        if (warFiles.length > 0) {
          warFiles.sort(
            (a, b) =>
              fs.statSync(path.join(dir, b)).mtimeMs -
              fs.statSync(path.join(dir, a)).mtimeMs
          );
          return path.join(dir, warFiles[0]);
        }
      }
    }
    return "";
  };

  // Check if project is recognized
  const canBuild =
    (pkg && pkg.scripts && pkg.scripts.war) ||
    fs.existsSync(scriptBuildQa) ||
    fs.existsSync(pomPath) ||
    fs.existsSync(gradlePath);

  if (!canBuild && !findWar()) {
    console.error(
      `❌ Cannot build WAR: No pom.xml, build.gradle, 'yarn war' script, or existing .war file in:\n   ${resolvedInput}`
    );
    process.exit(1);
  }

  // Build WAR project
  console.log(`🔨 Building WAR project in: ${resolvedInput}`);
  try {
    if (pkg && pkg.scripts && pkg.scripts.war) {
      execSync(hasYarn ? "yarn war" : "npm run war", {
        cwd: resolvedInput,
        stdio: "inherit",
      });
    } else if (fs.existsSync(scriptBuildQa)) {
      execSync("node scripts/build-qa.cjs", { cwd: resolvedInput, stdio: "inherit" });
    } else if (fs.existsSync(pomPath)) {
      execSync("mvn clean package -Pprod", { cwd: resolvedInput, stdio: "inherit" });
    } else if (fs.existsSync(gradlePath)) {
      const gradlew = isWin ? "gradlew.bat" : "./gradlew";
      execSync(`${gradlew} war`, { cwd: resolvedInput, stdio: "inherit" });
    }
  } catch (err) {
    console.error(`❌ Build failed:`, err.message);
    process.exit(1);
  }

  warFilePath = findWar();

  if (!warFilePath) {
    console.error(`❌ Error: WAR file could not be found after build in ${resolvedInput}`);
    process.exit(1);
  }
} else if (stat.isFile() && resolvedInput.endsWith(".war")) {
  warFilePath = resolvedInput;
} else {
  console.error(`❌ Error: '${resolvedInput}' is not a valid project folder or .war file.`);
  process.exit(1);
}

if (!contextName) {
  const baseName = path.basename(warFilePath, ".war");
  contextName = baseName.split("##")[0];
}

console.log(`\n✅ WAR artifact ready: ${warFilePath}`);

// Check if Docker is running
if (!isDockerRunning()) {
  console.log(`\nℹ️  Docker (gateway-tomcat) is NOT running.`);
  console.log(`📦 Build completed and kept in project release folder:`);
  console.log(`   ${warFilePath}`);
  console.log(`💡 Tip: Run 'd-up' to start Docker and auto-deploy.`);
  process.exit(0);
}

// Deploy to Docker Tomcat
if (!fs.existsSync(globalWebappsDir)) {
  fs.mkdirSync(globalWebappsDir, { recursive: true });
}

console.log(`\n🐳 Docker detected! Deploying to Tomcat...`);
console.log(`🎯 Context Name: ${contextName}`);

try {
  fs.readdirSync(globalWebappsDir).forEach((file) => {
    if (
      file.startsWith(`${contextName}##`) ||
      file === `${contextName}.war` ||
      file === contextName
    ) {
      console.log(`🧹 Cleaning old version: ${file}`);
      fs.rmSync(path.join(globalWebappsDir, file), { recursive: true, force: true });
    }
  });
} catch (e) {}

const targetWar = path.join(globalWebappsDir, `${contextName}.war`);
fs.copyFileSync(warFilePath, targetWar);
console.log(`📋 Copied WAR: ${path.basename(warFilePath)} -> ${targetWar}`);

fs.writeFileSync(
  path.join(globalWebappsDir, `${contextName}.meta.json`),
  JSON.stringify({ name: contextName, version, deployedAt: new Date().toISOString() }, null, 2)
);


const { updateGlobalDashboard, getTailscaleDomain } = require("./dashboard-generator.cjs");

// Update central dashboard
updateGlobalDashboard();

const qaDomain = getTailscaleDomain("tailscale-qa", "local-qa");
console.log(`\n🎉 Deployed successfully to Apache Tomcat!`);
console.log(`📁 Target: ${targetWar}`);
console.log(`🌐 Public URL: ${qaDomain}/${contextName}/`);


