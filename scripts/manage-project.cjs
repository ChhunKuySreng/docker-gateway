const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { updateGlobalDashboard } = require("./dashboard-generator.cjs");

// Ensure Docker is in PATH on Windows
if (process.platform === "win32") {
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

const action = process.argv[2] || "stop"; // 'stop', 'start', 'restart'
let projectName = process.argv[3] || "";

// If no name provided, detect from current directory
if (!projectName || projectName === ".") {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) projectName = pkg.name;
    } catch (e) {}
  }
  if (!projectName) {
    projectName = path.basename(cwd);
  }
}

if (!projectName) {
  console.error(`❌ Error: Please specify project name. Example: d-stop my-web-app`);
  process.exit(1);
}

const containerName = `app-${projectName}`;

try {
  if (action === "stop") {
    console.log(`⏸️ Stopping container [${containerName}]...`);
    execSync(`docker stop ${containerName}`, { stdio: "inherit" });
    console.log(`🔴 Container [${containerName}] is now STOPPED.`);
  } else if (action === "start") {
    console.log(`▶️ Starting container [${containerName}]...`);
    execSync(`docker start ${containerName}`, { stdio: "inherit" });
    console.log(`🟢 Container [${containerName}] is now RUNNING.`);
  } else if (action === "restart") {
    console.log(`🔄 Restarting container [${containerName}]...`);
    execSync(`docker restart ${containerName}`, { stdio: "inherit" });
    console.log(`🟢 Container [${containerName}] has been RESTARTED.`);
  }
} catch (e) {
  console.error(`❌ Action failed: ${e.message}`);
}

// Immediately update dashboard status
console.log(`🔄 Updating live dashboard...`);
updateGlobalDashboard();
console.log(`🌐 Live Dashboard updated in real-time.`);
