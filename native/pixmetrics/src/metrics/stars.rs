//! Star / tonal / reference metrics. Ports of agents/ops/quality-gates.mjs (checkStarQuality, measureStarField +
//! summarizeStarField, checkTonalPresence, checkStarLayerIntegrity, checkBrightChroma, measurePsfField +
//! summarizePsfField) and agents/ops/subject-metrics.mjs (compareToReference + chromaHistAdd, slicedWasserstein,
//! decileCdfDistance). The PJSR string is the algorithm; the JS wrapper's pass/verdict/details logic is included
//! so each metric returns the same object the JS function returns.
use super::Ctx;
use crate::image::Image;
use rayon::prelude::*;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub const NAMES: &[&str] = &["star_quality", "star_field", "tonal_presence", "compare_reference", "star_layer_integrity", "bright_chroma", "psf_field"];
pub fn dispatch(name: &str, ctx: &Ctx, p: &Value) -> Option<Result<Value, String>> {
    Some(match name {
        "star_quality" => star_quality(ctx.img, p),
        "star_field" => star_field(ctx.img, p),
        "tonal_presence" => tonal_presence(ctx.img, p),
        "compare_reference" => compare_reference(ctx.img, p),
        "star_layer_integrity" => star_layer_integrity(ctx.img),
        "bright_chroma" => bright_chroma(ctx.img, p),
        "psf_field" => psf_field(ctx.img, p),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// shared private helpers
// ---------------------------------------------------------------------------------------------------------------

/// img.sample(x, y, c) as a double.
#[inline] fn smp(img: &Image, x: i64, y: i64, c: usize) -> f64 { img.ch[c][y as usize * img.w + x as usize] as f64 }
/// PJSR getLum/lumAt: Rec.709 in doubles for colour, the sample for mono.
#[inline] fn lum(img: &Image, x: i64, y: i64) -> f64 {
    if img.is_color() { 0.2126 * smp(img, x, y, 0) + 0.7152 * smp(img, x, y, 1) + 0.0722 * smp(img, x, y, 2) } else { smp(img, x, y, 0) }
}
/// measureStarField getLum: NaN outside the image.
#[inline] fn lum_nan(img: &Image, x: i64, y: i64) -> f64 {
    if x < 0 || y < 0 || x >= img.w as i64 || y >= img.h as i64 { f64::NAN } else { lum(img, x, y) }
}
/// JS Math.round (half up).
#[inline] fn jround(v: f64) -> i64 { (v + 0.5).floor() as i64 }
fn sort64(v: &mut [f64]) { v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); }
/// sort + a[floor(n/2)], 0 for empty (the PJSR `median` helpers).
fn jmed(mut v: Vec<f64>) -> f64 { if v.is_empty() { return 0.0; } sort64(&mut v); v[v.len() / 2] }
fn fx(v: f64, n: usize) -> String { format!("{:.*}", n, v) }
/// JS Number -> String (template literal) for simple values.
fn jnum(v: f64) -> String { if v.fract() == 0.0 && v.abs() < 1e21 { format!("{}", v as i64) } else { format!("{}", v) } }
fn num(v: f64) -> Value { if v.is_finite() { json!(v) } else { Value::Null } }
fn onum(v: Option<f64>) -> Value { v.map(num).unwrap_or(Value::Null) }
fn pf(p: &Value, k: &str) -> Option<f64> { p.get(k).and_then(|v| v.as_f64()) }

// ---- exact order statistics over large planes (PixInsight Image.median()/MAD()) ----
#[inline] fn okey(v: f32) -> u32 { let b = v.to_bits(); if b & 0x8000_0000 != 0 { !b } else { b | 0x8000_0000 } }
#[inline] fn unkey(k: u32) -> f32 { if k & 0x8000_0000 != 0 { f32::from_bits(k & 0x7fff_ffff) } else { f32::from_bits(!k) } }

/// k-th smallest (0-based) of f(v) over all planes: two 16-bit radix histogram passes, exact.
fn select_k<F: Fn(f32) -> f32 + Sync>(planes: &[&[f32]], f: &F, k: u64) -> f32 {
    let hist = |pred: &(dyn Fn(u32) -> Option<usize> + Sync)| -> Vec<u64> {
        let mut tot = vec![0u64; 65536];
        for p in planes {
            let h = p.par_chunks(1 << 20).fold(|| vec![0u32; 65536], |mut h, c| { for &v in c { if let Some(b) = pred(okey(f(v))) { h[b] += 1; } } h })
                .reduce(|| vec![0u32; 65536], |mut a, b| { for i in 0..65536 { a[i] += b[i]; } a });
            for i in 0..65536 { tot[i] += h[i] as u64; }
        }
        tot
    };
    let find = |h: &[u64], mut k: u64| -> (usize, u64) { for (i, &c) in h.iter().enumerate() { if k < c { return (i, k); } k -= c; } (65535, 0) };
    let h1 = hist(&|key| Some((key >> 16) as usize));
    let (hi, k2) = find(&h1, k);
    let h2 = hist(&move |key| if (key >> 16) as usize == hi { Some((key & 0xffff) as usize) } else { None });
    let (lo, _) = find(&h2, k2);
    unkey(((hi as u32) << 16) | lo as u32)
}
/// Exact median; even counts average the two central elements (PCL convention).
fn exact_median<F: Fn(f32) -> f32 + Sync>(planes: &[&[f32]], f: &F) -> f64 {
    let n: u64 = planes.iter().map(|p| p.len() as u64).sum();
    if n == 0 { return 0.0; }
    if n % 2 == 1 { select_k(planes, f, n / 2) as f64 } else { (select_k(planes, f, n / 2 - 1) as f64 + select_k(planes, f, n / 2) as f64) / 2.0 }
}
/// Image.median() and raw Image.MAD() over all channels (no channel selection = all channels pooled). Cached per image.
static STATS: Mutex<Vec<(usize, usize, f64, f64)>> = Mutex::new(Vec::new());
fn pooled_med_mad(img: &Image) -> (f64, f64) {
    let key = (img.ch[0].as_ptr() as usize, img.w * img.h);
    if let Some(e) = STATS.lock().unwrap().iter().find(|e| (e.0, e.1) == key) { return (e.2, e.3); }
    let planes: Vec<&[f32]> = img.ch.iter().take(if img.is_color() { 3 } else { 1 }).map(|c| c.as_slice()).collect();
    let med = exact_median(&planes, &|v| v);
    let mad = exact_median(&planes, &|v| ((v as f64 - med).abs()) as f32);
    STATS.lock().unwrap().push((key.0, key.1, med, mad));
    (med, mad)
}
fn small_median(mut v: Vec<f32>) -> f64 {
    let n = v.len(); if n == 0 { return 0.0; }
    let cmp = |a: &f32, b: &f32| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    let (_, m, _) = v.select_nth_unstable_by(n / 2, cmp); let m = *m as f64;
    if n % 2 == 1 { m } else { let lo = v[..n / 2].iter().cloned().fold(f32::MIN, f32::max) as f64; (lo + m) / 2.0 }
}

// ---------------------------------------------------------------------------------------------------------------
// checkStarQuality (quality-gates.mjs:21)
// ---------------------------------------------------------------------------------------------------------------
#[derive(Clone, Copy)] struct Cand { x: i64, y: i64, peak: f64 }

/// params: { minContrast=3.0, fwhmHard=12, starField=true, centerRadiusPx, peaks:[{x,y}] }
fn star_quality(img: &Image, p: &Value) -> Result<Value, String> {
    let (w, h) = (img.w as i64, img.h as i64);
    let is_color = img.is_color();
    let (bg_median, bg_mad) = pooled_med_mad(img);
    let threshold = bg_median + 5.0 * bg_mad;
    let (step, half_box) = (16i64, 10i64);
    let rows: Vec<i64> = (0..).map(|i| half_box + 1 + i * step).take_while(|&y| y < h - half_box - 1).collect();
    let mut cands: Vec<Cand> = rows.par_iter().map(|&y| {
        let mut out = Vec::new();
        let mut x = half_box + 1;
        while x < w - half_box - 1 {
            let l0 = lum(img, x, y);
            if l0 > threshold {
                let (mut bx, mut by, mut bl) = (x, y, l0);
                for dy in -2..=2 { for dx in -2..=2 { let l = lum(img, x + dx, y + dy); if l > bl { bl = l; bx = x + dx; by = y + dy; } } }
                let mut is_max = true;
                'o: for dy in -1..=1 { for dx in -1..=1 { if dx == 0 && dy == 0 { continue; } if lum(img, bx + dx, by + dy) > bl { is_max = false; break 'o; } } }
                if is_max && bl > threshold { out.push(Cand { x: bx, y: by, peak: bl }); }
            }
            x += step;
        }
        out
    }).flatten().collect();
    cands.sort_by(|a, b| b.peak.partial_cmp(&a.peak).unwrap());
    let mut seen = HashSet::new(); let (mut stars_detected, mut faint_stars) = (0usize, 0usize);
    for c in &cands { if seen.insert((c.x.div_euclid(20), c.y.div_euclid(20))) { stars_detected += 1; if c.peak < 0.25 { faint_stars += 1; } } }
    let mut stars: Vec<Cand> = Vec::new();
    for c in &cands {
        let dupe = stars.iter().any(|s| (((c.x - s.x) * (c.x - s.x) + (c.y - s.y) * (c.y - s.y)) as f64).sqrt() < 20.0);
        if !dupe { stars.push(*c); }
        if stars.len() >= 100 { break; }
    }
    let top: Vec<Cand> = stars.iter().take(30).cloned().collect();
    let (mut fwhms, mut cdivs) = (Vec::new(), Vec::new());
    let dirs = [(1i64, 0i64), (0, 1), (-1, 0), (0, -1)];
    for s in &top {
        let half_max = s.peak / 2.0;
        let mut radii = Vec::new();
        for (ddx, ddy) in dirs {
            for r in 1..=half_box {
                let (px, py) = (s.x + ddx * r, s.y + ddy * r);
                if px < 0 || px >= w || py < 0 || py >= h { break; }
                if lum(img, px, py) < half_max { radii.push(r as f64); break; }
            }
        }
        if radii.len() >= 2 { fwhms.push(radii.iter().sum::<f64>() / radii.len() as f64 * 2.0); }
        if is_color {
            let cp = [smp(img, s.x, s.y, 0), smp(img, s.x, s.y, 1), smp(img, s.x, s.y, 2)];
            let mx = cp[0].max(cp[1]).max(cp[2]);
            if mx > 0.01 { let n = [cp[0] / mx, cp[1] / mx, cp[2] / mx]; cdivs.push(n[0].max(n[1]).max(n[2]) - n[0].min(n[1]).min(n[2])); }
        }
    }
    sort64(&mut fwhms); sort64(&mut cdivs);
    let med_fwhm = if fwhms.is_empty() { 0.0 } else { fwhms[fwhms.len() / 2] };
    let med_cdiv = if cdivs.is_empty() { 0.0 } else { cdivs[cdivs.len() / 2] };
    let mut peaks: Vec<f64> = top.iter().map(|s| s.peak).collect(); sort64(&mut peaks);
    let median_peak = if peaks.is_empty() { 0.0 } else { peaks[peaks.len() / 2] };
    let p25_peak = if peaks.len() >= 4 { peaks[(peaks.len() as f64 * 0.25).floor() as usize] } else { median_peak };
    let contrast = if bg_median > 0.001 { median_peak / bg_median } else { 0.0 };

    // JS wrapper
    let min_contrast = pf(p, "minContrast").unwrap_or(3.0);
    let fwhm_limit = pf(p, "fwhmHard").unwrap_or(12.0);
    let stars_found = stars.len();
    let fwhm_pass = med_fwhm <= fwhm_limit;
    let color_pass = med_cdiv > 0.05;
    let count_pass = stars_found >= 20;
    let bright_pass = contrast >= min_contrast;
    let pass = fwhm_pass && color_pass && count_pass && bright_pass;
    let mut det = Vec::new();
    if !fwhm_pass { det.push(format!("Stars bloated: median FWHM={}px (limit: {}px)", fx(med_fwhm, 2), jnum(fwhm_limit))); }
    if !color_pass { det.push(format!("Stars colorless: diversity={} (limit: 0.05)", fx(med_cdiv, 3))); }
    if !count_pass { det.push(format!("Too few stars: {} found (minimum: 20) — stars may be missing or over-reduced", stars_found)); }
    if !bright_pass { det.push(format!("Stars too dim: contrast={}× vs background (limit: {}×), median peak={}, bg={}", fx(contrast, 1), jnum(min_contrast), fx(median_peak, 3), fx(bg_median, 4))); }
    if pass { det.push(format!("Stars OK: FWHM={}px, color={}, count={}, brightness={}× bg", fx(med_fwhm, 2), fx(med_cdiv, 3), stars_found, fx(contrast, 1))); }
    let star_field_v = if p.get("starField") == Some(&Value::Bool(false)) { Value::Null } else {
        let mut sp = Map::new();
        if let Some(v) = p.get("centerRadiusPx") { sp.insert("centerRadiusPx".into(), v.clone()); }
        if let Some(v) = p.get("peaks") { sp.insert("peaks".into(), v.clone()); }
        match star_field(img, &Value::Object(sp)) { Ok(v) => v, Err(e) => json!({ "error": e }) }
    };
    let mpx = (w * h) as f64 / 1e6;
    Ok(json!({
        "pass": pass, "starField": star_field_v,
        "medianFWHM": med_fwhm, "colorDiversity": med_cdiv, "starsFound": stars_found,
        "starsDetected": stars_detected, "faintStars": faint_stars,
        "faintFraction": if stars_detected > 0 { json!(faint_stars as f64 / stars_detected as f64) } else { Value::Null },
        "starsPerMpx": if w > 0 && h > 0 { json!(stars_detected as f64 / mpx) } else { Value::Null },
        "starsMeasured": fwhms.len(), "medianPeak": median_peak, "p25Peak": p25_peak, "bgMedian": bg_median,
        "starBgContrast": contrast, "details": det.join("; "),
        "fwhmSamples": &fwhms[..fwhms.len().min(10)], "colorSamples": &cdivs[..cdivs.len().min(10)], "peakSamples": &peaks[..peaks.len().min(10)],
    }))
}

// ---------------------------------------------------------------------------------------------------------------
// measureStarField = buildStarFieldPjsr + summarizeStarField (quality-gates.mjs:242/510/519)
// ---------------------------------------------------------------------------------------------------------------
fn ring_values(img: &Image, cx: i64, cy: i64, r0: f64, r1: f64) -> Vec<f64> {
    let mut vals = Vec::with_capacity(144);
    for ri in 0..3 {
        let rr = r0 + (r1 - r0) * ri as f64 / 2.0;
        for ai in 0..48 {
            let ang = 2.0 * std::f64::consts::PI * (ai as f64 + 0.5 * (ri % 2) as f64) / 48.0;
            let v = lum_nan(img, jround(cx as f64 + rr * ang.cos()), jround(cy as f64 + rr * ang.sin()));
            if !v.is_nan() { vals.push(v); }
        }
    }
    vals
}
fn walk_fwhm(img: &Image, cx: i64, cy: i64, peak: f64, bg: f64) -> Option<(f64, usize)> {
    let half = bg + (peak - bg) / 2.0;
    const D: [(f64, f64); 8] = [(1., 0.), (0., 1.), (-1., 0.), (0., -1.), (0.7071, 0.7071), (-0.7071, 0.7071), (0.7071, -0.7071), (-0.7071, -0.7071)];
    let (mut radii, mut capped) = (Vec::new(), 0usize);
    for (dx, dy) in D {
        let mut found = -1.0; let mut prev = peak;
        for r in 1..=31 {
            let v = lum_nan(img, jround(cx as f64 + dx * r as f64), jround(cy as f64 + dy * r as f64));
            if v.is_nan() { break; }
            if v < half { found = (r - 1) as f64 + (prev - half) / (1e-9f64).max(prev - v); break; }
            prev = v;
        }
        if found < 0.0 {
            let ve = lum_nan(img, jround(cx as f64 + dx * 31.0), jround(cy as f64 + dy * 31.0));
            if !ve.is_nan() { radii.push(31.0); capped += 1; }
        } else { radii.push(found); }
    }
    if radii.len() < 4 { return None; }
    Some((2.0 * radii.iter().sum::<f64>() / radii.len() as f64, capped))
}
struct Meas { x: i64, y: i64, peak: f64, local_bg: f64, prom: f64, ratio: f64, fwhm: f64, capped: usize, ell: f64, cdiv: f64, dark: f64, center: bool }

/// params: { centerRadiusPx, centerRadiusFrac=0.55, peaks:[{x,y}], maxStars=60, knotRatio=0.6, saturated=0.98,
///           thresholds:{ ellipticity=0.25, darkRing=0.05, fwhmAdvisory=8 } }
fn star_field(img: &Image, p: &Value) -> Result<Value, String> {
    let center_radius_px = pf(p, "centerRadiusPx").filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
    let center_frac = pf(p, "centerRadiusFrac").unwrap_or(0.55);
    let max_stars = pf(p, "maxStars").filter(|v| *v != 0.0).unwrap_or(60.0);
    let knot_ratio = pf(p, "knotRatio").unwrap_or(0.6);
    let saturated = pf(p, "saturated").unwrap_or(0.98);
    let peaks_in: Vec<(i64, i64)> = p.get("peaks").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|q| {
        let (x, y) = (q.get("x")?.as_f64()?, q.get("y")?.as_f64()?);
        if x.is_finite() && y.is_finite() { Some((jround(x), jround(y))) } else { None }
    }).take(200).collect()).unwrap_or_default();
    let is_color = img.is_color();
    let (w, h) = (img.w as i64, img.h as i64);
    let (bg_median, bg_mad) = pooled_med_mad(img);
    let threshold = bg_median + 5.0 * bg_mad;
    let mut cands: Vec<Cand> = Vec::new();
    if !peaks_in.is_empty() {
        for &(px0, py0) in &peaks_in {
            let (mut bx, mut by, mut bl) = (px0, py0, lum_nan(img, px0, py0));
            if bl.is_nan() { continue; }
            for dy in -3..=3 { for dx in -3..=3 { let l2 = lum_nan(img, px0 + dx, py0 + dy); if !l2.is_nan() && l2 > bl { bl = l2; bx = px0 + dx; by = py0 + dy; } } }
            cands.push(Cand { x: bx, y: by, peak: bl });
        }
    } else {
        let (step, margin) = (16i64, 12i64);
        let rows: Vec<i64> = (0..).map(|i| margin + i * step).take_while(|&y| y < h - margin).collect();
        cands = rows.par_iter().map(|&y| {
            let mut out = Vec::new();
            let mut x = margin;
            while x < w - margin {
                let l0 = lum_nan(img, x, y);
                if l0 > threshold {
                    let (mut bx, mut by, mut bl) = (x, y, l0);
                    for _ in 0..25 {
                        let (mut mx, mut my, mut ml) = (bx, by, bl);
                        for dy in -2..=2 { for dx in -2..=2 { let l = lum_nan(img, bx + dx, by + dy); if !l.is_nan() && l > ml { ml = l; mx = bx + dx; my = by + dy; } } }
                        if mx == bx && my == by { break; }
                        bx = mx; by = my; bl = ml;
                    }
                    let mut is_max = true;
                    'o: for dy in -1..=1 { for dx in -1..=1 { if dx == 0 && dy == 0 { continue; } if lum_nan(img, bx + dx, by + dy) > bl { is_max = false; break 'o; } } }
                    if is_max && bl > threshold { out.push(Cand { x: bx, y: by, peak: bl }); }
                }
                x += step;
            }
            out
        }).flatten().collect();
    }
    let raw_candidates = cands.len();
    cands.sort_by(|a, b| b.peak.partial_cmp(&a.peak).unwrap());
    let mut stars: Vec<Cand> = Vec::new();
    for c in &cands {
        if !stars.iter().any(|s| { let (dx, dy) = (c.x - s.x, c.y - s.y); dx * dx + dy * dy < 400 }) { stars.push(*c); }
        if stars.len() >= 400 { break; }
    }
    let (mut sat_skipped, mut knot_rej, mut no_walk, mut snr_rej, mut blend_rej) = (0, 0, 0, 0, 0);
    let (cx_img, cy_img) = (w as f64 / 2.0, h as f64 / 2.0);
    let half_diag = ((w * w + h * h) as f64).sqrt() / 2.0;
    let center_r = if center_radius_px > 0.0 { center_radius_px } else { center_frac * half_diag };
    let mut measured: Vec<Meas> = Vec::new();
    for s in &stars {
        if measured.len() as f64 >= max_stars { break; }
        if s.peak > saturated { sat_skipped += 1; continue; }
        let bg0 = jmed(ring_values(img, s.x, s.y, 20.0, 26.0));
        if s.peak - bg0 <= 5.0 * bg_mad { snr_rej += 1; continue; }
        let wk0 = match walk_fwhm(img, s.x, s.y, s.peak, bg0) { Some(v) => v, None => { no_walk += 1; continue; } };
        let r_a = 14f64.max(200f64.min(6.0 * wk0.0));
        let r_b = (r_a + 4.0).max(240f64.min(8.0 * wk0.0));
        let ring = ring_values(img, s.x, s.y, r_a, r_b);
        if ring.len() < 24 { no_walk += 1; continue; }
        let local_bg = jmed(ring.clone());
        let sigma = 1e-6f64.max(1.4826 * jmed(ring.iter().map(|v| (v - local_bg).abs()).collect()));
        let prom = s.peak - local_bg;
        if prom <= 0.0 { snr_rej += 1; continue; }
        let off = 8i64.max(31i64.min(jround(wk0.0)));
        let nb = [lum_nan(img, s.x + off, s.y), lum_nan(img, s.x - off, s.y), lum_nan(img, s.x, s.y + off), lum_nan(img, s.x, s.y - off)];
        if nb.iter().any(|v| !v.is_nan() && (v - local_bg) >= knot_ratio * prom) { knot_rej += 1; continue; }
        let wk = match walk_fwhm(img, s.x, s.y, s.peak, local_bg) { Some(v) => v, None => { no_walk += 1; continue; } };
        let dr0 = 10f64.max(60f64.min(1.5 * wk.0));
        let dr1 = (dr0 + 4.0).max(80f64.min(2.5 * wk.0));
        let dark_med = jmed(ring_values(img, s.x, s.y, dr0, dr1));
        let dark = 0f64.max((local_bg - dark_med) / prom);
        let mut cdiv = -1.0;
        if is_color {
            let (mut mr, mut mg, mut mb, mut mn) = (0.0, 0.0, 0.0, 0usize);
            for ey in -1..=1 { for ex in -1..=1 {
                let (qx, qy) = (s.x + ex, s.y + ey);
                if qx < 0 || qy < 0 || qx >= w || qy >= h { continue; }
                mr += smp(img, qx, qy, 0); mg += smp(img, qx, qy, 1); mb += smp(img, qx, qy, 2); mn += 1;
            } }
            if mn > 0 {
                mr /= mn as f64; mg /= mn as f64; mb /= mn as f64;
                let mxc = mr.max(mg).max(mb);
                if mxc > 0.01 { cdiv = (mxc - mr.min(mg).min(mb)) / mxc; }
            }
        }
        let mut ell = -1.0; let snr = prom / sigma; let thr = 0.10 * prom;
        let mut vals = [[0f64; 31]; 31];
        for by in -15..=15i64 { for bx in -15..=15i64 { let v = lum_nan(img, s.x + bx, s.y + by); vals[(by + 15) as usize][(bx + 15) as usize] = if v.is_nan() { 0.0 } else { v - local_bg }; } }
        let mut blend = false;
        'b: for by3 in 1..30usize { for bx3 in 1..30usize {
            let (dxs, dys) = (bx3 as i64 - 15, by3 as i64 - 15);
            if dxs * dxs + dys * dys < 36 { continue; }
            let vc = vals[by3][bx3];
            if vc < 0.30 * prom { continue; }
            let mut is_lm = true;
            'l: for ky in -1..=1i64 { for kx in -1..=1i64 { if (kx != 0 || ky != 0) && vals[(by3 as i64 + ky) as usize][(bx3 as i64 + kx) as usize] > vc { is_lm = false; break 'l; } } }
            if is_lm { blend = true; break 'b; }
        } }
        if snr > 20.0 && !blend {
            let (mut sw, mut sx, mut sy) = (0.0, 0.0, 0.0);
            for my in 0..31 { for mx in 0..31 { let vm = vals[my][mx]; if vm < thr { continue; } sw += vm; sx += vm * (mx as f64 - 15.0); sy += vm * (my as f64 - 15.0); } }
            if sw > 0.0 {
                let (mux, muy) = (sx / sw, sy / sw);
                let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
                for my in 0..31 { for mx in 0..31 { let vm = vals[my][mx]; if vm < thr { continue; }
                    let (ux, uy) = ((mx as f64 - 15.0) - mux, (my as f64 - 15.0) - muy);
                    sxx += vm * ux * ux; syy += vm * uy * uy; sxy += vm * ux * uy; } }
                sxx /= sw; syy /= sw; sxy /= sw;
                let (tr, det) = (sxx + syy, sxx * syy - sxy * sxy);
                let disc = (0f64.max(tr * tr / 4.0 - det)).sqrt();
                let (e1, e2) = (tr / 2.0 + disc, tr / 2.0 - disc);
                if e1 > 1e-9 && e2 >= 0.0 { ell = 1.0 - (e2 / e1).sqrt(); }
            }
        } else if blend { blend_rej += 1; } else { snr_rej += 1; }
        let (dcx, dcy) = (s.x as f64 - cx_img, s.y as f64 - cy_img);
        let dist = (dcx * dcx + dcy * dcy).sqrt();
        measured.push(Meas { x: s.x, y: s.y, peak: s.peak, local_bg, prom, ratio: s.peak / 1e-6f64.max(local_bg), fwhm: wk.0, capped: wk.1, ell, cdiv, dark, center: dist <= center_r });
    }
    let col = |set: &[&Meas], f: &dyn Fn(&Meas) -> f64, ok: &dyn Fn(f64) -> bool| -> Vec<f64> { set.iter().map(|m| f(m)).filter(|v| ok(*v)).collect() };
    let all: Vec<&Meas> = measured.iter().collect();
    let ctr: Vec<&Meas> = measured.iter().filter(|m| m.center).collect();
    let edg: Vec<&Meas> = measured.iter().filter(|m| !m.center).collect();
    let any = |_: f64| true; let nonneg = |v: f64| v >= 0.0;
    let ell_count = col(&all, &|m| m.ell, &nonneg).len();
    let n_meas = measured.len();
    let d = json!({
        "starsFound": stars.len(), "rawCandidates": raw_candidates, "starsMeasured": n_meas,
        "rejected": { "saturated": sat_skipped, "knots": knot_rej, "noWalk": no_walk, "lowSNR": snr_rej, "blends": blend_rej },
        "centerRadiusPx": center_r,
        "medianFWHM": jmed(col(&all, &|m| m.fwhm, &any)),
        "centerFWHM": jmed(col(&ctr, &|m| m.fwhm, &any)), "edgeFWHM": jmed(col(&edg, &|m| m.fwhm, &any)),
        "centerCount": ctr.len(), "edgeCount": edg.len(),
        "cappedFraction": if n_meas > 0 { measured.iter().filter(|m| m.capped > 0).count() as f64 / n_meas as f64 } else { 0.0 },
        "medianEllipticity": jmed(col(&all, &|m| m.ell, &nonneg)), "centerEllipticity": jmed(col(&ctr, &|m| m.ell, &nonneg)), "edgeEllipticity": jmed(col(&edg, &|m| m.ell, &nonneg)),
        "ellipticityCount": ell_count,
        "medianDarkRing": jmed(col(&all, &|m| m.dark, &any)),
        "colorDiversity": jmed(col(&all, &|m| m.cdiv, &nonneg)),
        "prominenceAbs": jmed(col(&all, &|m| m.prom, &any)), "localRatio": jmed(col(&all, &|m| m.ratio, &any)),
        "medianPeak": jmed(col(&all, &|m| m.peak, &any)), "bgMedian": bg_median,
        "compactPeaks": measured.iter().take(120).map(|m| json!({ "x": m.x, "y": m.y })).collect::<Vec<_>>(),
        "sample": measured.iter().take(12).map(|m| json!({ "x": m.x, "y": m.y, "peak": m.peak, "localBg": m.local_bg, "prom": m.prom, "ratio": m.ratio,
            "fwhm": m.fwhm, "capped": m.capped, "ell": m.ell, "cdiv": m.cdiv, "dark": m.dark, "center": m.center })).collect::<Vec<_>>(),
    });
    Ok(summarize_star_field(d, p.get("thresholds").unwrap_or(&Value::Null)))
}
fn summarize_star_field(mut d: Value, th: &Value) -> Value {
    let ell_warn = pf(th, "ellipticity").unwrap_or(0.25);
    let ring_warn = pf(th, "darkRing").unwrap_or(0.05);
    let fwhm_adv = pf(th, "fwhmAdvisory").unwrap_or(8.0);
    let g = |k: &str| d.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let gr = |k: &str| d["rejected"].get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let mut adv: Vec<String> = Vec::new();
    if g("centerCount") > 0.0 && g("centerFWHM") > fwhm_adv { adv.push(format!("centre FWHM {}px > {}px", fx(g("centerFWHM"), 1), jnum(fwhm_adv))); }
    if g("ellipticityCount") >= 5.0 && g("centerEllipticity") > ell_warn { adv.push(format!("centre ellipticity {} > {}", fx(g("centerEllipticity"), 2), jnum(ell_warn))); }
    if g("starsMeasured") >= 5.0 && g("medianDarkRing") > ring_warn { adv.push(format!("dark rings {}% of prominence > {}%", fx(g("medianDarkRing") * 100.0, 1), fx(ring_warn * 100.0, 0))); }
    let f = |v: f64, n: usize| if v.is_finite() && v > 0.0 { fx(v, n) } else { "n/a".to_string() };
    let text = format!("star field: {} compact stars (rejected: {} knots, {} saturated, {} blends); FWHM centre {}px (n={}) / edge {}px (n={}); ellipticity centre {} / edge {}; abs prominence {}, local ratio {}x{}",
        g("starsMeasured"), gr("knots"), gr("saturated"), gr("blends"), f(g("centerFWHM"), 1), g("centerCount"), f(g("edgeFWHM"), 1), g("edgeCount"),
        f(g("centerEllipticity"), 2), f(g("edgeEllipticity"), 2), f(g("prominenceAbs"), 3), f(g("localRatio"), 1),
        if adv.is_empty() { String::new() } else { format!(" [ADVISORY: {}]", adv.join("; ")) });
    d["advisories"] = json!(adv); d["text"] = json!(text);
    d
}

// ---------------------------------------------------------------------------------------------------------------
// checkTonalPresence (quality-gates.mjs:986)
// ---------------------------------------------------------------------------------------------------------------
/// params: { category: "<classification>" } (alias: classification)
fn tonal_presence(img: &Image, p: &Value) -> Result<Value, String> {
    let category = p.get("category").or(p.get("classification")).and_then(|v| v.as_str()).unwrap_or("");
    let (w, h) = (img.w as i64, img.h as i64);
    let bg_lum = if img.is_color() {
        let m: Vec<f64> = (0..3).map(|c| exact_median(&[img.ch[c].as_slice()], &|v| v)).collect();
        0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
    } else { exact_median(&[img.ch[0].as_slice()], &|v| v) };
    let mut diffs = Vec::new();
    for y in (0..h).step_by(32) { for x in (0..w).step_by(32) { diffs.push((lum(img, x, y) - bg_lum).abs()); } }
    sort64(&mut diffs);
    let bg_mad = diffs[diffs.len() / 2];
    let thr = bg_lum + 5.0 * bg_mad;
    let (step, probe) = (8i64, 3i64);
    let (mut subj, mut bgp) = (Vec::new(), Vec::new());
    let (mut swx, mut swy, mut sw) = (0.0, 0.0, 0.0);
    let mut starlike = 0usize;
    for y in (0..h).step_by(step as usize) { for x in (0..w).step_by(step as usize) {
        let l = lum(img, x, y);
        if l > thr {
            let mut nb = 0;
            if x - probe >= 0 && lum(img, x - probe, y) > thr { nb += 1; }
            if x + probe < w && lum(img, x + probe, y) > thr { nb += 1; }
            if y - probe >= 0 && lum(img, x, y - probe) > thr { nb += 1; }
            if y + probe < h && lum(img, x, y + probe) > thr { nb += 1; }
            if nb >= 2 { subj.push(l); swx += x as f64 * l; swy += y as f64 * l; sw += l; }
            else { starlike += 1; bgp.push(l); }
        } else { bgp.push(l); }
    } }
    let cxx = if sw > 0.0 { swx / sw } else { w as f64 / 2.0 };
    let cyy = if sw > 0.0 { swy / sw } else { h as f64 / 2.0 };
    let mut roi_mode = "single";
    if subj.len() > 50 {
        let excl = w as f64 * 0.15;
        let (mut swx2, mut swy2, mut sw2) = (0.0, 0.0, 0.0);
        for y in (0..h).step_by(step as usize) { for x in (0..w).step_by(step as usize) {
            let l = lum(img, x, y);
            if l > thr { let (dx, dy) = (x as f64 - cxx, y as f64 - cyy); if (dx * dx + dy * dy).sqrt() > excl { swx2 += x as f64 * l; swy2 += y as f64 * l; sw2 += l; } }
        } }
        if sw2 > sw * 0.15 {
            let (c2x, c2y) = (swx2 / sw2, swy2 / sw2);
            if ((c2x - cxx).powi(2) + (c2y - cyy).powi(2)).sqrt() > w as f64 * 0.25 { roi_mode = "compound_roi"; }
        }
    }
    sort64(&mut subj); sort64(&mut bgp);
    let (sn, bn) = (subj.len(), bgp.len());
    let q = |a: &[f64], f: f64| a[(a.len() as f64 * f).floor() as usize];
    let bg_median = if bn > 0 { q(&bgp, 0.5) } else { bg_lum };
    let bg_p90 = if bn > 0 { q(&bgp, 0.9) } else { bg_lum };
    let (s_med, s_p75, s_p90, s_p10) = if sn > 0 { (q(&subj, 0.5), q(&subj, 0.75), q(&subj, 0.9), q(&subj, 0.1)) } else { (0.0, 0.0, 0.0, 0.0) };
    let top5 = 0f64.max((sn as f64 * 0.95).floor()) as usize;
    let core_n = sn - top5.min(sn);
    let core = if core_n > 0 { subj[top5..].iter().sum::<f64>() / core_n as f64 } else { 0.0 };
    let faint_vis = (s_p10 - bg_p90) / bg_p90.max(0.001);
    let separation = s_med / bg_median.max(0.001);
    let core_to_disk = if s_med > 0.001 { core / s_med } else { 0.0 };
    let total_sampled = ((w as f64 / 8.0) * (h as f64 / 8.0)).floor();
    let sfrac = sn as f64 / total_sampled.max(1.0);
    let roi_conf = if sfrac > 0.03 { "high" } else if sfrac > 0.01 { "medium" } else { "low" };
    let verdict = if separation < 3.0 { "subdued" } else if separation <= 8.0 { "balanced" } else { "aggressive" };
    let pass = verdict != "subdued" || roi_conf == "low";
    let mut cm = Map::new();
    if category.starts_with("galaxy") { cm.insert("core_to_disk".into(), json!(core_to_disk)); }
    let mut det = Vec::new();
    match verdict {
        "subdued" => {
            det.push(format!("SUBDUED: subject/background separation={}× (need >3×). Subject median={}, background median={}.", fx(separation, 2), fx(s_med, 4), fx(bg_median, 4)));
            if roi_conf == "low" { det.push("ROI confidence LOW — few subject pixels detected. Verdict is advisory only.".into()); }
        }
        "aggressive" => det.push(format!("AGGRESSIVE: separation={}× (>8×). Check for burns in bright areas.", fx(separation, 2))),
        _ => det.push(format!("BALANCED: separation={}× (3-8× range). Subject is tonally impactful.", fx(separation, 2))),
    }
    det.push(format!("Core brightness={}, faint visibility={}", fx(core, 4), fx(faint_vis, 3)));
    Ok(json!({
        "pass": pass, "tonal_verdict": verdict, "background_median": bg_median, "background_p90": bg_p90,
        "subject_median": s_med, "subject_p75": s_p75, "subject_p90": s_p90, "separation": separation,
        "core_brightness": core, "faint_structure_visibility": faint_vis, "roi_confidence": roi_conf, "roi_mode": roi_mode,
        "subjectPixelCount": sn, "starlike_rejected": starlike, "category_metrics": cm, "details": det.join(" "),
    }))
}

// ---------------------------------------------------------------------------------------------------------------
// checkStarLayerIntegrity (quality-gates.mjs:1559) and checkBrightChroma (quality-gates.mjs:1732)
// ---------------------------------------------------------------------------------------------------------------
fn star_layer_integrity(img: &Image) -> Result<Value, String> {
    let is_color = img.is_color();
    let nc = if is_color { 3 } else { 1 };
    let max_val = (0..nc).map(|c| img.ch[c].par_iter().cloned().reduce(|| f32::MIN, f32::max) as f64).fold(0.0, f64::max);
    let (w, h) = (img.w as i64, img.h as i64);
    let (mut nonzero, mut c98, mut c995) = (0usize, 0usize, 0usize);
    let mut sats = Vec::new();
    let mut bright: Vec<(f64, f64, f64, f64)> = Vec::new(); // (brightness, r, g, b) in scan order
    for y in (0..h).step_by(4) { for x in (0..w).step_by(4) {
        let val = if is_color { smp(img, x, y, 0).max(smp(img, x, y, 1)).max(smp(img, x, y, 2)) } else { smp(img, x, y, 0) };
        if val > 0.005 {
            nonzero += 1;
            if is_color {
                let (r, g, b) = (smp(img, x, y, 0), smp(img, x, y, 1), smp(img, x, y, 2));
                if r > 0.98 || g > 0.98 || b > 0.98 { c98 += 1; }
                if r > 0.995 || g > 0.995 || b > 0.995 { c995 += 1; }
                let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
                sats.push(if mx > 0.001 { (mx - mn) / mx } else { 0.0 });
                bright.push((r + g + b, r, g, b));
            } else { if val > 0.98 { c98 += 1; } if val > 0.995 { c995 += 1; } }
        }
    } }
    let f98 = if nonzero > 0 { c98 as f64 / nonzero as f64 } else { 0.0 };
    let f995 = if nonzero > 0 { c995 as f64 / nonzero as f64 } else { 0.0 };
    let mut cdiv = 0.0;
    if sats.len() > 10 { sort64(&mut sats); let n = sats.len() as f64; cdiv = sats[(n * 0.75).floor() as usize] - sats[(n * 0.25).floor() as usize]; }
    // JS keeps a running top-20 (insert when brightness > current 20th; stable sort): = top 20 by brightness, ties by scan order.
    bright.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap()); bright.truncate(20);
    let chroma: Vec<f64> = bright.iter().map(|&(_, r, g, b)| { let (mx, mn) = (r.max(g).max(b), r.min(g).min(b)); if mx > 0.001 { (mx - mn) / mx } else { 0.0 } }).collect();
    let bsc = jmed(chroma);
    let mut det = Vec::new();
    let verdict = if max_val >= 0.98 || f995 > 0.0 {
        det.push(format!("CLIPPED STARS: max={} (limit: <0.98), {}% at >0.995.", fx(max_val, 4), fx(f995 * 100.0, 2)));
        det.push("Apply soft rolloff on star layer BEFORE blending: min($T, 0.95) or smooth compression above 0.65.".to_string());
        "FAIL"
    } else if f98 > 0.01 || cdiv < 0.05 {
        if f98 > 0.01 { det.push(format!("Near-clipping: {}% of star pixels >0.98.", fx(f98 * 100.0, 2))); }
        if cdiv < 0.05 { det.push(format!("Low color diversity: {} — stars may appear monochrome.", fx(cdiv, 4))); }
        "WARN"
    } else {
        det.push(format!("Stars clean: max={}, color diversity={}, chroma={}.", fx(max_val, 4), fx(cdiv, 4), fx(bsc, 4)));
        "PASS"
    };
    Ok(json!({
        "pass": verdict == "PASS", "verdict": verdict, "max_value": max_val, "clipped_fraction_98": f98, "clipped_fraction_995": f995,
        "color_diversity": cdiv, "bright_star_chroma": bsc, "nonzero_pixel_count": nonzero,
        "sampled_pixel_count": ((img.w + 3) / 4) * ((img.h + 3) / 4), "details": det.join(" "),
    }))
}

/// params: { brightnessThreshold = 0.50 }
fn bright_chroma(img: &Image, p: &Value) -> Result<Value, String> {
    if !img.is_color() { return Ok(json!({ "medianChroma": 0, "meanChroma": 0, "brightPixelCount": 0, "details": "Mono image — chroma check skipped" })); }
    let t = pf(p, "brightnessThreshold").unwrap_or(0.5);
    let mut cv = Vec::new();
    for y in (0..img.h as i64).step_by(8) { for x in (0..img.w as i64).step_by(8) {
        let (r, g, b) = (smp(img, x, y, 0), smp(img, x, y, 1), smp(img, x, y, 2));
        if (r + g + b) / 3.0 > t { let (mx, mn) = (r.max(g).max(b), r.min(g).min(b)); cv.push(if mx > 0.001 { (mx - mn) / mx } else { 0.0 }); }
    } }
    sort64(&mut cv);
    let n = cv.len();
    let q = |f: f64| if n > 0 { cv[(n as f64 * f).floor() as usize] } else { 0.0 };
    let mean = if n > 0 { cv.iter().sum::<f64>() / n as f64 } else { 0.0 };
    let (m, p25, p75) = (q(0.5), q(0.25), q(0.75));
    Ok(json!({ "medianChroma": m, "meanChroma": mean, "brightPixelCount": n, "p25Chroma": p25, "p75Chroma": p75,
        "details": format!("Bright-region chroma (lum>{}): median={}, mean={}, P25={}, P75={} ({} bright pixels)", jnum(t), fx(m, 4), fx(mean, 4), fx(p25, 4), fx(p75, 4), n) }))
}

// ---------------------------------------------------------------------------------------------------------------
// compareToReference (subject-metrics.mjs:1017)
// ---------------------------------------------------------------------------------------------------------------
fn chroma_hist_add(hist: &mut [f64], a: f64, b: f64, n: usize, lo: f64, hi: f64) {
    let bw = (hi - lo) / n as f64;
    let ia = (((a - lo) / bw).floor() as i64).clamp(0, n as i64 - 1) as usize;
    let ib = (((b - lo) / bw).floor() as i64).clamp(0, n as i64 - 1) as usize;
    hist[ib * n + ia] += 1.0;
}
fn sliced_wasserstein(ha: &[f64], hb: &[f64], n: usize, lo: f64, hi: f64, n_angles: usize) -> Option<f64> {
    let bw = (hi - lo) / n as f64;
    let (sa, sb): (f64, f64) = (ha.iter().sum(), hb.iter().sum());
    if !(sa > 0.0) || !(sb > 0.0) { return None; }
    let idx: Vec<usize> = (0..n * n).filter(|&i| ha[i] > 0.0 || hb[i] > 0.0).collect();
    let (mut total, mut cos_sum) = (0.0, 0.0);
    for k in 0..n_angles {
        let th = k as f64 * std::f64::consts::PI / n_angles as f64; let (c, s) = (th.cos(), th.sin());
        cos_sum += c.abs();
        let mut items: Vec<(f64, f64, f64)> = idx.iter().map(|&q| {
            let (ia, ib) = (q % n, q / n);
            let (ca, cb) = (lo + (ia as f64 + 0.5) * bw, lo + (ib as f64 + 0.5) * bw);
            (ca * c + cb * s, ha[q] / sa, hb[q] / sb)
        }).collect();
        items.sort_by(|p, r| p.0.partial_cmp(&r.0).unwrap());
        let (mut ca, mut cb, mut w1) = (0.0, 0.0, 0.0);
        for m in 0..items.len().saturating_sub(1) { ca += items[m].1; cb += items[m].2; w1 += (ca - cb).abs() * (items[m + 1].0 - items[m].0); }
        total += w1;
    }
    let mc = cos_sum / n_angles as f64;
    Some((total / n_angles as f64) / if mc > 1e-9 { mc } else { 1.0 })
}
fn decile_cdf_distance(a: &[f64], b: &[f64]) -> Option<f64> {
    if a.is_empty() || b.is_empty() { return None; }
    let mut s = 0.0;
    for d in 1..=9 {
        let qa = a[(a.len() - 1).min((a.len() as f64 * d as f64 / 10.0).floor() as usize)];
        let qb = b[(b.len() - 1).min((b.len() as f64 * d as f64 / 10.0).floor() as usize)];
        s += (qa - qb).abs();
    }
    Some(s / 9.0)
}
fn srgb_to_lin(c: f64) -> f64 { if c <= 0.0 { 0.0 } else if c <= 0.04045 { c / 12.92 } else { (2.4 * ((c + 0.055) / 1.055).ln()).exp() } }
fn cbrt_js(t: f64) -> f64 { if t <= 0.0 { 0.0 } else { (t.ln() / 3.0).exp() } }
fn f_lab(t: f64) -> f64 { if t > 0.008856 { cbrt_js(t) } else { 7.787 * t + 16.0 / 116.0 } }
fn rgb_to_lab(r: f64, g: f64, b: f64) -> [f64; 3] {
    let (rl, gl, bl) = (srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b));
    let x = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / 0.95047;
    let y = (0.2126 * rl + 0.7152 * gl + 0.0722 * bl) / 1.00000;
    let z = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / 1.08883;
    let (fx_, fy, fz) = (f_lab(x), f_lab(y), f_lab(z));
    [116.0 * fy - 16.0, 500.0 * (fx_ - fy), 200.0 * (fy - fz)]
}
fn clamp01(v: f64) -> f64 { if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v } }
/// Median RGB of the darkest 20% of a 12x8 grid of per-channel cell medians (Image.median on a selectedRect).
fn dark_cell_medians(img: &Image) -> [f64; 3] {
    let (w, h, nx, ny) = (img.w, img.h, 12usize, 8usize);
    let mut cells: Vec<(f64, [f64; 3])> = (0..nx * ny).into_par_iter().map(|i| {
        let (gx, gy) = (i % nx, i / nx);
        let (x0, y0, x1, y1) = (gx * w / nx, gy * h / ny, (gx + 1) * w / nx, (gy + 1) * h / ny);
        let mut m = [0f64; 3];
        for c in 0..3 { let mut v = Vec::with_capacity((x1 - x0) * (y1 - y0)); for y in y0..y1 { v.extend_from_slice(&img.ch[c][y * w + x0..y * w + x1]); } m[c] = small_median(v); }
        (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2], m)
    }).collect();
    cells.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap());
    let n = 3usize.max((cells.len() as f64 * 0.2).floor() as usize);
    let mut res = [0f64; 3];
    for c in 0..3 { let mut v: Vec<f64> = cells[..n].iter().map(|e| e.1[c]).collect(); sort64(&mut v); res[c] = v[v.len() / 2]; }
    res
}
fn fam_of(h: f64) -> usize { if h < 18.0 || h >= 335.0 { 0 } else if h < 50.0 { 1 } else if h < 70.0 { 2 } else if h < 160.0 { 3 } else if h < 200.0 { 4 } else if h < 255.0 { 5 } else { 6 } }
struct Analysis { hist: Vec<f64>, fam: [f64; 7], n_subject: usize, n_sat: usize, sat_frac: f64, lums: Vec<f64> }
fn analyse(img: &Image, bg: [f64; 3]) -> Analysis {
    let (w, h, color) = (img.w as i64, img.h as i64, img.is_color());
    let step = 1i64.max(((w * h) as f64 / 200000.0).sqrt().ceil() as i64);
    let mut px: Vec<[f64; 4]> = Vec::new();
    for y in (0..h).step_by(step as usize) { for x in (0..w).step_by(step as usize) {
        let (r, g, b) = if color { (smp(img, x, y, 0), smp(img, x, y, 1), smp(img, x, y, 2)) } else { let r = smp(img, x, y, 0); (r, r, r) };
        px.push([r, g, b, 0.2126 * r + 0.7152 * g + 0.0722 * b]);
    } }
    let mut ls: Vec<f64> = px.iter().map(|p| p[3]).collect(); sort64(&mut ls);
    let med = ls[ls.len() / 2];
    let mut dv: Vec<f64> = ls.iter().map(|v| (v - med).abs()).collect(); sort64(&mut dv);
    let thr = med + 4.0 * 1.4826 * dv[dv.len() / 2];
    let subj: Vec<[f64; 4]> = px.into_iter().filter(|p| p[3] > thr).collect();
    let cap = 50000usize;
    let sel: Vec<[f64; 4]> = if subj.len() > cap {
        let kk = subj.len() as f64 / cap as f64;
        (0..cap).map(|j| subj[(subj.len() - 1).min((j as f64 * kk + kk / 2.0).floor() as usize)]).collect()
    } else { subj };
    let mut hist = vec![0f64; 576];
    let (mut fam, mut n_sat, mut lums) = ([0f64; 7], 0usize, Vec::with_capacity(sel.len()));
    for p in &sel {
        lums.push(p[3]);
        if color { let lab = rgb_to_lab(clamp01(p[0] - bg[0]), clamp01(p[1] - bg[1]), clamp01(p[2] - bg[2])); chroma_hist_add(&mut hist, lab[1], lab[2], 24, -60.0, 60.0); }
        let (mx, mn) = (p[0].max(p[1]).max(p[2]), p[0].min(p[1]).min(p[2])); let c = mx - mn;
        let sat = if mx > 0.0 { c / mx } else { 0.0 };
        if sat < 0.08 { continue; }
        let mut hh = 0.0;
        if c > 1e-6 {
            hh = if mx == p[0] { 60.0 * (((p[1] - p[2]) / c) % 6.0) } else if mx == p[1] { 60.0 * ((p[2] - p[0]) / c + 2.0) } else { 60.0 * ((p[0] - p[1]) / c + 4.0) };
            if hh < 0.0 { hh += 360.0; }
        }
        fam[fam_of(hh)] += 1.0; n_sat += 1;
    }
    sort64(&mut lums);
    let mut fr = [0f64; 7]; for f in 0..7 { fr[f] = if n_sat > 0 { fam[f] / n_sat as f64 } else { 0.0 }; }
    Analysis { hist, fam: fr, n_subject: sel.len(), n_sat, sat_frac: if !sel.is_empty() { n_sat as f64 / sel.len() as f64 } else { 0.0 }, lums }
}
fn faint_fraction(img: &Image) -> f64 {
    let (bg_m, bg_mad) = pooled_med_mad(img);
    let (lo, hi) = (bg_m + 1.0 * 1.4826 * bg_mad, bg_m + 6.0 * 1.4826 * bg_mad);
    let (step, d) = (8i64, 3i64); let k = d * step;
    let (w, h) = (img.w as i64, img.h as i64);
    let rows: Vec<i64> = (0..).map(|i| k + i * step).take_while(|&y| y < h - k).collect();
    let (sampled, faint) = rows.par_iter().map(|&y| {
        let (mut s, mut f) = (0usize, 0usize);
        let mut x = k;
        while x < w - k {
            s += 1;
            let l = lum(img, x, y);
            if !(l <= lo || l >= hi) {
                let nb = [lum(img, x - k, y), lum(img, x + k, y), lum(img, x, y - k), lum(img, x, y + k)].iter().filter(|v| **v > lo).count();
                if nb >= 2 { f += 1; }
            }
            x += step;
        }
        (s, f)
    }).reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
    if sampled > 0 { faint as f64 / sampled as f64 } else { 0.0 }
}
fn structure_stats(img: &Image) -> (f64, f64, f64) {
    let st = 1i64.max(img.w as i64 / 400); let k = 4 * st;
    let (w, h) = (img.w as i64, img.h as i64);
    let (mut ls, mut lc) = (Vec::new(), Vec::new());
    let mut y = k;
    while y < h - k { let mut x = k; while x < w - k {
        let l = lum(img, x, y); ls.push(l);
        let m = (lum(img, x - k, y) + lum(img, x + k, y) + lum(img, x, y - k) + lum(img, x, y + k)) / 4.0;
        lc.push((l - m).abs()); x += st; } y += st; }
    sort64(&mut ls); sort64(&mut lc);
    let pc = |a: &[f64], f: f64| if a.is_empty() { 0.0 } else { a[(a.len() - 1).min((f * a.len() as f64).floor() as usize)] };
    let p50 = 1e-4f64.max(pc(&ls, 0.5));
    ((p50 - pc(&ls, 0.05)) / p50, pc(&lc, 0.5) / p50, pc(&lc, 0.9) / p50)
}
fn grain_stats(img: &Image) -> (Option<f64>, Option<f64>) {
    let (w, h) = (img.w as i64, img.h as i64);
    let mut ls = Vec::new();
    let mut y = 8; while y < h - 8 { let mut x = 8; while x < w - 8 { ls.push(lum(img, x, y)); x += 4; } y += 4; }
    sort64(&mut ls);
    let p50 = if ls.is_empty() { 0.0 } else { ls[ls.len() / 2] };
    let (mut halo, mut sky) = (Vec::new(), Vec::new());
    let mut y = 8; while y < h - 8 { let mut x = 8; while x < w - 8 {
        let l = lum(img, x, y);
        let n1 = (lum(img, x - 1, y) + lum(img, x + 1, y) + lum(img, x, y - 1) + lum(img, x, y + 1)) / 4.0;
        let wide = (lum(img, x - 6, y) + lum(img, x + 6, y) + lum(img, x, y - 6) + lum(img, x, y + 6)
            + lum(img, x - 4, y - 4) + lum(img, x + 4, y + 4) + lum(img, x - 4, y + 4) + lum(img, x + 4, y - 4)) / 8.0;
        if (l - wide).abs() <= 0.08 {
            let hf = (l - n1).abs();
            if wide > p50 + 0.06 && wide < p50 + 0.35 { halo.push(hf); } else if wide < p50 + 0.01 { sky.push(hf); }
        }
        x += 2; } y += 2; }
    sort64(&mut halo); sort64(&mut sky);
    (if halo.len() > 200 { Some(halo[halo.len() / 2]) } else { None }, if sky.len() > 200 { Some(sky[sky.len() / 2]) } else { None })
}
fn mitchell(x: f64) -> f64 {
    let (b, c) = (1.0 / 3.0, 1.0 / 3.0); let x = x.abs();
    if x < 1.0 { ((12.0 - 9.0 * b - 6.0 * c) * x * x * x + (-18.0 + 12.0 * b + 6.0 * c) * x * x + (6.0 - 2.0 * b)) / 6.0 }
    else if x < 2.0 { ((-b - 6.0 * c) * x * x * x + (6.0 * b + 30.0 * c) * x * x + (-12.0 * b - 48.0 * c) * x + (8.0 * b + 24.0 * c)) / 6.0 }
    else { 0.0 }
}
/// Per output index: (first source index, normalised weights). Matches PixInsight 1.9.5 Resample with
/// MitchellNetravaliFilter (default smoothness 1.5) to 3e-8 — fitted 2026-11-10 on 2-D noise for scale factors
/// 0.6-3: separable; source position c = t * (src/dst) (no half-pixel offset); kernel radius
/// R = max(1, floor(src/dst)) + 1.5 source pixels, weight = Mitchell(B=C=1/3)(2 (j - c) / R), normalised;
/// out-of-range taps clamp to the edge pixel.
fn resample_weights(src: usize, dst: usize) -> Vec<(usize, Vec<f32>)> {
    let scale = src as f64 / dst as f64; let r = (scale.floor()).max(1.0) + 1.5;
    (0..dst).map(|t| {
        let c = t as f64 * scale;
        let (a, b) = ((c - r).ceil() as i64, (c + r).floor() as i64);
        let ws: Vec<f64> = (a..=b).map(|j| mitchell(2.0 * (j as f64 - c) / r)).collect();
        let lo = a.clamp(0, src as i64 - 1) as usize; let hi = b.clamp(0, src as i64 - 1) as usize;
        let mut wv = vec![0f64; hi - lo + 1];
        for (i, j) in (a..=b).enumerate() { let jj = j.clamp(lo as i64, hi as i64) as usize; wv[jj - lo] += ws[i]; }
        let s: f64 = wv.iter().sum();
        (lo, wv.iter().map(|v| (v / s) as f32).collect())
    }).collect()
}
/// PixInsight Resample (AbsolutePixels, ForceWidthAndHeight, MitchellNetravaliFilter) approximation; `levels` > 0
/// re-quantises to an integer sample format (the reference window keeps its on-disk format in PI).
fn resample(img: &Image, dw: usize, dh: usize, levels: f64) -> Image {
    let (wx, wy) = (resample_weights(img.w, dw), resample_weights(img.h, dh));
    let mut out = Image::new(dw, dh, img.n_channels());
    for c in 0..img.n_channels() {
        let src = &img.ch[c];
        let mut tmp = vec![0f32; dw * img.h];
        tmp.par_chunks_mut(dw).enumerate().for_each(|(y, row)| { let s = &src[y * img.w..(y + 1) * img.w];
            for (x, (st, ws)) in wx.iter().enumerate() { let mut a = 0f32; for (i, w) in ws.iter().enumerate() { a += w * s[st + i]; } row[x] = a; } });
        out.ch[c].par_chunks_mut(dw).enumerate().for_each(|(y, row)| { let (st, ws) = &wy[y];
            for (i, w) in ws.iter().enumerate() { let t = &tmp[(st + i) * dw..(st + i + 1) * dw]; for x in 0..dw { row[x] += w * t[x]; } }
            for v in row.iter_mut() { let mut q = v.clamp(0.0, 1.0); if levels > 0.0 { q = ((q as f64 * levels).round() / levels) as f32; } *v = q; } });
    }
    out
}
fn load_reference(path: &str) -> Result<(Image, f64), String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        // PI opens PNG as an 8/16-bit integer image: keep its quantisation for the resampled copy.
        let mut hdr = [0u8; 26];
        use std::io::Read; std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut hdr)).map_err(|e| e.to_string())?;
        let levels = if hdr[24] == 16 { 65535.0 } else { 255.0 };
        return Ok((crate::util::read_png(path)?, levels));
    }
    if lower.ends_with(".xisf") {
        let (im, info) = crate::xisf::read(path, 0)?;
        let levels = match info.sample_format.as_str() { "UInt8" => 255.0, "UInt16" => 65535.0, "UInt32" => 4294967295.0, _ => 0.0 };
        return Ok((im, levels));
    }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { return Ok((crate::util::read_jpeg(path)?, 255.0)); }
    Err(format!("compareToReference: unsupported reference format (native reader handles .xisf/.png/.jpg): {path}"))
}

/// params: { reference_path (alias referencePath), targetWidth = 1500 }
fn compare_reference(a: &Image, p: &Value) -> Result<Value, String> {
    let path = p.get("reference_path").or(p.get("referencePath")).and_then(|v| v.as_str()).ok_or("params.reference_path required")?;
    let (b, levels) = load_reference(path).map_err(|e| format!("compareToReference: failed to open reference: {path}: {e}"))?;
    let tw = pf(p, "targetWidth").unwrap_or(1500.0) as usize;
    let mut out = Map::new();
    let aspect_a = a.w as f64 / a.h as f64; let aspect_b = b.w as f64 / b.h as f64;
    let aspect_ok = (aspect_a / aspect_b - 1.0).abs() <= 0.01;
    out.insert("aspect_ok".into(), json!(aspect_ok)); out.insert("geometry_ok".into(), json!(aspect_ok));
    out.insert("same_size".into(), json!(a.w == b.w && a.h == b.h));
    let mono_bg = |im: &Image| { let m = pooled_med_mad(im).0; [m, m, m] };
    let both_color = a.is_color() && b.is_color();
    let (bg_a, bg_b) = rayon::join(|| if a.is_color() { dark_cell_medians(a) } else { mono_bg(a) }, || if b.is_color() { dark_cell_medians(&b) } else { mono_bg(&b) });
    let (aa, bb) = rayon::join(|| analyse(a, bg_a), || analyse(&b, bg_b));
    out.insert("lum_cdf_dist".into(), onum(decile_cdf_distance(&aa.lums, &bb.lums)));
    out.insert("subject_samples_target".into(), json!(aa.n_subject)); out.insert("subject_samples_ref".into(), json!(bb.n_subject));
    out.insert("sat_frac_target".into(), json!(aa.sat_frac)); out.insert("sat_frac_ref".into(), json!(bb.sat_frac));
    out.insert("bg_cast_delta".into(), Value::Null); out.insert("palette_l1".into(), Value::Null); out.insert("lab_emd".into(), Value::Null);
    let mut bg_cast: Option<f64> = None;
    if both_color {
        let (la, lb) = (rgb_to_lab(bg_a[0], bg_a[1], bg_a[2]), rgb_to_lab(bg_b[0], bg_b[1], bg_b[2]));
        let (da, db) = (la[1] - lb[1], la[2] - lb[2]);
        bg_cast = Some((da * da + db * db).sqrt());
        out.insert("bg_cast_delta".into(), onum(bg_cast));
        if aa.n_sat > 0 && bb.n_sat > 0 { out.insert("palette_l1".into(), json!((0..7).map(|f| (aa.fam[f] - bb.fam[f]).abs()).sum::<f64>())); }
        out.insert("lab_emd".into(), onum(sliced_wasserstein(&aa.hist, &bb.hist, 24, -60.0, 60.0, 8)));
        out.insert("fam_target".into(), json!(aa.fam.to_vec())); out.insert("fam_ref".into(), json!(bb.fam.to_vec()));
    }
    out.insert("color_emd".into(), json!(bg_cast.map(|v| v / 100.0).unwrap_or(0.0)));
    let (ft, fr) = rayon::join(|| faint_fraction(a), || faint_fraction(&b));
    out.insert("faint_target".into(), json!(ft)); out.insert("faint_ref".into(), json!(fr)); out.insert("coverage_delta".into(), json!(fr - ft));
    let (st, sr) = rayon::join(|| structure_stats(a), || structure_stats(&b));
    out.insert("dark_depth_target".into(), num(st.0)); out.insert("dark_depth_ref".into(), num(sr.0)); out.insert("dark_depth_delta".into(), num(sr.0 - st.0));
    out.insert("lc_ratio".into(), if sr.1 > 0.0 { num(st.1 / sr.1) } else { Value::Null });
    out.insert("lc_p90_ratio".into(), if sr.2 > 0.0 { num(st.2 / sr.2) } else { Value::Null });
    // MS-SSIM + grain on copies resampled to a common width
    let (ta, tb) = rayon::join(|| resample(a, tw, (tw as f64 * a.h as f64 / a.w as f64).round() as usize, 0.0),
                               || resample(&b, tw, (tw as f64 * b.h as f64 / b.w as f64).round() as usize, levels));
    let (gt, gr) = rayon::join(|| grain_stats(&ta), || grain_stats(&tb));
    out.insert("grain_halo_target".into(), onum(gt.0)); out.insert("grain_halo_ref".into(), onum(gr.0));
    out.insert("grain_sky_target".into(), onum(gt.1)); out.insert("grain_sky_ref".into(), onum(gr.1));
    out.insert("grain_halo_ratio".into(), match (gt.0, gr.0) { (Some(t), Some(r)) if r > 0.0 => num(t / r), _ => Value::Null });
    out.insert("grain_sky_ratio".into(), match (gt.1, gr.1) { (Some(t), Some(r)) if r > 0.0 => num(t / r), _ => Value::Null });
    let mut ms_ssim: Option<f64> = None; let mut per_scale: Vec<f64> = Vec::new();
    if aspect_ok && ta.w == tb.w && ta.h == tb.h {
        let (w, h) = (ta.w as i64, ta.h as i64);
        let (c1, c2) = (0.0001, 0.0009);
        let mut prod = 1.0; let mut valid = 0;
        for step in [2i64, 4, 8] {
            let win = step * 3;
            let bys: Vec<i64> = (0..).map(|i| win + i * win).take_while(|&y| y < h - win).collect();
            let (sum_s, cnt) = bys.par_iter().map(|&by| {
                let (mut s, mut n) = (0.0, 0usize);
                let mut bx = win;
                while bx < w - win {
                    let (mut ma, mut mb, mut k) = (0.0, 0.0, 0usize);
                    let mut yy = by - win; while yy <= by + win { let mut xx = bx - win; while xx <= bx + win { ma += lum(&ta, xx, yy); mb += lum(&tb, xx, yy); k += 1; xx += step; } yy += step; }
                    if k >= 4 {
                        ma /= k as f64; mb /= k as f64;
                        let (mut va, mut vb, mut cov) = (0.0, 0.0, 0.0);
                        let mut yy = by - win; while yy <= by + win { let mut xx = bx - win; while xx <= bx + win {
                            let (pa, pb) = (lum(&ta, xx, yy) - ma, lum(&tb, xx, yy) - mb); va += pa * pa; vb += pb * pb; cov += pa * pb; xx += step; } yy += step; }
                        let kk = (k - 1) as f64; va /= kk; vb /= kk; cov /= kk;
                        s += ((2.0 * ma * mb + c1) * (2.0 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2)); n += 1;
                    }
                    bx += win;
                }
                (s, n)
            }).collect::<Vec<_>>().into_iter().fold((0.0, 0usize), |a, b| (a.0 + b.0, a.1 + b.1));
            let avg = if cnt > 0 { sum_s / cnt as f64 } else { 1.0 }.clamp(0.0, 1.0);
            per_scale.push(avg); prod *= avg; valid += 1;
        }
        ms_ssim = if valid > 0 { Some(prod) } else { None };
    }
    out.insert("ms_ssim".into(), onum(ms_ssim)); out.insert("ms_ssim_per_scale".into(), json!(per_scale));
    let g = |k: &str| out.get(k).and_then(|v| v.as_f64());
    let f3 = |v: Option<f64>| v.map(|x| fx(x, 3)).unwrap_or("n/a".into());
    let f1 = |v: Option<f64>| v.map(|x| fx(x, 1)).unwrap_or("n/a".into());
    let details = format!("bg_cast_delta={} dE(a*b*) [color_emd alias={}]; palette_l1={} (saturated subject: target {}, ref {}); lab_emd={} (chroma-only a*b*); lum_cdf_dist={}; ms_ssim={}; coverage_delta={} (faint target={}, ref={}); dark_depth target={} ref={}; local_contrast ratio={} (p90 {}; 1.0 = same as reference); grain halo ratio={} sky ratio={} (>1 = grainier than reference)",
        f1(g("bg_cast_delta")), f3(g("color_emd")), f3(g("palette_l1")), f3(g("sat_frac_target")), f3(g("sat_frac_ref")), f1(g("lab_emd")), f3(g("lum_cdf_dist")),
        if aspect_ok { f3(g("ms_ssim")) } else { "n/a (aspect mismatch)".into() }, f3(g("coverage_delta")), f3(g("faint_target")), f3(g("faint_ref")),
        f3(g("dark_depth_target")), f3(g("dark_depth_ref")), f3(g("lc_ratio")), f3(g("lc_p90_ratio")), f3(g("grain_halo_ratio")), f3(g("grain_sky_ratio")));
    out.insert("details".into(), json!(details));
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------------------------------------------
// measurePsfField = buildPsfFieldPjsr + summarizePsfField (quality-gates.mjs:1848/1910/1976)
// ---------------------------------------------------------------------------------------------------------------
struct PsfStar { fwhm: f64, e: f64, rel: f64, skew: f64, cell: (usize, usize) }
/// params: { cols=8, rows=6, maxStars=1500, satLimit=0.45, thresholds:{ minStarsPerCell=3, fwhmFactor=1.5, maxEllipticity=0.3, asymmetryRatio=1.5 } }
fn psf_field(img: &Image, p: &Value) -> Result<Value, String> {
    let nx = pf(p, "cols").unwrap_or(8.0) as usize; let ny = pf(p, "rows").unwrap_or(6.0) as usize;
    let max_stars = pf(p, "maxStars").unwrap_or(1500.0) as usize; let sat = pf(p, "satLimit").unwrap_or(0.45);
    let (w, h) = (img.w as i64, img.h as i64);
    let chn = if img.is_color() { 1 } else { 0 };
    let (med, mad) = pooled_med_mad(img); let sig = mad * 1.4826;
    // IntegerResample zoomFactor -2, Average (only channel CH is read)
    let (bw, bh) = (img.w / 2, img.h / 2);
    let src = &img.ch[chn];
    let mut bin = vec![0f32; bw * bh];
    bin.par_chunks_mut(bw).enumerate().for_each(|(y, row)| { for x in 0..bw {
        let i = 2 * y * img.w + 2 * x;
        row[x] = ((src[i] as f64 + src[i + 1] as f64 + src[i + img.w] as f64 + src[i + img.w + 1] as f64) / 4.0) as f32; } });
    let bs = |x: i64, y: i64| bin[y as usize * bw + x as usize] as f64;
    let thr = med + 40.0 * sig / 2.0;
    let step: i64 = if w * h > 30_000_000 { 2 } else { 1 };
    let (bw, bh) = (bw as i64, bh as i64);
    let rows: Vec<i64> = (0..).map(|i| 12 + i * step).take_while(|&y| y < bh - 12).collect();
    let mut cands: Vec<(i64, i64, f64)> = rows.par_iter().map(|&y| {
        let mut o = Vec::new(); let mut x = 12;
        while x < bw - 12 {
            let v = bs(x, y);
            if v >= thr {
                let mut is_max = true;
                'o: for dy in -2..=2 { for dx in -2..=2 { if (dx != 0 || dy != 0) && bs(x + dx, y + dy) > v { is_max = false; break 'o; } } }
                if is_max { o.push((x * 2, y * 2, v)); }
            }
            x += step;
        }
        o
    }).flatten().collect();
    cands.sort_by(|p, q| q.2.partial_cmp(&p.2).unwrap());
    let (cx0, cy0, r) = (w as f64 / 2.0, h as f64 / 2.0, 24i64);
    let cap = ((max_stars as f64 / (nx * ny) as f64).ceil() * 2.0) as usize;
    let mut stars: Vec<PsfStar> = Vec::new(); let mut cell_count: HashMap<(usize, usize), usize> = HashMap::new();
    let s = |x: i64, y: i64| smp(img, x, y, chn);
    for &(sx, sy, _) in &cands {
        if stars.len() >= max_stars { break; }
        if sx < r + 2 || sy < r + 2 || sx > w - r - 3 || sy > h - r - 3 { continue; }
        let (mut pk, mut px, mut py) = (0.0, sx, sy);
        for dy in -2..=2 { for dx in -2..=2 { let v = s(sx + dx, sy + dy); if v > pk { pk = v; px = sx + dx; py = sy + dy; } } }
        if pk > sat { continue; }
        let ci = (nx - 1).min((px as f64 / w as f64 * nx as f64).floor() as usize);
        let cj = (ny - 1).min((py as f64 / h as f64 * ny as f64).floor() as usize);
        if *cell_count.get(&(ci, cj)).unwrap_or(&0) >= cap { continue; }
        let mut ring: Vec<f64> = (0..64).map(|a| { let t = a as f64 / 64.0 * 2.0 * std::f64::consts::PI; s(jround(px as f64 + r as f64 * t.cos()), jround(py as f64 + r as f64 * t.sin())) }).collect();
        sort64(&mut ring); let lb = ring[32];
        let amp = pk - lb; if amp < 20.0 * sig { continue; }
        let (mut s0, mut sx1, mut sy1) = (0.0, 0.0, 0.0); let mut win: Vec<(f64, f64, f64)> = Vec::new();
        for dy in -r..=r { for dx in -r..=r { let v = s(px + dx, py + dy) - lb; if v < 0.08 * amp { continue; } s0 += v; sx1 += v * dx as f64; sy1 += v * dy as f64; win.push((dx as f64, dy as f64, v)); } }
        if s0 <= 0.0 || win.len() < 6 { continue; }
        let (mx, my) = (sx1 / s0, sy1 / s0);
        let (mut ixx, mut iyy, mut ixy) = (0.0, 0.0, 0.0);
        for d in &win { let (ex, ey) = (d.0 - mx, d.1 - my); ixx += d.2 * ex * ex; iyy += d.2 * ey * ey; ixy += d.2 * ex * ey; }
        ixx /= s0; iyy /= s0; ixy /= s0;
        let tr = (ixx + iyy) / 2.0; let dd = (0f64.max((ixx - iyy) * (ixx - iyy) / 4.0 + ixy * ixy)).sqrt();
        let (l1, l2) = (tr + dd, 1e-6f64.max(tr - dd));
        let (a_ax, b_ax) = (l1.sqrt(), l2.sqrt()); let theta = 0.5 * (2.0 * ixy).atan2(ixx - iyy);
        let (rx, ry) = (px as f64 + mx - cx0, py as f64 + my - cy0);
        let rr = { let v = (rx * rx + ry * ry).sqrt(); if v == 0.0 { 1.0 } else { v } };
        let (ux, uy, phi) = (rx / rr, ry / rr, ry.atan2(rx));
        let (mut m3, mut m2) = (0.0, 0.0);
        for d in &win { let t = (d.0 - mx) * ux + (d.1 - my) * uy; m2 += d.2 * t * t; m3 += d.2 * t * t * t; }
        m2 /= s0; m3 /= s0;
        let skew = m3 / m2.max(1e-6).powf(1.5);
        let mut rel = (((theta - phi) * 180.0 / std::f64::consts::PI) % 180.0).abs(); if rel > 90.0 { rel = 180.0 - rel; }
        stars.push(PsfStar { fwhm: 2.3548 * ((l1 + l2) / 2.0).sqrt(), e: 1.0 - b_ax / a_ax, rel, skew, cell: (ci, cj) });
        *cell_count.entry((ci, cj)).or_insert(0) += 1;
    }
    let medv = |v: Vec<f64>| if v.is_empty() { f64::NAN } else { jmed(v) };
    // grid[row][col] = (n, fwhm, e, rel, skew)
    let grid: Vec<Vec<(usize, f64, f64, f64, f64)>> = (0..ny).map(|j| (0..nx).map(|i| {
        let c: Vec<&PsfStar> = stars.iter().filter(|s| s.cell == (i, j)).collect();
        (c.len(), medv(c.iter().map(|s| s.fwhm).collect()), medv(c.iter().map(|s| s.e).collect()), medv(c.iter().map(|s| s.rel).collect()), medv(c.iter().map(|s| s.skew).collect()))
    }).collect()).collect();
    Ok(summarize_psf(w, h, stars.len(), &grid, p.get("thresholds").unwrap_or(&Value::Null)))
}
fn largest_good_rect(good: &[Vec<bool>]) -> Option<(usize, usize, usize, usize, usize)> {
    let rows = good.len(); let cols = if rows > 0 { good[0].len() } else { 0 };
    let mut best: Option<(usize, usize, usize, usize, usize)> = None;
    for r0 in 0..rows { for c0 in 0..cols { for r1 in r0..rows { for c1 in c0..cols {
        let ok = (r0..=r1).all(|r| (c0..=c1).all(|c| good[r][c]));
        if !ok { continue; }
        let cells = (r1 - r0 + 1) * (c1 - c0 + 1);
        if best.map_or(true, |b| cells > b.4) { best = Some((c0, r0, c1, r1, cells)); }
    } } } }
    best
}
fn summarize_psf(w: i64, h: i64, n_stars: usize, grid: &[Vec<(usize, f64, f64, f64, f64)>], th: &Value) -> Value {
    let min_n = pf(th, "minStarsPerCell").unwrap_or(3.0) as usize;
    let fwhm_factor = pf(th, "fwhmFactor").unwrap_or(1.5);
    let max_e = pf(th, "maxEllipticity").unwrap_or(0.3);
    let asym_r = pf(th, "asymmetryRatio").unwrap_or(1.5);
    let rows = grid.len(); let cols = if rows > 0 { grid[0].len() } else { 0 };
    let cell_json = |j: usize, i: usize| { let c = grid[j][i]; let on = c.0 > 0;
        json!({ "col": i, "row": j, "n": c.0, "fwhm_med": if on { num(c.1) } else { Value::Null }, "ellipticity_med": if on { num(c.2) } else { Value::Null },
                "orient_vs_radial_deg": if on { num(c.3) } else { Value::Null }, "radial_skew": if on { num(c.4) } else { Value::Null } }) };
    let cells: Vec<Vec<Value>> = (0..rows).map(|j| (0..cols).map(|i| cell_json(j, i)).collect()).collect();
    let mut valid: Vec<(usize, usize)> = Vec::new(); // (row, col)
    for j in 0..rows { for i in 0..cols { if grid[j][i].0 >= min_n && grid[j][i].0 > 0 && grid[j][i].1.is_finite() { valid.push((j, i)); } } }
    if valid.len() < 4 {
        return json!({ "ok": false, "verdict": "insufficient stars", "nStars": n_stars, "cells": cells, "details": format!("PSF map: only {} cells with >= {} stars.", valid.len(), min_n) });
    }
    let fw = |c: (usize, usize)| grid[c.0][c.1].1;
    let (mut best, mut worst) = (valid[0], valid[0]);
    for &c in &valid { if fw(c) < fw(best) { best = c; } if fw(c) > fw(worst) { worst = c; } }
    let cc = [(cols - 1) / 2, (cols - 1 + 1) / 2]; let cr = [(rows - 1) / 2, (rows - 1 + 1) / 2];
    let mut centre = Vec::new();
    for &j in &cr { for &i in &cc { if grid[j][i].0 >= min_n { centre.push(grid[j][i].1); } } }
    let center_fwhm = if centre.is_empty() { None } else { Some(jmed(centre)) };
    let side = |cs: Vec<usize>, rs: Vec<usize>| -> Option<f64> {
        let mut v = Vec::new(); for &j in &rs { for &i in &cs { if grid[j][i].0 >= min_n { v.push(grid[j][i].1); } } }
        if v.is_empty() { None } else { Some(jmed(v)) } };
    let (wc, hc) = (2.min(cols / 2), 2.min(rows / 2));
    let all_r: Vec<usize> = (0..rows).collect(); let all_c: Vec<usize> = (0..cols).collect();
    let l = side((0..wc).collect(), all_r.clone()); let r = side((cols - wc..cols).collect(), all_r.clone());
    let t = side(all_c.clone(), (0..hc).collect()); let b = side(all_c.clone(), (rows - hc..rows).collect());
    let truthy = |v: Option<f64>| v.filter(|x| *x != 0.0 && !x.is_nan());
    let ratio = |a: Option<f64>, b: Option<f64>| match (truthy(a), truthy(b)) { (Some(a), Some(b)) => Some(a.max(b) / a.min(b)), _ => None };
    let (lr, tb) = (ratio(l, r), ratio(t, b));
    let edge: Vec<(usize, usize)> = valid.iter().cloned().filter(|&(j, i)| j == 0 || j == rows - 1 || i == 0 || i == cols - 1).collect();
    let em = |k: usize| -> Option<f64> { if edge.is_empty() { None } else { Some(jmed(edge.iter().map(|&(j, i)| { let c = grid[j][i]; [c.1, c.2, c.3][k] }).collect())) } };
    let (edge_fwhm, edge_e, edge_rel) = (em(0), em(1), em(2));
    let mut verdict = "uniform";
    if lr.map_or(false, |v| v >= asym_r) || tb.map_or(false, |v| v >= asym_r) { verdict = "asymmetric — check tilt/backfocus"; }
    else if let (Some(cf), Some(ef)) = (truthy(center_fwhm), truthy(edge_fwhm)) {
        if ef / cf >= 1.3 && edge_rel.map_or(false, |v| v < 35.0) && edge_e.unwrap_or(0.0) > 0.15 { verdict = "radial coma"; }
    }
    let good: Vec<Vec<bool>> = (0..rows).map(|j| (0..cols).map(|i| { let c = grid[j][i]; c.0 >= min_n && c.0 > 0 && c.1 <= fwhm_factor * fw(best) && c.2 <= max_e }).collect()).collect();
    let rect = largest_good_rect(&good);
    let (cw, chh) = (w as f64 / cols as f64, h as f64 / rows as f64);
    let crop = rect.map(|(c0, r0, c1, r1, n)| json!({ "x0": jround(c0 as f64 * cw), "y0": jround(r0 as f64 * chh), "x1": jround((c1 + 1) as f64 * cw), "y1": jround((r1 + 1) as f64 * chh),
        "cells": n, "fractionOfFrame": n as f64 / (cols * rows) as f64 }));
    let f = |x: Option<f64>| x.map(|v| fx(v, 2)).unwrap_or("n/a".into());
    let details = format!("PSF field: verdict={}. FWHM best={}px (cell {},{}) worst={}px (cell {},{}) centre={}px; L/R={}x (L={} R={}), T/B={}x. {}",
        verdict, f(Some(fw(best))), best.1, best.0, f(Some(fw(worst))), worst.1, worst.0, f(center_fwhm), f(lr), f(l), f(r), f(tb),
        match &crop { Some(c) => format!("Suggested crop box (for the user's crop; never crop the starless deliverable): x {}-{}, y {}-{} ({}% of frame).", c["x0"], c["x1"], c["y0"], c["y1"], fx(c["fractionOfFrame"].as_f64().unwrap() * 100.0, 0)),
            None => "No contiguous good-PSF region found.".into() });
    json!({ "ok": true, "verdict": verdict, "nStars": n_stars, "W": w, "H": h,
        "best": { "col": best.1, "row": best.0, "fwhm": fw(best) }, "worst": { "col": worst.1, "row": worst.0, "fwhm": fw(worst) },
        "center_fwhm": onum(center_fwhm), "lr_ratio": onum(lr), "tb_ratio": onum(tb), "left_fwhm": onum(l), "right_fwhm": onum(r), "top_fwhm": onum(t), "bottom_fwhm": onum(b),
        "crop_box": crop.unwrap_or(Value::Null), "cells": cells, "details": details })
}
