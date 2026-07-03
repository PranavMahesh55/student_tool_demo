const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getInitialData: () => ipcRenderer.invoke("app:getInitialData"),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("overlay:setAlwaysOnTop", enabled),
  setCollapsed: (collapsed) => ipcRenderer.invoke("overlay:setCollapsed", collapsed),
  setMousePassthrough: (ignored) => ipcRenderer.invoke("overlay:setMousePassthrough", ignored),
  toggleMousePassthrough: () => ipcRenderer.invoke("overlay:toggleMousePassthrough"),
  windowAction: (action) => ipcRenderer.invoke("overlay:windowAction", action),
  getTargetApp: () => ipcRenderer.invoke("target:get"),
  captureSelectedText: () => ipcRenderer.invoke("target:captureSelectedText"),
  insertText: (text) => ipcRenderer.invoke("target:insertText", text),
  parseFiles: (paths) => ipcRenderer.invoke("documents:parseFiles", paths),
  saveSlice: (key, value) => ipcRenderer.invoke("data:set", key, value),
  appendSliceItem: (key, item) => ipcRenderer.invoke("data:append", key, item),
  clearSlice: (key) => ipcRenderer.invoke("data:clear", key),
  autoTyperStart: (request) => ipcRenderer.invoke("autoTyper:start", request),
  autoTyperGetStatus: () => ipcRenderer.invoke("autoTyper:getStatus"),
  autoTyperPause: () => ipcRenderer.invoke("autoTyper:pause"),
  autoTyperResume: () => ipcRenderer.invoke("autoTyper:resume"),
  autoTyperStop: () => ipcRenderer.invoke("autoTyper:stop"),
  autoTyperSkip: () => ipcRenderer.invoke("autoTyper:skip"),
  onAutoTyperEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("autoTyper:event", handler);
    return () => ipcRenderer.removeListener("autoTyper:event", handler);
  },
  onTargetUpdated: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("target:updated", handler);
    return () => ipcRenderer.removeListener("target:updated", handler);
  },
  citationsSearch: (request) => ipcRenderer.invoke("citations:search", request),
  exportReport: (request) => ipcRenderer.invoke("export:report", request),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
};

contextBridge.exposeInMainWorld("overlayAPI", api);
