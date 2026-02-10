import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ────────────────────────────────────────────
// HTML utilities
// ────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ────────────────────────────────────────────
// DuckDuckGo HTML search
// ────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function searchDDG(query: string): Promise<SearchResult[]> {
  try {
    const resp = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(15000) }
    );
    const html = await resp.text();

    const results: SearchResult[] = [];
    const linkPattern =
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern =
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const urls: string[] = [];
    const titles: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = linkPattern.exec(html)) !== null) {
      let href = match[1];
      const uddg = href.match(/uddg=([^&]*)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      urls.push(href);
      titles.push(stripHtml(match[2]));
    }

    const snippets: string[] = [];
    while ((match = snippetPattern.exec(html)) !== null) {
      snippets.push(stripHtml(match[1]));
    }

    for (let i = 0; i < Math.min(urls.length, 10); i++) {
      results.push({
        title: titles[i] ?? "",
        url: urls[i] ?? "",
        snippet: snippets[i] ?? "",
      });
    }

    return results;
  } catch (err) {
    console.error(`DDG search failed for "${query}":`, err);
    return [];
  }
}

// ────────────────────────────────────────────
// Page fetching (selective — skip Cloudflare sites)
// ────────────────────────────────────────────

// These domains are behind Cloudflare/SPA and reject automated fetches
const SKIP_FETCH_DOMAINS = [
  "astrobin.com",
  "cloudynights.com",
  "reddit.com",
  "stargazerslounge.com",
  "pixinsight.com",
  "youtube.com",
  "facebook.com",
];

function shouldFetchPage(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return !SKIP_FETCH_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return false;
  }
}

async function fetchPageContent(
  url: string,
  maxChars = 8000
): Promise<string | null> {
  if (!shouldFetchPage(url)) return null;
  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const text = stripHtml(html);
    // Filter out Cloudflare challenge pages
    if (
      text.length < 200 &&
      (text.includes("Just a moment") ||
        text.includes("Access Denied") ||
        text.includes("blocked"))
    ) {
      return null;
    }
    return text.slice(0, maxChars);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────
// Search query builder
// ────────────────────────────────────────────

interface SearchQuery {
  category: string;
  query: string;
}

// Determine the data type descriptor from available filters
function describeDataType(filters?: string[]): {
  label: string;      // e.g. "HaLRGB", "SHO", "LRGB", "HaRGB", "OSC"
  narrowband: string[];
  broadband: string[];
  hasL: boolean;
  hasBroadband: boolean;
  hasNarrowband: boolean;
  isSHO: boolean;
  isHOO: boolean;
} {
  const f = (filters ?? []).map((s) => s.toUpperCase());
  const narrowband = f.filter((x) =>
    ["HA", "OIII", "SII", "H-ALPHA", "O-III", "S-II"].includes(x)
  );
  const broadband = f.filter((x) => ["L", "R", "G", "B", "V"].includes(x));
  const hasL = broadband.includes("L");
  const hasBroadband = broadband.length > 0;
  const hasNarrowband = narrowband.length > 0;
  const hasHa = narrowband.some((x) => x === "HA" || x === "H-ALPHA");
  const hasOIII = narrowband.some((x) => x === "OIII" || x === "O-III");
  const hasSII = narrowband.some((x) => x === "SII" || x === "S-II");
  const isSHO = hasHa && hasOIII && hasSII;
  const isHOO = hasHa && hasOIII && !hasSII;

  let label: string;
  if (isSHO) label = "SHO";
  else if (isHOO) label = "HOO";
  else if (hasHa && hasBroadband && hasL) label = "HaLRGB";
  else if (hasHa && hasBroadband) label = "HaRGB";
  else if (hasL && hasBroadband) label = "LRGB";
  else if (hasBroadband) label = "RGB";
  else if (hasNarrowband) label = narrowband.join("+");
  else label = "OSC"; // no filters specified, assume one-shot color

  return { label, narrowband, broadband, hasL, hasBroadband, hasNarrowband, isSHO, isHOO };
}

function buildSearchQueries(
  objectName: string,
  filters?: string[],
  telescope?: string
): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const dt = describeDataType(filters);

  // 1. PixInsight workflow, tailored to data type
  queries.push({
    category: "pixinsight_workflow",
    query: `"${objectName}" ${dt.label} processing PixInsight workflow`,
  });

  // 2. Astrobin — with data type for relevant results
  queries.push({
    category: "astrobin",
    query: `site:astrobin.com "${objectName}" ${dt.label} processing`,
  });

  // 3. Forum discussions — tailored to data type
  queries.push({
    category: "forum",
    query: `"${objectName}" ${dt.label} processing recipe PixInsight`,
  });

  // 4. Narrowband-specific queries
  if (dt.hasNarrowband) {
    queries.push({
      category: "narrowband",
      query: `"${objectName}" ${dt.narrowband.join(" ")} narrowband processing PixInsight`,
    });
  }

  // 5. HaLRGB / HaRGB combination (only if both narrowband + broadband)
  if (dt.hasBroadband && dt.hasNarrowband) {
    queries.push({
      category: "combination",
      query: `"${objectName}" ${dt.label} narrowband broadband combination PixInsight`,
    });
  }

  // 6. SHO / HOO palette mapping (only if user actually has multi-narrowband)
  if (dt.isSHO) {
    queries.push({
      category: "palette",
      query: `"${objectName}" SHO Hubble palette mapping PixInsight`,
    });
  } else if (dt.isHOO) {
    queries.push({
      category: "palette",
      query: `"${objectName}" HOO bicolor palette PixInsight`,
    });
  }

  // 7. Telescope-specific if provided
  if (telescope) {
    queries.push({
      category: "equipment_match",
      query: `"${objectName}" "${telescope}" ${dt.label} astrophotography processing`,
    });
  }

  // 8. Modern tools workflow
  queries.push({
    category: "modern_workflow",
    query: `"${objectName}" StarXTerminator BlurXTerminator ${dt.label} PixInsight`,
  });

  // 9. YouTube tutorials — with data type
  queries.push({
    category: "tutorial",
    query: `"${objectName}" ${dt.label} PixInsight processing tutorial site:youtube.com`,
  });

  // 10. General processing advice
  queries.push({
    category: "general",
    query: `"${objectName}" ${dt.label} astrophotography image processing`,
  });

  return queries;
}

// ────────────────────────────────────────────
// Result scoring (modernity + domain quality)
// ────────────────────────────────────────────

// Modern PixInsight tools (post-2020 era) — presence signals a modern workflow
const MODERN_TOOLS: Array<[RegExp, number]> = [
  [/StarXTerminator|SXT/i, 3],
  [/NoiseXTerminator|NXT/i, 3],
  [/BlurXTerminator|BXT/i, 3],
  [/SPCC|SpectrophotometricColor/i, 2],
  [/GHS|GeneralizedHyperbolicStretch|Generali[sz]ed\s*Hyperbolic/i, 2],
  [/GraXpert/i, 2],
  [/RC[\s-]?Astro/i, 1],
  [/BlurX|NoiseX|StarX/i, 2],
  [/NBNormali[sz]ation/i, 1],
  [/EZ[\s-]?Suite|EZ[\s-]?Denoise|EZ[\s-]?Process/i, 1],
];

// Recent year mentions (2020+) signal modern workflow
const RECENT_YEARS = /\b(202[0-9])\b/g;

function scoreResult(text: string, url: string): number {
  let score = 0;

  // Modern tool mentions (biggest signal)
  for (const [pattern, weight] of MODERN_TOOLS) {
    if (pattern.test(text)) score += weight;
  }

  // Recent year mentions
  const years = text.match(RECENT_YEARS);
  if (years) {
    const maxYear = Math.max(...years.map(Number));
    // More recent = more points: 2024+ => 3, 2022-23 => 2, 2020-21 => 1
    if (maxYear >= 2024) score += 3;
    else if (maxYear >= 2022) score += 2;
    else if (maxYear >= 2020) score += 1;
  }

  // Domain quality bonus
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes("astrobin.com")) score += 2;
    else if (hostname.includes("cloudynights.com")) score += 1;
    else if (hostname.includes("pixinsight.com")) score += 2;
    else if (hostname.includes("stargazerslounge.com")) score += 1;
  } catch {
    // ignore
  }

  // Penalty for very old tool mentions without modern ones
  if (score === 0 && /\b(TGV|ACDNR|LocalHistogramEqualization)\b/i.test(text)) {
    score -= 2;
  }

  return score;
}

// ────────────────────────────────────────────
// Tool registration
// ────────────────────────────────────────────

export function registerResearchTools(server: McpServer): void {
  server.tool(
    "search_processing_recommendations",
    `Search astrophotography forums, Astrobin, and the web for processing
recommendations for a deep sky object. Runs targeted searches across
multiple sources (Astrobin, Cloudy Nights, PixInsight forums, YouTube
tutorials, blogs) and returns search results with snippets and page
content where accessible. The search is tailored to the available
filter channels (narrowband, broadband, combination techniques).
Results are prioritized by source quality.`,
    {
      objectName: z
        .string()
        .describe(
          "Deep sky object name or catalog ID (e.g. 'Bubble Nebula', 'NGC 7635', 'M42')"
        ),
      filters: z
        .array(z.string())
        .optional()
        .describe(
          "Available filter channels (e.g. ['Ha', 'OIII', 'R', 'G', 'B', 'L'])"
        ),
      telescope: z
        .string()
        .optional()
        .describe(
          "Telescope or focal length to find similar setups"
        ),
    },
    async ({ objectName, filters, telescope }) => {
      const dt = describeDataType(filters);
      const queries = buildSearchQueries(objectName, filters, telescope);

      // Run all searches in parallel
      const searchBatches = await Promise.all(
        queries.map(async (q) => {
          const results = await searchDDG(q.query);
          return { category: q.category, query: q.query, results };
        })
      );

      // Flatten, deduplicate, and score
      const seen = new Set<string>();
      const allResults: Array<
        SearchResult & { category: string; score: number }
      > = [];
      for (const { category, results } of searchBatches) {
        for (const r of results) {
          if (!seen.has(r.url) && r.url.startsWith("http")) {
            seen.add(r.url);
            const text = `${r.title} ${r.snippet}`;
            const score = scoreResult(text, r.url);
            allResults.push({ ...r, category, score });
          }
        }
      }

      // Sort by modernity score (descending), then domain quality
      allResults.sort((a, b) => b.score - a.score);

      // Take top results and fetch accessible pages in parallel
      const topResults = allResults.slice(0, 12);
      const pageContents = await Promise.all(
        topResults.map((r) => fetchPageContent(r.url))
      );

      // Re-score with page content if available, then re-sort
      const scored = topResults.map((r, i) => {
        let finalScore = r.score;
        if (pageContents[i]) {
          finalScore += scoreResult(pageContents[i], r.url);
        }
        return { ...r, finalScore, pageContent: pageContents[i] };
      });
      scored.sort((a, b) => b.finalScore - a.finalScore);

      // Build structured output
      const recommendations = scored.map((r) => {
        let source: string;
        try {
          source = new URL(r.url).hostname.replace("www.", "");
        } catch {
          source = "unknown";
        }
        const entry: Record<string, unknown> = {
          source,
          category: r.category,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          modernityScore: r.finalScore,
        };
        if (r.pageContent) {
          entry.pageContent = r.pageContent;
        }
        return entry;
      });

      const output = {
        objectName,
        dataType: dt.label,
        filters: filters ?? [],
        searchesPerformed: queries.map((q) => `[${q.category}] ${q.query}`),
        totalResultsFound: allResults.length,
        recommendations,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );
}
