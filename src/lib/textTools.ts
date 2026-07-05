import type { TypingMode } from "../types";

export function countWords(text: string): number {
  return (text.trim().match(/\b[\w'-]+\b/g) || []).length;
}

export function countVisibleUnits(text: string): number {
  return Array.from(text.matchAll(/\p{L}[\p{L}\p{N}'-]*|\p{N}+(?:[.,]\p{N}+)*|[^\s]/gu)).length;
}

function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locale?: string | string[],
      options?: { granularity: "grapheme" | "word" | "sentence" },
    ) => { segment(value: string): Iterable<{ segment: string }> };
  }).Segmenter;
  if (typeof Segmenter === "function") {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

export function splitSentences(text: string): string[] {
  return (
    text
      .match(/(?:[^\s.!?](?:[^.!?]|\.(?=\d)|\.(?=[A-Za-z]\.)|[!?](?=[\w"'()[\]{}]))*[.!?]+["')\]]*\s*|[^.!?]+$)/g)
      ?.map((part) => part)
      .filter(Boolean) || []
  );
}

export function splitParagraphs(text: string): string[] {
  const pieces = text.split(/(\n\s*\n)/);
  const paragraphs: string[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const current = pieces[index] || "";
    if (!current) continue;
    if (/^\n\s*\n$/.test(current) && paragraphs.length) {
      paragraphs[paragraphs.length - 1] += current;
    } else {
      paragraphs.push(current);
    }
  }
  return paragraphs.filter((part) => part.length > 0);
}

export function createChunks(text: string, mode: TypingMode): string[] {
  if (!text) return [];

  if (mode === "character") return splitGraphemes(text);
  if (mode === "word") return text.match(/\S+\s*/g) || [];
  if (mode === "sentence") return splitSentences(text);
  return splitParagraphs(text);
}

export function estimateDurationSeconds(chunks: string[], mode: TypingMode, wpm: number): number {
  const safeWpm = Math.max(5, wpm || 45);
  if (mode === "character") return chunks.length * (60 / (safeWpm * 5));
  if (mode === "word") return chunks.length * (60 / safeWpm);
  return chunks.reduce((total, chunk) => total + (Math.max(1, countVisibleUnits(chunk)) / safeWpm) * 60, 0);
}

export function textFromFiles(files: FileList | File[] | string[] | ArrayLike<File | string>): string[] {
  return Array.from(files as ArrayLike<File | string>).map((file) => (typeof file === "string" ? file : (file as File & { path?: string }).path || ""));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return "under 1 sec";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function downloadNameSafe(value: string): string {
  return value.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "export";
}

export function uniqueLines(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line.toLowerCase())) return false;
      seen.add(line.toLowerCase());
      return true;
    });
}
