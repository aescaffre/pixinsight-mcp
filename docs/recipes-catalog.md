# Processing Recipes Catalog

## Concept

The recipes catalog is a searchable database of PixInsight post-processing workflows contributed by the astrophotography community. Each recipe documents a proven approach for processing a specific type of target, always with attribution to its original source.

The AI assistant uses this catalog as its primary knowledge base when a user wants to process an object. It can also search online for new recipes to supplement the catalog.

## What is a Recipe?

A recipe is a structured description of a post-processing workflow — the sequence of PixInsight operations applied to integrated data (post-WBPP) to produce a final image.

### Recipe Schema

```json
{
  "id": "m42-lrgbha-deep-2024-01",
  "title": "M42 LRGB+Ha Deep Field Processing",
  "version": 1,

  "target": {
    "objects": ["M42", "NGC 1976"],
    "type": "emission_nebula",
    "constellation": "Orion",
    "tags": ["nebula", "hydrogen-alpha", "wide-field"]
  },

  "input": {
    "filters": ["L", "R", "G", "B", "Ha"],
    "startingPoint": "post-wbpp",
    "description": "Integrated masters from WBPP: L, R, G, B, Ha"
  },

  "source": {
    "url": "https://example-astro-blog.com/m42-processing-tutorial",
    "author": "Jane Astronomer",
    "platform": "blog",
    "datePublished": "2024-03-15",
    "dateCollected": "2025-01-20"
  },

  "resultImage": {
    "url": "https://example-astro-blog.com/images/m42-final.jpg",
    "localPath": null,
    "thumbnailPath": null
  },

  "steps": [
    {
      "order": 1,
      "name": "Dynamic Crop",
      "process": "DynamicCrop",
      "description": "Crop stacking artifacts from edges",
      "parameters": {},
      "notes": "Apply to all integrated masters"
    },
    {
      "order": 2,
      "name": "Gradient Removal (L)",
      "process": "AutomaticBackgroundExtractor",
      "description": "Remove gradients from luminance",
      "parameters": {
        "polyDegree": 4,
        "tolerance": 1.0
      },
      "targetChannel": "L",
      "notes": "Repeat for each channel"
    },
    {
      "order": 3,
      "name": "Color Calibration",
      "process": "SpectrophotometricColorCalibration",
      "description": "Calibrate colors using plate-solved image",
      "parameters": {},
      "targetChannel": "RGB",
      "notes": "Image must be plate-solved first"
    },
    {
      "order": 4,
      "name": "Noise Reduction (linear)",
      "process": "MultiscaleLinearTransform",
      "description": "Wavelet noise reduction on linear data",
      "parameters": {
        "layers": 4
      },
      "notes": "Apply before stretching"
    },
    {
      "order": 5,
      "name": "Histogram Stretch",
      "process": "HistogramTransformation",
      "description": "Stretch to non-linear",
      "parameters": {},
      "notes": "Use STF auto-stretch values as starting point"
    },
    {
      "order": 6,
      "name": "Ha Blend",
      "process": "PixelMath",
      "description": "Blend Ha into luminance and red channel",
      "parameters": {
        "expression": "max($T, Ha_stretched)"
      },
      "notes": "Blend ratio depends on Ha signal strength"
    },
    {
      "order": 7,
      "name": "LRGB Combination",
      "process": "LRGBCombination",
      "description": "Combine luminance with color data",
      "parameters": {}
    },
    {
      "order": 8,
      "name": "Curves",
      "process": "CurvesTransformation",
      "description": "Final contrast and saturation adjustment",
      "parameters": {}
    }
  ],

  "metadata": {
    "difficulty": "intermediate",
    "estimatedTime": "45 minutes",
    "pixinsightVersion": "1.8.9",
    "thirdPartyRequired": [],
    "totalExposure": null,
    "collectedBy": "on-demand",
    "collectedAt": "2025-01-20T14:30:00Z"
  }
}
```

## Key Design Principles

### 1. Always Attribute Sources

Every recipe **must** link back to where the workflow was found. Supported platforms:

| Platform | Example URL patterns |
|---|---|
| **AstroBin** | `astrobin.com/users/...`, `astrobin.com/...` |
| **WebAstro** | `webastro.net/forum/...` |
| **Cloudy Nights** | `cloudynights.com/topic/...` |
| **PixInsight Forum** | `pixinsight.com/forum/...` |
| **Personal blogs** | Any URL |
| **YouTube** | `youtube.com/watch?v=...` |
| **Astro Bin descriptions** | Processing details in image descriptions |

### 2. Start After WBPP

Recipes begin with **integrated masters** (the output of WBPP or manual pre-processing). We assume:
- Calibration (bias, dark, flat) is done
- Registration (alignment) is done
- Integration (stacking) is done
- Input = one master file per filter/channel

This simplifies recipes significantly and matches how most tutorials are structured.

### 3. Searchable by Object

The primary search key is the **astronomical object** (M42, NGC 7000, IC 1805, etc.). Secondary search dimensions:
- Object type (galaxy, nebula, cluster, planetary, etc.)
- Filter set (LRGB, SHO, HOO, broadband, narrowband, mono, OSC)
- Difficulty level
- Third-party tools required

### 4. Recipes are Guidelines, Not Rigid Scripts

Many processing steps require judgment (e.g., "stretch until the nebula looks right"). Recipes capture:
- The **sequence** of operations
- **Suggested parameters** as starting points
- **Notes** explaining the reasoning and what to look for

The AI can adapt parameters based on the actual data (e.g., adjusting noise reduction strength based on image statistics).

## Catalog Storage

### Phase 1: Local JSON Files

```
~/.pixinsight-mcp/
  catalog/
    recipes/
      m42-lrgbha-deep-2024-01.json
      m31-lrgb-mosaic-2024-02.json
      ...
    index.json          # Object -> recipe ID mapping for fast lookup
    sources.json        # Tracked source URLs to avoid duplicates
```

### Phase 2: SQLite Database

For faster querying and full-text search as the catalog grows:
- FTS5 index on object names, tags, descriptions
- Efficient filtering by object type, filters, difficulty

### Phase 3: Shared Online Catalog

Eventually, a shared catalog that users can contribute to and pull from. This is the "user portal" future vision.

## Recipe Lifecycle

### Discovery — Three Modes

#### Mode 1: On-Demand (Default — Zero Cost When Idle)

When a user asks to process an object, Claude searches the web *at that moment* for tutorials and extracts recipes. This is the baseline — it costs nothing until someone actually needs it.

```
User asks about M82 -> search web -> extract recipes -> cache in catalog -> present options
```

**Pros**: No ongoing cost, always fresh results, only pays for what's used.
**Cons**: Slower first-time experience for a given object, depends on web search quality.

#### Mode 2: Manual / AI-Assisted Entry

A user or contributor provides a URL and the AI extracts a structured recipe from it:

```
User: "Import this tutorial: https://astro-blog.com/m42-processing"
Claude: [reads page, extracts steps, creates recipe, asks user to review]
```

#### Mode 3: Proactive Crawler (Future — Budget Required)

A background intelligence process that systematically builds the catalog by crawling known sources for a reference list of deep sky objects. This is the "dream mode" that makes the catalog rich before any user asks for a specific object.

**How it works:**

1. **Reference object list** — A curated list of ~200-500 popular deep sky targets (Messier catalog, bright NGC/IC objects, Sharpless nebulae, well-known targets). Prioritized by popularity in the astrophotography community.

2. **Source crawl schedule** — For each object, periodically search known platforms:
   - AstroBin: search for the object, read processing details from top-rated images
   - Cloudy Nights / WebAstro / PI Forum: search for "[object] processing" threads
   - Blogs: web search for "[object] PixInsight processing tutorial"
   - YouTube: search for "[object] PixInsight" (extract from descriptions/transcripts)

3. **AI extraction** — For each found source, the AI reads the content and extracts a structured recipe. This is the expensive step (LLM calls).

4. **Deduplication** — Compare against existing recipes by source URL and content similarity. Only add genuinely new approaches.

5. **Freshness check** — Re-crawl periodically (monthly?) to find new tutorials for objects already in the catalog.

**Cost structure:**
- Web searches: cheap (or free with search APIs)
- Page fetches: cheap
- AI extraction (LLM calls): **this is where the cost is** — one call per source page to extract a structured recipe
- Rough estimate: ~2-5 LLM calls per object per source platform = ~1,000-5,000 calls for an initial crawl of 200 objects across 5 platforms

**Crawl priorities:**
| Priority | Objects | Rationale |
|---|---|---|
| P0 | Messier catalog (110 objects) | Most commonly photographed |
| P1 | Bright NGC (NGC 7000, 2024, 6992...) | Popular extended targets |
| P2 | Sharpless / IC highlights (Sh2-129, IC 1805...) | Popular narrowband targets |
| P3 | Long tail (lesser-known objects) | On-demand is fine here |

**Implementation options:**
- **CLI command**: `pixinsight-mcp crawl --objects messier --sources astrobin,cloudynights` — run manually when you want to build the catalog
- **Scheduled job**: cron/launchd that runs the crawler weekly/monthly
- **Budget cap**: stop after N LLM calls per run to control costs

**Recommendation**: Start with Mode 1 (on-demand) and Mode 2 (manual import). Add Mode 3 later when the project has momentum and you want to pre-populate the catalog. The catalog schema and storage are the same regardless of how recipes get in — so nothing is lost by deferring the crawler.

### Curation
- Recipes can be **rated** after use (did the result look good?)
- Recipes can be **versioned** (updated with better parameters)
- Duplicate/similar recipes for the same object give the user options
- Crawler-imported recipes are marked `"collectedBy": "crawler"` vs `"collectedBy": "manual"` or `"collectedBy": "on-demand"`

### Usage Flow
```
User: "I want to process M81"
  |
  v
Claude: search_recipes({ object: "M81" })
  |
  v
[Found 2 local recipes]
  |
  v
Claude: search_new_recipes({ object: "M81", query: "M81 PixInsight processing tutorial" })
  |
  v
[Found 1 new blog post, extracts recipe]
  |
  v
Claude: presents 3 options to user:
  1. "M81 LRGB Classic" (source: Cloudy Nights forum, 2024) — result image shown
  2. "M81 LHaRGB Deep" (source: AstroBin description, 2024) — result image shown
  3. "M81 Narrowband Palette" (source: new blog post, 2025) — no result image
  |
  v
User: picks option 2
  |
  v
Claude: executes each step via PixInsight MCP tools
```

## MCP Tools for the Catalog

See [mcp-tools.md](mcp-tools.md) for the full tool definitions. Key catalog-related tools:

- `search_recipes` — Search local catalog by object, type, filters
- `get_recipe` — Get full recipe details by ID
- `add_recipe` — Add a new recipe to the catalog (from structured data)
- `import_recipe_from_url` — AI reads a URL and extracts a recipe
- `execute_recipe` — Run a recipe step-by-step on loaded images
- `rate_recipe` — Rate a recipe after use

## Known Sources to Seed the Catalog

Initial sources to build the catalog from:

- **AstroBin** — Image descriptions often contain detailed processing workflows
- **Cloudy Nights Forum** — "Image Processing" subforum
- **WebAstro Forum** (French) — Active community with processing tutorials
- **PixInsight Forum** — Workflows and tips from the PI community
- **Light Vortex Astronomy** — Detailed PI tutorials (lightvortexastronomy.com)
- **Adam Block** — Professional tutorials
- **Astro Imaging Channel** — YouTube tutorials with PI workflows
- **Astronomy Tools Blog** — Processing write-ups
- **Reddit r/astrophotography** — Processing details in comments
