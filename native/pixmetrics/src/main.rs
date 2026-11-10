//! pixmetrics — native measurements for pixinsight-mcp.
//!   pixmetrics info    --image <file.xisf|.png>
//!   pixmetrics measure --image <file> (--request '<json>' | --request-file <file>)
//! request: {"metrics":[{"name":"palette_purity","id":"optional label","params":{...}}, ...]}
//! The image is read once; metrics run in parallel. Output: one JSON object on stdout.
mod blur;
mod image;
mod metrics;
mod util;
mod xisf;

use rayon::prelude::*;
use serde_json::{json, Value};
use std::time::Instant;

fn load(path: &str, index: usize) -> Result<image::Image, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".xisf") { return xisf::read(path, index).map(|(i, _)| i); }
    util::read_any(path)
}

fn arg(args: &[String], k: &str) -> Option<String> { args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned()) }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    let out = run(cmd, &args);
    match out {
        Ok(v) => println!("{}", v),
        Err(e) => { println!("{}", json!({ "ok": false, "error": e })); std::process::exit(1); }
    }
}

fn run(cmd: &str, args: &[String]) -> Result<Value, String> {
    match cmd {
        "list" => Ok(json!({ "ok": true, "metrics": metrics::names() })),
        "info" | "measure" => {
            let path = arg(args, "--image").ok_or("--image required")?;
            let idx = arg(args, "--image-index").and_then(|s| s.parse().ok()).unwrap_or(0);
            let t0 = Instant::now();
            let img = load(&path, idx)?;
            let read_ms = t0.elapsed().as_millis();
            if cmd == "info" { return Ok(json!({ "ok": true, "w": img.w, "h": img.h, "c": img.n_channels(), "readMs": read_ms })); }
            let req: Value = match (arg(args, "--request"), arg(args, "--request-file")) {
                (Some(s), _) => serde_json::from_str(&s).map_err(|e| format!("request JSON: {e}"))?,
                (_, Some(f)) => serde_json::from_str(&std::fs::read_to_string(&f).map_err(|e| e.to_string())?).map_err(|e| format!("request JSON: {e}"))?,
                _ => return Err("--request or --request-file required".into()),
            };
            let list = req.get("metrics").and_then(|m| m.as_array()).ok_or("request.metrics must be an array")?.clone();
            let ctx = metrics::Ctx::new(&img);
            let results: Vec<Value> = list.par_iter().map(|m| {
                let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let id = m.get("id").and_then(|n| n.as_str()).unwrap_or(name);
                let params = m.get("params").cloned().unwrap_or(json!({}));
                let t = Instant::now();
                match metrics::run(name, &ctx, &params) {
                    Ok(v) => json!({ "id": id, "name": name, "ok": true, "value": v, "ms": t.elapsed().as_millis() }),
                    Err(e) => json!({ "id": id, "name": name, "ok": false, "error": e, "ms": t.elapsed().as_millis() }),
                }
            }).collect();
            Ok(json!({ "ok": true, "w": img.w, "h": img.h, "c": img.n_channels(), "readMs": read_ms, "totalMs": t0.elapsed().as_millis(), "results": results }))
        }
        _ => Ok(json!({ "ok": true, "usage": "pixmetrics list | info --image F | measure --image F --request JSON|--request-file F" })),
    }
}
