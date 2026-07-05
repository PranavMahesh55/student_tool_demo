import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if (!window.overlayAPI) {
  const noop = () => undefined;
  window.overlayAPI = {
    getInitialData: async () => ({ data: {}, targetApp: "Browser Preview", platform: "browser", autoTyperStatus: null }),
    setAlwaysOnTop: async () => ({ ok: true }),
    setCollapsed: async () => ({ ok: true }),
    setMousePassthrough: async () => ({ ok: true }),
    toggleMousePassthrough: async () => ({ ok: true }),
    windowAction: async () => ({ ok: true }),
    getTargetApp: async () => ({ targetApp: "Browser Preview", frontApp: "Browser Preview" }),
    captureSelectedText: async () => ({ ok: false, text: "", error: "Selection capture is available in the desktop app." }),
    insertText: async () => ({ ok: false, error: "Insertion is available in the desktop app." }),
    parseFiles: async () => [],
    filePathForFile: () => "",
    saveSlice: async (_key, value) => ({ ok: true, data: value }),
    appendSliceItem: async () => ({ ok: true, data: {} }),
    clearSlice: async () => ({ ok: true, data: {} }),
    autoTyperStart: async () => ({ ok: false, error: "Auto typing is available in the desktop app." }),
    autoTyperGetStatus: async () => ({ active: false }),
    autoTyperPause: async () => ({ ok: true }),
    autoTyperResume: async () => ({ ok: true }),
    autoTyperStop: async () => ({ ok: true }),
    autoTyperSkip: async () => ({ ok: true }),
    onAutoTyperEvent: () => noop,
    onTargetUpdated: () => noop,
    citationsSearch: async () => ({ ok: true, claims: [], notes: [] }),
    exportReport: async () => ({ ok: false }),
    openExternal: async () => ({ ok: true }),
  };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
