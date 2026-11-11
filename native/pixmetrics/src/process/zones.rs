//! createAdaptiveZoneMasks (agents/ops/narrowband-enhance.mjs): core / shell / outer luminance masks inside a subject
//! ROI. The PJSR ran a per-pixel sample()/setSample() loop (185 s at 61 MP). Same arithmetic (doubles, JS sort/floor/
//! Math.round), masks stored as f32. The Gaussian blurs (sigma 5/10/20) stay in PixInsight.
use crate::image::Image;
use rayon::prelude::*;
use serde_json::{json, Value};

#[inline] fn lum(img: &Image, x: usize, y: usize) -> f64 {
    let i = y * img.w + x;
    if img.is_color() { 0.2126 * img.ch[0][i] as f64 + 0.7152 * img.ch[1][i] as f64 + 0.0722 * img.ch[2][i] as f64 } else { img.ch[0][i] as f64 }
}
fn pooled_median(img: &Image) -> f64 {
    let mut v: Vec<f32> = img.ch.iter().flat_map(|c| c.iter().cloned()).collect();
    let n = v.len(); let h = n / 2;
    let (left, m, _) = v.select_nth_unstable_by(h, |a, b| a.partial_cmp(b).unwrap());
    let hi = *m as f64;
    if n & 1 == 1 { hi } else { (left.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64 + hi) / 2.0 }
}
#[inline] fn js_round(x: f64) -> f64 { (x + 0.5).floor() }
fn grid_mad(img: &Image, m: f64) -> f64 {
    let mut df = Vec::new();
    let mut y = 0; while y < img.h { let mut x = 0; while x < img.w { df.push((lum(img, x, y) - m).abs()); x += 32; } y += 32; }
    df.sort_by(|a, b| a.partial_cmp(b).unwrap());
    df[df.len() / 2]
}

/// Returns (json, Some([core, shell, outer])) or (json with error, None).
pub fn adaptive_zone_masks(img: &Image, p: &Value) -> (Value, Option<[Vec<f32>; 3]>) {
    let (w, h) = (img.w as i64, img.h as i64);
    let g = |k: &str, d: f64| p.get(k).and_then(|v| v.as_f64()).unwrap_or(d);
    let (mut cx, mut cy, mut rad) = (g("cx", -1.0), g("cy", -1.0), g("radius", -1.0));
    let core_bias = g("coreBias", 0.5);
    let bg = pooled_median(img);
    let bmad = grid_mad(img, bg);
    if cx < 0.0 {
        let sth = bg + 5.0 * bmad;
        let (mut swx, mut swy, mut sw) = (0f64, 0f64, 0f64);
        let mut y = 8; while y < h - 8 { let mut x = 8; while x < w - 8 {
            let l = lum(img, x as usize, y as usize); if l > sth { swx += x as f64 * l; swy += y as f64 * l; sw += l; }
            x += 8; } y += 8; }
        cx = if sw > 0.0 { js_round(swx / sw) } else { js_round(w as f64 / 2.0) };
        cy = if sw > 0.0 { js_round(swy / sw) } else { js_round(h as f64 / 2.0) };
        rad = js_round((w.min(h)) as f64 * 0.35);
    }
    let subject_th = bg + 5.0 * bmad;
    let mut roi = Vec::new();
    let (cxi, cyi, ri) = (cx as i64, cy as i64, rad as i64);
    let mut y = (cyi - ri).max(0); while y < (cyi + ri).min(h) {
        let mut x = (cxi - ri).max(0); while x < (cxi + ri).min(w) {
            let (dx, dy) = ((x - cxi) as f64, (y - cyi) as f64);
            if !(dx * dx + dy * dy > rad * rad) { let l = lum(img, x as usize, y as usize); if l > subject_th { roi.push(l); } }
            x += 4; }
        y += 4; }
    roi.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if roi.len() < 50 { return (json!({ "error": "too_few_subject_pixels", "count": roi.len() }), None); }
    let core_perc = 0.85 + 0.10 * core_bias;
    let core_th = roi[(roi.len() as f64 * core_perc).floor() as usize];
    let shell_low = roi[(roi.len() as f64 * 0.25).floor() as usize];
    let (mid, half) = ((shell_low + core_th) / 2.0, (core_th - shell_low) / 2.0);
    let n = img.w * img.h;
    let mut mc = vec![0f32; n]; let mut ms = vec![0f32; n]; let mut mo = vec![0f32; n];
    let counts: Vec<(usize, usize, usize)> = mc.par_chunks_mut(img.w).zip(ms.par_chunks_mut(img.w)).zip(mo.par_chunks_mut(img.w)).enumerate()
        .map(|(y, ((rc, rs), ro))| {
            let (mut cc, mut sc, mut oc) = (0, 0, 0);
            for x in 0..img.w {
                let l = lum(img, x, y);
                let (dx, dy) = (x as f64 - cx, y as f64 - cy);
                let dist = (dx * dx + dy * dy).sqrt();
                let roiw = if dist < rad { 1.0 } else { (1.0 - (dist - rad) / 20.0).max(0.0) };
                let mut cv = 0.0; if l > core_th { cv = ((l - core_th) / (1.0 - core_th).max(0.01)).min(1.0); cc += 1; }
                let mut sv = 0.0; if l > shell_low && l <= core_th { sv = (1.0 - (l - mid).abs() / half).min(1.0).max(0.0); sc += 1; }
                let mut ov = 0.0; if l > subject_th && l <= shell_low { ov = ((l - subject_th) / (shell_low - subject_th).max(0.01)).min(1.0); oc += 1; }
                rc[x] = (cv * roiw) as f32; rs[x] = (sv * roiw) as f32; ro[x] = (ov * roiw) as f32;
            }
            (cc, sc, oc)
        }).collect();
    let (cc, sc, oc) = counts.iter().fold((0, 0, 0), |a, c| (a.0 + c.0, a.1 + c.1, a.2 + c.2));
    (json!({ "roi": { "cx": cx, "cy": cy, "radius": rad }, "thresholds": { "core": core_th, "shellLow": shell_low, "outer": subject_th },
             "pixelCounts": { "core": cc, "shell": sc, "outer": oc } }), Some([mc, ms, mo]))
}
