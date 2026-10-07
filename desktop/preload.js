const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  version: process.env.npm_package_version || "0.1.0",
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
  retry: () => ipcRenderer.send("app:retry"),
  openLog: () => ipcRenderer.send("app:open-log"),
  quit: () => ipcRenderer.send("app:quit"),
  getApiBase: () => ipcRenderer.invoke("app:api-base"),
  onStatus: callback => ipcRenderer.on("desktop-status", (_event, status) => callback(status))
});
