/// <reference types="vite/client" />

export type StoreKey =
  | "settings"
  | "styleProfile"
  | "writingSamples"
  | "savedCitations"
  | "autoTyperLogs"
  | "rubricReports"
  | "revisionHistory";

declare global {
  interface Window {
    overlayAPI: {
      getInitialData: () => Promise<any>;
      setAlwaysOnTop: (enabled: boolean) => Promise<any>;
      setCollapsed: (collapsed: boolean) => Promise<any>;
      setMousePassthrough: (ignored: boolean) => Promise<any>;
      toggleMousePassthrough: () => Promise<any>;
      windowAction: (action: "minimize" | "close") => Promise<any>;
      getTargetApp: () => Promise<any>;
      captureSelectedText: () => Promise<any>;
      insertText: (text: string) => Promise<any>;
      selectFiles?: (options: { accept: string; multiple?: boolean }) => Promise<any>;
      parseFiles: (paths: string[]) => Promise<any[]>;
      filePathForFile?: (file: File) => string;
      saveSlice: (key: StoreKey, value: unknown) => Promise<any>;
      appendSliceItem: (key: StoreKey, item: unknown) => Promise<any>;
      clearSlice: (key: StoreKey) => Promise<any>;
      autoTyperStart: (request: any) => Promise<any>;
      autoTyperGetStatus: () => Promise<any>;
      autoTyperPause: () => Promise<any>;
      autoTyperResume: () => Promise<any>;
      autoTyperStop: () => Promise<any>;
      autoTyperSkip: () => Promise<any>;
      onAutoTyperEvent: (callback: (payload: any) => void) => () => void;
      onTargetUpdated: (callback: (payload: any) => void) => () => void;
      citationsSearch: (request: any) => Promise<any>;
      exportReport: (request: { title: string; content: string; format: string }) => Promise<any>;
      openExternal: (url: string) => Promise<any>;
    };
  }
}
