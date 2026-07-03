export type TypingMode = "character" | "word" | "sentence" | "paragraph" | "custom";
export type CitationStyle = "APA" | "MLA" | "Chicago" | "IEEE";

export interface SourceRecord {
  id: string;
  title: string;
  authors: string[];
  year?: string | number;
  publisher?: string;
  container?: string;
  doi?: string;
  url?: string;
  type?: string;
  sourceApi?: string;
  qualityLabel?: string;
  qualityReason?: string;
  relevanceScore?: number;
  manual?: boolean;
}

export interface ClaimResult {
  id: string;
  text: string;
  type: string;
  index: number;
  sources: SourceRecord[];
  warning?: string | null;
}

export interface StyleProfile {
  id: string;
  createdAt: string;
  sampleCount: number;
  wordCount: number;
  averageSentenceLength: number;
  averageParagraphLength: number;
  sentenceLengthVariation: number;
  paragraphLengthVariation: number;
  vocabularyLevel: "plain" | "moderate" | "advanced";
  formalityLevel: "casual" | "balanced" | "formal";
  toneSummary: string;
  styleSummary: string;
  commonTransitions: string[];
  commonVocabulary: string[];
  punctuationHabits: string[];
  contractionRate: number;
  activeVoiceHint: string;
  structurePatterns: string[];
  commonlyDoes: string[];
  rarelyDoes: string[];
  rewriteInstructions: string;
}

export interface RewriteResult {
  rewritten: string;
  changes: string[];
  styleMatchScore: number;
  meaningWarning?: string;
  toneNotes: string[];
}

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  keywords: string[];
}

export interface RubricCriterionResult extends RubricCriterion {
  status: "Fully met" | "Mostly met" | "Partially met" | "Not met";
  evidence: string;
  missing: string;
  whyPointsMayBeLost: string;
  suggestedFix: string;
  estimatedScore: number;
  confidence: number;
}

export interface RubricReport {
  id: string;
  createdAt: string;
  mode: string;
  overallScore: number;
  riskLevel: "Low" | "Medium" | "High";
  wordCount: number;
  biggestIssues: string[];
  mustFix: string[];
  niceToFix: string[];
  missingRequirements: string[];
  weakEvidenceWarnings: string[];
  citationWarnings: string[];
  suggestedEdits: string[];
  revisionChecklist: string[];
  criteria: RubricCriterionResult[];
  annotatedParagraphs: Array<{
    id: string;
    text: string;
    flags: string[];
    matchedCriteria: string[];
  }>;
  markdown: string;
}
