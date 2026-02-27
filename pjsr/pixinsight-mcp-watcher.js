// PixInsight MCP Watcher Script
// Runs inside PixInsight's PJSR engine (ECMAScript 5)
// Polls the bridge directory for commands, executes them, writes results.

// ============================================================================
// ImageSolver Library (loaded at preprocessor time for plate solving)
// ============================================================================

#define __PJSR_USE_STAR_DETECTOR_V2

#include <pjsr/BRQuadTree.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/LinearTransformation.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/SectionBar.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/StarDetector.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/PropertyType.jsh>
#include <pjsr/PropertyAttribute.jsh>
#include <pjsr/RBFType.jsh>
#include <pjsr/APASSFlag.jsh>
#include <pjsr/GaiaFlag.jsh>
#include <pjsr/ReadTextOptions.jsh>

#define TITLE           "Image Solver"
#define SETTINGS_MODULE "SOLVER"
#define STAR_CSV_FILE   (File.systemTempDirectory + "/stars-mcp.csv")

// Include AdP dependencies then ImageSolver in library mode
#include "/Applications/PixInsight/src/scripts/AdP/Projections.js"
#include "/Applications/PixInsight/src/scripts/AdP/WCSmetadata.jsh"
#include "/Applications/PixInsight/src/scripts/AdP/AstronomicalCatalogs.jsh"
#include "/Applications/PixInsight/src/scripts/AdP/CommonUIControls.js"
#include "/Applications/PixInsight/src/scripts/AdP/SearchCoordinatesDialog.js"
#include "/Applications/PixInsight/src/scripts/AdP/CatalogDownloader.js"

#define USE_SOLVER_LIBRARY
#include "/Applications/PixInsight/src/scripts/AdP/ImageSolver.js"

#define SETTINGS_MODULE_SCRIPT "SOLVER"

// ============================================================================
// Configuration
// ============================================================================

var BRIDGE_DIR = File.homeDirectory + "/.pixinsight-mcp/bridge";
var COMMANDS_DIR = BRIDGE_DIR + "/commands";
var RESULTS_DIR = BRIDGE_DIR + "/results";
var LOGS_DIR = BRIDGE_DIR + "/logs";
var POLL_INTERVAL_MS = 1000;
var WATCHER_VERSION = "0.1.0";

// ============================================================================
// File Helpers (PJSR File API)
// ============================================================================

function readTextFile(path) {
   var lines = File.readLines(path);
   return lines.join("\n");
}

function writeTextFile(path, text) {
   File.writeTextFile(path, text);
}

function deleteFile(path) {
   if (File.exists(path)) {
      File.remove(path);
   }
}

function ensureDirectory(path) {
   if (!File.directoryExists(path)) {
      File.createDirectory(path, true);
   }
}

function listJsonFiles(dirPattern) {
   try {
      return searchDirectory(dirPattern);
   } catch (e) {
      return [];
   }
}

function getTimestamp() {
   var d = new Date();
   return d.toISOString();
}

// ============================================================================
// Command Handlers
// ============================================================================

function handleListOpenImages(command) {
   var windows = ImageWindow.windows;
   var images = [];
   for (var i = 0; i < windows.length; ++i) {
      var w = windows[i];
      var v = w.mainView;
      var img = v.image;
      images.push({
         id: v.id,
         filePath: w.filePath || null,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels,
         isColor: img.isColor,
         bitDepth: img.bitsPerSample
      });
   }
   return {
      status: "success",
      outputs: { images: images },
      message: "Found " + images.length + " open image(s)"
   };
}

function handleOpenImage(command) {
   var filePath = command.parameters.filePath;
   if (!File.exists(filePath)) {
      throw new Error("File not found: " + filePath);
   }
   var windows = ImageWindow.open(filePath);
   if (windows.length === 0) {
      throw new Error("Failed to open image: " + filePath);
   }
   var w = windows[0];
   w.show();
   var v = w.mainView;
   var img = v.image;
   return {
      status: "success",
      outputs: {
         id: v.id,
         width: img.width,
         height: img.height,
         channels: img.numberOfChannels
      },
      message: "Opened " + v.id
   };
}

function handleSaveImage(command) {
   var viewId = command.parameters.viewId;
   var filePath = command.parameters.filePath;
   var overwrite = command.parameters.overwrite || false;

   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   if (File.exists(filePath) && !overwrite) {
      throw new Error("File already exists (set overwrite=true): " + filePath);
   }
   window.saveAs(filePath, false, false, false, false);
   return {
      status: "success",
      outputs: { filePath: filePath },
      message: "Saved " + viewId + " to " + filePath
   };
}

function handleCloseImage(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   window.forceClose();
   return {
      status: "success",
      outputs: {},
      message: "Closed " + viewId
   };
}

function handleGetImageStatistics(command) {
   var viewId = command.parameters.viewId;
   var window = findWindowByViewId(viewId);
   if (!window) {
      throw new Error("Image not found: " + viewId);
   }
   var img = window.mainView.image;
   var stats = [];
   var channelNames = img.isColor ? ["Red", "Green", "Blue"] : ["Gray"];

   for (var c = 0; c < img.numberOfChannels; ++c) {
      img.selectedChannel = c;
      stats.push({
         channel: c,
         channelName: c < channelNames.length ? channelNames[c] : "Channel_" + c,
         mean: img.mean(),
         median: img.median(),
         stdDev: img.stdDev(),
         min: img.minimum(),
         max: img.maximum()
      });
   }
   img.resetSelections();

   return {
      status: "success",
      outputs: { statistics: stats },
      message: "Statistics for " + viewId + " (" + stats.length + " channel(s))"
   };
}

// ============================================================================
// Process Execution Handlers
// ============================================================================

function handleRunPixelMath(command) {
   var P = new PixelMath;
   P.expression = command.parameters.expression || "";
   P.expression1 = command.parameters.expression1 || "";
   P.expression2 = command.parameters.expression2 || "";
   P.useSingleExpression = command.parameters.useSingleExpression !== false;
   P.createNewImage = command.parameters.createNewImage || false;
   if (command.parameters.newImageId) {
      P.newImageId = command.parameters.newImageId;
   }

   if (command.targetView) {
      var view = findViewById(command.targetView);
      if (!view) throw new Error("View not found: " + command.targetView);
      P.executeOn(view);
   } else {
      P.executeGlobal();
   }
   return {
      status: "success",
      outputs: {},
      message: "PixelMath executed: " + command.parameters.expression
   };
}

function handleRemoveGradient(command) {
   var P = new AutomaticBackgroundExtractor;
   P.polyDegree = command.parameters.polyDegree || 4;
   P.tolerance = command.parameters.tolerance || 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Gradient removed from " + command.targetView + " (ABE, degree " + P.polyDegree + ")"
   };
}

function handleColorCalibrate(command) {
   var method = command.parameters.method || "spcc";
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);

   if (method === "spcc") {
      var P = new SpectrophotometricColorCalibration;
      P.executeOn(view);
   } else if (method === "pcc") {
      var P = new PhotometricColorCalibration;
      P.executeOn(view);
   } else {
      var P = new ColorCalibration;
      P.executeOn(view);
   }
   return {
      status: "success",
      outputs: {},
      message: "Color calibrated " + command.targetView + " using " + method.toUpperCase()
   };
}

function handleRemoveGreenCast(command) {
   var P = new SCNR;
   P.colorToRemove = SCNR.prototype.Green;
   P.amount = command.parameters.amount !== undefined ? command.parameters.amount : 1.0;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Green cast removed from " + command.targetView
   };
}

function handleStretchImage(command) {
   var method = command.parameters.method || "auto";
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);

   if (method === "auto") {
      var P = new AutoHistogram;
      P.executeOn(view);
   } else if (method === "stf") {
      // Apply STF auto-stretch then apply permanently via HistogramTransformation
      var stf = new ScreenTransferFunction;
      stf.executeOn(view);
      // Read STF values and apply as permanent HT
      // For now, just apply STF (non-destructive preview)
      return {
         status: "success",
         outputs: {},
         message: "STF auto-stretch applied to " + command.targetView + " (preview only, non-destructive)"
      };
   } else {
      // Manual HistogramTransformation
      var P = new HistogramTransformation;
      var sc = command.parameters.shadowsClipping || 0.0;
      var mt = command.parameters.midtones || 0.5;
      P.H = [
         [0, 0.5, 0.5, 0.5, 1.0],
         [0, 0.5, 0.5, 0.5, 1.0],
         [0, 0.5, 0.5, 0.5, 1.0],
         [sc, 0.5, mt, 0.5, 1.0],
         [0, 0.5, 0.5, 0.5, 1.0]
      ];
      P.executeOn(view);
   }
   return {
      status: "success",
      outputs: {},
      message: "Stretched " + command.targetView + " using " + method + " method"
   };
}

function handleApplyCurves(command) {
   var P = new CurvesTransformation;
   var curvePoints = command.parameters.curvePoints || [[0, 0], [1, 1]];
   var channel = command.parameters.channel || "rgb";

   // CurvesTransformation uses arrays like: [ [x0,y0], [x1,y1], ... ]
   // Channel mapping: R=0, G=1, B=2, RGB/K=3, alpha=4, L=5, a=6, b=7, c=8, H=9, S=10
   var channelMap = {
      "red": "R", "green": "G", "blue": "B", "rgb": "K",
      "lightness": "L", "saturation": "S"
   };

   // Set the curve for the selected channel
   var ch = channelMap[channel] || "K";
   P[ch] = curvePoints;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Curves applied to " + command.targetView + " (" + channel + " channel)"
   };
}

function handleDenoise(command) {
   var P = new MultiscaleLinearTransform;
   var layers = command.parameters.layers || 4;
   // MLT uses an array of layer configurations
   // Default: enable noise reduction on first N layers
   var layerConfig = [];
   for (var i = 0; i < layers; ++i) {
      // [enabled, biasEnabled, bias, noiseReductionEnabled, noiseReductionThreshold, noiseReductionAmount, ...]
      layerConfig.push([true, true, 0.000, true, 3.000, 1.00, false]);
   }
   // Add the residual layer (no noise reduction)
   layerConfig.push([true, true, 0.000, false, 3.000, 1.00, false]);
   P.layers = layerConfig;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Denoised " + command.targetView + " (MLT, " + layers + " layers)"
   };
}

function handleSharpen(command) {
   var P = new UnsharpMask;
   P.sigma = command.parameters.sigma || 2.0;
   P.amount = command.parameters.amount || 0.8;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Sharpened " + command.targetView + " (sigma: " + P.sigma + ", amount: " + P.amount + ")"
   };
}

function handleDeconvolve(command) {
   var P = new Deconvolution;
   // Use a Gaussian PSF
   P.algorithm = Deconvolution.prototype.RichardsonLucy;
   P.psfMode = Deconvolution.prototype.Gaussian;
   P.psfGaussianSigma = command.parameters.psfSigma || 2.5;
   P.iterations = [
      [command.parameters.iterations || 50, false, 0, 0, 0, false, 0, 0]
   ];

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Deconvolved " + command.targetView
   };
}

function handleCombineLRGB(command) {
   var P = new LRGBCombination;
   P.channelL = [true, command.parameters.luminanceViewId];
   P.channelR = [false, ""];
   P.channelG = [false, ""];
   P.channelB = [false, ""];
   P.luminanceWeight = command.parameters.luminanceWeight || 1.0;

   // Execute on the RGB image
   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "LRGB combined onto " + command.targetView
   };
}

function handleBlendNarrowband(command) {
   var P = new PixelMath;
   var nbView = command.parameters.narrowbandViewId;
   var strength = command.parameters.blendStrength || 1.0;
   var mode = command.parameters.blendMode || "max";
   var channel = command.parameters.targetChannel || "red";

   // Build PixelMath expression based on blend mode
   var expr;
   if (mode === "max") {
      expr = "max($T, " + nbView + " * " + strength + ")";
   } else if (mode === "screen") {
      expr = "~(~$T * ~(" + nbView + " * " + strength + "))";
   } else if (mode === "add") {
      expr = "$T + " + nbView + " * " + strength;
   } else {
      // Custom fallback: simple max
      expr = "max($T, " + nbView + " * " + strength + ")";
   }

   if (channel === "red") {
      P.expression = expr;
      P.expression1 = "$T";
      P.expression2 = "$T";
      P.useSingleExpression = false;
   } else if (channel === "all" || channel === "luminance") {
      P.expression = expr;
      P.useSingleExpression = true;
   } else {
      P.expression = expr;
      P.useSingleExpression = true;
   }
   P.createNewImage = false;

   var view = findViewById(command.targetView);
   if (!view) throw new Error("View not found: " + command.targetView);
   P.executeOn(view);
   return {
      status: "success",
      outputs: {},
      message: "Blended " + nbView + " into " + command.targetView + " (" + mode + ", strength: " + strength + ")"
   };
}

function handleRunScript(command) {
   var code = command.parameters.code;
   // Capture console output
   var consoleOutput = "";
   try {
      // Execute the code
      var result = eval(code);
      return {
         status: "success",
         outputs: { consoleOutput: String(result !== undefined ? result : "Script executed.") },
         message: "Script executed successfully"
      };
   } catch (e) {
      throw new Error("Script error: " + e.message);
   }
}

// ============================================================================
// Utility Functions
// ============================================================================

function findWindowByViewId(viewId) {
   var windows = ImageWindow.windows;
   for (var i = 0; i < windows.length; ++i) {
      if (windows[i].mainView.id === viewId) {
         return windows[i];
      }
      // Check previews too
      for (var j = 0; j < windows[i].previews.length; ++j) {
         if (windows[i].previews[j].id === viewId) {
            return windows[i];
         }
      }
   }
   return null;
}

function findViewById(viewId) {
   var windows = ImageWindow.windows;
   for (var i = 0; i < windows.length; ++i) {
      if (windows[i].mainView.id === viewId) {
         return windows[i].mainView;
      }
      for (var j = 0; j < windows[i].previews.length; ++j) {
         if (windows[i].previews[j].id === viewId) {
            return windows[i].previews[j];
         }
      }
   }
   return null;
}

// ============================================================================
// Command Router
// ============================================================================

function dispatchCommand(command) {
   var tool = command.tool;

   // Internal commands
   if (tool === "list_open_images") return handleListOpenImages(command);
   if (tool === "open_image") return handleOpenImage(command);
   if (tool === "save_image") return handleSaveImage(command);
   if (tool === "close_image") return handleCloseImage(command);
   if (tool === "get_image_statistics") return handleGetImageStatistics(command);

   // Processing commands
   if (tool === "run_pixelmath") return handleRunPixelMath(command);
   if (tool === "remove_gradient") return handleRemoveGradient(command);
   if (tool === "color_calibrate") return handleColorCalibrate(command);
   if (tool === "remove_green_cast") return handleRemoveGreenCast(command);
   if (tool === "stretch_image") return handleStretchImage(command);
   if (tool === "apply_curves") return handleApplyCurves(command);
   if (tool === "denoise") return handleDenoise(command);
   if (tool === "sharpen") return handleSharpen(command);
   if (tool === "deconvolve") return handleDeconvolve(command);
   if (tool === "combine_lrgb") return handleCombineLRGB(command);
   if (tool === "blend_narrowband") return handleBlendNarrowband(command);

   // Script execution
   if (tool === "run_script") return handleRunScript(command);

   throw new Error("Unknown tool: " + tool);
}

// ============================================================================
// Main Polling Loop
// ============================================================================

function processNextCommand() {
   var files = listJsonFiles(COMMANDS_DIR + "/*.json");
   if (files.length === 0) {
      return false;
   }

   // Sort by filename (timestamp-based UUIDs give roughly chronological order)
   files.sort();

   // Process the first command
   var filePath = files[0];
   var commandJson, command;

   try {
      commandJson = readTextFile(filePath);
      command = JSON.parse(commandJson);
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to parse command file: " + filePath + " - " + e.message);
      deleteFile(filePath);
      return true;
   }

   var startTime = Date.now();
   var resultObj;

   try {
      console.writeln("[MCP Watcher] Executing: " + command.tool + " (id: " + command.id + ")");
      var handlerResult = dispatchCommand(command);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: handlerResult.status,
         process: command.process,
         duration_ms: Date.now() - startTime,
         outputs: handlerResult.outputs || {},
         message: handlerResult.message || ""
      };
   } catch (e) {
      console.criticalln("[MCP Watcher] Error executing " + command.tool + ": " + e.message);
      resultObj = {
         id: command.id,
         timestamp: getTimestamp(),
         status: "error",
         process: command.process,
         duration_ms: Date.now() - startTime,
         error: {
            message: e.message,
            type: e.name || "Error",
            stack: e.stack || ""
         }
      };
   }

   // Write result
   var resultPath = RESULTS_DIR + "/" + command.id + ".json";
   try {
      writeTextFile(resultPath, JSON.stringify(resultObj));
      console.writeln("[MCP Watcher] Result written: " + resultObj.status +
         " (" + resultObj.duration_ms + "ms)");
   } catch (e) {
      console.criticalln("[MCP Watcher] Failed to write result: " + e.message);
   }

   // Delete command file
   deleteFile(filePath);

   return true;
}

function runWatcher() {
   // Ensure directories exist
   ensureDirectory(BRIDGE_DIR);
   ensureDirectory(COMMANDS_DIR);
   ensureDirectory(RESULTS_DIR);
   ensureDirectory(LOGS_DIR);

   console.noteln("===========================================");
   console.noteln("  PixInsight MCP Watcher v" + WATCHER_VERSION);
   console.noteln("  Bridge: " + BRIDGE_DIR);
   console.noteln("  Polling every " + POLL_INTERVAL_MS + "ms");
   console.noteln("  Ctrl+F11 to abort");
   console.noteln("===========================================");

   var commandCount = 0;

   console.show();

   // Main loop — processEvents() keeps PixInsight UI responsive
   for (;;) {
      // Let PixInsight process UI events (prevents freeze)
      processEvents();

      // Check if abort was requested (Ctrl+F11 or console abort button)
      if (console.abortRequested) {
         console.warningln("[MCP Watcher] Abort requested. Stopping.");
         break;
      }

      var processed = processNextCommand();
      if (processed) {
         commandCount++;
         // Yield heavily after command execution so UI can catch up
         for (var y = 0; y < 5; ++y) {
            processEvents();
            msleep(100);
         }
      } else {
         // No commands — sleep in longer bursts, yield often
         for (var i = 0; i < 10; ++i) {
            msleep(100);
            processEvents();
            if (console.abortRequested) break;
         }
      }
   }

   console.noteln("[MCP Watcher] Stopped. Processed " + commandCount + " command(s).");
}

// ============================================================================
// Entry Point
// ============================================================================

runWatcher();
