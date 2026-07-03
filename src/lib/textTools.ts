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

function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function isMathFenceLine(line: string): boolean {
  return /^\s*(\$\$|\\\[|\\\]|\\begin\{(?:equation|align|align\*|gather|gather\*|matrix|pmatrix|bmatrix|cases)\}|\\end\{(?:equation|align|align\*|gather|gather\*|matrix|pmatrix|bmatrix|cases)\})\s*$/.test(
    line,
  );
}

function isCodeLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /^( {2,}|\t)/.test(line) ||
    /^(import|export|from|class|def|function|const|let|var|if|else|for|while|switch|case|try|catch|return|public|private|protected|interface|type|enum|namespace|package|using|#include|SELECT|WITH|UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)\b/.test(
      trimmed,
    ) ||
    /^[}\])};,]+$/.test(trimmed) ||
    /[{}[\];]|=>|:=|==|!=|<=|>=|&&|\|\||::|->|<\/?[A-Za-z][^>]*>/.test(trimmed)
  );
}

function isMathLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /\\(?:frac|sum|int|lim|sqrt|alpha|beta|gamma|theta|lambda|mu|pi|sigma|Delta|nabla|cdot|times|leq|geq|neq|approx|infty|begin|end)\b/.test(
      trimmed,
    ) ||
    /\$\S.*\S\$/.test(trimmed) ||
    /(?:^|[\s(])[A-Za-z0-9_]+\s*=\s*[-+*/^()[\]{}\w\s.,]+$/.test(trimmed) ||
    /[∑∫√∞≈≠≤≥±×÷→←↔∀∃∈∉⊂⊆∪∩∂∆∇πθλμσΩ]/.test(trimmed)
  );
}

function isTableOrListLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(\|.*\||[-*+]\s+|\d+[.)]\s+|>\s+)/.test(trimmed) || /^\s*[-:| ]{3,}\s*$/.test(trimmed);
}

function isStructuredLine(line: string): boolean {
  return isCodeLikeLine(line) || isMathLikeLine(line) || isTableOrListLine(line);
}

function pushStructuredChunk(chunks: string[], value: string) {
  if (value) chunks.push(value);
}

export function splitStructured(text: string): string[] {
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) || [];
  const chunks: string[] = [];
  let prose = "";
  let structured = "";
  let inFence = false;
  let inMathBlock = false;

  function flushProse() {
    if (!prose) return;
    splitSentences(prose).forEach((part) => pushStructuredChunk(chunks, part));
    prose = "";
  }

  function flushStructured() {
    pushStructuredChunk(chunks, structured);
    structured = "";
  }

  for (const line of lines) {
    const blank = line.trim().length === 0;
    const opensFence = isFenceLine(line);
    const mathFence = isMathFenceLine(line);
    const shouldStayWhole = inFence || inMathBlock || opensFence || mathFence || isStructuredLine(line);

    if (shouldStayWhole) {
      flushProse();
      structured += line;
      if (opensFence) inFence = !inFence;
      if (mathFence) inMathBlock = !inMathBlock;
      continue;
    }

    if (structured) flushStructured();
    prose += line;
    if (blank) flushProse();
  }

  flushProse();
  flushStructured();
  return chunks.filter((part) => part.length > 0);
}

export function createChunks(text: string, mode: TypingMode, customChunkSize = 40): string[] {
  if (!text) return [];

  if (mode === "structured") return splitStructured(text);
  if (mode === "character") return splitGraphemes(text);
  if (mode === "word") return text.match(/\S+\s*/g) || [];
  if (mode === "sentence") return splitSentences(text);
  if (mode === "paragraph") return splitParagraphs(text);

  const words = text.match(/\S+\s*/g) || [];
  const size = Math.max(1, customChunkSize);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += size) {
    chunks.push(words.slice(index, index + size).join(""));
  }
  return chunks;
}

export function estimateDurationSeconds(chunks: string[], mode: TypingMode, wpm: number): number {
  const safeWpm = Math.max(5, wpm || 45);
  if (mode === "character") return chunks.length * (60 / (safeWpm * 5));
  if (mode === "word") return chunks.length * (60 / safeWpm);
  return chunks.reduce((total, chunk) => total + (Math.max(1, countVisibleUnits(chunk)) / safeWpm) * 60, 0);
}

export function textFromFiles(files: FileList | File[]): string[] {
  return Array.from(files).map((file) => (file as File & { path?: string }).path || "");
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
