// Research processing recommendations for Bubble Nebula HaRGB

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function searchDDG(query) {
  try {
    const resp = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(15000) }
    );
    const html = await resp.text();
    const results = [];
    const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const urls = [], titles = [];
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      let href = match[1];
      const uddg = href.match(/uddg=([^&]*)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      urls.push(href);
      titles.push(stripHtml(match[2]));
    }
    const snippets = [];
    while ((match = snippetPattern.exec(html)) !== null) {
      snippets.push(stripHtml(match[1]));
    }
    for (let i = 0; i < Math.min(urls.length, 10); i++) {
      results.push({ title: titles[i] || "", url: urls[i] || "", snippet: snippets[i] || "" });
    }
    return results;
  } catch (e) {
    console.error(`Search failed for "${query}":`, e.message);
    return [];
  }
}

const MODERN_TOOLS = [
  [/StarXTerminator|SXT/i, 3], [/NoiseXTerminator|NXT/i, 3], [/BlurXTerminator|BXT/i, 3],
  [/SPCC|SpectrophotometricColor/i, 2], [/GHS|GeneralizedHyperbolicStretch/i, 2],
  [/GraXpert/i, 2], [/RC[\s-]?Astro/i, 1], [/BlurX|NoiseX|StarX/i, 2],
  [/NBNormali[sz]ation/i, 1],
];

function score(text) {
  let s = 0;
  for (const [p, w] of MODERN_TOOLS) if (p.test(text)) s += w;
  const years = text.match(/\b(202[0-9])\b/g);
  if (years) {
    const m = Math.max(...years.map(Number));
    if (m >= 2024) s += 3; else if (m >= 2022) s += 2; else if (m >= 2020) s += 1;
  }
  return s;
}

// HaRGB-specific queries for Bubble Nebula
const queries = [
  { cat: "workflow", q: '"Bubble Nebula" HaRGB processing PixInsight workflow' },
  { cat: "astrobin", q: 'site:astrobin.com "NGC 7635" Ha RGB processing' },
  { cat: "forum", q: '"Bubble Nebula" Ha RGB processing recipe PixInsight' },
  { cat: "narrowband", q: '"Bubble Nebula" Ha narrowband RGB processing workflow PixInsight' },
  { cat: "combination", q: '"NGC 7635" Ha luminance RGB combination PixInsight' },
  { cat: "modern", q: '"Bubble Nebula" StarXTerminator BlurXTerminator PixInsight' },
  { cat: "tutorial", q: '"Bubble Nebula" PixInsight processing tutorial site:youtube.com' },
  { cat: "general", q: 'NGC 7635 Ha RGB astrophotography processing 2024' },
];

const t0 = Date.now();
const batches = await Promise.all(queries.map(async (q) => {
  const results = await searchDDG(q.q);
  return { cat: q.cat, results };
}));

const seen = new Set();
const all = [];
for (const { cat, results } of batches) {
  for (const r of results) {
    if (!seen.has(r.url) && r.url.startsWith("http")) {
      seen.add(r.url);
      const s = score(`${r.title} ${r.snippet}`);
      all.push({ ...r, cat, score: s });
    }
  }
}
all.sort((a, b) => b.score - a.score);

console.log(`=== BUBBLE NEBULA HaRGB RESEARCH (${all.length} results, ${Date.now() - t0}ms) ===\n`);
for (const r of all.slice(0, 20)) {
  console.log(`[score=${r.score}] [${r.cat}] ${r.title}`);
  console.log(`  ${r.url}`);
  if (r.snippet) console.log(`  ${r.snippet.slice(0, 250)}`);
  console.log();
}
