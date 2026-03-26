# I built an autonomous astrophotography processing pipeline where Claude drives PixInsight

After spending too many evenings manually tweaking LHE amounts, HDRMT iterations, and saturation curves in PixInsight -- often ending up with worse results after hours of experimentation -- I decided to let an LLM do the creative decision-making. The result is a system where Claude (via Claude Code) autonomously processes deep sky images through PixInsight, from calibrated masters to finished output.

## How it works

The system has two phases. The first is a deterministic prep stage written in plain Node.js: open masters, align, combine channels, gradient correction, BXT, SPCC color calibration, noise reduction, star extraction, and statistical stretch. This is the boring-but-necessary linear processing that does not benefit from creative judgment. It runs in about 12 minutes and is cached -- same inputs, same code, no reprocessing.

The second phase is where things get interesting. A Claude agent (spawned as a `claude -p` subprocess using a Max subscription, so no API costs) receives the prepped working assets plus a system prompt dynamically built from the target's classification and traits. The agent has access to 53 tools that map directly to PixInsight operations -- curves, masks, LHE, HDRMT, Ha injection, star blending, everything. It then drives PixInsight through a structured creative workflow.

The key architectural idea is **bracket-then-critic**. For each of four independent branches (luminance detail, faint structure/IFN, color/saturation, and stars), the agent must generate four candidates at increasing intensity: restrained, target, edge, and overdone. The overdone candidate is mandatory -- if the agent cannot show something that is clearly too aggressive, it has not searched enough of the parameter space. After generating all candidates, the agent switches to critic mode, compares them, identifies the rejection boundary, and selects winners. Then it composes multiple final candidates from the branch winners and picks the best one.

This matters because the failure mode of LLM-driven processing is convergence to safe mediocrity. The agent naturally wants to produce something "clean" and "balanced" -- which in astrophotography means washed out, flat, and boring. The bracketing discipline forces it to find the edge before choosing where to land.

## Quality gates the AI cannot bypass

One thing I learned quickly: prompting the agent to "avoid ringing" is not enough. It will say "I checked and there is no ringing" while the image clearly has concentric oscillation patterns around the galaxy core. So the quality checks are now implemented as actual PJSR code that runs inside PixInsight and measures pixel values.

The `finish` tool (which the agent must call to complete processing) automatically runs all gates. If any fail, the agent gets the failure reason and must fix the issue before trying again:

- **Ringing detection**: Scans bright cores for oscillation patterns. Zero tolerance.
- **Star quality**: Detects stars, measures FWHM (< 6px) and color diversity (> 0.05). At least 50 stars must be present.
- **Core burning**: Galaxy core must retain structure -- less than 2% of core pixels above 0.98.

These are code constraints, not suggestions. The agent literally cannot produce a finished image with ringing artifacts.

## Hierarchical memory -- it learns across targets

The system maintains a 5-level knowledge store: universal rules, trait-level knowledge, type-level knowledge, data-class-level, and target-specific. When processing a new target, it recalls all relevant memories based on the target's classification and processing traits.

The interesting part is auto-promotion. After every run, a memory optimizer checks for patterns: if the same parameter value wins across 3+ targets of the same type, that knowledge promotes from target-level to type-level. If it holds across multiple types that share a processing trait, it promotes to trait-level.

Concretely: the system learned from processing M81 that spiral galaxies with bright cores need HDRMT maskClipLow >= 0.35 to avoid ringing. That knowledge now applies automatically to any target classified with the `core_halo` structural zone trait -- including edge-on galaxies, ellipticals, globular clusters, and planetary nebulae it has never processed before.

## Target taxonomy

Rather than hardcoding processing recipes, I built a taxonomy of 12 deep sky object categories, each defined by 7 processing-relevant trait dimensions (signal type, structural zones, color zonation, star relationship, faint structure goal, subject scale, dynamic range). The system prompt is built entirely from these traits -- zero target-specific text. The same generic orchestrator prompt handles M81 (spiral galaxy, HaLRGB, IFN goal, high dynamic range) and M97 (planetary nebula, LRGB, core-halo structure, outer halo goal) by adapting behavior through the trait-driven classification.

## Results so far

I have processed M81/M82 (HaLRGB spiral galaxy with IFN), M97 Owl Nebula (LRGB planetary nebula), and Abell 2151 Hercules Cluster (LRGB galaxy cluster) through this system. The M97 result on first attempt with zero target-specific tuning was genuinely impressive -- internal shell structure resolved, faint outer halo visible, natural star colors. Each run takes about 12 minutes for prep (cached after first run) plus 30-60 minutes for the creative phase.

## What is NOT automated

To be clear about scope: this does not handle data acquisition, telescope control, calibration, or stacking. It expects WBPP-stacked master frames as input. It also does not replace human aesthetic judgment entirely -- there is still a feedback loop where you look at results and adjust the intent (e.g., "push IFN harder" or "too much saturation on red"). But it handles the tedious parameter exploration that previously took hours of manual experimentation.

## Honest limitations

- Bridge latency is about 2 seconds per tool call, which adds up across 53 tools and many iterations
- Creative phase runs are 30-60 minutes (the agent makes many tool calls)
- The agent sometimes needs 2-3 attempts to get quality gates to pass (especially ringing on aggressive HDRMT)
- Star handling is still the weakest branch -- SXT leaves residuals on bright galaxy features that contaminate the star layer
- Memory system is effective but young -- needs more targets to build a robust knowledge base

## Open source / work in progress

The project is on GitHub at [pixinsight-mcp](https://github.com/aescaffre/pixinsight-mcp) (work in progress, actively developed). You need PixInsight with BXT/NXT/SXT, Node.js 22+, and a Claude Max subscription. It runs on macOS (ARM tested); Linux is untested but likely works.

Happy to answer questions about the architecture, the bracket-then-critic approach, or how the taxonomy/memory system works. This has been a fascinating intersection of AI agent design and domain-specific image processing.
