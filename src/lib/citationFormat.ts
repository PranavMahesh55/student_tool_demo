import type { CitationStyle, ClaimResult, SourceRecord } from "../types";

function firstAuthorLast(source: SourceRecord): string {
  const author = source.authors?.[0] || "Unknown";
  const cleaned = author.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "Unknown author") return "Unknown";
  if (cleaned.includes(",")) return cleaned.split(",")[0].trim();
  const parts = cleaned.split(" ");
  return parts[parts.length - 1] || cleaned;
}

function authorList(source: SourceRecord): string {
  if (!source.authors?.length) return "Unknown author";
  if (source.authors.length === 1) return source.authors[0];
  if (source.authors.length === 2) return `${source.authors[0]} and ${source.authors[1]}`;
  return `${source.authors[0]} et al.`;
}

function year(source: SourceRecord): string {
  return source.year ? String(source.year) : "n.d.";
}

export function sourceKey(source: SourceRecord): string {
  return (source.doi || source.url || source.title || source.id).toLowerCase();
}

export function dedupeSources(sources: SourceRecord[]): SourceRecord[] {
  const seen = new Set<string>();
  const unique: SourceRecord[] = [];
  for (const source of sources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }
  return unique;
}

export function formatInlineCitation(
  style: CitationStyle,
  sources: SourceRecord[],
  numberMap: Map<string, number>,
): string {
  if (!sources.length) return "";
  if (style === "IEEE") {
    const numbers = sources.map((source) => numberMap.get(sourceKey(source))).filter(Boolean);
    return `[${numbers.join(", ")}]`;
  }

  if (style === "MLA") {
    return `(${sources.map((source) => firstAuthorLast(source)).join("; ")})`;
  }

  if (style === "Chicago") {
    return `(${sources.map((source) => `${firstAuthorLast(source)} ${year(source)}`).join("; ")})`;
  }

  return `(${sources.map((source) => `${firstAuthorLast(source)}, ${year(source)}`).join("; ")})`;
}

export function formatBibliography(style: CitationStyle, sources: SourceRecord[]): string {
  const unique = dedupeSources(sources);
  if (!unique.length) return "";

  return unique
    .map((source, index) => {
      const authors = authorList(source);
      const title = source.title || "Untitled source";
      const container = source.container ? `${source.container}. ` : "";
      const publisher = source.publisher ? `${source.publisher}. ` : "";
      const doiOrUrl = source.doi ? `https://doi.org/${source.doi}` : source.url || "";

      if (style === "IEEE") {
        return `[${index + 1}] ${authors}, "${title}," ${container}${publisher}${year(source)}. ${doiOrUrl}`.trim();
      }

      if (style === "MLA") {
        return `${authors}. "${title}." ${container}${publisher}${year(source)}. ${doiOrUrl}`.trim();
      }

      if (style === "Chicago") {
        return `${authors}. ${year(source)}. "${title}." ${container}${publisher}${doiOrUrl}`.trim();
      }

      return `${authors}. (${year(source)}). ${title}. ${container}${publisher}${doiOrUrl}`.trim();
    })
    .join("\n");
}

function addCitationToSentence(sentence: string, citation: string): string {
  if (!citation) return sentence;
  const trimmed = sentence.trimEnd();
  const trailingSpace = sentence.slice(trimmed.length);
  const match = trimmed.match(/([.!?])(["')\]]*)$/);
  if (!match) return `${trimmed} ${citation}${trailingSpace}`;
  const punctuation = match[1];
  const closer = match[2] || "";
  const body = trimmed.slice(0, trimmed.length - match[0].length);
  return `${body} ${citation}${punctuation}${closer}${trailingSpace}`;
}

export function buildCitationOutput(
  originalText: string,
  claims: ClaimResult[],
  approvedByClaim: Record<string, string[]>,
  style: CitationStyle,
): { revisedText: string; bibliography: string; usedSources: SourceRecord[] } {
  const usedSources: SourceRecord[] = [];
  for (const claim of claims) {
    const approvedIds = new Set(approvedByClaim[claim.id] || []);
    const sources = claim.sources.filter((source) => approvedIds.has(source.id));
    usedSources.push(...sources);
  }

  const uniqueSources = dedupeSources(usedSources);
  const numberMap = new Map<string, number>();
  uniqueSources.forEach((source, index) => numberMap.set(sourceKey(source), index + 1));

  let revisedText = originalText;
  for (const claim of claims) {
    const approvedIds = new Set(approvedByClaim[claim.id] || []);
    const sources = claim.sources.filter((source) => approvedIds.has(source.id));
    if (!sources.length) continue;
    const citation = formatInlineCitation(style, sources, numberMap);
    const replacement = addCitationToSentence(claim.text, citation);
    revisedText = revisedText.replace(claim.text, replacement);
  }

  return {
    revisedText,
    bibliography: formatBibliography(style, uniqueSources),
    usedSources: uniqueSources,
  };
}

export function sourcePreview(source: SourceRecord): string {
  const bits = [
    source.title,
    source.authors?.length ? authorList(source) : "",
    source.year ? String(source.year) : "",
    source.doi ? `DOI: ${source.doi}` : source.url || "",
  ].filter(Boolean);
  return bits.join(" | ");
}
