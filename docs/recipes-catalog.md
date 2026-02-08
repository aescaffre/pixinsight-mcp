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
    "totalExposure": null
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

### Discovery
1. **Manual entry**: User or contributor writes a recipe from a tutorial
2. **AI-assisted collection**: Claude reads a blog post/tutorial URL and extracts a structured recipe
3. **Online search**: When a user asks about an object, Claude searches for tutorials and creates new recipes

### Curation
- Recipes can be **rated** after use (did the result look good?)
- Recipes can be **versioned** (updated with better parameters)
- Duplicate/similar recipes for the same object give the user options

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
