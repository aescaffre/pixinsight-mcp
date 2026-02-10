import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "../bridge/client.js";

function processResult(result: any, successMsg: string) {
  if (result.status === "error") {
    return {
      content: [{ type: "text" as const, text: `Error: ${result.error.message}` }],
      isError: true,
    };
  }
  const msg = result.message || successMsg;
  return {
    content: [{ type: "text" as const, text: msg }],
  };
}

export function registerProcessingTools(server: McpServer, bridge: BridgeClient): void {

  // run_pixelmath
  server.tool(
    "run_pixelmath",
    "Execute a PixelMath expression on an image",
    {
      expression: z.string().describe("Math expression (e.g. '$T * 0.5')"),
      expression1: z.string().optional().describe("Green channel expression (if different)"),
      expression2: z.string().optional().describe("Blue channel expression (if different)"),
      targetViewId: z.string().optional().describe("Apply to this view in-place"),
      createNewImage: z.boolean().default(false).describe("Create a new image instead"),
      newImageId: z.string().optional().describe("ID for new image"),
    },
    async (params) => {
      const result = await bridge.sendCommand("run_pixelmath", "PixelMath", {
        expression: params.expression,
        expression1: params.expression1 ?? "",
        expression2: params.expression2 ?? "",
        useSingleExpression: !params.expression1 && !params.expression2,
        createNewImage: params.createNewImage,
        newImageId: params.newImageId ?? "",
      }, {
        executeMethod: params.targetViewId ? "executeOn" : "executeGlobal",
        targetView: params.targetViewId,
      });
      return processResult(result, `PixelMath executed: ${params.expression}`);
    }
  );

  // remove_gradient
  server.tool(
    "remove_gradient",
    "Remove background gradients using AutomaticBackgroundExtractor (ABE)",
    {
      viewId: z.string().describe("View ID of the image"),
      polyDegree: z.number().min(1).max(6).default(4).describe("Polynomial degree (1-6)"),
      tolerance: z.number().default(1.0).describe("Sample rejection tolerance"),
    },
    async ({ viewId, polyDegree, tolerance }) => {
      const result = await bridge.sendCommand("remove_gradient", "AutomaticBackgroundExtractor", {
        polyDegree,
        tolerance,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Gradient removed from **${viewId}** (ABE, degree ${polyDegree})`);
    }
  );

  // color_calibrate
  server.tool(
    "color_calibrate",
    "Calibrate colors using SPCC, PCC, or basic ColorCalibration",
    {
      viewId: z.string().describe("View ID of the image"),
      method: z.enum(["spcc", "pcc", "basic"]).default("spcc").describe("Calibration method"),
    },
    async ({ viewId, method }) => {
      const processMap: Record<string, string> = {
        spcc: "SpectrophotometricColorCalibration",
        pcc: "PhotometricColorCalibration",
        basic: "ColorCalibration",
      };
      const result = await bridge.sendCommand("color_calibrate", processMap[method], {
        method,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Color calibrated **${viewId}** using ${method.toUpperCase()}`);
    }
  );

  // remove_green_cast
  server.tool(
    "remove_green_cast",
    "Apply SCNR to remove green cast from an image",
    {
      viewId: z.string().describe("View ID of the image"),
      amount: z.number().min(0).max(1).default(1.0).describe("Removal amount (0-1)"),
    },
    async ({ viewId, amount }) => {
      const result = await bridge.sendCommand("remove_green_cast", "SCNR", {
        colorToRemove: 1, // Green
        amount,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Green cast removed from **${viewId}** (amount: ${amount})`);
    }
  );

  // stretch_image
  server.tool(
    "stretch_image",
    "Apply histogram stretch (linear to non-linear)",
    {
      viewId: z.string().describe("View ID of the image"),
      method: z.enum(["auto", "stf", "manual"]).default("auto").describe("Stretch method"),
      shadowsClipping: z.number().optional().describe("Shadows clipping (for manual)"),
      midtones: z.number().optional().describe("Midtones balance (for manual)"),
    },
    async ({ viewId, method, shadowsClipping, midtones }) => {
      const processMap: Record<string, string> = {
        auto: "AutoHistogram",
        stf: "ScreenTransferFunction",
        manual: "HistogramTransformation",
      };
      const result = await bridge.sendCommand("stretch_image", processMap[method], {
        method,
        shadowsClipping,
        midtones,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Stretched **${viewId}** using ${method} method`);
    }
  );

  // apply_curves
  server.tool(
    "apply_curves",
    "Apply curves transformation to an image",
    {
      viewId: z.string().describe("View ID of the image"),
      curvePoints: z.array(z.tuple([z.number(), z.number()])).describe("Array of [x, y] control points (0-1)"),
      channel: z.enum(["rgb", "red", "green", "blue", "lightness", "saturation"]).default("rgb").describe("Target channel"),
    },
    async ({ viewId, curvePoints, channel }) => {
      const result = await bridge.sendCommand("apply_curves", "CurvesTransformation", {
        curvePoints,
        channel,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Curves applied to **${viewId}** (${channel} channel, ${curvePoints.length} points)`);
    }
  );

  // denoise
  server.tool(
    "denoise",
    "Apply noise reduction using MultiscaleLinearTransform (MLT)",
    {
      viewId: z.string().describe("View ID of the image"),
      layers: z.number().min(1).max(8).default(4).describe("Number of wavelet layers"),
      strength: z.array(z.number()).optional().describe("Per-layer noise reduction strength"),
    },
    async ({ viewId, layers, strength }) => {
      const result = await bridge.sendCommand("denoise", "MultiscaleLinearTransform", {
        layers,
        strength: strength ?? [],
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Denoised **${viewId}** (MLT, ${layers} layers)`);
    }
  );

  // sharpen
  server.tool(
    "sharpen",
    "Apply UnsharpMask sharpening to an image",
    {
      viewId: z.string().describe("View ID of the image"),
      sigma: z.number().default(2.0).describe("Gaussian sigma"),
      amount: z.number().default(0.8).describe("Sharpening amount"),
    },
    async ({ viewId, sigma, amount }) => {
      const result = await bridge.sendCommand("sharpen", "UnsharpMask", {
        sigma,
        amount,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Sharpened **${viewId}** (sigma: ${sigma}, amount: ${amount})`);
    }
  );

  // deconvolve
  server.tool(
    "deconvolve",
    "Apply deconvolution to restore image detail",
    {
      viewId: z.string().describe("View ID of the image"),
      psfSigma: z.number().default(2.5).describe("PSF sigma estimate"),
      iterations: z.number().default(50).describe("Number of iterations"),
    },
    async ({ viewId, psfSigma, iterations }) => {
      const result = await bridge.sendCommand("deconvolve", "Deconvolution", {
        psfSigma,
        iterations,
      }, {
        executeMethod: "executeOn",
        targetView: viewId,
      });
      return processResult(result, `Deconvolved **${viewId}** (PSF sigma: ${psfSigma}, ${iterations} iterations)`);
    }
  );

  // combine_lrgb
  server.tool(
    "combine_lrgb",
    "Combine Luminance with RGB color data",
    {
      luminanceViewId: z.string().describe("View ID of the luminance image"),
      rgbViewId: z.string().describe("View ID of the RGB image"),
      luminanceWeight: z.number().default(1.0).describe("Luminance weight"),
    },
    async ({ luminanceViewId, rgbViewId, luminanceWeight }) => {
      const result = await bridge.sendCommand("combine_lrgb", "LRGBCombination", {
        luminanceViewId,
        rgbViewId,
        luminanceWeight,
      }, {
        executeMethod: "executeOn",
        targetView: rgbViewId,
      });
      return processResult(result, `Combined LRGB: L=${luminanceViewId} + RGB=${rgbViewId}`);
    }
  );

  // blend_narrowband
  server.tool(
    "blend_narrowband",
    "Blend narrowband channel (e.g., Ha) into broadband data using PixelMath",
    {
      targetViewId: z.string().describe("View ID of the broadband image"),
      narrowbandViewId: z.string().describe("View ID of the narrowband channel"),
      blendMode: z.enum(["max", "screen", "add", "custom"]).default("max").describe("Blending mode"),
      blendStrength: z.number().min(0).max(1).default(1.0).describe("Blend strength (0-1)"),
      targetChannel: z.string().optional().describe("Target channel: red, luminance, all"),
    },
    async ({ targetViewId, narrowbandViewId, blendMode, blendStrength, targetChannel }) => {
      const result = await bridge.sendCommand("blend_narrowband", "PixelMath", {
        narrowbandViewId,
        blendMode,
        blendStrength,
        targetChannel: targetChannel ?? "red",
      }, {
        executeMethod: "executeOn",
        targetView: targetViewId,
      });
      return processResult(result,
        `Blended ${narrowbandViewId} into ${targetViewId} (${blendMode}, strength: ${blendStrength})`
      );
    }
  );

  // run_script
  server.tool(
    "run_script",
    "Execute arbitrary PJSR code inside PixInsight (escape hatch for anything not covered by specific tools)",
    {
      code: z.string().describe("PJSR JavaScript code to execute"),
    },
    async ({ code }) => {
      const result = await bridge.sendCommand("run_script", "__script__", { code });
      if (result.status === "error") {
        return {
          content: [{ type: "text" as const, text: `Script error: ${result.error.message}` }],
          isError: true,
        };
      }
      const output = (result as any).outputs?.consoleOutput ?? (result as any).message ?? "Script executed.";
      return {
        content: [{ type: "text" as const, text: output }],
      };
    }
  );
}
