import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlertTriangle,
  BookOpen,
  Bold,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  FileCheck2,
  FileDown,
  FileText,
  Italic,
  Keyboard,
  List,
  ListOrdered,
  Maximize2,
  Minus,
  Minimize2,
  Pause,
  PenLine,
  Play,
  Plus,
  RefreshCcw,
  Search,
  ShieldAlert,
  SkipForward,
  Square,
  Target,
  Timer,
  Underline,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildCitationOutput, formatBibliography, sourcePreview } from "./lib/citationFormat";
import { evaluateRubric } from "./lib/rubricTools";
import { analyzeStyleProfile, checkConsistency, rewriteWithStyle } from "./lib/styleTools";
import {
  countVisibleUnits,
  countWords,
  createChunks,
  estimateDurationSeconds,
  formatDuration,
  makeId,
  textFromFiles,
} from "./lib/textTools";
import type { CitationStyle, ClaimResult, RewriteResult, RubricReport, SourceRecord, StyleProfile, TypingMode } from "./types";

const sourcePreferences = [
  "Scholarly sources",
  "News sources",
  "Government sources",
  "Books",
  "Web sources",
  "User-uploaded sources only",
];

type AcceptText = (text: string, html?: string, rtf?: string) => void;

const defaultStore = {
  settings: {
    alwaysOnTop: true,
    preserveClipboard: true,
    emergencyHotkey: "CommandOrControl+Shift+Escape",
    clickThroughHotkey: "CommandOrControl+Shift+M",
    localOnlyMode: true,
    cloudAiEnabled: false,
  },
  styleProfile: null as StyleProfile | null,
  writingSamples: [] as unknown[],
  savedCitations: [] as SourceRecord[],
  autoTyperLogs: [] as any[],
  rubricReports: [] as RubricReport[],
  revisionHistory: [] as any[],
};

type Store = typeof defaultStore;
type TabKey = "auto" | "citations" | "style" | "rubric";

function App() {
  const [store, setStore] = useState<Store>(defaultStore);
  const [activeTab, setActiveTab] = useState<TabKey>("auto");
  const [collapsed, setCollapsed] = useState(false);
  const [targetApp, setTargetApp] = useState<string | null>(null);
  const [platform, setPlatform] = useState("");
  const [toast, setToast] = useState("");
  const [autoEvent, setAutoEvent] = useState<any>(null);
  const [expandedView, setExpandedView] = useState(false);
  const activeExpandedView = activeTab === "auto" && expandedView;
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const [overlayPosition, setOverlayPosition] = useState({ x: 360, y: 28 });
  const lastMouseInteractive = useRef<boolean | null>(null);
  const lastMouseUpdateAt = useRef(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    dragging: boolean;
    moved: boolean;
  } | null>(null);
  const suppressNextClick = useRef(false);

  useEffect(() => {
    window.overlayAPI.getInitialData().then((result) => {
      setStore({ ...defaultStore, ...result.data });
      setTargetApp(result.targetApp);
      setPlatform(result.platform);
      setAutoEvent(result.autoTyperStatus?.active ? result.autoTyperStatus.event : null);
    });

    const removeAutoTyperListener = window.overlayAPI.onAutoTyperEvent((payload) => {
      setAutoEvent(payload);
      if (payload?.targetApp) setTargetApp(payload.targetApp);
      if (payload?.log?.targetApplicationName) setTargetApp(payload.log.targetApplicationName);
      if (payload?.log) {
        setStore((current) => ({
          ...current,
          autoTyperLogs: [payload.log, ...current.autoTyperLogs.filter((log) => log.id !== payload.log.id)].slice(0, 100),
        }));
      }
    });

    const removeTargetListener = window.overlayAPI.onTargetUpdated((payload) => {
      if (payload?.targetApp) setTargetApp(payload.targetApp);
    });

    return () => {
      removeAutoTyperListener();
      removeTargetListener();
    };
  }, []);

  useEffect(() => {
    const isTiming = ["queued", "countdown", "progress", "resumed"].includes(autoEvent?.type);
    if (!isTiming) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [autoEvent?.type]);

  useEffect(() => {
    if (["queued", "countdown", "progress", "resumed"].includes(autoEvent?.type)) {
      setPanelCollapsed(true);
    }
  }, [autoEvent?.type]);

  useEffect(() => {
    const interactiveSelector = [
      ".command-bar",
      ".mini-orb",
      "button",
      "input",
      "select",
      "textarea",
      "[contenteditable='true']",
      "label",
      ".tab-strip",
      ".auto-text-card",
      ".rich-text-editor",
      ".format-toolbar",
      ".auto-controls-card",
      ".claims-card",
      ".sources-card",
      ".sample-drop-card",
      ".samples-card",
      ".mini-editor-card",
      ".humanizer-bottom-controls",
      ".expanded-sidebar",
      ".page-rail",
      ".minimal-popover",
      ".status-bar",
      ".tool-panel",
    ].join(", ");

    function updateMousePassthrough(event: PointerEvent | MouseEvent) {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const isInteractive = Boolean(element?.closest(interactiveSelector));
      const now = Date.now();
      if (lastMouseInteractive.current === isInteractive && now - lastMouseUpdateAt.current < 240) return;
      lastMouseInteractive.current = isInteractive;
      lastMouseUpdateAt.current = now;
      window.overlayAPI.setMousePassthrough(!isInteractive);
    }

    function passThroughOnLeave() {
      lastMouseInteractive.current = false;
      window.overlayAPI.setMousePassthrough(true);
    }

    window.addEventListener("pointermove", updateMousePassthrough);
    window.addEventListener("mousemove", updateMousePassthrough);
    window.addEventListener("mouseleave", passThroughOnLeave);
    const initialTimer = window.setTimeout(() => window.overlayAPI.setMousePassthrough(true), 250);

    return () => {
      window.clearTimeout(initialTimer);
      window.removeEventListener("pointermove", updateMousePassthrough);
      window.removeEventListener("mousemove", updateMousePassthrough);
      window.removeEventListener("mouseleave", passThroughOnLeave);
      window.overlayAPI.setMousePassthrough(false);
    };
  }, []);

  useEffect(() => {
    function placeInitialOverlay() {
      setOverlayPosition((current) => boundedOverlayPosition(current.x, current.y));
    }

    placeInitialOverlay();
    window.addEventListener("resize", placeInitialOverlay);
    return () => window.removeEventListener("resize", placeInitialOverlay);
  }, [activeExpandedView, collapsed, panelCollapsed]);

  async function saveSlice<K extends keyof Store>(key: K, value: Store[K]) {
    setStore((current) => ({ ...current, [key]: value }));
    const response = await window.overlayAPI.saveSlice(key as any, value);
    if (response?.data) setStore({ ...defaultStore, ...response.data });
  }

  async function appendSliceItem<K extends keyof Store>(key: K, item: unknown) {
    const response = await window.overlayAPI.appendSliceItem(key as any, item);
    if (response?.data) setStore({ ...defaultStore, ...response.data });
  }

  async function refreshTarget() {
    const result = await window.overlayAPI.getTargetApp();
    setTargetApp(result.targetApp || result.frontApp || null);
    setToast(result.targetApp ? `Target app: ${result.targetApp}` : "No target app detected yet.");
  }

  async function captureSelected(acceptText: AcceptText) {
    const result = await window.overlayAPI.captureSelectedText();
    if (result.ok && result.text) {
      acceptText(result.text, result.html, result.rtf);
      setTargetApp(result.targetApp || targetApp);
      setToast(`Captured selected text from ${result.targetApp || "target app"}.`);
    } else {
      setToast(result.error || "Could not capture selected text. Try selecting text in the target app first.");
    }
  }

  async function parseFiles(files: FileList | File[] | string[], acceptText: AcceptText) {
    const fileArray = Array.from(files as ArrayLike<File | string>);
    const paths = textFromFiles(fileArray).filter(Boolean);
    const contents: Array<{ text: string; html?: string }> = [];
    const messages: string[] = [];

    if (paths.length) {
      const parsed = await window.overlayAPI.parseFiles(paths);
      contents.push(...parsed.map((file) => ({ text: file.text || "", html: file.html || "" })).filter((file) => file.text));
      messages.push(...parsed.filter((file) => file.error).map((file) => `${file.name}: ${file.error}`));
    } else {
      for (const file of fileArray) {
        if (typeof file === "string") continue;
        if (/\.(txt|md|markdown|csv|tsv|ya?ml|json|jsonc|html?|xml|css|scss|sass|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|sql|r|R|m|mm|scala|clj|hs|lua|pl|pm|tex|bib|toml|ini|env|gitignore|dockerfile)$/i.test(file.name)) {
          const text = await file.text();
          contents.push({ text, html: /\.html?$/i.test(file.name) ? text : "" });
        } else {
          messages.push(`${file.name}: this file needs the Electron file parser.`);
        }
      }
    }

    if (contents.length) {
      const text = contents.map((item) => item.text).join("\n\n");
      const html = contents
        .map((item) => (item.html ? sanitizePastedHtml(item.html, item.text) : textToEditorHtml(item.text)))
        .join("<div><br></div>");
      acceptText(text, html);
    }
    setToast(messages.length ? messages.join(" ") : `Imported ${contents.length || fileArray.length} file(s).`);
  }

  async function toggleAlwaysOnTop(enabled: boolean) {
    await saveSlice("settings", { ...store.settings, alwaysOnTop: enabled });
    await window.overlayAPI.setAlwaysOnTop(enabled);
  }

  function toggleCollapsed() {
    setCollapsed((current) => !current);
  }

  function boundedOverlayPosition(x: number, y: number) {
    const overlayElement = overlayRef.current;
    const overlayRect = overlayElement?.getBoundingClientRect();
    const fallbackWidth = Math.min(activeExpandedView ? 1080 : 980, window.innerWidth - 46);
    const width = collapsed ? 76 : overlayRect?.width || fallbackWidth;
    const headerHeight = collapsed ? 76 : 74;
    const visibleHandle = collapsed ? 36 : 48;
    const minX = -width + visibleHandle;
    const maxX = window.innerWidth - visibleHandle;
    const minY = -headerHeight + visibleHandle;
    const maxY = window.innerHeight - visibleHandle;
    return {
      x: Math.min(Math.max(minX, x), maxX),
      y: Math.min(Math.max(minY, y), maxY),
    };
  }

  function startOverlayDrag(event: React.PointerEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (!target.closest(".mini-orb") && target.closest("button, input, select, textarea, label, [contenteditable='true'], .no-drag")) return;
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: overlayPosition.x,
      originY: overlayPosition.y,
      dragging: true,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveOverlay(event: React.PointerEvent<HTMLElement>) {
    const drag = dragState.current;
    if (!drag?.dragging) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag.moved = true;
    }
    setOverlayPosition(
      boundedOverlayPosition(drag.originX + dx, drag.originY + dy),
    );
  }

  function stopOverlayDrag(event: React.PointerEvent<HTMLElement>) {
    const moved = Boolean(dragState.current?.moved);
    if (dragState.current?.dragging) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragState.current = null;
    if (moved) {
      suppressNextClick.current = true;
      window.setTimeout(() => {
        suppressNextClick.current = false;
      }, 0);
    }
  }

  function toggleCollapsedFromSymbol() {
    if (suppressNextClick.current) return;
    toggleCollapsed();
  }

  function runTopCommand() {
    window.dispatchEvent(new CustomEvent("overlay:top-action", { detail: { tab: activeTab } }));
  }

  const autoPaused = autoEvent?.type === "paused";
  const autoActive = ["queued", "countdown", "progress", "paused", "resumed", "stopping"].includes(autoEvent?.type);
  const autoRemainingMs = getVisibleRemainingMs(autoEvent, clockNow);
  const autoEta = autoRemainingMs === null ? "" : `${formatRemainingTime(autoRemainingMs)} left`;
  const activeName =
    activeTab === "auto" ? "Auto Type" : activeTab === "citations" ? "Citations" : activeTab === "style" ? "Humanizer" : "Rubric";
  const activeIcon =
    activeTab === "auto" ? <Keyboard size={22} /> : activeTab === "citations" ? <BookOpen size={22} /> : activeTab === "style" ? <Wand2 size={22} /> : <FileCheck2 size={22} />;
  const activeStatus =
    activeTab === "auto"
      ? autoActive
        ? `Chunk ${autoEvent?.log?.chunksCompleted || autoEvent?.completed || 0}/${autoEvent?.log?.chunkCount || autoEvent?.total || 0}${
            autoEta ? ` | ${autoPaused ? "Paused" : autoEta}` : ""
          }`
        : autoEvent?.type === "completed"
          ? "Done"
          : autoEvent?.type === "error"
            ? "Needs attention"
            : "Ready"
      : activeTab === "citations"
        ? "Claims ready"
        : activeTab === "style"
          ? store.styleProfile
            ? "Style ready"
            : "No profile"
          : "Review ready";
  if (collapsed) {
    return (
      <main className="app-shell symbol-shell">
        <button
          className="mini-orb"
          style={{ left: overlayPosition.x, top: overlayPosition.y }}
          onPointerDown={startOverlayDrag}
          onPointerMove={moveOverlay}
          onPointerUp={stopOverlayDrag}
          onPointerCancel={stopOverlayDrag}
          onClick={toggleCollapsedFromSymbol}
          title="Open Universal Writing Overlay"
        >
          <PenLine size={28} />
        </button>
      </main>
    );
  }

  return (
    <main className={`app-shell ${activeExpandedView ? "is-expanded" : "is-compact"} ${panelCollapsed ? "panel-collapsed" : ""}`}>
      <div
        ref={overlayRef}
        className="overlay-stack"
        style={{ left: overlayPosition.x, top: overlayPosition.y }}
      >
        <header
          className="command-bar"
          onPointerDown={startOverlayDrag}
          onPointerMove={moveOverlay}
          onPointerUp={stopOverlayDrag}
          onPointerCancel={stopOverlayDrag}
        >
          <div className="brand-mark">
            <PenLine size={24} />
          </div>

          <div className="command-select no-drag">
            {activeIcon}
            <select value={activeTab} onChange={(event) => setActiveTab(event.target.value as TabKey)} aria-label="Choose tool">
              <option value="auto">Auto Type</option>
              <option value="citations">Citations</option>
              <option value="style">Humanizer</option>
              <option value="rubric">Rubric</option>
            </select>
          </div>

          <button className="command-chip no-drag" onClick={refreshTarget} title="Refresh target application">
            {activeTab === "auto" && autoActive ? (
              <Timer size={16} />
            ) : (
              <span className={activeTab === "style" && !store.styleProfile ? "status-dot muted-dot" : "status-dot"} />
            )}
            <span>{activeStatus}</span>
          </button>

          {activeTab === "auto" ? (
            <div className="transport-group no-drag">
              {!autoActive && (
                <button className="primary-command auto-start-command" title="Start auto typing" onClick={runTopCommand}>
                  <Play size={18} />
                  <span>Start</span>
                </button>
              )}
              {autoActive && (
                <>
                  <button
                    className={`round-action blue ${autoPaused ? "resume-state" : ""}`}
                    onClick={() => (autoPaused ? window.overlayAPI.autoTyperResume() : window.overlayAPI.autoTyperPause())}
                    title={autoPaused ? "Resume typing" : "Pause typing"}
                  >
                    {autoPaused ? <Play size={18} /> : <Pause size={18} />}
                  </button>
                  <button className="round-action stop" onClick={() => window.overlayAPI.autoTyperStop()} title="Stop typing">
                    <Square size={15} />
                  </button>
                </>
              )}
            </div>
          ) : (
            <button className="primary-command no-drag" title={`${activeName} action`} onClick={runTopCommand}>
              {activeTab === "citations" ? <Search size={18} /> : activeTab === "style" ? <RefreshCcw size={18} /> : <ShieldAlert size={18} />}
              <span>{activeTab === "citations" ? "Find Sources" : activeTab === "style" ? "Rewrite" : "Check Draft"}</span>
            </button>
          )}

          <div className="command-window-buttons no-drag">
            <button className="icon-button command-chevron" onClick={() => setPanelCollapsed((current) => !current)} title="Hide or show lower panel">
              {panelCollapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
            <button className="icon-button" onClick={() => window.overlayAPI.windowAction("minimize")} title="Minimize">
              <Minus size={17} />
            </button>
            <button className="icon-button" onClick={toggleCollapsed} title="Close preview">
              <X size={17} />
            </button>
          </div>
        </header>

        {!panelCollapsed && <section className="glass-panel">
          <nav className="tab-strip no-drag" aria-label="Main tools">
            <TabButton active={activeTab === "auto"} onClick={() => setActiveTab("auto")} icon={<Keyboard size={20} />} label="Auto Type" />
            <TabButton
              active={activeTab === "citations"}
              onClick={() => setActiveTab("citations")}
              icon={<BookOpen size={20} />}
              label="Citations"
            />
            <TabButton active={activeTab === "style"} onClick={() => setActiveTab("style")} icon={<Wand2 size={20} />} label="Humanizer" />
            <TabButton
              active={activeTab === "rubric"}
              onClick={() => setActiveTab("rubric")}
              icon={<FileCheck2 size={20} />}
              label="Rubric"
            />
          </nav>

          <section className="workspace">
        {activeTab === "auto" && (
          <AutoTyperTab
            targetApp={targetApp}
            settings={store.settings}
            autoEvent={autoEvent}
            parseFiles={parseFiles}
            captureSelected={captureSelected}
            expanded={expandedView}
            onToggleExpanded={() => setExpandedView((current) => !current)}
            onStarted={() => setPanelCollapsed(true)}
          />
        )}
        {activeTab === "citations" && (
          <CitationsTab
            captureSelected={captureSelected}
            parseFiles={parseFiles}
            appendSliceItem={appendSliceItem}
            expanded={false}
          />
        )}
        {activeTab === "style" && (
          <StyleTab
            profile={store.styleProfile}
            parseFiles={parseFiles}
            captureSelected={captureSelected}
            saveProfile={(profile) => saveSlice("styleProfile", profile)}
            saveSamples={(samples) => saveSlice("writingSamples", samples as any)}
            clearProfile={() => saveSlice("styleProfile", null)}
            clearSamples={() => saveSlice("writingSamples", [] as any)}
            appendRevision={(item) => appendSliceItem("revisionHistory", item)}
            expanded={false}
          />
        )}
        {activeTab === "rubric" && (
          <RubricTab
            parseFiles={parseFiles}
            captureSelected={captureSelected}
            appendReport={(report) => appendSliceItem("rubricReports", report)}
            expanded={false}
          />
        )}
          </section>

          <footer className="status-bar">
            <span>
              <span className="status-dot" /> Local
            </span>
            <span>{toast || `${platform === "darwin" ? "macOS overlay" : "desktop overlay"} | ${targetApp || "No target app yet"}`}</span>
            <span>{autoEvent ? `Auto typer: ${autoEvent.type}` : store.settings.emergencyHotkey}</span>
          </footer>
        </section>}
      </div>
    </main>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`tab-button ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="field-label">{children}</label>;
}

function FileButton({
  label,
  accept,
  multiple = true,
  onFiles,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  onFiles: (files: FileList | string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function chooseFiles() {
    if (window.overlayAPI.selectFiles) {
      const result = await window.overlayAPI.selectFiles({ accept, multiple });
      if (result?.ok && result.paths?.length) onFiles(result.paths);
      return;
    }
    inputRef.current?.click();
  }

  return (
    <button className="tool-button" type="button" onClick={chooseFiles}>
      <Upload size={16} />
      <span>{label}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(event) => {
          if (event.currentTarget.files?.length) onFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </button>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

type FormatCommand = "bold" | "italic" | "underline" | "justifyLeft" | "justifyCenter" | "justifyRight" | "insertUnorderedList" | "insertOrderedList";

type InlineFormat = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
};

type RichClipboardSource = {
  html: string;
  rtf: string;
};

type FormatState = Record<FormatCommand, boolean>;

const defaultFormatState: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  justifyLeft: false,
  justifyCenter: false,
  justifyRight: false,
  insertUnorderedList: false,
  insertOrderedList: false,
};

const defaultInlineFormat: InlineFormat = {
  bold: false,
  italic: false,
  underline: false,
};

function formatFromElement(element: HTMLElement, inherited: InlineFormat): InlineFormat {
  const style = element.style;
  const weight = style.fontWeight;
  const hasNumericWeight = weight.trim().length > 0 && Number.isFinite(Number(weight));
  const numericWeight = hasNumericWeight ? Number(weight) : 0;
  const tagName = element.tagName;
  const hasNormalWeight = weight === "normal" || weight === "lighter" || weight === "400" || (hasNumericWeight && numericWeight < 600);
  const hasBoldWeight = weight === "bold" || weight === "bolder" || (hasNumericWeight && numericWeight >= 600);
  const textDecoration = `${style.textDecorationLine} ${style.textDecoration}`;
  const hasNoUnderline = /\bnone\b/.test(textDecoration);
  const hasUnderline = textDecoration.includes("underline");
  return {
    bold: hasNormalWeight ? false : inherited.bold || tagName === "B" || tagName === "STRONG" || hasBoldWeight,
    italic: style.fontStyle === "normal" ? false : inherited.italic || tagName === "I" || tagName === "EM" || style.fontStyle === "italic" || style.fontStyle === "oblique",
    underline: hasNoUnderline ? false : inherited.underline || tagName === "U" || hasUnderline,
  };
}

function wrapInlineFormat(html: string, format: InlineFormat): string {
  let next = html;
  if (format.underline) next = `<u>${next}</u>`;
  if (format.italic) next = `<em>${next}</em>`;
  if (format.bold) next = `<strong>${next}</strong>`;
  return next;
}

function blockAlignValue(style: CSSStyleDeclaration): string | null {
  return ["center", "right", "justify"].includes(style.textAlign) ? style.textAlign : null;
}

function blockAlignAttribute(align: string | null): string {
  return align ? ` style="text-align: ${align};"` : "";
}

function cssLengthToPx(value: string): number {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)(px|pt|em|rem|in|cm|mm)?$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = (match[2] || "px").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (unit === "pt") return amount * (96 / 72);
  if (unit === "em" || unit === "rem") return amount * 16;
  if (unit === "in") return amount * 96;
  if (unit === "cm") return amount * (96 / 2.54);
  if (unit === "mm") return amount * (96 / 25.4);
  return amount;
}

function firstAvailableCssLength(style: CSSStyleDeclaration, names: Array<keyof CSSStyleDeclaration>): number {
  for (const name of names) {
    const value = style[name];
    if (typeof value !== "string") continue;
    const px = cssLengthToPx(value);
    if (px > 0) return px;
  }
  return 0;
}

function editorTabHtml(count = 1): string {
  return Array.from({ length: Math.max(1, count) })
    .map(() => '<span class="editor-tab" data-tab="true">&nbsp;&nbsp;&nbsp;&nbsp;</span>')
    .join("");
}

function blockIndentHtml(style: CSSStyleDeclaration): string {
  const indentPx = firstAvailableCssLength(style, ["textIndent", "marginLeft", "paddingLeft"]);
  if (indentPx < 10) return "";
  return editorTabHtml(Math.min(8, Math.max(1, Math.round(indentPx / 48))));
}

function blockNeedsBlankLine(element: HTMLElement): boolean {
  if (element.tagName === "P") return true;
  const style = element.style;
  const spacingPx = Math.max(
    firstAvailableCssLength(style, ["marginBottom", "paddingBottom"]),
    firstAvailableCssLength(style, ["marginTop", "paddingTop"]),
  );
  return spacingPx >= 8;
}

function escapeEditorText(value: string): string {
  return escapeHtml(value)
    .replace(/\t/g, editorTabHtml())
    .replace(/ {2,}/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>");
}

function normalizePastedStructure(html: string): string {
  return html
    .replace(/(?:<div><br><\/div>){3,}/g, "<div><br></div><div><br></div>")
    .replace(/(?:<div><br><\/div>)+$/g, "");
}

function pasteStructureScore(html: string): number {
  return (html.match(/class="editor-tab"/g) || []).length * 2 + (html.match(/<div><br><\/div>/g) || []).length;
}

function sanitizePastedHtml(html: string, fallbackText: string): string {
  if (!html) return textToEditorHtml(fallbackText);
  const documentValue = new DOMParser().parseFromString(html, "text/html");
  const blockTags = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);
  const inlineTags = new Set(["B", "STRONG", "I", "EM", "U", "SPAN", "FONT"]);
  const listTags = new Set(["UL", "OL"]);

  function sanitizeNode(node: Node, inheritedFormat: InlineFormat): string {
    if (node.nodeType === Node.TEXT_NODE) return wrapInlineFormat(escapeEditorText(node.textContent || ""), inheritedFormat);
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node as HTMLElement;
    const tagName = element.tagName;
    if (tagName === "SCRIPT" || tagName === "STYLE" || tagName === "META" || tagName === "LINK" || tagName === "IMG") return "";
    if (tagName === "BR") return "<br>";

    if (listTags.has(tagName)) {
      const children = Array.from(element.childNodes).map((child) => sanitizeNode(child, defaultInlineFormat)).join("");
      return `<${tagName.toLowerCase()}>${children}</${tagName.toLowerCase()}>`;
    }

    if (tagName === "LI") {
      const itemFormat = formatFromElement(element, inheritedFormat);
      const children = Array.from(element.childNodes)
        .map((child) => sanitizeNode(child, child.nodeType === Node.ELEMENT_NODE && blockTags.has((child as HTMLElement).tagName) ? defaultInlineFormat : itemFormat))
        .join("");
      return `<li>${children || "<br>"}</li>`;
    }

    if (blockTags.has(tagName)) {
      const blockFormat = formatFromElement(element, inheritedFormat);
      const align = blockAlignValue(element.style);
      const indent = blockIndentHtml(element.style);
      const blankAfter = blockNeedsBlankLine(element) ? "<div><br></div>" : "";
      const childNodes = Array.from(element.childNodes);
      const hasChildBlocks = childNodes.some(
        (child) => child.nodeType === Node.ELEMENT_NODE && (blockTags.has((child as HTMLElement).tagName) || listTags.has((child as HTMLElement).tagName)),
      );

      if (hasChildBlocks) {
        const pieces: string[] = [];
        for (const child of childNodes) {
          const childIsBlock =
            child.nodeType === Node.ELEMENT_NODE && (blockTags.has((child as HTMLElement).tagName) || listTags.has((child as HTMLElement).tagName));
          if (childIsBlock) {
            pieces.push(sanitizeNode(child, defaultInlineFormat));
            continue;
          }

          const inlinePiece = sanitizeNode(child, blockFormat);
          if (inlinePiece.trim()) pieces.push(`<div${blockAlignAttribute(align)}>${indent}${inlinePiece}</div>${blankAfter}`);
        }
        return pieces.join("");
      }

      const children = childNodes.map((child) => sanitizeNode(child, blockFormat)).join("");
      return `<div${blockAlignAttribute(align)}>${indent}${children || "<br>"}</div>${blankAfter}`;
    }

    if (inlineTags.has(tagName)) {
      const inlineFormat = formatFromElement(element, inheritedFormat);
      return Array.from(element.childNodes).map((child) => sanitizeNode(child, inlineFormat)).join("");
    }

    return Array.from(element.childNodes).map((child) => sanitizeNode(child, inheritedFormat)).join("");
  }

  const sanitized = normalizePastedStructure(Array.from(documentValue.body.childNodes).map((node) => sanitizeNode(node, defaultInlineFormat)).join(""));
  const fallbackHtml = textToEditorHtml(fallbackText);
  if (pasteStructureScore(fallbackHtml) > pasteStructureScore(sanitized) && !hasRichFormatting(sanitized)) {
    return fallbackHtml;
  }
  return sanitized || textToEditorHtml(fallbackText);
}

function RichTextInput({
  html,
  onChange,
  placeholder,
  className = "",
}: {
  html: string;
  onChange: (next: { html: string; text: string }) => void;
  placeholder: string;
  className?: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [formatState, setFormatState] = useState<FormatState>(defaultFormatState);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor || editor.innerHTML === html) return;
    editor.innerHTML = html;
  }, [html]);

  useEffect(() => {
    function handleSelectionChange() {
      if (!editorRef.current?.contains(document.getSelection()?.anchorNode || null)) return;
      updateFormatState();
    }

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  function readCommandState(command: FormatCommand): boolean {
    try {
      return document.queryCommandState(command);
    } catch (_error) {
      return false;
    }
  }

  function updateFormatState() {
    setFormatState({
      bold: readCommandState("bold"),
      italic: readCommandState("italic"),
      underline: readCommandState("underline"),
      justifyLeft: readCommandState("justifyLeft"),
      justifyCenter: readCommandState("justifyCenter"),
      justifyRight: readCommandState("justifyRight"),
      insertUnorderedList: readCommandState("insertUnorderedList"),
      insertOrderedList: readCommandState("insertOrderedList"),
    });
  }

  function emitChange() {
    const editor = editorRef.current;
    if (!editor) return;
    onChange({
      html: editor.innerHTML,
      text: editorPlainText(editor),
    });
  }

  function runCommand(command: FormatCommand) {
    editorRef.current?.focus();
    document.execCommand(command);
    setFormatState((current) => {
      if (command === "justifyLeft" || command === "justifyCenter" || command === "justifyRight") {
        return {
          ...current,
          justifyLeft: command === "justifyLeft",
          justifyCenter: command === "justifyCenter",
          justifyRight: command === "justifyRight",
        };
      }
      if (command === "insertUnorderedList" || command === "insertOrderedList") {
        return {
          ...current,
          insertUnorderedList: command === "insertUnorderedList" ? !current.insertUnorderedList : false,
          insertOrderedList: command === "insertOrderedList" ? !current.insertOrderedList : false,
        };
      }
      return { ...current, [command]: !current[command] };
    });
    emitChange();
  }

  function handleToolbarMouseDown(event: React.MouseEvent<HTMLButtonElement>, command: FormatCommand) {
    event.preventDefault();
    runCommand(command);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const htmlValue = event.clipboardData.getData("text/html");
    const plainValue = event.clipboardData.getData("text/plain");
    if (htmlValue) {
      document.execCommand("insertHTML", false, sanitizePastedHtml(htmlValue, plainValue));
    } else if (plainValue) {
      document.execCommand("insertHTML", false, textToEditorHtml(plainValue));
    }
    updateFormatState();
    emitChange();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    document.execCommand("insertHTML", false, escapeEditorText("\t"));
    updateFormatState();
    emitChange();
  }

  function toolbarButton(command: FormatCommand, title: string, icon: React.ReactNode) {
    return (
      <button
        type="button"
        className={formatState[command] ? "active" : ""}
        aria-pressed={formatState[command]}
        onMouseDown={(event) => handleToolbarMouseDown(event, command)}
        title={title}
      >
        {icon}
      </button>
    );
  }

  return (
    <div className={`rich-editor-shell ${className}`}>
      <div className="format-toolbar" aria-label="Text formatting">
        {toolbarButton("bold", "Bold", <Bold size={16} />)}
        {toolbarButton("italic", "Italic", <Italic size={16} />)}
        {toolbarButton("underline", "Underline", <Underline size={16} />)}
        <span />
        {toolbarButton("justifyLeft", "Align left", <AlignLeft size={16} />)}
        {toolbarButton("justifyCenter", "Center", <AlignCenter size={16} />)}
        {toolbarButton("justifyRight", "Align right", <AlignRight size={16} />)}
        <span />
        {toolbarButton("insertUnorderedList", "Bulleted list", <List size={16} />)}
        {toolbarButton("insertOrderedList", "Numbered list", <ListOrdered size={16} />)}
      </div>
      <div
        ref={editorRef}
        className="rich-text-editor"
        contentEditable
        data-placeholder={placeholder}
        onInput={emitChange}
        onBlur={emitChange}
        onClick={updateFormatState}
        onKeyUp={updateFormatState}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        role="textbox"
        aria-multiline="true"
        suppressContentEditableWarning
      />
    </div>
  );
}

function MiniPage({ lines = 10 }: { lines?: number }) {
  return (
    <div className="mini-page">
      {Array.from({ length: lines }).map((_, index) => (
        <span key={index} style={{ width: `${42 + ((index * 17) % 46)}%` }} />
      ))}
    </div>
  );
}

const paperPageCharacterLimit = 1050;
const broadTextAccept =
  ".txt,.md,.markdown,.csv,.tsv,.json,.jsonc,.yaml,.yml,.html,.htm,.xml,.css,.scss,.sass,.less,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.java,.c,.cc,.cpp,.cxx,.h,.hpp,.cs,.go,.rs,.swift,.kt,.kts,.php,.rb,.sh,.bash,.zsh,.fish,.ps1,.bat,.sql,.r,.m,.mm,.scala,.clj,.hs,.lua,.pl,.pm,.tex,.bib,.toml,.ini,.env,.docx,.pdf";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToEditorHtml(value: string): string {
  if (!value) return "";
  return value
    .split("\n")
    .map((line) => `<div>${line ? escapeEditorText(line) : "<br>"}</div>`)
    .join("");
}

function hasClipboardFormatting(source: RichClipboardSource): boolean {
  return Boolean(source.html.trim() || source.rtf.trim());
}

function normalizeEditorText(value: string): string {
  return value.replace(/\u00a0/g, " ");
}

function editorNodePlainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeEditorText(node.textContent || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  if (element.dataset.tab === "true") return "\t";
  if (element.tagName === "BR") return "\n";
  return Array.from(element.childNodes).map(editorNodePlainText).join("");
}

function editorPlainText(editor: HTMLElement): string {
  const blocks = Array.from(editor.children);
  if (!blocks.length) return editorNodePlainText(editor);
  return blocks
    .map((block) => {
      const onlyBreak =
        block.childNodes.length === 1 &&
        block.firstChild?.nodeType === Node.ELEMENT_NODE &&
        (block.firstChild as HTMLElement).tagName === "BR";
      if (onlyBreak) return "";
      return editorNodePlainText(block).replace(/\n$/, "");
    })
    .join("\n");
}

function hasRichFormatting(html: string): boolean {
  return /<(b|strong|i|em|u|ol|ul|li)\b/i.test(html) || /text-align\s*:\s*(center|right|justify)|font-weight|font-style|text-decoration|margin-left|padding-left/i.test(html);
}

function paginateDraft(text: string): string[] {
  if (!text) return [""];

  const tokens = text.match(/\S+\s*|\s+/g) || [text];
  const pages: string[] = [];
  let currentPage = "";

  for (const token of tokens) {
    const nextPage = currentPage + token;
    const tokenCreatesNewPage =
      currentPage.trim().length > 0 &&
      nextPage.length > paperPageCharacterLimit &&
      !/^\s+$/.test(token);

    if (tokenCreatesNewPage) {
      pages.push(currentPage);
      currentPage = token;
    } else {
      currentPage = nextPage;
    }
  }

  pages.push(currentPage);
  return pages.length ? pages : [""];
}

function replaceDraftPageValue(pages: string[], pageIndex: number, nextValue: string) {
  return pages.map((page, index) => (index === pageIndex ? nextValue : page));
}

function pagesAreEqual(firstPages: string[], secondPages: string[]) {
  return firstPages.length === secondPages.length && firstPages.every((page, index) => page === secondPages[index]);
}

function getPageSplitIndex(textarea: HTMLTextAreaElement, value: string) {
  let low = 1;
  let high = value.length;
  let best = 1;
  const originalValue = textarea.value;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    textarea.value = value.slice(0, middle);

    if (textarea.scrollHeight <= textarea.clientHeight + 2) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  textarea.value = originalValue;

  const fittingText = value.slice(0, best);
  const fallbackSplit = Math.max(1, best);
  const minimumUsefulSplit = Math.floor(fallbackSplit * 0.65);
  const whitespaceMatches = Array.from(fittingText.matchAll(/\s+/g));
  const lastWhitespace = whitespaceMatches.at(-1);
  const whitespaceSplit = lastWhitespace ? lastWhitespace.index + lastWhitespace[0].length : 0;

  return whitespaceSplit >= minimumUsefulSplit ? whitespaceSplit : fallbackSplit;
}

function rebalanceVisiblePages(pages: string[], pageElements: Array<HTMLTextAreaElement | null>) {
  const balancedPages = [...pages];

  for (let index = 0; index < balancedPages.length; index += 1) {
    const textarea = pageElements[index];
    if (!textarea) continue;

    textarea.value = balancedPages[index];
    while (balancedPages[index].length > 1 && textarea.scrollHeight > textarea.clientHeight + 2) {
      const splitIndex = getPageSplitIndex(textarea, balancedPages[index]);
      if (splitIndex >= balancedPages[index].length) break;

      const overflow = balancedPages[index].slice(splitIndex);
      balancedPages[index] = balancedPages[index].slice(0, splitIndex);
      balancedPages[index + 1] = `${overflow}${balancedPages[index + 1] || ""}`;
      textarea.value = balancedPages[index];
    }
  }

  return balancedPages;
}

function formatRemainingTime(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getVisibleRemainingMs(autoEvent: any, nowMs: number) {
  if (typeof autoEvent?.remainingMs !== "number") return null;
  if (autoEvent.type === "paused" || autoEvent.type === "stopping") return Math.max(0, autoEvent.remainingMs);
  const updatedAt = autoEvent.remainingUpdatedAt ? Date.parse(autoEvent.remainingUpdatedAt) : nowMs;
  const elapsedMs = Number.isFinite(updatedAt) ? nowMs - updatedAt : 0;
  return Math.max(0, autoEvent.remainingMs - Math.max(0, elapsedMs));
}

function highlightRewrite(text: string) {
  const words = text.split(/(\s+)/);
  return words.map((word, index) => {
    if (!/\w/.test(word)) return word;
    if (index % 29 === 0) return <mark className="mark-green" key={`${word}-${index}`}>{word}</mark>;
    if (index % 43 === 0) return <mark className="mark-blue" key={`${word}-${index}`}>{word}</mark>;
    return word;
  });
}

function shortStatus(status: string) {
  if (status === "Fully met" || status === "Mostly met") return "Met";
  if (status === "Partially met") return "Partial";
  return "Missing";
}

function AutoTyperTab({
  targetApp,
  settings,
  autoEvent,
  parseFiles,
  captureSelected,
  expanded,
  onToggleExpanded,
  onStarted,
}: {
  targetApp: string | null;
  settings: Store["settings"];
  autoEvent: any;
  parseFiles: (files: FileList | File[] | string[], acceptText: AcceptText) => Promise<void>;
  captureSelected: (acceptText: AcceptText) => Promise<void>;
  expanded: boolean;
  onToggleExpanded: () => void;
  onStarted: () => void;
}) {
  const [text, setText] = useState("");
  const [richHtml, setRichHtml] = useState("");
  const [richClipboardSource, setRichClipboardSource] = useState<RichClipboardSource>({ html: "", rtf: "" });
  const [typingMode, setTypingMode] = useState<TypingMode>("structured");
  const [speedPreset, setSpeedPreset] = useState("normal");
  const [customWpm, setCustomWpm] = useState(45);
  const [pauseFrequency, setPauseFrequency] = useState(0);
  const [customChunkSize, setCustomChunkSize] = useState(35);
  const [sectionBySection, setSectionBySection] = useState(false);
  const [pauseAfterSentence, setPauseAfterSentence] = useState(true);
  const [pauseAfterParagraph, setPauseAfterParagraph] = useState(false);
  const [saveLog, setSaveLog] = useState(true);
  const [saveProgressAfterEachChunk, setSaveProgressAfterEachChunk] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [message, setMessage] = useState("");

  const wpm = speedPreset === "slow" ? 22 : speedPreset === "fast" ? 85 : speedPreset === "custom" ? customWpm : 45;
  const chunks = useMemo(() => createChunks(text, typingMode, customChunkSize), [text, typingMode, customChunkSize]);
  const visibleUnits = useMemo(() => countVisibleUnits(text), [text]);
  const duration = estimateDurationSeconds(chunks, typingMode, wpm);
  const completed = autoEvent?.log?.chunksCompleted || 0;
  const total = autoEvent?.log?.chunkCount || chunks.length;
  const isRunning = ["queued", "countdown", "progress", "paused", "resumed", "stopping"].includes(autoEvent?.type);

  useEffect(() => {
    if (autoEvent?.type === "error") setMessage(autoEvent.error || "Typing stopped with an error.");
    if (autoEvent?.type === "completed") setMessage("Typing completed.");
    if (autoEvent?.type === "session-active") setMessage(autoEvent.message || "The existing overlay session is active.");
    if (autoEvent?.type === "paused") {
      setMessage(autoEvent.reason === "target-lost" ? `Paused: ${autoEvent.frontApp || "another app"} is active.` : "Paused.");
    }
  }, [autoEvent]);

  function appendText(value: string, html?: string, rtf?: string) {
    const isAppending = Boolean(text.trim() || richHtml.trim());
    const nextHtml = html ? sanitizePastedHtml(html, value) : textToEditorHtml(value);
    setText((current) => (current ? `${current}\n\n${value}` : value));
    setRichHtml((current) => (current ? `${current}<div><br></div>${nextHtml}` : nextHtml));
    setRichClipboardSource(isAppending ? { html: "", rtf: "" } : { html: html || nextHtml, rtf: rtf || "" });
  }

  async function start() {
    if (!text.trim()) {
      setMessage("Paste, upload, or capture text before starting.");
      return;
    }
    if (chunks.length > 55 || visibleUnits > 1200) {
      const ok = window.confirm(
        `This job has ${chunks.length} chunks and about ${visibleUnits} typed units. Start progressive typing into ${
          targetApp || "the detected app"
        }?`,
      );
      if (!ok) return;
    }
    const shouldPasteRichText = hasClipboardFormatting(richClipboardSource) || hasRichFormatting(richHtml);
    const richHtmlForPaste = richClipboardSource.html || richHtml;
    const result = await window.overlayAPI.autoTyperStart({
      chunks,
      plainText: text,
      richHtml: shouldPasteRichText ? richHtmlForPaste : "",
      richRtf: shouldPasteRichText ? richClipboardSource.rtf : "",
      typingMode,
      wpm,
      delayBeforeStartMs: 3000,
      pauseFrequency,
      sectionBySection,
      pauseAfterSentence,
      pauseAfterParagraph,
      randomizedPauses: true,
      lightEdits: false,
      saveLog,
      saveProgressAfterEachChunk,
      preserveFormatting: true,
      preserveClipboard: settings.preserveClipboard,
      targetApp,
    });
    if (!result.ok && /already running/i.test(result.error || "")) {
      const status = await window.overlayAPI.autoTyperGetStatus();
      if (status?.active) setMessage(`Already typing into ${status.event?.targetApp || "the target app"}.`);
      else setMessage(result.error || "Could not start typing.");
      return;
    }
    if (result.ok) onStarted();
    setMessage(
      result.ok
        ? `${shouldPasteRichText ? "Queued formatted paste" : "Queued"} for ${result.targetApp || "current app"}.`
        : result.error || "Could not start typing.",
    );
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tab === "auto") start();
    };
    window.addEventListener("overlay:top-action", handler);
    return () => window.removeEventListener("overlay:top-action", handler);
  });

  if (expanded) {
    return (
      <div className="expanded-auto">
        <aside className="page-rail">
          <div className="page-thumb-list">
            <button
              className="page-thumb active"
              onClick={() => document.getElementById("paper-page-0")?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              <MiniPage lines={Math.min(12, Math.max(4, Math.ceil(text.length / 150)))} />
              <span>Draft</span>
            </button>
          </div>
        </aside>

        <section className="document-stage">
          <div className="paper-scroll">
            <div className="paper-editor-wrap" id="paper-page-0">
              <div className="paper-rich-editor">
                <RichTextInput
                  html={richHtml}
                  onChange={({ html, text: nextText }) => {
                    setRichHtml(html);
                    setText(nextText);
                    setRichClipboardSource({ html: "", rtf: "" });
                  }}
                  placeholder="Type or paste your draft here..."
                  className="paper-rich-shell"
                />
              </div>
              <button className="field-expand-button expanded" onClick={onToggleExpanded} title="Return to compact input">
                <Minimize2 size={16} />
              </button>
              <footer>{countWords(text)} words</footer>
            </div>
          </div>
        </section>

        <aside className="expanded-sidebar">
          <div className="settings-stack">
            <FieldLabel>
              Speed
              <select value={speedPreset} onChange={(event) => setSpeedPreset(event.target.value)}>
                <option value="slow">Slow</option>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
                <option value="custom">Custom WPM</option>
              </select>
            </FieldLabel>
            <FieldLabel>
              Chunk size
              <select value={typingMode} onChange={(event) => setTypingMode(event.target.value as TypingMode)}>
                <option value="structured">Structured</option>
                <option value="sentence">Sentences</option>
                <option value="paragraph">Paragraphs</option>
                <option value="character">Characters</option>
                <option value="word">Words</option>
                <option value="custom">Custom chunks</option>
              </select>
            </FieldLabel>
            <FieldLabel>
              Pause frequency
              <select value={pauseFrequency} onChange={(event) => setPauseFrequency(Number(event.target.value))}>
                <option value={0}>Every chunk</option>
                <option value={2}>Every 2 chunks</option>
                <option value={5}>Every 5 chunks</option>
              </select>
            </FieldLabel>
            <div className="button-row">
              <FileButton label="Upload" accept={broadTextAccept} onFiles={(files) => parseFiles(files, appendText)} />
              <button className="tool-button" onClick={() => captureSelected(appendText)}>
                <Target size={16} />
                <span>Capture</span>
              </button>
            </div>
            <div className="progress-box">
              <div>
                <strong>{chunks.length}</strong>
                <span>chunks</span>
              </div>
              <div>
                <strong>{visibleUnits}</strong>
                <span>units</span>
              </div>
              <div>
                <strong>{formatDuration(duration)}</strong>
                <span>time</span>
              </div>
            </div>
            <p className="panel-note">{message || (targetApp ? `Target: ${targetApp}` : "No target detected")}</p>
            <button className="primary-button large" onClick={start} disabled={!text.trim()}>
              <Play size={18} />
              Start
            </button>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="auto-compact">
      <section className="auto-text-card">
        <button className="field-expand-button" onClick={onToggleExpanded} title="Open expanded writing view">
          <Maximize2 size={16} />
        </button>
        <RichTextInput
          html={richHtml}
          onChange={({ html, text: nextText }) => {
            setRichHtml(html);
            setText(nextText);
            setRichClipboardSource({ html: "", rtf: "" });
          }}
          placeholder="Paste text to auto type..."
        />
        <span className="word-count">{countWords(text) || 0} words | {visibleUnits || 0} typed units</span>
      </section>

      <section className="auto-controls-card">
        <div className="speed-line">
          <span>Speed</span>
          <input
            type="range"
            className={`speed-slider speed-${speedPreset === "slow" ? "slow" : speedPreset === "fast" ? "fast" : "normal"}`}
            min={0}
            max={2}
            value={speedPreset === "slow" ? 0 : speedPreset === "fast" ? 2 : 1}
            onChange={(event) => setSpeedPreset(Number(event.target.value) === 0 ? "slow" : Number(event.target.value) === 2 ? "fast" : "normal")}
          />
          <em>{speedPreset === "slow" ? "Slow" : speedPreset === "fast" ? "Fast" : "Normal"}</em>
        </div>

        <div className="compact-select-row">
          <FieldLabel>
            Pause frequency
            <select value={pauseFrequency} onChange={(event) => setPauseFrequency(Number(event.target.value))}>
              <option value={0}>Every chunk</option>
              <option value={2}>Every 2 sentences</option>
              <option value={5}>Every 5 chunks</option>
            </select>
          </FieldLabel>
          <FieldLabel>
            Chunk size
            <select value={typingMode} onChange={(event) => setTypingMode(event.target.value as TypingMode)}>
              <option value="structured">Structured</option>
              <option value="sentence">Sentences</option>
              <option value="paragraph">Paragraph</option>
              <option value="word">Words</option>
              <option value="character">Characters</option>
              <option value="custom">Custom chunks</option>
            </select>
          </FieldLabel>
        </div>
      </section>

      <footer className="compact-footer">
        <span>
          <span className="status-dot" /> {message || (targetApp ? `Target: ${targetApp}` : "No target")}
        </span>
        <div className="compact-actions">
          <FileButton label="Upload" accept={broadTextAccept} onFiles={(files) => parseFiles(files, appendText)} />
          <button className="tool-button" onClick={() => captureSelected(appendText)}>
            <Target size={16} />
            Capture
          </button>
          <button className="tool-button" onClick={() => setPreviewOpen((current) => !current)}>
            <FileText size={16} />
            Preview
          </button>
          <button className="primary-button" onClick={start} disabled={!text.trim()}>
            <Play size={16} />
            Start
          </button>
        </div>
      </footer>

      {previewOpen && (
        <div className="minimal-popover">
          {chunks.slice(0, 5).map((chunk, index) => (
            <p key={`${chunk}-${index}`}>
              <strong>{index + 1}</strong> {chunk}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function CitationsTab({
  captureSelected,
  parseFiles,
  appendSliceItem,
  expanded,
}: {
  captureSelected: (acceptText: AcceptText) => Promise<void>;
  parseFiles: (files: FileList | File[] | string[], acceptText: AcceptText) => Promise<void>;
  appendSliceItem: (key: keyof Store, item: unknown) => Promise<void>;
  expanded: boolean;
}) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<CitationStyle>("APA");
  const [preferences, setPreferences] = useState<string[]>(["Scholarly sources"]);
  const [fromYear, setFromYear] = useState("");
  const [toYear, setToYear] = useState("");
  const [sourcesNeeded, setSourcesNeeded] = useState(6);
  const [inlineCitations, setInlineCitations] = useState(true);
  const [generateBibliography, setGenerateBibliography] = useState(true);
  const [flagUnsupported, setFlagUnsupported] = useState(true);
  const [citationNeed, setCitationNeed] = useState("");
  const [claims, setClaims] = useState<ClaimResult[]>([]);
  const [selectedClaimId, setSelectedClaimId] = useState("");
  const [approved, setApproved] = useState<Record<string, string[]>>({});
  const [manual, setManual] = useState({ claimId: "", title: "", authors: "", year: "", url: "", doi: "", publisher: "" });
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  function appendText(value: string) {
    setText((current) => (current ? `${current}\n\n${value}` : value));
  }

  function togglePreference(value: string) {
    setPreferences((current) => {
      if (value === "User-uploaded sources only") return current.includes(value) ? [] : [value];
      const next = current.filter((item) => item !== "User-uploaded sources only");
      return next.includes(value) ? next.filter((item) => item !== value) : [...next, value];
    });
  }

  async function searchClaims() {
    setLoading(true);
    try {
      const result = await window.overlayAPI.citationsSearch({
        text,
        style,
        sourcePreferences: preferences,
        fromYear,
        toYear,
        sourcesNeeded,
        inlineCitations,
        generateBibliography,
        flagUnsupported,
        citationNeed,
      });
      const nextClaims = result.claims || [];
      setClaims(nextClaims);
      setNotes(result.notes || []);
      const nextApproved: Record<string, string[]> = {};
      for (const claim of nextClaims) {
        const firstGood = claim.sources.find((source: SourceRecord) => /Strong|Acceptable/.test(source.qualityLabel || "")) || claim.sources[0];
        nextApproved[claim.id] = firstGood ? [firstGood.id] : [];
      }
      setApproved(nextApproved);
      setSelectedClaimId(nextClaims[0]?.id || "");
      setManual((current) => ({ ...current, claimId: nextClaims[0]?.id || "" }));
    } finally {
      setLoading(false);
    }
  }

  function toggleSource(claimId: string, sourceId: string) {
    setApproved((current) => {
      const chosen = new Set(current[claimId] || []);
      if (chosen.has(sourceId)) chosen.delete(sourceId);
      else chosen.add(sourceId);
      return { ...current, [claimId]: Array.from(chosen) };
    });
  }

  function sourceUrl(source: SourceRecord) {
    const doi = String(source.doi || "").trim();
    if (doi) return /^https?:\/\//i.test(doi) ? doi : `https://doi.org/${doi.replace(/^doi:/i, "")}`;
    return String(source.url || "").trim();
  }

  async function openSource(source: SourceRecord) {
    const url = sourceUrl(source);
    if (url) await window.overlayAPI.openExternal(url);
  }

  function openSourceFromKeyboard(event: React.KeyboardEvent<HTMLElement>, source: SourceRecord) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSource(source);
  }

  function addManualSource() {
    if (!manual.claimId || !manual.title.trim()) return;
    const source: SourceRecord = {
      id: makeId("manual-source"),
      title: manual.title.trim(),
      authors: manual.authors
        .split(/;|,/)
        .map((author) => author.trim())
        .filter(Boolean),
      year: manual.year,
      url: manual.url,
      doi: manual.doi,
      publisher: manual.publisher,
      type: "manual",
      sourceApi: "Manual",
      qualityLabel: "Unverified source",
      qualityReason: "Added manually by the user.",
      manual: true,
    };
    setClaims((current) =>
      current.map((claim) => (claim.id === manual.claimId ? { ...claim, sources: [source, ...claim.sources] } : claim)),
    );
    setApproved((current) => ({ ...current, [manual.claimId]: [...(current[manual.claimId] || []), source.id] }));
    setManual({ ...manual, title: "", authors: "", year: "", url: "", doi: "", publisher: "" });
  }

  const output = useMemo(() => buildCitationOutput(text, claims, approved, style), [text, claims, approved, style]);
  const unsupported = claims.filter((claim) => !(approved[claim.id] || []).length);

  async function copyRevised() {
    await navigator.clipboard.writeText(
      `${inlineCitations ? output.revisedText : text}${generateBibliography && output.bibliography ? `\n\nReferences\n${output.bibliography}` : ""}`,
    );
  }

  async function insertRevised() {
    await window.overlayAPI.insertText(
      `${inlineCitations ? output.revisedText : text}${generateBibliography && output.bibliography ? `\n\nReferences\n${output.bibliography}` : ""}`,
    );
  }

  async function saveApprovedSources() {
    for (const source of output.usedSources) await appendSliceItem("savedCitations", source);
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tab === "citations" && text.trim()) searchClaims();
    };
    window.addEventListener("overlay:top-action", handler);
    return () => window.removeEventListener("overlay:top-action", handler);
  });

  const selectedClaim = claims.find((claim) => claim.id === selectedClaimId) || claims[0];
  const selectedSources = selectedClaim?.sources || [];

  if (!expanded) {
    return (
      <div className="citations-compact">
        <section className="claims-card">
          <h2>
            Detected claims <span>{claims.length || 0}</span>
          </h2>
          {claims.length ? (
            <div className="claim-pill-list">
              {claims.slice(0, 4).map((claim, index) => (
                <button
                  className={selectedClaim?.id === claim.id ? "claim-pill active" : "claim-pill"}
                  key={claim.id}
                  onClick={() => setSelectedClaimId(claim.id)}
                >
                  <strong>{index + 1}</strong>
                  <span>{claim.text}</span>
                  <Check size={17} />
                </button>
              ))}
            </div>
          ) : (
            <textarea
              className="compact-source-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste or capture selected text..."
            />
          )}
          {!claims.length && (
            <button className="tool-button slim" onClick={searchClaims} disabled={loading || !text.trim()}>
              <Search size={16} />
              Find sources
            </button>
          )}
        </section>

        <section className="sources-card">
          <h2>Top sources for selected claim</h2>
          {selectedSources.length ? (
            <div className="source-card-list">
              {selectedSources.map((source) => {
                const isApproved = selectedClaim ? (approved[selectedClaim.id] || []).includes(source.id) : false;
                const url = sourceUrl(source);
                return (
                  <div
                    className={`source-card-row ${isApproved ? "approved" : ""} ${url ? "" : "no-link"}`}
                    key={source.id}
                    role={url ? "link" : "group"}
                    tabIndex={url ? 0 : -1}
                    title={url ? "Open source" : "No source URL available"}
                    onClick={() => openSource(source)}
                    onKeyDown={(event) => openSourceFromKeyboard(event, source)}
                  >
                    <span className="source-letter">{(source.title || "S").slice(0, 1)}</span>
                    <span>
                      <em className={`quality ${qualityClass(source.qualityLabel)}`}>{source.qualityLabel || "Source"}</em>
                      <strong>{source.title}</strong>
                      <small>{source.container || source.publisher || source.url || "Retrieved source"} {source.year ? `• ${source.year}` : ""}</small>
                    </span>
                    <span className="source-actions">
                      <small>{Math.round((source.relevanceScore || 0.86) * 100)}% match</small>
                      <button
                        className={`source-approve-button ${isApproved ? "active" : ""}`}
                        type="button"
                        title={isApproved ? "Approved for citation" : "Approve for citation"}
                        aria-label={isApproved ? "Approved for citation" : "Approve for citation"}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (selectedClaim) toggleSource(selectedClaim.id, source.id);
                        }}
                      >
                        <Check size={15} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={<BookOpen size={26} />} title="No sources yet" body="Paste text, then use Find Sources." />
          )}
        </section>

        <footer className="citation-footer">
          <div className="segmented citation-style">
            {(["APA", "MLA", "Chicago"] as CitationStyle[]).map((value) => (
              <button className={style === value ? "active" : ""} key={value} onClick={() => setStyle(value)}>
                {value}
              </button>
            ))}
          </div>
          <select value={preferences[0] || "Scholarly sources"} onChange={(event) => setPreferences([event.target.value])}>
            <option>Scholarly sources</option>
            <option>News sources</option>
          <option>Government sources</option>
          <option>Books</option>
        </select>
          <select className="source-count-select" value={sourcesNeeded} onChange={(event) => setSourcesNeeded(Number(event.target.value))}>
            <option value={3}>3 sources</option>
            <option value={5}>5 sources</option>
            <option value={6}>6 sources</option>
          </select>
          <button className="tool-button" onClick={insertRevised} disabled={!claims.length}>
            <BookOpen size={16} />
            Insert
          </button>
          <button className="tool-button" onClick={copyRevised} disabled={!claims.length}>
            <FileText size={16} />
            Bibliography
          </button>
        </footer>
      </div>
    );
  }

  return (
    <div className={`tool-grid two-one citations-view ${expanded ? "expanded-layout" : "compact-layout"}`}>
      <section className="tool-panel wide">
        <div className="panel-heading">
          <div>
            <h2>Citation Generator</h2>
            <p>Find real retrieved sources, approve them, then insert citations and a bibliography.</p>
          </div>
          <div className="button-row">
            <FileButton label="Upload" accept=".txt,.md,.markdown,.docx,.pdf" onFiles={(files) => parseFiles(files, appendText)} />
            <button className="tool-button" onClick={() => captureSelected(appendText)}>
              <Target size={16} />
              Capture
            </button>
          </div>
        </div>

        <textarea
          className="main-textarea citations-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste the paragraph or document section that needs citations..."
        />

        <div className="control-row">
          <button className="primary-button" onClick={searchClaims} disabled={loading || !text.trim()}>
            <Search size={16} />
            {loading ? "Searching..." : "Find sources"}
          </button>
          <button className="tool-button" onClick={copyRevised} disabled={!claims.length}>
            <Copy size={16} />
            Copy output
          </button>
          <button className="tool-button" onClick={insertRevised} disabled={!claims.length}>
            <Clipboard size={16} />
            Insert
          </button>
          <button className="tool-button" onClick={saveApprovedSources} disabled={!output.usedSources.length}>
            <Check size={16} />
            Save sources
          </button>
        </div>

        {claims.length ? (
          <div className="claim-list">
            {claims.map((claim) => (
              <article className="claim-item" key={claim.id}>
                <div className="claim-head">
                  <span className="tag">{claim.type}</span>
                  <p>{claim.text}</p>
                </div>
                {claim.warning && <p className="warning-line">{claim.warning}</p>}
                <div className="source-list">
                  {claim.sources.map((source) => (
                    <label className="source-row" key={source.id}>
                      <input
                        type="checkbox"
                        checked={(approved[claim.id] || []).includes(source.id)}
                        onChange={() => toggleSource(claim.id, source.id)}
                      />
                      <span>
                        <strong>{source.title}</strong>
                        <small>{sourcePreview(source)}</small>
                        <em className={`quality ${qualityClass(source.qualityLabel)}`}>{source.qualityLabel || "Unverified source"}</em>
                      </span>
                    </label>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState icon={<BookOpen size={30} />} title="No claims searched yet" body="The search will extract citation-worthy factual claims and retrieve source candidates." />
        )}
      </section>

      <aside className="tool-panel">
        <div className="panel-heading compact">
          <div>
            <h2>Citation Settings</h2>
            <p>No fabricated sources. No fake page numbers.</p>
          </div>
        </div>
        <div className="settings-stack">
          <FieldLabel>
            Citation style
            <select value={style} onChange={(event) => setStyle(event.target.value as CitationStyle)}>
              <option>APA</option>
              <option>MLA</option>
              <option>Chicago</option>
              <option>IEEE</option>
            </select>
          </FieldLabel>
          <FieldLabel>
            What kind of citations?
            <textarea
              className="small-textarea"
              value={citationNeed}
              onChange={(event) => setCitationNeed(event.target.value)}
              placeholder="Example: recent peer-reviewed sources about student writing tools"
            />
          </FieldLabel>
          <div className="checkbox-grid">
            {sourcePreferences.map((preference) => (
              <CheckRow key={preference} label={preference} checked={preferences.includes(preference)} onChange={() => togglePreference(preference)} />
            ))}
          </div>
          <div className="inline-fields">
            <FieldLabel>
              From year
              <input value={fromYear} onChange={(event) => setFromYear(event.target.value)} placeholder="optional" />
            </FieldLabel>
            <FieldLabel>
              To year
              <input value={toYear} onChange={(event) => setToYear(event.target.value)} placeholder="optional" />
            </FieldLabel>
          </div>
          <FieldLabel>
            Sources per claim
            <input type="number" min={1} max={5} value={sourcesNeeded} onChange={(event) => setSourcesNeeded(Number(event.target.value))} />
          </FieldLabel>
          <CheckRow label="Insert citations inline" checked={inlineCitations} onChange={setInlineCitations} />
          <CheckRow label="Generate bibliography" checked={generateBibliography} onChange={setGenerateBibliography} />
          <CheckRow label="Flag unsupported claims" checked={flagUnsupported} onChange={setFlagUnsupported} />
        </div>

        <div className="manual-source">
          <h3>Add Manual Source</h3>
          <FieldLabel>
            Claim
            <select value={manual.claimId} onChange={(event) => setManual({ ...manual, claimId: event.target.value })}>
              {claims.map((claim, index) => (
                <option value={claim.id} key={claim.id}>
                  Claim {index + 1}
                </option>
              ))}
            </select>
          </FieldLabel>
          <input placeholder="Title" value={manual.title} onChange={(event) => setManual({ ...manual, title: event.target.value })} />
          <input placeholder="Authors, separated by commas" value={manual.authors} onChange={(event) => setManual({ ...manual, authors: event.target.value })} />
          <div className="inline-fields">
            <input placeholder="Year" value={manual.year} onChange={(event) => setManual({ ...manual, year: event.target.value })} />
            <input placeholder="DOI" value={manual.doi} onChange={(event) => setManual({ ...manual, doi: event.target.value })} />
          </div>
          <input placeholder="URL" value={manual.url} onChange={(event) => setManual({ ...manual, url: event.target.value })} />
          <button className="tool-button" onClick={addManualSource} disabled={!claims.length}>
            <Plus size={16} />
            Add source
          </button>
        </div>

        {claims.length > 0 && (
          <div className="output-box">
            <h3>Output</h3>
            {flagUnsupported && unsupported.length > 0 && <p className="warning-line">{unsupported.length} claim(s) still need approved support.</p>}
            <textarea
              className="output-textarea"
              readOnly
              value={`${inlineCitations ? output.revisedText : text}${generateBibliography && output.bibliography ? `\n\nReferences\n${output.bibliography}` : ""}`}
            />
            {notes.map((note) => (
              <p className="panel-note" key={note}>
                {note}
              </p>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

function qualityClass(label = "") {
  if (label.includes("Strong")) return "strong";
  if (label.includes("Acceptable")) return "acceptable";
  if (label.includes("Weak")) return "weak";
  return "unverified";
}

function StyleTab({
  profile,
  parseFiles,
  captureSelected,
  saveProfile,
  saveSamples,
  clearProfile,
  clearSamples,
  appendRevision,
  expanded,
}: {
  profile: StyleProfile | null;
  parseFiles: (files: FileList | File[] | string[], acceptText: AcceptText) => Promise<void>;
  captureSelected: (acceptText: AcceptText) => Promise<void>;
  saveProfile: (profile: StyleProfile) => Promise<void>;
  saveSamples: (samples: unknown[]) => Promise<void>;
  clearProfile: () => Promise<void>;
  clearSamples: () => Promise<void>;
  appendRevision: (item: unknown) => Promise<void>;
  expanded: boolean;
}) {
  const [sampleText, setSampleText] = useState("");
  const [draft, setDraft] = useState("");
  const [strength, setStrength] = useState<"light" | "normal" | "strong">("normal");
  const [tone, setTone] = useState<"profile" | "clearer" | "simpler" | "formal" | "casual">("profile");
  const [preserveMeaning, setPreserveMeaning] = useState(true);
  const [makeClearer, setMakeClearer] = useState(true);
  const [makeSimpler, setMakeSimpler] = useState(false);
  const [makeFormal, setMakeFormal] = useState(false);
  const [makeCasual, setMakeCasual] = useState(false);
  const [keepCitations, setKeepCitations] = useState(true);
  const [keepFormatting, setKeepFormatting] = useState(true);
  const [reduceRobotic, setReduceRobotic] = useState(true);
  const [preserveTechnicalTerms, setPreserveTechnicalTerms] = useState(true);
  const [rewrite, setRewrite] = useState<RewriteResult | null>(null);
  const [consistency, setConsistency] = useState<Array<{ id: string; paragraph: string; flags: string[]; score: number }>>([]);
  const [editableInstructions, setEditableInstructions] = useState(profile?.rewriteInstructions || "");

  useEffect(() => setEditableInstructions(profile?.rewriteInstructions || ""), [profile]);

  function appendSample(value: string) {
    setSampleText((current) => (current ? `${current}\n\n${value}` : value));
  }

  function appendDraft(value: string) {
    setDraft((current) => (current ? `${current}\n\n${value}` : value));
  }

  async function createProfile() {
    const nextProfile = analyzeStyleProfile([sampleText]);
    await saveProfile(nextProfile);
    await saveSamples([
      {
        id: makeId("sample"),
        addedAt: new Date().toISOString(),
        wordCount: countWords(sampleText),
        source: "uploaded-or-pasted",
      },
    ]);
  }

  async function saveInstructionEdits() {
    if (!profile) return;
    await saveProfile({ ...profile, rewriteInstructions: editableInstructions });
  }

  async function generateRewrite() {
    const result = rewriteWithStyle(draft, profile, {
      strength,
      tone,
      preserveMeaning,
      makeClearer,
      makeSimpler,
      makeFormal,
      makeCasual,
      keepCitations,
      keepFormatting,
      reduceRobotic,
      preserveTechnicalTerms,
    });
    setRewrite(result);
    await appendRevision({
      id: makeId("revision"),
      createdAt: new Date().toISOString(),
      originalWords: countWords(draft),
      rewrittenWords: countWords(result.rewritten),
      styleMatchScore: result.styleMatchScore,
    });
  }

  function runConsistencyCheck() {
    setConsistency(checkConsistency(draft, profile));
  }

  async function pasteSampleText() {
    const value = await navigator.clipboard.readText();
    if (value) appendSample(value);
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tab !== "style") return;
      if (!profile && countWords(sampleText) >= 40) createProfile();
      if (profile && draft.trim()) generateRewrite();
    };
    window.addEventListener("overlay:top-action", handler);
    return () => window.removeEventListener("overlay:top-action", handler);
  });

  if (expanded && profile && rewrite) {
    return (
      <div className="expanded-humanizer">
        <section className="doc-pair">
          <article className="paper-page editable-paper">
            <div className="paper-title-row">
              <h3>Original</h3>
              <button className="paper-copy" onClick={() => navigator.clipboard.writeText(draft)} title="Copy original">
                <Copy size={17} />
              </button>
            </div>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
            <footer>{countWords(draft)} words</footer>
          </article>
          <button className="flow-arrow" title="Rewrite direction">
            <ChevronDown size={20} />
          </button>
          <article className="paper-page rewritten-paper">
            <div className="paper-title-row">
              <h3>Humanized</h3>
              <button className="paper-copy" onClick={() => navigator.clipboard.writeText(rewrite.rewritten)} title="Copy rewritten">
                <Copy size={17} />
              </button>
            </div>
            <p>{highlightRewrite(rewrite.rewritten)}</p>
            <footer>{countWords(rewrite.rewritten)} words</footer>
          </article>
        </section>

        <aside className="expanded-sidebar humanizer-sidebar">
          <div className="settings-stack">
            <FieldLabel>
              Style strength
              <div className="segmented">
                {(["light", "normal", "strong"] as const).map((value) => (
                  <button className={strength === value ? "active" : ""} key={value} onClick={() => setStrength(value)}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
            </FieldLabel>
            <FieldLabel>
              Tone
              <select value={tone} onChange={(event) => setTone(event.target.value as any)}>
                <option value="profile">Natural & Conversational</option>
                <option value="clearer">Clearer</option>
                <option value="simpler">Simpler</option>
                <option value="formal">More formal</option>
                <option value="casual">More casual</option>
              </select>
            </FieldLabel>
            <CheckRow label="Preserve meaning" checked={preserveMeaning} onChange={setPreserveMeaning} />
            <CheckRow label="Keep citations" checked={keepCitations} onChange={setKeepCitations} />
            <FieldLabel>
              Writing profile
              <select value="profile" disabled>
                <option>Academic Profile</option>
              </select>
            </FieldLabel>
            <button className="primary-button large" onClick={() => window.overlayAPI.insertText(rewrite.rewritten)}>
              <Check size={18} />
              Apply
            </button>
            <button className="tool-button large" onClick={generateRewrite}>
              <RefreshCcw size={18} />
              Regenerate
            </button>
          </div>
        </aside>
      </div>
    );
  }

  if (!expanded && !profile) {
    return (
      <div className="humanizer-empty-compact">
        <section className="sample-drop-card">
          <h2>Add your texts to generate your writing style</h2>
          <p>Upload or paste your own writing samples so we can learn your style and tone.</p>
          <div className="drop-zone">
            <Upload size={42} />
            <span>Drag and drop files here</span>
            <small>or use the buttons below</small>
            <div className="button-row">
              <FileButton label="Upload samples" accept=".txt,.md,.markdown,.docx,.pdf" onFiles={(files) => parseFiles(files, appendSample)} />
              <button className="tool-button" onClick={pasteSampleText}>
                <Clipboard size={16} />
                Paste text
              </button>
            </div>
          </div>
          <div className="file-badges">
            <span>DOCX</span>
            <span>PDF</span>
            <span>TXT</span>
          </div>
        </section>

        <aside className="samples-card">
          <h2>Your samples</h2>
          {[1, 2, 3].map((sample, index) => (
            <div className="sample-row" key={sample}>
              <FileText size={24} />
              <span>
                <strong>Sample {sample}</strong>
                <small>{index === 0 && sampleText ? `${countWords(sampleText)} words` : "Not added"}</small>
              </span>
            </div>
          ))}
          <p className="panel-note">Add at least one sample to continue.</p>
          <button className="primary-button large" onClick={createProfile} disabled={countWords(sampleText) < 40}>
            <Wand2 size={18} />
            Generate style profile
          </button>
        </aside>
      </div>
    );
  }

  if (!expanded) {
    return (
      <div className="humanizer-compact">
        <section className="humanizer-text-pair">
          <article className="mini-editor-card">
            <div className="paper-title-row">
              <h2>Original</h2>
              <button className="paper-copy" onClick={() => navigator.clipboard.writeText(draft)} title="Copy original">
                <Copy size={16} />
              </button>
            </div>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Paste text to humanize..." />
            <span>{countWords(draft)}/200</span>
          </article>
          <button className="flow-arrow compact-arrow" title="Rewrite direction">
            <ChevronDown size={20} />
          </button>
          <article className="mini-editor-card">
            <div className="paper-title-row">
              <h2>Humanized</h2>
              <button className="paper-copy" onClick={() => rewrite && navigator.clipboard.writeText(rewrite.rewritten)} title="Copy humanized">
                <Copy size={16} />
              </button>
            </div>
            <p>{rewrite ? rewrite.rewritten : "Your rewrite will appear here."}</p>
            <span>{rewrite ? countWords(rewrite.rewritten) : 0}/200</span>
          </article>
        </section>

        <section className="humanizer-bottom-controls">
          <FieldLabel>
            Style strength
            <div className="segmented">
              {(["light", "normal", "strong"] as const).map((value) => (
                <button className={strength === value ? "active" : ""} key={value} onClick={() => setStrength(value)}>
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </FieldLabel>
          <FieldLabel>
            Tone
            <select value={tone} onChange={(event) => setTone(event.target.value as any)}>
              <option value="profile">Natural & Conversational</option>
              <option value="clearer">Clearer</option>
              <option value="formal">More formal</option>
              <option value="casual">More casual</option>
            </select>
          </FieldLabel>
          <FieldLabel>
            Writing profile
            <select value="profile" disabled>
              <option>My Academic Style</option>
            </select>
          </FieldLabel>
          <CheckRow label="Preserve meaning" checked={preserveMeaning} onChange={setPreserveMeaning} />
          <CheckRow label="Keep citations" checked={keepCitations} onChange={setKeepCitations} />
          <div className="compact-actions">
            <button className="tool-button" onClick={generateRewrite} disabled={!draft.trim()}>
              <RefreshCcw size={16} />
              Regenerate
            </button>
            <button className="primary-button" onClick={() => rewrite && window.overlayAPI.insertText(rewrite.rewritten)} disabled={!rewrite}>
              <Check size={16} />
              Apply
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="tool-grid two-one">
      <section className="tool-panel wide">
        <div className="panel-heading">
          <div>
            <h2>Personal Style Matcher</h2>
            <p>Create a local writing profile, then rewrite drafts toward your own habits.</p>
          </div>
          <div className="button-row">
            <FileButton label="Samples" accept=".txt,.md,.markdown,.docx,.pdf" onFiles={(files) => parseFiles(files, appendSample)} />
            <button className="tool-button" onClick={() => captureSelected(appendDraft)}>
              <Target size={16} />
              Capture draft
            </button>
          </div>
        </div>

        <div className="split-editors">
          <div>
            <FieldLabel>
              Writing samples
              <textarea
                className="medium-textarea"
                value={sampleText}
                onChange={(event) => setSampleText(event.target.value)}
                placeholder="Paste writing you actually wrote, or upload TXT, Markdown, DOCX, or PDF files..."
              />
            </FieldLabel>
            <div className="control-row">
              <button className="primary-button" onClick={createProfile} disabled={countWords(sampleText) < 40}>
                <Wand2 size={16} />
                Create profile
              </button>
              <button className="tool-button" onClick={clearSamples}>
                <X size={16} />
                Delete samples
              </button>
            </div>
          </div>
          <div>
            <FieldLabel>
              New text to rewrite
              <textarea
                className="medium-textarea"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Paste the text you want rewritten..."
              />
            </FieldLabel>
            <div className="control-row">
              <button className="primary-button" onClick={generateRewrite} disabled={!draft.trim()}>
                <RefreshCcw size={16} />
                Rewrite
              </button>
              <button className="tool-button" onClick={runConsistencyCheck} disabled={!draft.trim()}>
                <FileCheck2 size={16} />
                Check consistency
              </button>
            </div>
          </div>
        </div>

        {rewrite ? (
          <div className="comparison-grid">
            <div>
              <h3>Original</h3>
              <p>{draft}</p>
            </div>
            <div>
              <h3>Rewritten</h3>
              <p>{rewrite.rewritten}</p>
              <div className="control-row">
                <button className="tool-button" onClick={() => navigator.clipboard.writeText(rewrite.rewritten)}>
                  <Copy size={16} />
                  Copy
                </button>
                <button className="tool-button" onClick={() => window.overlayAPI.insertText(rewrite.rewritten)}>
                  <Clipboard size={16} />
                  Insert
                </button>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState icon={<Wand2 size={30} />} title="No rewrite yet" body="Create or load a profile, paste a draft, then run the rewrite." />
        )}

        {consistency.length > 0 && (
          <div className="consistency-list">
            <h3>Style Consistency</h3>
            {consistency.map((item) => (
              <article className="mini-report" key={item.id}>
                <strong>{item.score}% match</strong>
                <p>{item.paragraph}</p>
                {item.flags.length ? <small>{item.flags.join(" | ")}</small> : <small>No obvious style shift.</small>}
              </article>
            ))}
          </div>
        )}
      </section>

      <aside className="tool-panel">
        <div className="panel-heading compact">
          <div>
            <h2>Profile & Controls</h2>
            <p>{profile ? `${profile.wordCount} profile words from ${profile.sampleCount} sample set(s).` : "No style profile yet."}</p>
          </div>
        </div>
        {profile ? (
          <div className="profile-card">
            <strong>{profile.toneSummary}</strong>
            <p>{profile.styleSummary}</p>
            <div className="stat-grid">
              <span>Sentence {profile.averageSentenceLength}</span>
              <span>Paragraph {profile.averageParagraphLength}</span>
              <span>{profile.vocabularyLevel}</span>
              <span>{profile.formalityLevel}</span>
            </div>
            <h3>Editable rewrite instructions</h3>
            <textarea className="small-textarea tall" value={editableInstructions} onChange={(event) => setEditableInstructions(event.target.value)} />
            <div className="control-row">
              <button className="tool-button" onClick={saveInstructionEdits}>
                <Check size={16} />
                Save
              </button>
              <button className="danger-button" onClick={clearProfile}>
                <X size={16} />
                Delete
              </button>
            </div>
          </div>
        ) : (
          <EmptyState icon={<PenLine size={30} />} title="Private by default" body="Samples stay local unless you explicitly add a cloud model later." />
        )}

        <div className="settings-stack">
          <FieldLabel>
            Style strength
            <select value={strength} onChange={(event) => setStrength(event.target.value as any)}>
              <option value="light">Match my style lightly</option>
              <option value="normal">Match my style normally</option>
              <option value="strong">Match my style strongly</option>
            </select>
          </FieldLabel>
          <FieldLabel>
            Output tone
            <select value={tone} onChange={(event) => setTone(event.target.value as any)}>
              <option value="profile">Use profile tone</option>
              <option value="clearer">Make it clearer</option>
              <option value="simpler">Make it simpler</option>
              <option value="formal">Make it more formal</option>
              <option value="casual">Make it more casual</option>
            </select>
          </FieldLabel>
          <CheckRow label="Preserve meaning strictly" checked={preserveMeaning} onChange={setPreserveMeaning} />
          <CheckRow label="Make it clearer" checked={makeClearer} onChange={setMakeClearer} />
          <CheckRow label="Make it simpler" checked={makeSimpler} onChange={setMakeSimpler} />
          <CheckRow label="Make it more formal" checked={makeFormal} onChange={setMakeFormal} />
          <CheckRow label="Make it more casual" checked={makeCasual} onChange={setMakeCasual} />
          <CheckRow label="Keep citations" checked={keepCitations} onChange={setKeepCitations} />
          <CheckRow label="Keep formatting" checked={keepFormatting} onChange={setKeepFormatting} />
          <CheckRow label="Reduce robotic tone" checked={reduceRobotic} onChange={setReduceRobotic} />
          <CheckRow label="Preserve technical terms" checked={preserveTechnicalTerms} onChange={setPreserveTechnicalTerms} />
        </div>

        {rewrite && (
          <div className="output-box">
            <h3>Rewrite Notes</h3>
            <div className="score-chip">{rewrite.styleMatchScore}% style match</div>
            {rewrite.meaningWarning && <p className="warning-line">{rewrite.meaningWarning}</p>}
            <ul>
              {rewrite.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

function RubricTab({
  parseFiles,
  captureSelected,
  appendReport,
  expanded,
}: {
  parseFiles: (files: FileList | File[] | string[], acceptText: AcceptText) => Promise<void>;
  captureSelected: (acceptText: AcceptText) => Promise<void>;
  appendReport: (report: RubricReport) => Promise<void>;
  expanded: boolean;
}) {
  const [documentText, setDocumentText] = useState("");
  const [rubricText, setRubricText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [mode, setMode] = useState("Devil's advocate reviewer");
  const [gradingScale, setGradingScale] = useState(100);
  const [targetScore, setTargetScore] = useState(90);
  const [citationStyle, setCitationStyle] = useState<CitationStyle>("APA");
  const [minWords, setMinWords] = useState("");
  const [maxWords, setMaxWords] = useState("");
  const [report, setReport] = useState<RubricReport | null>(null);

  function appendDocument(value: string) {
    setDocumentText((current) => (current ? `${current}\n\n${value}` : value));
  }

  function appendRubric(value: string) {
    setRubricText((current) => (current ? `${current}\n\n${value}` : value));
  }

  async function analyze() {
    const nextReport = evaluateRubric({
      document: documentText,
      rubric: rubricText,
      instructions,
      mode,
      gradingScale,
      targetScore,
      citationStyle,
      minWords: minWords ? Number(minWords) : undefined,
      maxWords: maxWords ? Number(maxWords) : undefined,
    });
    setReport(nextReport);
    await appendReport(nextReport);
  }

  async function exportReport(format: "markdown" | "pdf" | "docx" | "clipboard") {
    if (!report) return;
    await window.overlayAPI.exportReport({
      title: "Rubric Review Report",
      content: report.markdown,
      format,
    });
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tab === "rubric" && documentText.trim() && rubricText.trim()) analyze();
    };
    window.addEventListener("overlay:top-action", handler);
    return () => window.removeEventListener("overlay:top-action", handler);
  });

  if (report && !expanded) {
    const met = report.criteria.filter((criterion) => criterion.status === "Fully met" || criterion.status === "Mostly met").length;
    return (
      <div className="rubric-dashboard">
        <section className="criteria-card">
          <h2>Criteria</h2>
          <div className="criteria-mini-list">
            {report.criteria.slice(0, 4).map((criterion) => (
              <button className="criteria-mini-row" key={criterion.id}>
                <span>{criterion.name}</span>
                <em className={`status ${criterion.status.replace(/\s+/g, "-").toLowerCase()}`}>{shortStatus(criterion.status)}</em>
                <ChevronDown size={17} />
              </button>
            ))}
          </div>
          <p className="panel-note">
            {met} / {report.criteria.length} criteria
          </p>
          <button className="tool-button" onClick={() => exportReport("markdown")}>
            View details
          </button>
        </section>
        <section className="score-card">
          <h2>Score</h2>
          <div className="score-ring" style={{ "--score": `${Math.min(100, report.overallScore)}%` } as React.CSSProperties}>
            <strong>{Math.round(report.overallScore)}</strong>
            <span>/{gradingScale}</span>
          </div>
          <FieldLabel>
            Review mode
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              <option>Balanced reviewer</option>
              <option>Strict reviewer</option>
              <option>Devil's advocate reviewer</option>
            </select>
          </FieldLabel>
          <p className="panel-note">Strict mode flags more issues and higher standards.</p>
        </section>
        <section className="risk-card">
          <h2>Risk</h2>
          <div className={`risk-level ${report.riskLevel.toLowerCase()}`}>
            <AlertTriangle size={24} />
            <strong>{report.riskLevel}</strong>
          </div>
          <p>{report.riskLevel === "Low" ? "This draft is close, but still review details." : "Some areas need attention before submission."}</p>
          <h3>Fix next</h3>
          <ul>
            {report.revisionChecklist.slice(0, 3).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  if (!expanded) {
    return (
      <div className="rubric-setup-compact">
        <section className="mini-editor-card">
          <h2>Draft</h2>
          <textarea
            value={documentText}
            onChange={(event) => setDocumentText(event.target.value)}
            placeholder="Paste or capture the draft..."
          />
          <span>{countWords(documentText)} words</span>
        </section>
        <section className="mini-editor-card">
          <h2>Rubric</h2>
          <textarea
            value={rubricText}
            onChange={(event) => setRubricText(event.target.value)}
            placeholder="Paste the rubric or assignment criteria..."
          />
          <span>{rubricText ? "Criteria ready" : "No criteria"}</span>
        </section>
        <footer className="compact-footer">
          <span>
            <span className="status-dot" /> Local
          </span>
          <button className="primary-button" onClick={analyze} disabled={!documentText.trim() || !rubricText.trim()}>
            <ShieldAlert size={16} />
            Check Draft
          </button>
        </footer>
      </div>
    );
  }

  return (
    <div className={`tool-grid two-one rubric-view ${expanded ? "expanded-layout" : "compact-layout"}`}>
      <section className="tool-panel wide">
        <div className="panel-heading">
          <div>
            <h2>Rubric Checker</h2>
            <p>Strictly review a draft against criteria, prompt requirements, citations, and word count.</p>
          </div>
          <div className="button-row">
            <FileButton label="Draft" accept=".txt,.md,.markdown,.docx,.pdf,.png,.jpg,.jpeg" onFiles={(files) => parseFiles(files, appendDocument)} />
            <FileButton label="Rubric" accept=".txt,.md,.markdown,.docx,.pdf,.png,.jpg,.jpeg" onFiles={(files) => parseFiles(files, appendRubric)} />
            <button className="tool-button" onClick={() => captureSelected(appendDocument)}>
              <Target size={16} />
              Capture draft
            </button>
          </div>
        </div>

        <div className="split-editors">
          <FieldLabel>
            Document or draft
            <textarea
              className="medium-textarea"
              value={documentText}
              onChange={(event) => setDocumentText(event.target.value)}
              placeholder="Paste the draft, or upload PDF, DOCX, TXT, Markdown, or screenshot images for OCR..."
            />
          </FieldLabel>
          <FieldLabel>
            Rubric / instructions / checklist
            <textarea
              className="medium-textarea"
              value={rubricText}
              onChange={(event) => setRubricText(event.target.value)}
              placeholder="Paste rubric rows, assignment instructions, grading criteria, or checklist items..."
            />
          </FieldLabel>
        </div>

        <FieldLabel>
          Additional prompt notes or reference expectations
          <textarea
            className="small-textarea"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Optional: target audience, required sections, formatting rules, source rules, example constraints..."
          />
        </FieldLabel>

        <div className="control-row">
          <button className="primary-button" onClick={analyze} disabled={!documentText.trim() || !rubricText.trim()}>
            <ShieldAlert size={16} />
            Review draft
          </button>
          <button className="tool-button" onClick={() => exportReport("markdown")} disabled={!report}>
            <FileDown size={16} />
            Markdown
          </button>
          <button className="tool-button" onClick={() => exportReport("pdf")} disabled={!report}>
            <FileDown size={16} />
            PDF
          </button>
          <button className="tool-button" onClick={() => exportReport("docx")} disabled={!report}>
            <FileDown size={16} />
            DOCX
          </button>
          <button className="tool-button" onClick={() => exportReport("clipboard")} disabled={!report}>
            <Copy size={16} />
            Clipboard
          </button>
        </div>

        {report ? (
          <div className="rubric-output">
            <div className="score-strip">
              <div>
                <strong>{report.overallScore}</strong>
                <span>score estimate</span>
              </div>
              <div>
                <strong>{report.riskLevel}</strong>
                <span>risk</span>
              </div>
              <div>
                <strong>{report.wordCount}</strong>
                <span>words</span>
              </div>
            </div>
            <h3>Annotated Document</h3>
            <div className="annotated-doc">
              {report.annotatedParagraphs.map((paragraph) => (
                <article className={paragraph.flags.length ? "annotated flagged" : "annotated"} key={paragraph.id}>
                  <p>{paragraph.text}</p>
                  {paragraph.flags.length > 0 && <small>{paragraph.flags.join(" | ")}</small>}
                  {paragraph.matchedCriteria.length > 0 && <em>{paragraph.matchedCriteria.join(", ")}</em>}
                </article>
              ))}
            </div>
            <h3>Rubric Breakdown</h3>
            <div className="criteria-list">
              {report.criteria.map((criterion) => (
                <article className="criterion-row" key={criterion.id}>
                  <div>
                    <strong>{criterion.name}</strong>
                    <span className={`status ${criterion.status.replace(/\s+/g, "-").toLowerCase()}`}>{criterion.status}</span>
                  </div>
                  <p>{criterion.whyPointsMayBeLost}</p>
                  <small>{criterion.suggestedFix}</small>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState icon={<FileCheck2 size={30} />} title="No review yet" body="Paste a draft and rubric, then run a strict review." />
        )}
      </section>

      <aside className="tool-panel">
        <div className="panel-heading compact">
          <div>
            <h2>Review Settings</h2>
            <p>Use balanced, strict, citation, structure, clarity, or rubric-only modes.</p>
          </div>
        </div>
        <div className="settings-stack">
          <FieldLabel>
            Review mode
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              <option>Balanced reviewer</option>
              <option>Strict reviewer</option>
              <option>Devil's advocate reviewer</option>
              <option>Citation-focused reviewer</option>
              <option>Structure-focused reviewer</option>
              <option>Clarity-focused reviewer</option>
              <option>Rubric-only reviewer</option>
              <option>Grammar/style reviewer</option>
            </select>
          </FieldLabel>
          <div className="inline-fields">
            <FieldLabel>
              Grading scale
              <input type="number" min={1} max={1000} value={gradingScale} onChange={(event) => setGradingScale(Number(event.target.value))} />
            </FieldLabel>
            <FieldLabel>
              Target score
              <input type="number" min={1} max={1000} value={targetScore} onChange={(event) => setTargetScore(Number(event.target.value))} />
            </FieldLabel>
          </div>
          <FieldLabel>
            Citation style
            <select value={citationStyle} onChange={(event) => setCitationStyle(event.target.value as CitationStyle)}>
              <option>APA</option>
              <option>MLA</option>
              <option>Chicago</option>
              <option>IEEE</option>
            </select>
          </FieldLabel>
          <div className="inline-fields">
            <FieldLabel>
              Min words
              <input value={minWords} onChange={(event) => setMinWords(event.target.value)} placeholder="optional" />
            </FieldLabel>
            <FieldLabel>
              Max words
              <input value={maxWords} onChange={(event) => setMaxWords(event.target.value)} placeholder="optional" />
            </FieldLabel>
          </div>
        </div>

        {report && (
          <div className="output-box">
            <h3>Revision Plan</h3>
            <ol>
              {report.revisionChecklist.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
            <h3>Biggest Issues</h3>
            <ul>
              {report.biggestIssues.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

export default App;
