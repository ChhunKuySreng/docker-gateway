const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { updateGlobalDashboard } = require("./dashboard-generator.cjs");

const globalDir = path.resolve(__dirname, "..");
const globalProjectsDir = path.join(globalDir, "projects");
const globalWebappsDir = path.join(globalDir, "webapps");

let projectName = process.argv[2] || "";

// If no name provided, try detecting from current directory package.json or folder name
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
  console.error("❌ Error: Please specify project name to remove. Example: d-rm my-web-app");
  process.exit(1);
}

console.log(`\n🗑️ Removing project [${projectName}]...`);

// 1. Stop and remove Docker container
const containerName = `app-${projectName}`;
try {
  console.log(`🐳 Stopping & removing container [${containerName}]...`);
  execSync(`docker rm -f ${containerName}`, { stdio: "inherit" });
} catch (e) {
  console.log(`ℹ️ Container [${containerName}] not running or already removed.`);
}

// 2. Remove web project files
const projectDir = path.join(globalProjectsDir, projectName);
if (fs.existsSync(projectDir)) {
  console.log(`📁 Deleting project volume: ${projectDir}...`);
  fs.rmSync(projectDir, { recursive: true, force: true });
}

// 3. Optional: Remove Tomcat WAR if exists
if (fs.existsSync(globalWebappsDir)) {
  const warFile = path.join(globalWebappsDir, `${projectName}.war`);
  const warFolder = path.join(globalWebappsDir, projectName);
  if (fs.existsSync(warFile)) {
    console.log(`☕ Deleting Tomcat WAR: ${warFile}...`);
    fs.rmSync(warFile, { force: true });
  }
  if (fs.existsSync(warFolder)) {
    console.log(`☕ Deleting Tomcat unpacked folder: ${warFolder}...`);
    fs.rmSync(warFolder, { recursive: true, force: true });
  }
}

// 4. Update Central Dashboard
console.log(`🔄 Updating live dashboard...`);
updateGlobalDashboard();

console.log(`\n✅ Project [${projectName}] removed successfully!`);
console.log(`🌐 Live Dashboard updated in real-time.\n`);
