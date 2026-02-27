// Debug DDG search
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const query = "Bubble Nebula processing PixInsight";
const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
console.log("Fetching:", url);

try {
  const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  console.log("Status:", resp.status);
  const html = await resp.text();
  console.log("HTML length:", html.length);
  console.log("First 500 chars:", html.slice(0, 500));

  // Check for results
  const count = (html.match(/class="result__a"/g) || []).length;
  console.log("\nResult links found:", count);

  if (count === 0) {
    // Check for captcha or block
    if (html.includes("captcha") || html.includes("robot")) {
      console.log("BLOCKED: Captcha/robot detected");
    }
    if (html.includes("no results")) {
      console.log("No results found for query");
    }
    console.log("\nLooking for any <a> tags...");
    const aCount = (html.match(/<a /g) || []).length;
    console.log("Total <a> tags:", aCount);
  }
} catch (e) {
  console.error("Error:", e.message);
}
