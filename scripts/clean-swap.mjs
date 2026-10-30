#!/usr/bin/env node
// Clean orphaned PixInsight swap files. Safe rule: delete ~PI~* entries whose creation time
// (birthtime, fallback mtime) is EARLIER than the live PixInsight process start time.
// If PI is not running, every ~PI~* entry is an orphan. Never touches newer entries.
// Usage: node scripts/clean-swap.mjs [--dry-run]
import { cleanOrphanSwap } from '../agents/llm/disk-hygiene.mjs';
cleanOrphanSwap({ dryRun: process.argv.includes('--dry-run') });
