const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const DEFAULT_PORT = Number(process.env.COMFY_DESKTOP_PORT || 8188);
const isPackaged = app.isPackaged;
const sourceRoot = path.resolve(__dirname, "..");
const packagedRoot = path.join(process.resourcesPath || "", "comfyui");
const ROOT = isPackaged && fs.existsSync(path.join(packagedRoot, "main.py")) ? packagedRoot : sourceRoot;

let mainWindow = null;
let backend = null;
let ownsBackend = false;
let shuttingDown = false;
let booting = false;
let port = DEFAULT_PORT;
let backendExit = null;
let backendLog = [];
let logPath = null;
let currentStatus = {
  state: "loading",
  title: "正在启动 ComfyUI",
  message: "正在准备本地推理环境…",
  detail: "数据只保存在本机。首次启动可能需要较长时间。"
};
const tracePath = path.join(process.env.APPDATA || process.env.TEMP || ".", "comfyui-local-studio", "logs", "desktop.log");

function trace(message) {
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch (_) {
    // Diagnostics must never prevent the desktop app from starting.
  }
}

trace(`loaded packaged=${isPackaged} root=${ROOT}`);

function pythonCandidates() {
  return [
    process.env.COMFY_DESKTOP_PYTHON,
    path.join(ROOT, "python_embeded", "python.exe"),
    path.join(process.env.ProgramData || "", "anaconda3", "python.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python311", "python.exe"),
    process.platform === "win32" ? "python.exe" : "python3"
  ].filter(Boolean);
}

function compatiblePython(executable) {
  if (!fs.existsSync(executable) && !path.isAbsolute(executable)) {
    return false;
  }
  const result = spawnSync(executable, ["-c", "raise SystemExit(0 if __import__('sys').version_info >= (3, 10) else 1)"], {
    stdio: "ignore",
    timeout: 3000,
    windowsHide: true
  });
  return result.status === 0;
}

function findPython() {
  const seen = new Set();
  for (const candidate of pythonCandidates()) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (compatiblePython(candidate)) return candidate;
  }
  return null;
}

function request(portNumber, pathname, timeout = 800) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: portNumber, path: pathname, timeout }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode >= 200 && response.statusCode < 300));
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", reject);
  });
}

function portInUse(portNumber) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once("error", error => resolve(error.code === "EADDRINUSE"));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(portNumber, "127.0.0.1");
  });
}

async function selectPort() {
  trace(`selectPort start default=${DEFAULT_PORT}`);
  try {
    if (await request(DEFAULT_PORT, "/system_stats", 500)) return DEFAULT_PORT;
  } catch (_) {
    // An unavailable port is the normal cold-start case.
  }
  trace("selectPort no existing service");
  if (!await portInUse(DEFAULT_PORT)) return DEFAULT_PORT;
  trace(`selectPort default busy=${DEFAULT_PORT}`);
  for (let offset = 1; offset <= 20; offset += 1) {
    const candidate = DEFAULT_PORT + offset;
    if (!await portInUse(candidate)) return candidate;
  }
  throw new Error(`本机端口 ${DEFAULT_PORT} 至 ${DEFAULT_PORT + 20} 都不可用，请关闭占用端口的程序后重试。`);
}

function appendBackendLog(data, isError = false) {
  const text = String(data);
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    backendLog.push(line);
    if (backendLog.length > 80) backendLog.shift();
  }
  if (logPath) fs.appendFileSync(logPath, text, "utf8");
  if (isError) console.error(`[ComfyUI] ${text.trimEnd()}`);
  else console.log(`[ComfyUI] ${text.trimEnd()}`);
}

function updateStatus(status) {
  currentStatus = { ...currentStatus, ...status };
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("desktop-status", currentStatus);
  }
}

function backendFailure() {
  const exit = backendExit ? `退出码：${backendExit.code ?? "未知"}，信号：${backendExit.signal ?? "无"}` : "进程未能保持运行";
  const output = backendLog.slice(-14).join("\n");
  return `${exit}\n\n${output || "没有收到 ComfyUI 日志输出。"}`;
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backendExit) throw new Error(backendFailure());
    try {
      if (await request(port, "/system_stats")) return true;
    } catch (_) {
      // The service may still be importing its model and dependencies.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

function appendPythonPath(environment) {
  const shim = path.join(ROOT, "desktop_runtime");
  environment.PYTHONPATH = [shim, environment.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return environment;
}

function packagedDirectories() {
  if (!isPackaged) return [];
  const root = path.join(app.getPath("userData"), "workspace");
  const directories = {
    models: path.join(root, "models"),
    input: path.join(root, "input"),
    output: path.join(root, "output"),
    temp: path.join(root, "temp"),
    user: path.join(root, "user")
  };
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
  return [
    "--models-directory", directories.models,
    "--input-directory", directories.input,
    "--output-directory", directories.output,
    "--temp-directory", directories.temp,
    "--user-directory", directories.user
  ];
}

function startBackend(python) {
  const command = [
    path.join(ROOT, "main.py"),
    "--listen",
    "127.0.0.1",
    "--port",
    String(port),
    "--dont-print-server",
    "--enable-cors-header",
    "*",
    ...packagedDirectories()
  ];
  const packagedFrontend = path.join(ROOT, "frontend");
  if (isPackaged && fs.existsSync(path.join(packagedFrontend, "index.html"))) {
    command.push("--front-end-root", packagedFrontend);
  }
  logPath = path.join(app.getPath("userData"), "logs", "backend.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `ComfyUI desktop start ${new Date().toISOString()}\nPython: ${python}\nPort: ${port}\n`, "utf8");
  backendExit = null;
  backend = spawn(python, command, {
    cwd: ROOT,
    env: appendPythonPath({ ...process.env }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  ownsBackend = true;
  backend.stdout.on("data", data => appendBackendLog(data));
  backend.stderr.on("data", data => appendBackendLog(data, true));
  backend.once("error", error => {
    backendExit = { error: error.message };
    appendBackendLog(`process error: ${error.message}\n`, true);
  });
  backend.once("exit", (code, signal) => {
    backendExit = { code, signal };
    backend = null;
    if (!shuttingDown && !booting && mainWindow && !mainWindow.isDestroyed()) {
      updateStatus({
        state: "error",
        title: "ComfyUI 服务已停止",
        message: backendFailure(),
        detail: logPath ? `日志文件：${logPath}` : "未生成启动日志。"
      });
      mainWindow.loadFile(path.join(__dirname, "loading.html"));
    }
  });
}

async function ensureBackend() {
  trace("ensureBackend start");
  port = await selectPort();
  trace(`ensureBackend selected port=${port}`);
  updateStatus({ title: "正在检查本地服务", message: `准备使用本机端口 ${port}`, detail: "正在检测现有 ComfyUI 服务和端口占用情况。" });
  if (await waitForBackend(1000)) return;
  const python = findPython();
  trace(`ensureBackend python=${python || "none"}`);
  if (!python) {
    throw new Error("未找到 Python 3.10 或更高版本。请安装 Python 3.10+，或设置 COMFY_DESKTOP_PYTHON。\n\n桌面应用需要 Python 运行 ComfyUI 推理核心。它不会另开启动器窗口。");
  }
  console.log(`Using Python: ${python}`);
  updateStatus({ title: "正在启动 ComfyUI 服务", message: `Python：${python}`, detail: `端口 ${port} · 正在加载推理环境、节点和模型目录。` });
  startBackend(python);
  await waitForBackend(10 * 60 * 1000);
}

function createWindow() {
  trace("createWindow");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: "#0f172a",
    title: "ComfyUI 本地创作工作台",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://127.0.0.1:")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-finish-load", () => mainWindow.webContents.send("desktop-status", currentStatus));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadFile(path.join(ROOT, "web", "product", "index.html"));
}

function registerWindowControls() {
  ipcMain.on("window:minimize", event => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on("window:maximize", event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  ipcMain.on("window:close", event => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.on("app:retry", () => {
    if (!booting && mainWindow && !mainWindow.isDestroyed()) boot();
  });
  ipcMain.handle("app:api-base", () => "http://127.0.0.1:" + port);
  ipcMain.on("app:open-log", () => {
    if (logPath) shell.openPath(logPath);
  });
  ipcMain.on("app:quit", () => app.quit());
}

async function boot() {
  if (booting || shuttingDown) return;
  booting = true;
  trace("boot start");
  backendExit = null;
  backendLog = [];
  try {
    port = await selectPort();
    trace("boot selected port=" + port);
    if (!mainWindow) createWindow();
    updateStatus({ state: "loading", title: "正在启动 ComfyUI", message: "正在准备本地推理环境…", detail: "工作台已打开，服务正在后台初始化。" });
    await ensureBackend();
    trace("boot backend ready");
    updateStatus({ state: "ready", title: "工作台已就绪", message: "本地 ComfyUI 服务已启动", detail: `服务地址：http://127.0.0.1:${port}` });
  } catch (error) {
    trace(`boot failed ${error.stack || error.message}`);
    updateStatus({ state: "error", title: "ComfyUI 服务启动失败", message: error.message, detail: logPath ? `日志文件：${logPath}` : "未生成启动日志。" });
  } finally {
    booting = false;
  }
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    trace("app ready");
    registerWindowControls();
    boot();
  });
}

app.on("before-quit", event => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (ownsBackend && backend && !backend.killed) {
    event.preventDefault();
    backend.once("exit", () => app.quit());
    backend.kill();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
