import type { RewriteResult, StyleProfile } from "../types";
import { countWords, makeId, splitParagraphs, splitSentences } from "./textTools";

const transitionCandidates = [
  "however",
  "therefore",
  "also",
  "because",
  "for example",
  "in contrast",
  "as a result",
  "in addition",
  "overall",
  "instead",
  "meanwhile",
  "first",
  "finally",
];

const roboticPhrases: Array<[RegExp, string]> = [
  [/\bit is important to note that\b/gi, ""],
  [/\bin today's fast-paced world\b/gi, ""],
  [/\bplays a crucial role in\b/gi, "matters for"],
  [/\butilize\b/gi, "use"],
  [/\bfacilitate\b/gi, "help"],
  [/\bmoreover\b/gi, "also"],
  [/\badditionally\b/gi, "also"],
  [/\bthis essay will discuss\b/gi, "this draft examines"],
];

const simplerWords: Array<[RegExp, string]> = [
  [/\bapproximately\b/gi, "about"],
  [/\bdemonstrates\b/gi, "shows"],
  [/\bsignificant\b/gi, "important"],
  [/\bsubsequently\b/gi, "later"],
  [/\bcommence\b/gi, "start"],
  [/\bterminate\b/gi, "end"],
  [/\bobtain\b/gi, "get"],
];

const casualPairs: Array<[RegExp, string]> = [
  [/\bdo not\b/gi, "don't"],
  [/\bdoes not\b/gi, "doesn't"],
  [/\bcannot\b/gi, "can't"],
  [/\bwill not\b/gi, "won't"],
  [/\bit is\b/gi, "it's"],
  [/\bthat is\b/gi, "that's"],
];

const formalPairs: Array<[RegExp, string]> = [
  [/\bdon't\b/gi, "do not"],
  [/\bdoesn't\b/gi, "does not"],
  [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"],
  [/\bit's\b/gi, "it is"],
  [/\bthat's\b/gi, "that is"],
];

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variation(values: number[]): number {
  const avg = average(values);
  if (!values.length) return 0;
  const variance = average(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function topWords(text: string, limit = 18): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "that",
    "with",
    "this",
    "from",
    "have",
    "has",
    "are",
    "was",
    "were",
    "but",
    "not",
    "you",
    "your",
    "they",
    "their",
    "there",
    "into",
    "about",
    "because",
  ]);
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/\b[a-z][a-z'-]{3,}\b/g) || []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function transitionUse(text: string): string[] {
  const lower = text.toLowerCase();
  return transitionCandidates.filter((candidate) => lower.includes(candidate));
}

function punctuationHabits(text: string): string[] {
  const habits: string[] = [];
  const sentenceCount = Math.max(1, splitSentences(text).length);
  if ((text.match(/;/g) || []).length / sentenceCount > 0.08) habits.push("Uses semicolons");
  if ((text.match(/:/g) || []).length / sentenceCount > 0.08) habits.push("Uses colon-led explanations");
  if ((text.match(/\?/g) || []).length / sentenceCount > 0.06) habits.push("Uses rhetorical questions");
  if ((text.match(/\([^)]{6,}\)/g) || []).length / sentenceCount > 0.1) habits.push("Uses parenthetical asides");
  if (!habits.length) habits.push("Mostly straightforward sentence punctuation");
  return habits;
}

export function analyzeStyleProfile(samples: string[]): StyleProfile {
  const corpus = samples.join("\n\n").trim();
  const sentences = splitSentences(corpus);
  const paragraphs = splitParagraphs(corpus);
  const sentenceLengths = sentences.map(countWords).filter(Boolean);
  const paragraphLengths = paragraphs.map(countWords).filter(Boolean);
  const words = countWords(corpus);
  const avgSentence = average(sentenceLengths);
  const avgParagraph = average(paragraphLengths);
  const contractionCount = (corpus.match(/\b\w+'(?:t|re|ve|ll|d|m|s)\b/gi) || []).length;
  const contractionRate = words ? contractionCount / words : 0;
  const longWordRate = ((corpus.match(/\b[a-zA-Z]{9,}\b/g) || []).length || 0) / Math.max(1, words);
  const vocabularyLevel = longWordRate > 0.12 ? "advanced" : longWordRate > 0.065 ? "moderate" : "plain";
  const formalityLevel = contractionRate > 0.018 ? "casual" : longWordRate > 0.1 ? "formal" : "balanced";
  const transitions = transitionUse(corpus);
  const punctuation = punctuationHabits(corpus);
  const commonVocabulary = topWords(corpus);

  const structurePatterns = [
    avgSentence < 16 ? "Prefers shorter sentences" : avgSentence > 26 ? "Builds longer, layered sentences" : "Uses medium-length sentences",
    avgParagraph < 85 ? "Keeps paragraphs compact" : avgParagraph > 170 ? "Develops longer paragraphs" : "Uses moderate paragraph blocks",
    variation(sentenceLengths) > 9 ? "Varies sentence length noticeably" : "Keeps sentence rhythm fairly even",
  ];

  const commonlyDoes = [
    transitions.length ? `Uses transitions like ${transitions.slice(0, 4).join(", ")}` : "Moves directly between ideas",
    punctuation[0],
    formalityLevel === "casual" ? "Uses contractions and direct phrasing" : "Keeps a controlled tone",
  ];

  const rarelyDoes = [
    contractionRate < 0.006 ? "Rarely uses contractions" : "Rarely sounds stiff for long stretches",
    avgSentence < 18 ? "Rarely relies on very long sentences" : "Rarely uses fragment-like sentences",
  ];

  const toneSummary =
    formalityLevel === "formal"
      ? "Formal, careful, and explanation-oriented"
      : formalityLevel === "casual"
        ? "Conversational, direct, and flexible"
        : "Balanced, clear, and practical";

  const styleSummary = `${toneSummary}. Average sentence length is ${avgSentence.toFixed(
    1,
  )} words and average paragraph length is ${avgParagraph.toFixed(1)} words. Vocabulary reads as ${vocabularyLevel}.`;

  return {
    id: makeId("style"),
    createdAt: new Date().toISOString(),
    sampleCount: samples.length,
    wordCount: words,
    averageSentenceLength: Number(avgSentence.toFixed(1)),
    averageParagraphLength: Number(avgParagraph.toFixed(1)),
    sentenceLengthVariation: Number(variation(sentenceLengths).toFixed(1)),
    paragraphLengthVariation: Number(variation(paragraphLengths).toFixed(1)),
    vocabularyLevel,
    formalityLevel,
    toneSummary,
    styleSummary,
    commonTransitions: transitions,
    commonVocabulary,
    punctuationHabits: punctuation,
    contractionRate: Number(contractionRate.toFixed(4)),
    activeVoiceHint: "Prefer direct subject-verb phrasing unless the source text requires passive voice.",
    structurePatterns,
    commonlyDoes,
    rarelyDoes,
    rewriteInstructions: [
      styleSummary,
      `Use ${avgSentence < 16 ? "short, direct" : avgSentence > 26 ? "longer, developed" : "medium-length"} sentences.`,
      `Keep the tone ${formalityLevel}.`,
      transitions.length ? `Use familiar transitions sparingly: ${transitions.slice(0, 6).join(", ")}.` : "Avoid forcing transitions.",
      "Preserve meaning, citations, technical terms, and required formatting.",
    ].join(" "),
  };
}

function protectPatterns(text: string, keepCitations: boolean) {
  const placeholders: string[] = [];
  let output = text;
  if (keepCitations) {
    output = output.replace(/(\([^)]*\b\d{4}\b[^)]*\)|\[[\d,\s-]+\])/g, (match) => {
      const token = `__KEEP_${placeholders.length}__`;
      placeholders.push(match);
      return token;
    });
  }
  return {
    text: output,
    restore(value: string) {
      return placeholders.reduce((current, original, index) => current.replace(`__KEEP_${index}__`, original), value);
    },
  };
}

function applyPairs(text: string, pairs: Array<[RegExp, string]>, changes: string[], label: string): string {
  let output = text;
  for (const [pattern, replacement] of pairs) {
    if (pattern.test(output)) {
      output = output.replace(pattern, replacement);
      changes.push(label);
    }
  }
  return output;
}

function splitLongSentences(text: string, targetLength: number): string {
  return splitSentences(text)
    .map((sentence) => {
      if (countWords(sentence) < targetLength + 8) return sentence;
      return sentence
        .replace(/,\s+which\s+/i, ". This ")
        .replace(/;\s+/g, ". ")
        .replace(/,\s+and\s+/i, ". It also ");
    })
    .join("");
}

function scoreStyleMatch(text: string, profile: StyleProfile | null): number {
  if (!profile) return 48;
  const sentences = splitSentences(text);
  const avgSentence = average(sentences.map(countWords).filter(Boolean));
  const sentenceDiff = Math.abs(avgSentence - profile.averageSentenceLength);
  const sentenceScore = Math.max(0, 45 - sentenceDiff * 2.3);
  const contractions = (text.match(/\b\w+'(?:t|re|ve|ll|d|m|s)\b/gi) || []).length / Math.max(1, countWords(text));
  const contractionDiff = Math.abs(contractions - profile.contractionRate);
  const contractionScore = Math.max(0, 25 - contractionDiff * 900);
  const vocab = profile.commonVocabulary.slice(0, 10).filter((word) => text.toLowerCase().includes(word)).length;
  return Math.round(Math.min(96, 30 + sentenceScore + contractionScore + vocab * 2));
}

export function rewriteWithStyle(
  text: string,
  profile: StyleProfile | null,
  controls: {
    strength: "light" | "normal" | "strong";
    tone: "profile" | "clearer" | "simpler" | "formal" | "casual";
    preserveMeaning: boolean;
    makeClearer: boolean;
    makeSimpler: boolean;
    makeFormal: boolean;
    makeCasual: boolean;
    keepCitations: boolean;
    keepFormatting: boolean;
    reduceRobotic: boolean;
    preserveTechnicalTerms: boolean;
  },
): RewriteResult {
  const changes: string[] = [];
  const toneNotes: string[] = [];
  const protectedText = protectPatterns(text, controls.keepCitations);
  let output = protectedText.text;

  if (controls.reduceRobotic) output = applyPairs(output, roboticPhrases, changes, "Reduced robotic phrasing");
  if (controls.makeSimpler || controls.tone === "simpler") output = applyPairs(output, simplerWords, changes, "Simplified vocabulary");

  const shouldCasual = controls.makeCasual || controls.tone === "casual" || (controls.tone === "profile" && profile?.formalityLevel === "casual");
  const shouldFormal = controls.makeFormal || controls.tone === "formal" || (controls.tone === "profile" && profile?.formalityLevel === "formal");
  if (shouldCasual && !shouldFormal) {
    output = applyPairs(output, casualPairs, changes, "Matched a more conversational contraction pattern");
    toneNotes.push("Tone moved more conversational.");
  }
  if (shouldFormal && !shouldCasual) {
    output = applyPairs(output, formalPairs, changes, "Expanded contractions for formality");
    toneNotes.push("Tone moved more formal.");
  }

  if (controls.makeClearer || controls.tone === "clearer") {
    const target = profile?.averageSentenceLength ? Math.max(14, profile.averageSentenceLength) : 22;
    output = splitLongSentences(output, target);
    changes.push("Split or tightened long sentences where possible");
  }

  if (profile && controls.strength !== "light") {
    if (profile.averageSentenceLength < 17) {
      output = splitLongSentences(output, profile.averageSentenceLength);
      changes.push("Adjusted sentence rhythm toward the profile");
    }
    if (profile.commonTransitions.length && controls.strength === "strong") {
      const firstTransition = profile.commonTransitions[0];
      output = output.replace(/\bhowever\b/i, firstTransition);
      changes.push("Nudged transitions toward profile habits");
    }
  }

  output = output
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\n{3,}/g, controls.keepFormatting ? "\n\n" : "\n\n")
    .trim();

  output = protectedText.restore(output);

  const originalWords = countWords(text);
  const outputWords = countWords(output);
  const delta = originalWords ? Math.abs(outputWords - originalWords) / originalWords : 0;
  const meaningWarning =
    controls.preserveMeaning && delta > 0.32
      ? "Meaning preservation needs review because the rewrite changed length substantially."
      : undefined;

  if (!changes.length) changes.push("Kept the rewrite conservative to preserve meaning");
  if (profile) toneNotes.push(profile.toneSummary);

  return {
    rewritten: output,
    changes: Array.from(new Set(changes)),
    styleMatchScore: scoreStyleMatch(output, profile),
    meaningWarning,
    toneNotes,
  };
}

export function checkConsistency(text: string, profile: StyleProfile | null) {
  const paragraphs = splitParagraphs(text).filter((paragraph) => countWords(paragraph) > 4);
  return paragraphs.map((paragraph, index) => {
    const sentenceAvg = average(splitSentences(paragraph).map(countWords).filter(Boolean));
    const flags: string[] = [];
    if (profile) {
      if (Math.abs(sentenceAvg - profile.averageSentenceLength) > 10) flags.push("Sentence length differs from profile");
      if (profile.formalityLevel === "casual" && !/\b\w+'(?:t|re|ve|ll|d|m|s)\b/i.test(paragraph)) {
        flags.push("May sound more formal than your samples");
      }
      if (profile.formalityLevel === "formal" && /\b\w+'(?:t|re|ve|ll|d|m|s)\b/i.test(paragraph)) {
        flags.push("May sound more casual than your samples");
      }
    }
    if (/it is important to note|plays a crucial role|in today's/i.test(paragraph)) flags.push("Generic or robotic phrasing");
    if (countWords(paragraph) < 35) flags.push("Paragraph may be underdeveloped");
    return {
      id: `style-check-${index}`,
      paragraph,
      flags,
      score: flags.length ? Math.max(35, 90 - flags.length * 18) : 92,
    };
  });
}
