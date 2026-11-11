//! pixmetrics — native measurements for pixinsight-mcp.
//!   pixmetrics info    --image <file.xisf|.png>
//!   pixmetrics measure --image <file> (--request '<json>' | --request-file <file>)
//! request: {"metrics":[{"name":"palette_purity","id":"optional label","params":{...}}, ...]}
//! The image is read once; metrics run in parallel. Output: one JSON object on stdout.
//!   pixmetrics process --op lhe --image <in.xisf> --out <out.xisf> [--mask <mask.xisf>] --params '<json>'
//!     lhe params: radius (64), bins (8|10|12 -> 256|1024|4096, default 12), slopeLimit (2.0), amount (1.0), circular (true)
mod blur;
mod image;
mod metrics;
mod process;
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
        "diff" => {
            // pixel-level comparison of two images of the same geometry (parity tests)
            let a = load(&arg(args, "--a").ok_or("--a required")?, 0)?;
            let b = load(&arg(args, "--b").ok_or("--b required")?, 0)?;
            if a.w != b.w || a.h != b.h || a.n_channels() != b.n_channels() { return Err(format!("geometry {}x{}x{} vs {}x{}x{}", a.w, a.h, a.n_channels(), b.w, b.h, b.n_channels())); }
            let mut chans = Vec::new();
            for k in 0..a.n_channels() {
                let (mut mx, mut at, mut sum, mut n4, mut n3, mut nan) = (0f64, 0usize, 0f64, 0usize, 0usize, 0usize);
                for i in 0..a.w * a.h {
                    let (x, y) = (a.ch[k][i] as f64, b.ch[k][i] as f64);
                    if !x.is_finite() || !y.is_finite() { if x.is_finite() != y.is_finite() { nan += 1; } continue; }
                    let d = (x - y).abs(); sum += d; if d > 1e-4 { n4 += 1; } if d > 1e-3 { n3 += 1; } if d > mx { mx = d; at = i; }
                }
                chans.push(json!({ "maxAbs": mx, "at": [at % a.w, at / a.w], "meanAbs": sum / (a.w * a.h) as f64, "fracOver1e4": n4 as f64 / (a.w * a.h) as f64, "fracOver1e3": n3 as f64 / (a.w * a.h) as f64, "nanMismatch": nan }));
            }
            Ok(json!({ "ok": true, "w": a.w, "h": a.h, "channels": chans }))
        }
        "process" => {
            let op = arg(args, "--op").ok_or("--op required")?;
            let path = arg(args, "--image").ok_or("--image required")?;
            let outp = arg(args, "--out").ok_or("--out required")?;
            let params: Value = match (arg(args, "--params"), arg(args, "--params-file")) {
                (Some(s), _) => serde_json::from_str(&s).map_err(|e| format!("params JSON: {e}"))?,
                (_, Some(f)) => serde_json::from_str(&std::fs::read_to_string(&f).map_err(|e| e.to_string())?).map_err(|e| format!("params JSON: {e}"))?,
                _ => json!({}),
            };
            let t0 = Instant::now();
            let mut img = load(&path, 0)?;
            let mask = match arg(args, "--mask") {
                Some(m) => { let mi = load(&m, 0)?; if mi.w != img.w || mi.h != img.h { return Err("mask geometry mismatch".into()); } Some(mi.ch[0].clone()) }
                None => None,
            };
            let read_ms = t0.elapsed().as_millis();
            let t1 = Instant::now();
            match op.as_str() {
                "lhe" => {
                    let g = |k: &str, d: f64| params.get(k).and_then(|v| v.as_f64()).unwrap_or(d);
                    let bits = g("bins", 12.0) as u32;
                    if ![8, 10, 12].contains(&bits) { return Err("bins must be 8, 10 or 12".into()); }
                    let p = process::lhe::LheParams { radius: g("radius", 64.0) as i32, bins: 1 << bits, slope_limit: g("slopeLimit", 2.0), amount: g("amount", 1.0),
                        circular: params.get("circular").and_then(|v| v.as_bool()).unwrap_or(true) };
                    if p.radius < 2 { return Err("radius must be >= 2".into()); }
                    process::lhe::lhe_image(&mut img, &p, mask.as_deref());
                }
                "crop" => {
                    let g = |k: &str| params.get(k).and_then(|v| v.as_u64()).map(|v| v as usize);
                    let (x0, y0) = (g("x").unwrap_or(0), g("y").unwrap_or(0));
                    let (cw, chh) = (g("w").unwrap_or(img.w - x0).min(img.w - x0), g("h").unwrap_or(img.h - y0).min(img.h - y0));
                    let mut c = image::Image::new(cw, chh, img.n_channels());
                    for k in 0..img.n_channels() { for y in 0..chh { c.ch[k][y * cw..(y + 1) * cw].copy_from_slice(&img.ch[k][(y0 + y) * img.w + x0..(y0 + y) * img.w + x0 + cw]); } }
                    img = c;
                }
                "zone_masks" => {
                    // writes <out>_core.xisf, <out>_shell.xisf, <out>_outer.xisf (mono); --out is the prefix
                    let (info, masks) = process::zones::adaptive_zone_masks(&img, &params);
                    let proc_ms = t1.elapsed().as_millis();
                    if let Some(m) = masks {
                        let prefix = outp.trim_end_matches(".xisf").to_string();
                        for (name, plane) in ["core", "shell", "outer"].iter().zip(m) {
                            xisf::write(&format!("{prefix}_{name}.xisf"), &image::Image { w: img.w, h: img.h, ch: vec![plane] })?;
                        }
                    }
                    return Ok(json!({ "ok": true, "op": op, "readMs": read_ms, "processMs": proc_ms, "result": info }));
                }
                _ => return Err(format!("unknown op: {op}")),
            }
            let proc_ms = t1.elapsed().as_millis();
            let t2 = Instant::now();
            xisf::write(&outp, &img)?;
            Ok(json!({ "ok": true, "op": op, "w": img.w, "h": img.h, "c": img.n_channels(), "readMs": read_ms, "processMs": proc_ms, "writeMs": t2.elapsed().as_millis() }))
        }
        _ => Ok(json!({ "ok": true, "usage": "pixmetrics list | info --image F | measure --image F --request JSON|--request-file F | process --op lhe --image F --out F [--mask F] --params JSON" })),
    }
}
