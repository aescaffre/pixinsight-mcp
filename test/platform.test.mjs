import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piPath, normalizeWinPathsInCode } from '../agents/ops/platform.mjs';

test('piPath: backslashes become forward slashes, quotes are escaped', () => {
  assert.equal(piPath('D:\\pixinsight-mcp-tests\\output\\aligned'), 'D:/pixinsight-mcp-tests/output/aligned');
  assert.equal(piPath("C:\\a\\it's.xisf"), "C:/a/it\\'s.xisf");
});

test('normalizeWinPathsInCode: single- and JSON-escaped Windows paths in PJSR are rewritten', () => {
  assert.equal(normalizeWinPathsInCode("P.outputDirectory = 'D:\\pixinsight-mcp-tests\\output\\aligned';"),
    "P.outputDirectory = 'D:/pixinsight-mcp-tests/output/aligned';");
  assert.equal(normalizeWinPathsInCode('w.saveAs("C:\\\\Users\\\\me\\\\out.xisf",false);'), 'w.saveAs("C:/Users/me/out.xisf",false);');
});

test('normalizeWinPathsInCode: macOS/Linux scripts and ordinary escapes are untouched', () => {
  const s = "var p='/Users/x/a.xisf'; var t='line\\n'; P.expression = 'iif($T>0.5,1,0)';";
  assert.equal(normalizeWinPathsInCode(s), s);
});
