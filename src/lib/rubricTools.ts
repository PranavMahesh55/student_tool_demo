import type { RubricCriterion, RubricCriterionResult, RubricReport } from "../types";
import { countWords, makeId, splitParagraphs, splitSentences, uniqueLines } from "./textTools";

function keywords(text: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "that",
    "with",
    "from",
    "this",
    "your",
    "you",
    "will",
    "must",
    "should",
    "shall",
    "are",
    "was",
    "were",
    "have",
    "has",
    "use",
    "using",
    "include",
    "includes",
    "students",
    "assignment",
  ]);
  return Array.from(new Set((text.toLowerCase().match(/\b[a-z][a-z-]{3,}\b/g) || []).filter((word) => !stop.has(word)))).slice(
    0,
    16,
  );
}

function parseWeight(line: string): number | null {
  const percent = line.match(/(\d{1,3})\s*%/);
  if (percent) return Number(percent[1]);
  const points = line.match(/(\d+(?:\.\d+)?)\s*(?:pts?|points?)\b/i);
  if (points) return Number(points[1]);
  const slash = line.match(/\/\s*(\d+(?:\.\d+)?)/);
  if (slash) return Number(slash[1]);
  return null;
}

export function parseRubricCriteria(rubric: string, instructions = ""): RubricCriterion[] {
  const lines = uniqueLines(`${rubric}\n${instructions}`);
  const candidates = lines.filter((line) => {
    if (line.length < 8) return false;
    return /^(\d+[\).:-]|\-|\*|#{1,4}\s+|\|)/.test(line) || /criterion|criteria|requires|must|points?|%/i.test(line);
  });

  const source = candidates.length ? candidates : lines.filter((line) => line.length > 18);
  const criteria = source.slice(0, 18).map((line, index) => {
    const cleaned = line
      .replace(/^\|/, "")
      .replace(/\|$/g, "")
      .replace(/^(\d+[\).:-]|\-|\*|#{1,4})\s*/, "")
      .trim();
    const [namePart, ...rest] = cleaned.split(/\s[-:]\s/);
    return {
      id: `criterion-${index}-${Math.abs(hash(namePart))}`,
      name: namePart.slice(0, 80) || `Criterion ${index + 1}`,
      description: rest.join(" - ") || cleaned,
      weight: parseWeight(cleaned) ?? 1,
      keywords: keywords(cleaned),
    };
  });

  if (!criteria.length && (rubric.trim() || instructions.trim())) {
    const combined = `${rubric}\n${instructions}`.trim();
    criteria.push({
      id: "criterion-overall",
      name: "Overall prompt alignment",
      description: combined,
      weight: 1,
      keywords: keywords(combined),
    });
  }

  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0) || criteria.length || 1;
  return criteria.map((criterion) => ({ ...criterion, weight: criterion.weight / total }));
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result << 5) - result + value.charCodeAt(index);
    result |= 0;
  }
  return result;
}

function bestEvidence(documentParagraphs: string[], criterion: RubricCriterion) {
  let best = "";
  let bestScore = 0;
  for (const paragraph of documentParagraphs) {
    const lower = paragraph.toLowerCase();
    const overlap = criterion.keywords.filter((word) => lower.includes(word)).length;
    const density = overlap / Math.max(1, criterion.keywords.length);
    const score = density + Math.min(0.25, countWords(paragraph) / 400);
    if (score > bestScore) {
      bestScore = score;
      best = paragraph;
    }
  }
  return { evidence: best, score: bestScore };
}

function criterionStatus(score: number, mode: string): RubricCriterionResult["status"] {
  const strictPenalty = mode === "Devil's advocate reviewer" || mode === "Strict reviewer" ? 0.08 : 0;
  const adjusted = score - strictPenalty;
  if (adjusted >= 0.72) return "Fully met";
  if (adjusted >= 0.5) return "Mostly met";
  if (adjusted >= 0.25) return "Partially met";
  return "Not met";
}

function statusScore(status: RubricCriterionResult["status"]): number {
  if (status === "Fully met") return 1;
  if (status === "Mostly met") return 0.78;
  if (status === "Partially met") return 0.48;
  return 0.15;
}

function citationWarnings(document: string) {
  const warnings: string[] = [];
  const sentences = splitSentences(document);
  for (const sentence of sentences) {
    const factualSignal = /\b\d{2,4}\b|%|study|research|data|law|policy|increase|decrease|found|reported|according to/i.test(sentence);
    const hasCitation = /\([^)]*\b\d{4}\b[^)]*\)|\[[\d,\s-]+\]|https?:\/\//i.test(sentence);
    if (factualSignal && !hasCitation && countWords(sentence) > 9) {
      warnings.push(sentence.trim());
    }
  }
  return warnings.slice(0, 8);
}

function paragraphFlags(paragraph: string, citationFlagSet: Set<string>) {
  const flags: string[] = [];
  if (countWords(paragraph) < 45) flags.push("May be underdeveloped");
  if (!/\b(because|therefore|evidence|example|shows|suggests|means)\b/i.test(paragraph) && countWords(paragraph) > 70) {
    flags.push("Needs clearer explanation");
  }
  if (citationFlagSet.has(paragraph)) flags.push("Citation may be needed");
  if (/\bvery|really|things|stuff|good|bad\b/i.test(paragraph)) flags.push("Vague wording");
  return flags;
}

function estimateRisk(score: number, mustFixCount: number): RubricReport["riskLevel"] {
  if (score < 70 || mustFixCount >= 4) return "High";
  if (score < 86 || mustFixCount >= 2) return "Medium";
  return "Low";
}

export function evaluateRubric(options: {
  document: string;
  rubric: string;
  instructions: string;
  mode: string;
  gradingScale: number;
  targetScore?: number;
  citationStyle?: string;
  minWords?: number;
  maxWords?: number;
}): RubricReport {
  const criteria = parseRubricCriteria(options.rubric, options.instructions);
  const paragraphs = splitParagraphs(options.document).filter((paragraph) => paragraph.trim());
  const docLower = options.document.toLowerCase();
  const results: RubricCriterionResult[] = criteria.map((criterion) => {
    const coverage = criterion.keywords.length
      ? criterion.keywords.filter((word) => docLower.includes(word)).length / criterion.keywords.length
      : 0.2;
    const { evidence, score } = bestEvidence(paragraphs, criterion);
    const blendedScore = Math.min(1, coverage * 0.58 + score * 0.42);
    const status = criterionStatus(blendedScore, options.mode);
    return {
      ...criterion,
      status,
      evidence: evidence.slice(0, 420),
      missing:
        status === "Fully met"
          ? "No obvious missing piece detected."
          : `Needs clearer coverage of: ${criterion.keywords.filter((word) => !docLower.includes(word)).slice(0, 5).join(", ") || criterion.name}.`,
      whyPointsMayBeLost:
        status === "Fully met"
          ? "This criterion appears supported by the draft."
          : "A strict reviewer may see limited direct evidence, unclear alignment, or incomplete explanation.",
      suggestedFix:
        status === "Fully met"
          ? "Keep this section intact while revising surrounding weak areas."
          : `Add a targeted sentence or paragraph that explicitly addresses "${criterion.name}" and connects it to evidence.`,
      estimatedScore: Number((statusScore(status) * options.gradingScale * criterion.weight).toFixed(1)),
      confidence: Number(Math.min(0.92, 0.48 + blendedScore * 0.42).toFixed(2)),
    };
  });

  const weightedScore =
    results.reduce((sum, criterion) => sum + statusScore(criterion.status) * criterion.weight, 0) * options.gradingScale;
  const wordCount = countWords(options.document);
  const wordWarnings: string[] = [];
  if (options.minWords && wordCount < options.minWords) wordWarnings.push(`Draft is below the minimum word count (${wordCount}/${options.minWords}).`);
  if (options.maxWords && wordCount > options.maxWords) wordWarnings.push(`Draft is above the maximum word count (${wordCount}/${options.maxWords}).`);

  const citationIssues = citationWarnings(options.document);
  const mustFix = [
    ...results
      .filter((criterion) => criterion.status === "Not met" || criterion.status === "Partially met")
      .map((criterion) => `Strengthen: ${criterion.name}`),
    ...wordWarnings,
    ...citationIssues.slice(0, 3).map((warning) => `Add support or citation for: ${warning.slice(0, 120)}`),
  ].slice(0, 10);

  const niceToFix = results
    .filter((criterion) => criterion.status === "Mostly met")
    .map((criterion) => `Make "${criterion.name}" more explicit.`)
    .slice(0, 8);

  const citationFlagParagraphs = new Set(
    paragraphs.filter((paragraph) => citationIssues.some((issue) => paragraph.includes(issue.slice(0, 32)))),
  );

  const annotatedParagraphs = paragraphs.map((paragraph, index) => ({
    id: `paragraph-${index}`,
    text: paragraph,
    flags: paragraphFlags(paragraph, citationFlagParagraphs),
    matchedCriteria: results
      .filter((criterion) => criterion.keywords.some((word) => paragraph.toLowerCase().includes(word)))
      .map((criterion) => criterion.name)
      .slice(0, 3),
  }));

  const overallScore = Number(weightedScore.toFixed(1));
  const riskLevel = estimateRisk((overallScore / options.gradingScale) * 100, mustFix.length);
  const biggestIssues = [
    ...mustFix.slice(0, 4),
    ...(citationIssues.length ? [`${citationIssues.length} citation/support gap(s) detected.`] : []),
  ].slice(0, 5);

  const suggestedEdits = results
    .filter((criterion) => criterion.status !== "Fully met")
    .map((criterion) => criterion.suggestedFix)
    .slice(0, 8);

  const revisionChecklist = [
    ...mustFix.map((item) => item.replace(/^Strengthen: /, "Revise criterion: ")),
    ...niceToFix,
    "Run one final pass for citation style, formatting, and word count.",
  ].slice(0, 12);

  const report: Omit<RubricReport, "markdown"> = {
    id: makeId("rubric"),
    createdAt: new Date().toISOString(),
    mode: options.mode,
    overallScore,
    riskLevel,
    wordCount,
    biggestIssues,
    mustFix,
    niceToFix,
    missingRequirements: results.filter((criterion) => criterion.status !== "Fully met").map((criterion) => criterion.name),
    weakEvidenceWarnings: annotatedParagraphs
      .filter((paragraph) => paragraph.flags.length)
      .map((paragraph) => `${paragraph.flags.join(", ")}: ${paragraph.text.slice(0, 140)}`)
      .slice(0, 8),
    citationWarnings: citationIssues,
    suggestedEdits,
    revisionChecklist,
    criteria: results,
    annotatedParagraphs,
  };

  return { ...report, markdown: reportToMarkdown(report) };
}

function reportToMarkdown(report: Omit<RubricReport, "markdown">): string {
  const lines = [
    `# Rubric Review Report`,
    ``,
    `Created: ${new Date(report.createdAt).toLocaleString()}`,
    `Mode: ${report.mode}`,
    `Overall score estimate: ${report.overallScore}`,
    `Risk level: ${report.riskLevel}`,
    `Word count: ${report.wordCount}`,
    ``,
    `## Biggest Issues`,
    ...list(report.biggestIssues),
    ``,
    `## Must-Fix Items`,
    ...list(report.mustFix),
    ``,
    `## Nice-to-Fix Items`,
    ...list(report.niceToFix),
    ``,
    `## Rubric Breakdown`,
    ...report.criteria.flatMap((criterion) => [
      `### ${criterion.name}`,
      `Status: ${criterion.status}`,
      `Estimated score: ${criterion.estimatedScore}`,
      `Evidence: ${criterion.evidence || "No direct evidence found."}`,
      `Missing: ${criterion.missing}`,
      `Why points may be lost: ${criterion.whyPointsMayBeLost}`,
      `Suggested fix: ${criterion.suggestedFix}`,
      ``,
    ]),
    `## Citation Warnings`,
    ...list(report.citationWarnings),
    ``,
    `## Revision Checklist`,
    ...report.revisionChecklist.map((item, index) => `${index + 1}. ${item}`),
  ];
  return lines.join("\n");
}

function list(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["- None detected."];
}
