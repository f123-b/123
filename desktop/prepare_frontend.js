const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const desktopRoot = __dirname;
const target = path.join(desktopRoot, "frontend");

function pythonCandidates() {
  return [
    process.env.COMFY_DESKTOP_PYTHON,
    path.join(process.env.ProgramData || "", "anaconda3", "python.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"),
    process.platform === "win32" ? "python.exe" : "python3"
  ].filter(Boolean);
}

function frontendFromPython(python) {
  const result = spawnSync(python, [
    "-c",
    "import pathlib, comfyui_frontend_package; print(pathlib.Path(comfyui_frontend_package.__file__).resolve().parent)"
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, windowsHide: true });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

const candidates = [
  process.env.COMFY_DESKTOP_FRONTEND_ROOT,
  ...pythonCandidates().map(frontendFromPython).filter(Boolean)
].filter(Boolean).map(source => path.join(source, "static"));

const source = candidates.find(candidate => fs.existsSync(path.join(candidate, "index.html")));
if (!source) {
  throw new Error("找不到 comfyui-frontend-package。请先安装 ComfyUI 前端包，或设置 COMFY_DESKTOP_FRONTEND_ROOT。");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log("Copied ComfyUI frontend from " + source);
