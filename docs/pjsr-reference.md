# PJSR (PixInsight JavaScript Runtime) Reference

## Overview

PJSR is PixInsight's built-in scripting engine based on **Mozilla SpiderMonkey** (ECMAScript 5). Every installed PixInsight process is automatically scriptable through PJSR.

## Key Resources

- Official dev page: https://pixinsight.com/developer/pjsr/
- PJSR source: https://github.com/PixInsight/PJSR / https://gitlab.com/pixinsight/PJSR
- TypeScript type definitions (community): https://github.com/TheAmazingLooser/PixInsight_TypeScript_Definitions
- Best discovery tool: **Object Explorer** in PixInsight's Script Editor (Script > Object Explorer)

## Core Objects

### ProcessInstance — Execute Any Process

```javascript
// Create a process and set parameters
var P = new ImageCalibration;
P.targetFrames = [ /* frame list */ ];
P.masterBias = "/path/to/master_bias.xisf";
P.masterDark = "/path/to/master_dark.xisf";
P.masterFlat = "/path/to/master_flat.xisf";

// Execute globally (no target view)
P.executeGlobal();

// Or execute on a specific view
P.executeOn(ImageWindow.activeWindow.currentView);

// Load from a saved process icon
var P = ProcessInstance.fromIcon("MyProcessIcon");
P.executeGlobal();
```

### ImageWindow — Access Open Images

```javascript
// Get all open image windows
var windows = ImageWindow.windows;
for (var i = 0; i < windows.length; ++i) {
    console.writeln(windows[i].mainView.id + " : " +
                    windows[i].mainView.image.width + "x" +
                    windows[i].mainView.image.height);
}

// Open a file
var w = ImageWindow.open("/path/to/image.xisf")[0];

// Get the active window
var active = ImageWindow.activeWindow;

// Save / close
w.saveAs("/path/to/output.xisf", false, false, false, false);
w.close();
```

### View — Image Views

```javascript
var view = ImageWindow.activeWindow.currentView;
console.writeln("View ID: " + view.id);
console.writeln("Is preview: " + view.isPreview);

// Access the image
var img = view.image;
console.writeln("Dimensions: " + img.width + "x" + img.height);
console.writeln("Channels: " + img.numberOfChannels);
console.writeln("Color: " + img.isColor);
```

### Image — Pixel Access

```javascript
var img = ImageWindow.activeWindow.currentView.image;

// Read a pixel value (channel, x, y)
var value = img.sample(0, 100, 200);  // channel 0, x=100, y=200

// Statistics
var median = img.median();
var mean = img.mean();
var stdDev = img.stdDev();
```

### File — File System Operations

```javascript
// Read a file
var f = new File;
f.openForReading("/path/to/file.json");
var data = f.read(DataType_ByteArray, f.size);
f.close();
var text = data.toString();

// Write a file
var f = new File;
f.createForWriting("/path/to/output.json");
var bytes = new ByteArray(JSON.stringify({ key: "value" }));
f.write(bytes);
f.close();

// Check existence
var exists = File.exists("/path/to/file");

// List directory
var files = searchDirectory("/path/to/dir/*.json");
// Returns array of full paths matching the pattern
```

### Console — Output

```javascript
console.writeln("Message");          // Line with newline
console.write("No newline");          // Without newline
console.warningln("Warning!");        // Warning style
console.criticalln("Error!");         // Error style
console.noteln("Note");              // Note style

// Show/hide the process console
console.show();
console.hide();

// Abort check (for long operations)
console.abortRequested;               // Boolean — user clicked abort?
```

### Parameters — Script Arguments

When a script is launched with `-r=script.js,arg1,arg2`:

```javascript
// jsArguments is a global array
for (var i = 0; i < jsArguments.length; ++i) {
    console.writeln("Arg " + i + ": " + jsArguments[i]);
}
```

## Discovering Process Parameters

The best way to discover parameters for any process:

### Method 1: Drag from ProcessInstance to Script Editor

1. Configure a process in PixInsight's GUI (e.g., set up ImageCalibration)
2. Drag the blue triangle (new instance) to the Script Editor
3. PixInsight generates the complete PJSR code with all parameters

### Method 2: Object Explorer

1. Open Script > Object Explorer
2. Browse to the process class (e.g., `ImageCalibration`)
3. See all properties and methods

### Method 3: Script Console

```javascript
// List all properties of a process
var P = new ImageCalibration;
for (var key in P) {
    console.writeln(key + " = " + P[key]);
}
```

## Common Patterns

### Error Handling

```javascript
try {
    var P = new ImageCalibration;
    // ... set params ...
    P.executeGlobal();
} catch (e) {
    console.criticalln("Error: " + e.message);
}
```

### Sleeping / Timing

```javascript
msleep(500);  // Sleep for 500 milliseconds
```

### Process Console Commands

Inside PixInsight's Process Console:
- `help` — list all available commands
- `run script.js` — run a script
- `.properties` — show image properties
- `.statistics` — show image statistics

## PJSR Limitations

- ECMAScript 5 only (no `let`, `const`, arrow functions, template literals, `class`, etc.)
- No native networking (no sockets, no HTTP, no WebSocket)
- No native `setTimeout` / `setInterval` (use polling loops with `msleep`)
- Documentation is incomplete — Object Explorer is the authoritative reference
- SpiderMonkey version is old (24/38) — some modern JS features missing
