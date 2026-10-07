const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

const isWin = process.platform === "win32";
const rootDir = path.resolve(__dirname, "..");

if (isWin) {
  console.log("Detected Windows environment. Launching PowerShell setup...\n");
  const ps = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDir, "setup.ps1")],
    { stdio: "inherit", shell: true }
  );
  ps.on("close", (code) => process.exit(code));
} else {
  console.log("Detected macOS/Linux environment. Launching shell setup...\n");
  const sh = spawn("bash", [path.join(rootDir, "setup.sh")], {
    stdio: "inherit",
  });
  sh.on("close", (code) => process.exit(code));
}
