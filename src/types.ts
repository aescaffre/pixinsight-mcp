// Bridge protocol types

export interface BridgeCommand {
  id: string;
  timestamp: string;
  tool: string;
  process: string;
  parameters: Record<string, unknown>;
  executeMethod?: "executeGlobal" | "executeOn";
  targetView?: string | null;
}

export interface BridgeResultSuccess {
  id: string;
  timestamp: string;
  status: "success";
  process: string;
  duration_ms: number;
  outputs: Record<string, unknown>;
  message?: string;
}

export interface BridgeResultError {
  id: string;
  timestamp: string;
  status: "error";
  process: string;
  duration_ms: number;
  error: {
    message: string;
    type?: string;
    stack?: string;
  };
}

export interface BridgeResultRunning {
  id: string;
  timestamp: string;
  status: "running";
  process: string;
  duration_ms: number;
  message?: string;
}

export type BridgeResult = BridgeResultSuccess | BridgeResultError | BridgeResultRunning;

// Image types

export interface ImageInfo {
  id: string;
  filePath: string | null;
  width: number;
  height: number;
  channels: number;
  isColor: boolean;
  bitDepth: number;
}

export interface ImageStatistics {
  channel: number;
  channelName: string;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
}

// Configuration

export interface BridgeConfig {
  bridgeDir: string;
  pollIntervalMs: number;
  defaultTimeoutMs: number;
  extendedTimeoutMs: number;
  pixinsightPath: string;
  automationMode: boolean;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  bridgeDir: "~/.pixinsight-mcp/bridge",
  pollIntervalMs: 200,
  defaultTimeoutMs: 300_000,       // 5 minutes
  extendedTimeoutMs: 3_600_000,    // 1 hour
  pixinsightPath: "/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight",
  automationMode: true,
};
