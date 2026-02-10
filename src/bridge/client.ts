import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { BridgeCommand, BridgeResult, BridgeConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class BridgeClient {
  private config: BridgeConfig;
  private commandsDir: string;
  private resultsDir: string;
  private logsDir: string;

  constructor(config?: Partial<BridgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const bridgeDir = expandHome(this.config.bridgeDir);
    this.commandsDir = join(bridgeDir, "commands");
    this.resultsDir = join(bridgeDir, "results");
    this.logsDir = join(bridgeDir, "logs");
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.commandsDir, { recursive: true });
    await mkdir(this.resultsDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
  }

  async sendCommand(
    tool: string,
    process: string,
    parameters: Record<string, unknown>,
    options?: {
      executeMethod?: "executeGlobal" | "executeOn";
      targetView?: string | null;
      timeoutMs?: number;
    }
  ): Promise<BridgeResult> {
    await this.ensureDirectories();

    const id = randomUUID();
    const command: BridgeCommand = {
      id,
      timestamp: new Date().toISOString(),
      tool,
      process,
      parameters,
      executeMethod: options?.executeMethod ?? "executeGlobal",
      targetView: options?.targetView ?? null,
    };

    const commandPath = join(this.commandsDir, `${id}.json`);
    await writeFile(commandPath, JSON.stringify(command, null, 2), "utf-8");

    const timeoutMs = options?.timeoutMs ?? this.config.defaultTimeoutMs;
    return this.waitForResult(id, timeoutMs);
  }

  private async waitForResult(id: string, timeoutMs: number): Promise<BridgeResult> {
    const resultPath = join(this.resultsDir, `${id}.json`);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (existsSync(resultPath)) {
        // Small delay to ensure the file is fully written
        await sleep(50);
        try {
          const data = await readFile(resultPath, "utf-8");
          const result = JSON.parse(data) as BridgeResult;

          // If still running, keep polling
          if (result.status === "running") {
            await sleep(this.config.pollIntervalMs);
            continue;
          }

          // Clean up the result file
          try {
            await unlink(resultPath);
          } catch {
            // Ignore cleanup errors
          }

          return result;
        } catch {
          // File might still be written, retry
          await sleep(this.config.pollIntervalMs);
          continue;
        }
      }
      await sleep(this.config.pollIntervalMs);
    }

    return {
      id,
      timestamp: new Date().toISOString(),
      status: "error",
      process: "timeout",
      duration_ms: Date.now() - startTime,
      error: {
        message: `Command timed out after ${timeoutMs}ms. The PJSR watcher may not be running in PixInsight.`,
        type: "Timeout",
      },
    };
  }

  async isWatcherAlive(): Promise<boolean> {
    // Send a ping-like command and see if we get a response
    try {
      const result = await this.sendCommand(
        "list_open_images",
        "__internal__",
        {},
        { timeoutMs: 5000 }
      );
      return result.status === "success";
    } catch {
      return false;
    }
  }

  async cleanStaleCommands(): Promise<number> {
    try {
      const files = await readdir(this.commandsDir);
      let cleaned = 0;
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = join(this.commandsDir, file);
          try {
            const data = await readFile(filePath, "utf-8");
            const cmd = JSON.parse(data) as BridgeCommand;
            const age = Date.now() - new Date(cmd.timestamp).getTime();
            // Remove commands older than 10 minutes
            if (age > 600_000) {
              await unlink(filePath);
              cleaned++;
            }
          } catch {
            // Malformed file, remove it
            await unlink(filePath);
            cleaned++;
          }
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }

  getConfig(): BridgeConfig {
    return { ...this.config };
  }
}
