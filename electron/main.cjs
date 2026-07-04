const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

app.setName("Universal Writing Overlay");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow;
let db;
let lastTargetApp = null;
let currentJob = null;
let targetPollTimer = null;
let targetPollInFlight = false;
let mousePassthroughForced = false;
let lastMousePassthrough = false;

const allowedDataKeys = new Set([
  "settings",
  "styleProfile",
  "writingSamples",
  "savedCitations",
  "autoTyperLogs",
  "rubricReports",
  "revisionHistory",
]);

function defaultDb() {
  return {
    settings: {
      alwaysOnTop: true,
      preserveClipboard: true,
      emergencyHotkey: "CommandOrControl+Shift+Escape",
      clickThroughHotkey: "CommandOrControl+Shift+M",
      localOnlyMode: true,
      cloudAiEnabled: false,
    },
    styleProfile: null,
    writingSamples: [],
    savedCitations: [],
    autoTyperLogs: [],
    rubricReports: [],
    revisionHistory: [],
  };
}

function getDbPath() {
  return path.join(app.getPath("userData"), "writing-overlay-data.json");
}

function loadDb() {
  const file = getDbPath();
  if (!fs.existsSync(file)) {
    db = defaultDb();
    saveDb();
    return db;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const defaults = defaultDb();
    db = {
      ...defaults,
      ...parsed,
      settings: {
        ...defaults.settings,
        ...(parsed.settings || {}),
      },
    };
    clearStaleAutoTyperLogs();
  } catch (_error) {
    db = defaultDb();
    saveDb();
  }

  return db;
}

function clearStaleAutoTyperLogs() {
  if (!db || !Array.isArray(db.autoTyperLogs)) return;
  let changed = false;
  db.autoTyperLogs = db.autoTyperLogs.map((log) => {
    if (log?.stoppedAt || !["queued", "running", "progress", "started"].includes(log?.status)) return log;
    changed = true;
    return {
      ...log,
      status: "interrupted",
      stoppedAt: new Date().toISOString(),
      events: [
        ...(Array.isArray(log.events) ? log.events : []),
        {
          at: new Date().toISOString(),
          type: "interrupted",
          message: "Marked inactive because no live typing job exists.",
        },
      ],
    };
  });
  if (changed) saveDb();
}

function saveDb() {
  const file = getDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout ?? 15000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appleString(value) {
  return JSON.stringify(String(value ?? ""));
}

async function runAppleScript(script, timeout = 15000) {
  if (process.platform !== "darwin") {
    throw new Error("Desktop automation is currently implemented for macOS.");
  }
  return run("osascript", ["-e", script], { timeout });
}

async function getFrontAppName() {
  if (process.platform !== "darwin") return null;
  try {
    const output = await runAppleScript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
      5000,
    );
    return output.trim() || null;
  } catch (_error) {
    return null;
  }
}

function isOverlayProcessName(name) {
  if (!name) return false;
  return /^(Electron|Universal Writing Overlay|Auto Typer)$/i.test(name);
}

function cleanTargetAppName(name) {
  const value = String(name || "").trim();
  if (!value || isOverlayProcessName(value)) return null;
  return value;
}

function sendTargetEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("target:updated", payload);
}

async function rememberFrontTarget(reason = "unknown") {
  const frontApp = await getFrontAppName();
  const targetApp = cleanTargetAppName(frontApp);
  if (targetApp) {
    lastTargetApp = targetApp;
    sendTargetEvent({ targetApp, frontApp, reason });
  }
  return { targetApp: lastTargetApp, frontApp };
}

async function waitForFrontApp(expectedApp, timeout = 2400) {
  const deadline = Date.now() + timeout;
  let frontApp = await getFrontAppName();

  while (frontApp !== expectedApp && Date.now() < deadline) {
    await sleep(90);
    frontApp = await getFrontAppName();
  }

  return { ok: frontApp === expectedApp, frontApp };
}

async function activateAppByName(name) {
  if (!name || process.platform !== "darwin") return;
  await runAppleScript(`tell application ${appleString(name)} to activate`, 8000);
  await sleep(220);
}

function setAutomationWindowMode(owner, enabled, reason = "automation") {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (enabled) {
    if (owner && typeof owner.windowWasFocusable !== "boolean") {
      try {
        owner.windowWasFocusable = mainWindow.isFocusable();
      } catch (_error) {
        owner.windowWasFocusable = true;
      }
    }
    try {
      mainWindow.setFocusable(false);
      mainWindow.blur();
    } catch (_error) {
      // The target focus check below is the source of truth if the window API fails.
    }
    setWindowMousePassthrough(true, reason);
    return;
  }

  try {
    mainWindow.setFocusable(owner?.windowWasFocusable !== false);
  } catch (_error) {
    // Best effort: the renderer can still recover through mouse passthrough.
  }
  setWindowMousePassthrough(false, reason);
}

async function focusTargetApp(targetApp, reason = "typing") {
  const cleanTarget = cleanTargetAppName(targetApp);
  if (!cleanTarget) {
    throw new Error("No target document was detected. Click in the document first, then press Start.");
  }

  await activateAppByName(cleanTarget);
  const focused = await waitForFrontApp(cleanTarget, 2600);
  if (!focused.ok) {
    throw new Error(
      `Could not focus ${cleanTarget} before ${reason}. Current front app: ${focused.frontApp || "unknown"}.`,
    );
  }
  await sleep(140);
  return cleanTarget;
}

async function pasteTextIntoTarget(text) {
  clipboard.writeText(text);
  await runAppleScript('tell application "System Events" to keystroke "v" using command down', 8000);
  await sleep(70);
}

async function pasteRichContentIntoTarget(text, html, rtf = "") {
  clipboard.write({
    text: String(text || ""),
    html: String(html || ""),
    rtf: String(rtf || ""),
  });
  await runAppleScript('tell application "System Events" to keystroke "v" using command down', 8000);
  await sleep(110);
}

function readClipboardSnapshot() {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
  };
}

function restoreClipboardSnapshot(snapshot) {
  if (snapshot?.html || snapshot?.rtf) clipboard.write({ text: snapshot.text || "", html: snapshot.html || "", rtf: snapshot.rtf || "" });
  else clipboard.writeText(snapshot?.text || "");
}

function plainTextFromHtml(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pressBackspace(times = 1) {
  if (times <= 0) return;
  await runAppleScript(
    `tell application "System Events"\nrepeat ${Math.min(times, 12)} times\nkey code 51\nend repeat\nend tell`,
    8000,
  );
  await sleep(60);
}

function createWindow() {
  const displayBounds = screen.getPrimaryDisplay().bounds;
  mainWindow = new BrowserWindow({
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
    minWidth: 720,
    minHeight: 460,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    title: "Universal Writing Overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setHasShadow(false);
  mainWindow.setBounds(displayBounds);
  mainWindow.webContents.once("did-finish-load", () => {
    setWindowMousePassthrough(true, "initial");
  });

  mainWindow.on("blur", () => {
    rememberFrontTarget("window-blur").catch(() => {});
  });

  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function setWindowMousePassthrough(ignored, reason = "renderer") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const next = Boolean(ignored);
  if (!next) {
    rememberFrontTarget(`before-overlay-interaction:${reason}`).catch(() => {});
  }
  if (lastMousePassthrough === next) return;
  lastMousePassthrough = next;
  mainWindow.setIgnoreMouseEvents(next, { forward: true });
  mainWindow.webContents.send("overlay:mousePassthrough", {
    ignored: next,
    forced: mousePassthroughForced,
    reason,
  });
}

function sendAutoTyperEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("autoTyper:event", payload);
}

function getAutoTyperStatus() {
  if (!currentJob) return { active: false, event: null };
  const type = currentJob.stopped ? "stopping" : currentJob.paused ? "paused" : "progress";
  return {
    active: true,
    event: {
      type,
      jobId: currentJob.id,
      targetApp: currentJob.targetApp,
      index: currentJob.currentIndex,
      completed: currentJob.log?.chunksCompleted || 0,
      total: currentJob.request?.chunks?.length || currentJob.log?.chunkCount || 0,
      log: currentJob.log,
      estimatedTotalMs: currentJob.estimatedTotalMs || estimateJobDurationMs(currentJob.request),
      remainingMs: estimateRemainingMs(currentJob),
      remainingUpdatedAt: new Date().toISOString(),
    },
  };
}

function startTargetPolling() {
  if (process.platform !== "darwin") return;
  targetPollTimer = setInterval(async () => {
    if (targetPollInFlight) return;
    targetPollInFlight = true;
    try {
      await rememberFrontTarget("poll");
    } finally {
      targetPollInFlight = false;
    }
  }, 900);
}

function countVisibleUnits(text) {
  return Array.from(String(text).matchAll(/\p{L}[\p{L}\p{N}'-]*|\p{N}+(?:[.,]\p{N}+)*|[^\s]/gu)).length;
}

function isStructuredChunk(text) {
  const value = String(text || "");
  return (
    /```|~~~|\\(?:frac|sum|int|lim|sqrt|begin|end)\b|\$\S.*\S\$/.test(value) ||
    /[{}[\];]|=>|:=|==|!=|<=|>=|&&|\|\||::|->|<\/?[A-Za-z][^>]*>/.test(value) ||
    /[∑∫√∞≈≠≤≥±×÷→←↔∀∃∈∉⊂⊆∪∩∂∆∇πθλμσΩ]/.test(value) ||
    value
      .split(/\n/)
      .some((line) => /^\s*(\||[-*+]\s+|\d+[.)]\s+|>| {2,}|\t)/.test(line) || /^[\s|:-]{3,}$/.test(line))
  );
}

function calculateDelayMs(chunk, request, index) {
  const wpm = Math.max(5, Number(request.wpm) || 45);
  let delay;

  if (request.typingMode === "character") {
    delay = 60000 / (wpm * 5);
  } else if (request.typingMode === "word") {
    delay = 60000 / wpm;
  } else {
    delay = (Math.max(1, countVisibleUnits(chunk)) / wpm) * 60000;
  }

  if (request.pauseAfterSentence && /[.!?]["')\]]?\s*$/.test(chunk)) delay += 450;
  if (request.pauseAfterParagraph && /\n\s*\n$/.test(chunk)) delay += 850;
  if (request.randomizedPauses) delay += 120 + Math.random() * 900;
  if (request.pauseFrequency && index > 0 && index % Number(request.pauseFrequency) === 0) {
    delay += 1200;
  }

  return Math.max(35, Math.min(delay, 10000));
}

function estimateDelayMs(chunk, request, index) {
  const wpm = Math.max(5, Number(request.wpm) || 45);
  let delay;

  if (request.typingMode === "character") {
    delay = 60000 / (wpm * 5);
  } else if (request.typingMode === "word") {
    delay = 60000 / wpm;
  } else {
    delay = (Math.max(1, countVisibleUnits(chunk)) / wpm) * 60000;
  }

  if (request.pauseAfterSentence && /[.!?]["')\]]?\s*$/.test(chunk)) delay += 450;
  if (request.pauseAfterParagraph && /\n\s*\n$/.test(chunk)) delay += 850;
  if (request.randomizedPauses) delay += 570;
  if (request.pauseFrequency && index > 0 && index % Number(request.pauseFrequency) === 0) {
    delay += 1200;
  }

  return Math.max(35, Math.min(delay, 10000));
}

function estimateJobDurationMs(request) {
  const chunks = Array.isArray(request.chunks) ? request.chunks : [];
  return chunks.reduce((total, chunk, index) => total + estimateDelayMs(chunk, request, index), 0);
}

function estimateRemainingMs(job) {
  if (!job) return 0;
  const chunks = Array.isArray(job.request?.chunks) ? job.request.chunks : [];
  const completed = Math.min(Math.max(0, Number(job.log?.chunksCompleted) || 0), chunks.length);
  const typingRemaining = chunks
    .slice(completed)
    .reduce((total, chunk, offset) => total + estimateDelayMs(chunk, job.request, completed + offset), 0);
  return Math.max(0, typingRemaining);
}

function autoTyperTimingPayload(job, payload = {}) {
  return {
    ...payload,
    estimatedTotalMs: job.estimatedTotalMs || estimateJobDurationMs(job.request),
    remainingMs: payload.remainingMs ?? estimateRemainingMs(job),
    remainingUpdatedAt: new Date().toISOString(),
  };
}

async function waitWhilePaused(job) {
  while (!job.stopped && job.paused) {
    await sleep(180);
  }
}

async function insertChunk(job, chunk) {
  if (!job.request.lightEdits || chunk.length < 24 || isStructuredChunk(chunk) || Math.random() > 0.22) {
    await pasteTextIntoTarget(chunk);
    return;
  }

  const cut = Math.max(8, Math.floor(chunk.length * 0.58));
  const prefix = chunk.slice(0, cut);
  const suffix = chunk.slice(cut);
  await pasteTextIntoTarget(`${prefix}x`);
  await sleep(160);
  await pressBackspace(1);
  await pasteTextIntoTarget(suffix);
}

async function ensureTargetReadyForPaste(job) {
  if (process.platform !== "darwin") return true;

  const targetApp = cleanTargetAppName(job.targetApp);
  if (!targetApp) {
    throw new Error("No target document was detected. Click in the document first, then press Start.");
  }

  setAutomationWindowMode(job, true, "typing");
  const frontApp = await getFrontAppName();

  if (frontApp && frontApp !== targetApp && !isOverlayProcessName(frontApp)) {
    setAutomationWindowMode(job, false, "target-lost");
    job.paused = true;
    recordAutoTyperLogEvent(job.log, "target-lost", `Paused because focus moved to ${frontApp}.`);
    sendAutoTyperEvent(autoTyperTimingPayload(job, { type: "paused", reason: "target-lost", targetApp, frontApp, log: job.log }));
    await waitWhilePaused(job);
    if (job.stopped) return false;
    setAutomationWindowMode(job, true, "resume-target");
  }

  await focusTargetApp(targetApp, "typing");
  return true;
}

function recordAutoTyperLogEvent(log, type, message) {
  log.events.push({ at: new Date().toISOString(), type, message });
  saveDb();
}

async function runAutoTyperJob(job) {
  const { request, log } = job;
  const originalClipboard = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
  };

  try {
    setAutomationWindowMode(job, true, "auto-start");
    await focusTargetApp(job.targetApp, "typing");

    if (request.delayBeforeStartMs > 0) {
      sendAutoTyperEvent(
        autoTyperTimingPayload(job, {
          type: "countdown",
          jobId: job.id,
          targetApp: job.targetApp,
          delayMs: request.delayBeforeStartMs,
          remainingMs: estimateRemainingMs(job) + request.delayBeforeStartMs,
          log,
        }),
      );
      await sleep(request.delayBeforeStartMs);
    }

    log.startedAt = new Date().toISOString();
    recordAutoTyperLogEvent(log, "started", `Started typing into ${job.targetApp || "current app"}.`);

    if (request.preserveFormatting && request.richHtml) {
      const targetReady = await ensureTargetReadyForPaste(job);
      if (targetReady) {
        const richText = request.plainText || request.chunks.join("");
        await pasteRichContentIntoTarget(richText, request.richHtml, request.richRtf);
        log.textInserted = richText;
        log.chunksCompleted = request.chunks.length;
        if (request.saveProgressAfterEachChunk) saveDb();
        sendAutoTyperEvent(
          autoTyperTimingPayload(job, {
            type: "progress",
            jobId: job.id,
            index: request.chunks.length - 1,
            completed: log.chunksCompleted,
            total: request.chunks.length,
            log,
          }),
        );
      }
      log.stoppedAt = new Date().toISOString();
      log.status = job.stopped ? "stopped" : "completed";
      recordAutoTyperLogEvent(log, log.status, `Typing ${log.status}.`);
      sendAutoTyperEvent(autoTyperTimingPayload(job, { type: log.status, jobId: job.id, remainingMs: 0, log }));
      return;
    }

    for (let index = 0; index < request.chunks.length; index += 1) {
      job.currentIndex = index;
      await waitWhilePaused(job);
      if (job.stopped) break;

      if (job.skipRequested) {
        job.skipRequested = false;
        log.chunksSkipped += 1;
        recordAutoTyperLogEvent(log, "skipped", `Skipped chunk ${index + 1}.`);
        sendAutoTyperEvent(autoTyperTimingPayload(job, { type: "progress", jobId: job.id, index, skipped: true, log }));
        continue;
      }

      const targetReady = await ensureTargetReadyForPaste(job);
      if (!targetReady) break;

      await insertChunk(job, request.chunks[index]);
      log.textInserted += request.chunks[index];
      log.chunksCompleted += 1;
      if (request.saveProgressAfterEachChunk) saveDb();
      sendAutoTyperEvent(
        autoTyperTimingPayload(job, {
          type: "progress",
          jobId: job.id,
          index,
          completed: log.chunksCompleted,
          total: request.chunks.length,
          log,
        }),
      );

      if (request.sectionBySection && index < request.chunks.length - 1) {
        job.paused = true;
        setAutomationWindowMode(job, false, "section-pause");
        recordAutoTyperLogEvent(log, "section-pause", `Paused after section ${index + 1}.`);
        sendAutoTyperEvent(autoTyperTimingPayload(job, { type: "paused", reason: "section", targetApp: job.targetApp, log }));
      }

      await sleep(calculateDelayMs(request.chunks[index], request, index));
    }

    log.stoppedAt = new Date().toISOString();
    log.status = job.stopped ? "stopped" : "completed";
    recordAutoTyperLogEvent(log, log.status, `Typing ${log.status}.`);
    sendAutoTyperEvent(autoTyperTimingPayload(job, { type: log.status, jobId: job.id, remainingMs: 0, log }));
  } catch (error) {
    log.status = "error";
    log.stoppedAt = new Date().toISOString();
    log.errors.push(error.message || String(error));
    recordAutoTyperLogEvent(log, "error", error.message || String(error));
    sendAutoTyperEvent(autoTyperTimingPayload(job, { type: "error", jobId: job.id, error: error.message || String(error), log }));
  } finally {
    if (request.preserveClipboard) restoreClipboardSnapshot(originalClipboard);
    setAutomationWindowMode(job, false, "auto-finished");
    currentJob = null;
    saveDb();
  }
}

function textTokens(text) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "over",
    "under",
    "have",
    "has",
    "are",
    "was",
    "were",
    "but",
    "not",
    "their",
    "there",
    "which",
    "will",
    "can",
    "also",
  ]);
  return Array.from(
    new Set(
      String(text)
        .toLowerCase()
        .match(/\b[a-z][a-z0-9-]{2,}\b/g) || [],
    ),
  ).filter((word) => !stopWords.has(word));
}

function extractClaims(text) {
  const sentences = String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const claims = [];
  const claimSignals = [
    /\b\d{2,4}\b/,
    /%|\$|million|billion|increase|decrease|decline|growth|rate|study|research|evidence/i,
    /law|policy|regulation|court|legal|government|federal|state/i,
    /scientific|clinical|technical|algorithm|data|model|system|software/i,
    /defined as|is known as|refers to|causes|leads to|results in/i,
    /according to|reported|found|estimated|measured|survey/i,
  ];

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const words = countWords(sentence);
    if (words < 8) continue;
    if (/^(i think|i believe|in my opinion|personally)\b/i.test(sentence)) continue;
    const signalCount = claimSignals.filter((pattern) => pattern.test(sentence)).length;
    const capitalized = sentence.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
    const shouldCite = signalCount > 0 || (capitalized.length > 0 && words > 14);
    if (!shouldCite) continue;
    const type =
      /\d|%|\$|rate|increase|decrease/i.test(sentence)
        ? "Statistical"
        : /law|policy|court|regulation/i.test(sentence)
          ? "Legal or policy"
          : /study|scientific|clinical|research|data/i.test(sentence)
            ? "Scientific or technical"
            : "Factual";
    claims.push({
      id: `claim-${index}-${Math.abs(hashCode(sentence))}`,
      text: sentence,
      type,
      index,
    });
  }

  return claims.slice(0, 14);
}

function hashCode(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function normalizeAuthor(author) {
  if (!author) return "Unknown author";
  if (typeof author === "string") return author;
  if (author.display_name) return author.display_name;
  const parts = [author.given, author.family].filter(Boolean);
  return parts.join(" ") || author.name || "Unknown author";
}

function sourceMatchesDate(source, request) {
  const year = Number(source.year);
  if (!year) return true;
  if (request.fromYear && year < Number(request.fromYear)) return false;
  if (request.toYear && year > Number(request.toYear)) return false;
  return true;
}

function scoreSource(source, claim) {
  const claimTerms = textTokens(claim);
  const titleTerms = textTokens(source.title);
  const overlap = claimTerms.filter((term) => titleTerms.includes(term)).length;
  const ratio = claimTerms.length ? overlap / Math.max(1, claimTerms.length) : 0;
  const hasDoi = Boolean(source.doi);
  const isGov = /\.gov\b/i.test(source.url || "");
  const isScholarly = /journal|article|proceedings|preprint|dissertation/i.test(source.type || "");
  let qualityLabel = "Unverified source";
  let qualityReason = "Retrieved from a public source index, but needs manual review.";

  if (ratio < 0.06 && !isGov) {
    qualityLabel = "Possibly irrelevant source";
    qualityReason = "Low title overlap with the claim.";
  } else if ((hasDoi && isScholarly) || isGov) {
    qualityLabel = "Strong source";
    qualityReason = hasDoi ? "Scholarly source with DOI metadata." : "Government source URL.";
  } else if (hasDoi || isScholarly || /book/i.test(source.type || "")) {
    qualityLabel = "Acceptable source";
    qualityReason = "Stable bibliographic metadata was retrieved.";
  } else if (ratio > 0.15) {
    qualityLabel = "Weak source";
    qualityReason = "Relevant title terms, but limited authority metadata.";
  }

  return { qualityLabel, qualityReason, relevanceScore: Number(ratio.toFixed(2)) };
}

function dedupeSources(sources) {
  const seen = new Set();
  const unique = [];
  for (const source of sources) {
    const key = (source.doi || source.url || source.title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }
  return unique;
}

async function searchCrossref(query, request) {
  const rows = Math.min(10, Math.max(4, Number(request.sourcesNeeded || 3) + 4));
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", String(rows));
  if (request.fromYear) url.searchParams.set("filter", `from-pub-date:${request.fromYear}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "UniversalWritingOverlay/0.1 (mailto:local@example.invalid)" },
  });
  if (!response.ok) return [];
  const json = await response.json();
  return (json.message?.items || []).map((item) => {
    const year =
      item.issued?.["date-parts"]?.[0]?.[0] ||
      item.published?.["date-parts"]?.[0]?.[0] ||
      item.created?.["date-parts"]?.[0]?.[0] ||
      "";
    return {
      id: `crossref-${item.DOI || hashCode(JSON.stringify(item))}`,
      title: Array.isArray(item.title) ? item.title[0] : item.title || "Untitled source",
      authors: (item.author || []).slice(0, 6).map(normalizeAuthor),
      year,
      publisher: item.publisher || "",
      container: Array.isArray(item["container-title"]) ? item["container-title"][0] : "",
      doi: item.DOI || "",
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ""),
      type: item.type || "work",
      sourceApi: "Crossref",
    };
  });
}

async function searchOpenAlex(query, request) {
  const perPage = Math.min(10, Math.max(4, Number(request.sourcesNeeded || 3) + 4));
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(perPage));
  const filters = [];
  if (request.fromYear) filters.push(`from_publication_date:${request.fromYear}-01-01`);
  if (request.toYear) filters.push(`to_publication_date:${request.toYear}-12-31`);
  if (filters.length) url.searchParams.set("filter", filters.join(","));
  const response = await fetch(url);
  if (!response.ok) return [];
  const json = await response.json();
  return (json.results || []).map((item) => ({
    id: `openalex-${item.id || hashCode(JSON.stringify(item))}`,
    title: item.display_name || "Untitled source",
    authors: (item.authorships || []).slice(0, 6).map((entry) => normalizeAuthor(entry.author)),
    year: item.publication_year || "",
    publisher: item.primary_location?.source?.host_organization_name || "",
    container: item.primary_location?.source?.display_name || "",
    doi: item.doi ? String(item.doi).replace(/^https?:\/\/doi.org\//i, "") : "",
    url: item.primary_location?.landing_page_url || item.doi || item.id || "",
    type: item.type || "work",
    sourceApi: "OpenAlex",
  }));
}

async function searchGoogleBooks(query, request) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(Math.min(10, Math.max(4, Number(request.sourcesNeeded || 3) + 2))));
  const response = await fetch(url);
  if (!response.ok) return [];
  const json = await response.json();
  return (json.items || []).map((item) => {
    const info = item.volumeInfo || {};
    return {
      id: `books-${item.id}`,
      title: info.title || "Untitled book",
      authors: info.authors || [],
      year: info.publishedDate ? String(info.publishedDate).slice(0, 4) : "",
      publisher: info.publisher || "",
      container: "",
      doi: "",
      url: info.infoLink || "",
      type: "book",
      sourceApi: "Google Books",
    };
  });
}

async function searchSourcesForClaim(claim, request) {
  const preferences = request.sourcePreferences || [];
  if (preferences.includes("User-uploaded sources only")) {
    return [];
  }

  const searches = [];
  if (preferences.length === 0 || preferences.includes("Scholarly sources") || preferences.includes("Web sources")) {
    searches.push(searchOpenAlex(claim.text, request));
    searches.push(searchCrossref(claim.text, request));
  }
  if (preferences.includes("Books")) searches.push(searchGoogleBooks(claim.text, request));
  if (preferences.includes("News sources") || preferences.includes("Government sources")) {
    searches.push(searchCrossref(claim.text, request));
  }

  const settled = await Promise.allSettled(searches);
  const rawSources = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const filtered = rawSources.filter((source) => sourceMatchesDate(source, request));
  const scored = dedupeSources(filtered).map((source) => ({ ...source, ...scoreSource(source, claim.text) }));
  const preferred = scored.filter((source) => {
    if (preferences.includes("Government sources")) return /\.gov\b/i.test(source.url || "") || source.sourceApi !== "Google Books";
    if (preferences.includes("Books")) return /book/i.test(source.type || "") || preferences.length > 1;
    return true;
  });

  const qualityOrder = {
    "Strong source": 5,
    "Acceptable source": 4,
    "Weak source": 3,
    "Unverified source": 2,
    "Possibly irrelevant source": 1,
  };

  return preferred
    .sort((a, b) => {
      const qualityDiff = (qualityOrder[b.qualityLabel] || 0) - (qualityOrder[a.qualityLabel] || 0);
      if (qualityDiff) return qualityDiff;
      return (b.relevanceScore || 0) - (a.relevanceScore || 0);
    })
    .slice(0, Math.max(1, Number(request.sourcesNeeded || 3)));
}

async function parseOneFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    return { path: filePath, name, text: "", error: "File not found." };
  }

  try {
    const textExtensions = new Set([
      ".txt",
      ".md",
      ".markdown",
      ".csv",
      ".tsv",
      ".yaml",
      ".yml",
      ".json",
      ".jsonc",
      ".html",
      ".htm",
      ".xml",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".mjs",
      ".cjs",
      ".py",
      ".rb",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".kts",
      ".swift",
      ".c",
      ".cc",
      ".cpp",
      ".cxx",
      ".h",
      ".hpp",
      ".cs",
      ".php",
      ".sh",
      ".bash",
      ".zsh",
      ".fish",
      ".ps1",
      ".bat",
      ".sql",
      ".r",
      ".m",
      ".mm",
      ".scala",
      ".clj",
      ".hs",
      ".lua",
      ".pl",
      ".pm",
      ".tex",
      ".bib",
      ".toml",
      ".ini",
      ".env",
    ]);
    const plainTextNames = new Set(["dockerfile", "makefile", "gemfile", "rakefile", "procfile", ".gitignore"]);
    if (ext === ".html" || ext === ".htm") {
      const html = fs.readFileSync(filePath, "utf8");
      return { path: filePath, name, text: plainTextFromHtml(html), html };
    }

    if (textExtensions.has(ext) || plainTextNames.has(name.toLowerCase())) {
      const text = fs.readFileSync(filePath, "utf8");
      return { path: filePath, name, text };
    }

    if (ext === ".docx") {
      const mammoth = require("mammoth");
      const [textResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ path: filePath }),
        mammoth.convertToHtml({ path: filePath }),
      ]);
      return {
        path: filePath,
        name,
        text: textResult.value || plainTextFromHtml(htmlResult.value),
        html: htmlResult.value || "",
        warnings: [...(textResult.messages || []), ...(htmlResult.messages || [])],
      };
    }

    if (ext === ".pdf") {
      try {
        const text = (await run("pdftotext", ["-layout", filePath, "-"], { timeout: 30000 })).replace(/\f/g, "");
        if (text.trim()) return { path: filePath, name, text };
      } catch (_error) {
        // Fall through to the bundled parser when Poppler is unavailable.
      }
      const pdfParse = require("pdf-parse");
      const result = await pdfParse(fs.readFileSync(filePath));
      return { path: filePath, name, text: result.text || "" };
    }

    if ([".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"].includes(ext)) {
      try {
        const text = await run("tesseract", [filePath, "stdout"], { timeout: 30000 });
        return { path: filePath, name, text, ocr: true };
      } catch (_error) {
        return {
          path: filePath,
          name,
          text: "",
          error: "OCR needs the tesseract command-line tool installed.",
        };
      }
    }

    return { path: filePath, name, text: "", error: `Unsupported file type: ${ext}` };
  } catch (error) {
    return { path: filePath, name, text: "", error: error.message || String(error) };
  }
}

async function exportDocx(filePath, title, content) {
  const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
  const children = [
    new Paragraph({ text: title || "Writing Overlay Export", heading: HeadingLevel.TITLE }),
    ...String(content)
      .split(/\n/)
      .map((line) => new Paragraph({ text: line || " " })),
  ];
  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
}

async function exportPdf(filePath, title, content) {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 54 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(18).text(title || "Writing Overlay Export", { underline: true });
  doc.moveDown();
  doc.fontSize(10);
  for (const line of String(content).split(/\n/)) {
    doc.text(line || " ", { continued: false });
  }
  doc.end();
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const status = getAutoTyperStatus();
    sendAutoTyperEvent(
      status.event
        ? { ...status.event, duplicateSession: true, message: "Universal Writing Overlay is already running." }
        : { type: "session-active", message: "Universal Writing Overlay is already running." },
    );
  });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  loadDb();
  createWindow();
  startTargetPolling();

  const registered = globalShortcut.register(db.settings.emergencyHotkey, () => {
    if (currentJob) {
      currentJob.stopped = true;
      currentJob.paused = false;
      setAutomationWindowMode(currentJob, false, "emergency-stop");
      recordAutoTyperLogEvent(currentJob.log, "emergency-stop", "Emergency stop hotkey pressed.");
      sendAutoTyperEvent({ type: "emergency-stop", jobId: currentJob.id, log: currentJob.log });
    }
  });

  if (!registered) {
    console.warn("Could not register emergency hotkey.");
  }

  const clickThroughRegistered = globalShortcut.register(db.settings.clickThroughHotkey, () => {
    mousePassthroughForced = !mousePassthroughForced;
    setWindowMousePassthrough(mousePassthroughForced, "hotkey");
    if (!mousePassthroughForced) {
      setWindowMousePassthrough(false, "hotkey-release");
    }
  });

  if (!clickThroughRegistered) {
    console.warn("Could not register click-through hotkey.");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (targetPollTimer) clearInterval(targetPollTimer);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("app:getInitialData", async () => ({
  data: db,
  platform: process.platform,
  targetApp: lastTargetApp,
  userDataPath: app.getPath("userData"),
  hotkey: db.settings.emergencyHotkey,
  autoTyperStatus: getAutoTyperStatus(),
}));

ipcMain.handle("overlay:setAlwaysOnTop", async (_event, enabled) => {
  db.settings.alwaysOnTop = Boolean(enabled);
  saveDb();
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(Boolean(enabled), "floating");
    mainWindow.setVisibleOnAllWorkspaces(Boolean(enabled), { visibleOnFullScreen: Boolean(enabled) });
  }
  return { ok: true, enabled: Boolean(enabled) };
});

ipcMain.handle("overlay:setCollapsed", async (_event, collapsed) => {
  if (!mainWindow) return { ok: false };
  if (collapsed) {
    setWindowMousePassthrough(false, "collapsed");
  } else {
    const displayBounds = screen.getPrimaryDisplay().bounds;
    mainWindow.setBounds(displayBounds);
  }
  return { ok: true, collapsed: Boolean(collapsed) };
});

ipcMain.handle("overlay:setMousePassthrough", async (_event, ignored) => {
  if (!mousePassthroughForced) {
    setWindowMousePassthrough(Boolean(ignored), "renderer");
  }
  return { ok: true, ignored: lastMousePassthrough, forced: mousePassthroughForced };
});

ipcMain.handle("overlay:toggleMousePassthrough", async () => {
  mousePassthroughForced = !mousePassthroughForced;
  setWindowMousePassthrough(mousePassthroughForced, "manual");
  if (!mousePassthroughForced) {
    setWindowMousePassthrough(false, "manual-release");
  }
  return { ok: true, ignored: lastMousePassthrough, forced: mousePassthroughForced };
});

ipcMain.handle("overlay:windowAction", async (_event, action) => {
  if (!mainWindow) return { ok: false };
  if (action === "minimize") mainWindow.minimize();
  if (action === "close") mainWindow.close();
  return { ok: true };
});

ipcMain.handle("target:get", async () => {
  const result = await rememberFrontTarget("manual-refresh");
  return { targetApp: result.targetApp, frontApp: result.frontApp };
});

ipcMain.handle("target:captureSelectedText", async () => {
  const originalClipboard = readClipboardSnapshot();
  const targetApp = cleanTargetAppName(lastTargetApp);
  const windowState = {};
  if (!targetApp) {
    return {
      ok: false,
      text: "",
      targetApp: null,
      error: "No target document detected. Click in the document first, then try Capture.",
    };
  }

  try {
    setAutomationWindowMode(windowState, true, "capture");
    await focusTargetApp(targetApp, "capture");
    await runAppleScript('tell application "System Events" to keystroke "c" using command down', 8000);
    await sleep(260);
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    const rtf = clipboard.readRTF();
    restoreClipboardSnapshot(originalClipboard);
    return { ok: true, text, html, rtf, targetApp };
  } catch (error) {
    restoreClipboardSnapshot(originalClipboard);
    return { ok: false, text: "", targetApp, error: error.message || String(error) };
  } finally {
    setAutomationWindowMode(windowState, false, "capture-finished");
  }
});

ipcMain.handle("target:insertText", async (_event, text) => {
  const originalClipboard = clipboard.readText();
  const targetApp = cleanTargetAppName(lastTargetApp);
  const windowState = {};
  if (!targetApp) {
    return {
      ok: false,
      targetApp: null,
      error: "No target document detected. Click in the document first, then try Insert.",
    };
  }

  try {
    setAutomationWindowMode(windowState, true, "insert");
    await focusTargetApp(targetApp, "insert");
    await pasteTextIntoTarget(String(text || ""));
    clipboard.writeText(originalClipboard);
    return { ok: true, targetApp };
  } catch (error) {
    clipboard.writeText(originalClipboard);
    return { ok: false, targetApp, error: error.message || String(error) };
  } finally {
    setAutomationWindowMode(windowState, false, "insert-finished");
  }
});

ipcMain.handle("documents:selectFiles", async (_event, options = {}) => {
  const accept = String(options.accept || "");
  const extensions = Array.from(new Set(accept.match(/\.[A-Za-z0-9]+/g)?.map((part) => part.slice(1).toLowerCase()) || []));
  const filters = extensions.length
    ? [
        { name: "Supported documents", extensions },
        { name: "All files", extensions: ["*"] },
      ]
    : [{ name: "All files", extensions: ["*"] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: options.multiple === false ? ["openFile"] : ["openFile", "multiSelections"],
    filters,
  });
  if (result.canceled) return { ok: true, canceled: true, paths: [] };
  return { ok: true, canceled: false, paths: result.filePaths };
});

ipcMain.handle("documents:parseFiles", async (_event, paths) => {
  const files = Array.isArray(paths) ? paths : [];
  const results = [];
  for (const filePath of files) {
    results.push(await parseOneFile(filePath));
  }
  return results;
});

ipcMain.handle("data:set", async (_event, key, value) => {
  if (!allowedDataKeys.has(key)) return { ok: false, error: "Unsupported data key." };
  db[key] = value;
  saveDb();
  return { ok: true, data: db };
});

ipcMain.handle("data:append", async (_event, key, item) => {
  if (!allowedDataKeys.has(key)) return { ok: false, error: "Unsupported data key." };
  if (!Array.isArray(db[key])) db[key] = [];
  db[key].unshift(item);
  db[key] = db[key].slice(0, 250);
  saveDb();
  return { ok: true, data: db };
});

ipcMain.handle("data:clear", async (_event, key) => {
  if (!allowedDataKeys.has(key)) return { ok: false, error: "Unsupported data key." };
  db[key] = Array.isArray(db[key]) ? [] : null;
  saveDb();
  return { ok: true, data: db };
});

ipcMain.handle("autoTyper:start", async (_event, request) => {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Auto typing currently requires macOS Accessibility automation." };
  }

  if (currentJob) {
    return { ok: false, error: "A typing job is already running." };
  }

  const chunks = Array.isArray(request.chunks) ? request.chunks.filter(Boolean) : [];
  if (!chunks.length) return { ok: false, error: "No chunks to type." };

  const targetApp = cleanTargetAppName(lastTargetApp) || cleanTargetAppName(request.targetApp);
  if (!targetApp) {
    return {
      ok: false,
      error: "No target document detected. Click where the text should go, move to the overlay, then press Start.",
    };
  }

  const log = {
    id: `log-${Date.now()}`,
    status: "queued",
    targetApplicationName: targetApp,
    startedAt: null,
    stoppedAt: null,
    textInserted: "",
    chunkCount: chunks.length,
    chunksCompleted: 0,
    chunksSkipped: 0,
    errors: [],
    events: [],
    settings: { ...request, chunks: undefined },
  };

  db.autoTyperLogs.unshift(log);
  db.autoTyperLogs = db.autoTyperLogs.slice(0, 100);
  saveDb();

  currentJob = {
    id: log.id,
    request: { ...request, chunks },
    log,
    targetApp,
    paused: false,
    stopped: false,
    skipRequested: false,
    currentIndex: 0,
    estimatedTotalMs: estimateJobDurationMs({ ...request, chunks }),
  };

  sendAutoTyperEvent(autoTyperTimingPayload(currentJob, { type: "queued", jobId: currentJob.id, targetApp, log }));
  runAutoTyperJob(currentJob);
  return { ok: true, jobId: currentJob.id, targetApp };
});

ipcMain.handle("autoTyper:getStatus", async () => getAutoTyperStatus());

ipcMain.handle("autoTyper:pause", async () => {
  if (!currentJob) return { ok: false, error: "No active typing job." };
  currentJob.paused = true;
  setAutomationWindowMode(currentJob, false, "user-pause");
  recordAutoTyperLogEvent(currentJob.log, "paused", "Paused by user.");
  sendAutoTyperEvent(autoTyperTimingPayload(currentJob, { type: "paused", reason: "user", targetApp: currentJob.targetApp, log: currentJob.log }));
  return { ok: true };
});

ipcMain.handle("autoTyper:resume", async () => {
  if (!currentJob) return { ok: false, error: "No active typing job." };
  if (currentJob.targetApp) {
    try {
      setAutomationWindowMode(currentJob, true, "user-resume");
      await activateAppByName(currentJob.targetApp);
    } catch (_error) {
      // Resume still clears the pause so the next iteration can report any automation error.
    }
  }
  currentJob.paused = false;
  recordAutoTyperLogEvent(currentJob.log, "resumed", "Resumed by user.");
  sendAutoTyperEvent(autoTyperTimingPayload(currentJob, { type: "resumed", targetApp: currentJob.targetApp, log: currentJob.log }));
  return { ok: true };
});

ipcMain.handle("autoTyper:stop", async () => {
  if (!currentJob) return { ok: false, error: "No active typing job." };
  currentJob.stopped = true;
  currentJob.paused = false;
  setAutomationWindowMode(currentJob, false, "user-stop");
  recordAutoTyperLogEvent(currentJob.log, "stopped", "Stopped by user.");
  sendAutoTyperEvent(autoTyperTimingPayload(currentJob, { type: "stopping", targetApp: currentJob.targetApp, log: currentJob.log }));
  return { ok: true };
});

ipcMain.handle("autoTyper:skip", async () => {
  if (!currentJob) return { ok: false, error: "No active typing job." };
  currentJob.skipRequested = true;
  recordAutoTyperLogEvent(currentJob.log, "skip-requested", "Skip requested by user.");
  return { ok: true };
});

ipcMain.handle("citations:search", async (_event, request) => {
  const claims = extractClaims(request.text || "");
  const results = [];
  for (const claim of claims) {
    const sources = await searchSourcesForClaim(claim, request);
    results.push({
      ...claim,
      sources,
      warning: sources.length
        ? null
        : "No retrieved source met this search request. Add a manual source or revise the query.",
    });
  }
  return {
    ok: true,
    searchedAt: new Date().toISOString(),
    claims: results,
    notes: [
      "Only retrieved sources are shown.",
      "Page numbers are not generated unless you add them manually.",
      "Quality labels are estimates and should be reviewed before submission.",
    ],
  };
});

ipcMain.handle("export:report", async (_event, request) => {
  const format = request.format || "markdown";
  const title = request.title || "Writing Overlay Export";
  const content = request.content || "";

  if (format === "clipboard") {
    clipboard.writeText(content);
    return { ok: true, destination: "clipboard" };
  }

  const extensions = {
    markdown: "md",
    pdf: "pdf",
    docx: "docx",
  };
  const extension = extensions[format] || "txt";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${title}`,
    defaultPath: `${title.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-")}.${extension}`,
    filters: [{ name: format.toUpperCase(), extensions: [extension] }],
  });

  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  if (format === "pdf") await exportPdf(result.filePath, title, content);
  else if (format === "docx") await exportDocx(result.filePath, title, content);
  else fs.writeFileSync(result.filePath, content, "utf8");

  return { ok: true, destination: result.filePath };
});

ipcMain.handle("shell:openExternal", async (_event, url) => {
  if (url) await shell.openExternal(url);
  return { ok: true };
});
