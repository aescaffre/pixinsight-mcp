import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "../bridge/client.js";

export function registerImageManagementTools(server: McpServer, bridge: BridgeClient): void {

  // list_open_images
  server.tool(
    "list_open_images",
    "List all currently open image windows in PixInsight",
    {},
    async () => {
      const result = await bridge.sendCommand("list_open_images", "__internal__", {});
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }
      const images = (result as any).outputs?.images ?? [];
      if (images.length === 0) {
        return {
          content: [{ type: "text", text: "No images are currently open in PixInsight." }],
        };
      }
      const lines = images.map((img: any) =>
        `- **${img.id}**: ${img.width}x${img.height}, ${img.channels}ch, ${img.isColor ? "color" : "mono"}, ${img.bitDepth}bit` +
        (img.filePath ? ` (${img.filePath})` : "")
      );
      return {
        content: [{ type: "text", text: `Open images (${images.length}):\n${lines.join("\n")}` }],
      };
    }
  );

  // open_image
  server.tool(
    "open_image",
    "Open an image file in PixInsight",
    { filePath: z.string().describe("Absolute path to FITS/XISF/TIFF file") },
    async ({ filePath }) => {
      const result = await bridge.sendCommand("open_image", "__internal__", { filePath });
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Error opening image: ${result.error.message}` }],
          isError: true,
        };
      }
      const out = (result as any).outputs ?? {};
      return {
        content: [{
          type: "text",
          text: `Opened image: **${out.id}** (${out.width}x${out.height}, ${out.channels}ch)`,
        }],
      };
    }
  );

  // save_image
  server.tool(
    "save_image",
    "Save an open image to disk",
    {
      viewId: z.string().describe("View ID of the image to save"),
      filePath: z.string().describe("Output path (.xisf, .fits, .tiff, .png)"),
      overwrite: z.boolean().default(false).describe("Overwrite existing file"),
    },
    async ({ viewId, filePath, overwrite }) => {
      const result = await bridge.sendCommand("save_image", "__internal__", {
        viewId, filePath, overwrite,
      });
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Error saving image: ${result.error.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Saved **${viewId}** to ${filePath}` }],
      };
    }
  );

  // close_image
  server.tool(
    "close_image",
    "Close an open image window in PixInsight",
    { viewId: z.string().describe("View ID of the image to close") },
    async ({ viewId }) => {
      const result = await bridge.sendCommand("close_image", "__internal__", { viewId });
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Error closing image: ${result.error.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Closed image: **${viewId}**` }],
      };
    }
  );

  // get_image_statistics
  server.tool(
    "get_image_statistics",
    "Get per-channel statistics (mean, median, stddev, min, max) for an open image",
    { viewId: z.string().describe("View ID of the image") },
    async ({ viewId }) => {
      const result = await bridge.sendCommand("get_image_statistics", "__internal__", { viewId });
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
          isError: true,
        };
      }
      const stats = (result as any).outputs?.statistics ?? [];
      const lines = stats.map((s: any) =>
        `**${s.channelName}**: mean=${s.mean.toFixed(6)}, median=${s.median.toFixed(6)}, ` +
        `stdDev=${s.stdDev.toFixed(6)}, min=${s.min.toFixed(6)}, max=${s.max.toFixed(6)}`
      );
      return {
        content: [{ type: "text", text: `Statistics for **${viewId}**:\n${lines.join("\n")}` }],
      };
    }
  );
}
