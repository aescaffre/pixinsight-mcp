//! Colour metrics. Ports of agents/ops/subject-metrics.mjs (measurePalettePurity, measureNucleus, measureChromaNoise,
//! measureHaKnots, measureHaKnotColour), quality-gates.mjs checkSaturation, sho-palette.mjs measurePaletteBalance,
//! stats.mjs measureColorGradient (+ measureUniformity corner stats) and getStats.
use super::Ctx;
use crate::{blur, util::*};
use serde_json::{json, Value};

/// Dispatch for this module: Some(result) if the name belongs here.
pub fn dispatch(name: &str, ctx: &Ctx, p: &Value) -> Option<Result<Value, String>> {
    Some(match name {
        "palette_purity" => palette_purity(ctx, p),
        "outer_zone" => outer_zone(ctx, p),
        "nucleus" => nucleus(ctx, p),
        "saturation" => saturation(ctx, p),
        "palette_balance" => palette_balance(ctx, p),
        "color_gradient" => color_gradient(ctx, p),
        "chroma_noise" => chroma_noise(ctx, p),
        "ha_knots" => ha_knots(ctx, p),
        "ha_knot_colour" => ha_knot_colour(ctx, p),
        "stats" => stats(ctx, p),
        _ => return None,
    })
}
pub const NAMES: &[&str] = &["outer_zone", "palette_purity", "nucleus", "saturation", "palette_balance", "color_gradient", "chroma_noise", "ha_knots", "ha_knot_colour", "stats"];

/// measurePalettePurity(ctx, viewId, inv): params { inv: { centre:[x,y], rDet } }.
pub fn palette_purity(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; if !img.is_color() { return Err("measurePalettePurity: needs colour".into()); }
    let (cx, cy, rd) = p_centre(p)?;
    let (w, h, s) = (img.w, img.h, 4usize);
    let mut sky = Vec::new(); let mut px: Vec<[f32; 4]> = Vec::new();
    for y in (0..h).step_by(s) { for x in (0..w).step_by(s) {
        let d = (((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt()) / rd;
        if d <= 0.15 || (d >= 0.8 && d <= 1.2) || d >= 1.32 { continue; }
        let (r, g, b) = (img.at(0, x, y), img.at(1, x, y), img.at(2, x, y));
        let yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if yv <= 1e-6 { continue; }
        if d > 1.2 { sky.push(yv); } else { px.push([r, g, b, yv]); }
    } }
    let s0 = med(&mut sky).unwrap_or(0.0);
    let mut ys: Vec<f32> = px.iter().map(|p| p[3]).collect();
    let top = pct(&mut ys, 0.98).unwrap_or(1.0);
    let (mut n, mut lil, mut teal) = (0usize, 0usize, 0usize);
    for q in &px {
        if q[3] <= s0 + 0.02 || q[3] >= top { continue; } n += 1;
        let (hue, sat) = hsv(q[0], q[1], q[2]); if sat <= 0.06 { continue; }
        if (250.0..335.0).contains(&hue) { lil += 1; } else if (165.0..195.0).contains(&hue) { teal += 1; }
    }
    Ok(json!({ "n": n, "lilac": if n > 0 { Some(lil as f64 / n as f64) } else { None }, "teal": if n > 0 { Some(teal as f64 / n as f64) } else { None }, "sky": s0 }))
}

/// measureNucleus(ctx, viewId, inv): saturation of the brightest nucleus pixels after a light blur.
pub fn nucleus(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; if !img.is_color() { return Err("measureNucleus: needs colour".into()); }
    let (cx, cy, rd) = p_centre(p)?;
    let (cx, cy) = (cx.round() as i64, cy.round() as i64);
    let r = (0.12 * rd).round() as i64; let sig = (rd / 300.0).max(1.0) as f32;
    let x0 = (cx - r).max(0) as usize; let y0 = (cy - r).max(0) as usize;
    let x1 = ((cx + r) as usize).min(img.w); let y1 = ((cy + r) as usize).min(img.h);
    let (cw, chh) = (x1 - x0, y1 - y0); let n = cw * chh;
    let chs: Vec<Vec<f32>> = (0..3).map(|k| blur::gaussian_crop(&img.ch[k], img.w, x0, y0, cw, chh, sig)).collect();
    let l: Vec<f32> = (0..n).map(|i| 0.2126 * chs[0][i] + 0.7152 * chs[1][i] + 0.0722 * chs[2][i]).collect();
    let mut srt: Vec<f32> = (0..n).step_by(3).map(|i| l[i]).collect();
    srt.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pk = srt[((0.999 * srt.len() as f64).floor() as usize).min(srt.len() - 1)];
    let mut sats: Vec<f32> = (0..n).filter(|&i| l[i] > 0.9 * pk).map(|i| {
        let mx = chs[0][i].max(chs[1][i]).max(chs[2][i]); let mn = chs[0][i].min(chs[1][i]).min(chs[2][i]);
        if mx > 1e-6 { (mx - mn) / mx } else { 0.0 } }).collect();
    let top_n = sats.len();
    Ok(json!({ "peak": pk, "topSat": med(&mut sats), "topN": top_n }))
}

// ---------------------------------------------------------------------------------------------------------------
// Private helpers (PJSR / PixInsight conventions)
// ---------------------------------------------------------------------------------------------------------------

/// Option lookup: params.opts.k, else params.k (callers may pass either shape).
fn opt<'a>(p: &'a Value, k: &str) -> Option<&'a Value> {
    p.get("opts").and_then(|o| o.get(k)).or_else(|| p.get(k))
}
fn opt_f64(p: &Value, k: &str) -> Option<f64> { opt(p, k).and_then(|v| v.as_f64()) }

#[inline] fn fcmp(a: &f64, b: &f64) -> std::cmp::Ordering { a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal) }
fn sort64(v: &mut [f64]) { v.sort_by(fcmp); }

/// PixInsight Image.median() over a sample set: exact median, mean of the two middle values for even counts.
fn exact_median(v: &mut [f32]) -> f64 {
    let n = v.len(); if n == 0 { return 0.0; }
    let cmp = |a: &f32, b: &f32| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    let (lo, m, _) = v.select_nth_unstable_by(n / 2, cmp); let hi = *m as f64;
    if n % 2 == 1 { return hi; }
    let l = lo.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64;
    0.5 * (l + hi)
}
fn exact_median64(v: &mut [f64]) -> f64 {
    let n = v.len(); if n == 0 { return 0.0; }
    let (lo, m, _) = v.select_nth_unstable_by(n / 2, fcmp); let hi = *m;
    if n % 2 == 1 { return hi; }
    let l = lo.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    0.5 * (l + hi)
}
/// Image.median() on one channel with selectedRect = [x0,x1) x [y0,y1) (clipped to the image like PJSR).
fn rect_median(plane: &[f32], w: usize, h: usize, x0: i64, y0: i64, x1: i64, y1: i64) -> f64 {
    let (x0, y0) = (x0.max(0) as usize, y0.max(0) as usize);
    let (x1, y1) = ((x1.max(0) as usize).min(w), (y1.max(0) as usize).min(h));
    if x1 <= x0 || y1 <= y0 { return 0.0; }
    let mut v: Vec<f32> = Vec::with_capacity((x1 - x0) * (y1 - y0));
    for y in y0..y1 { v.extend_from_slice(&plane[y * w + x0..y * w + x1]); }
    exact_median(&mut v)
}

/// JS Number.prototype.toFixed (ties round up in magnitude on the exact binary value).
fn to_fixed(x: f64, f: usize) -> String {
    if !x.is_finite() { return if x.is_nan() { "NaN".into() } else if x > 0.0 { "Infinity".into() } else { "-Infinity".into() }; }
    let neg = x < 0.0; let s = format!("{:.1100}", x.abs());
    let dot = s.find('.').unwrap();
    let mut digits: Vec<u8> = s[..dot].bytes().chain(s[dot + 1..dot + 1 + f].bytes()).collect();
    if s.as_bytes()[dot + 1 + f] >= b'5' {
        let mut i = digits.len();
        loop {
            if i == 0 { digits.insert(0, b'1'); break; }
            i -= 1;
            if digits[i] == b'9' { digits[i] = b'0'; } else { digits[i] += 1; break; }
        }
    }
    let ip = digits.len() - f;
    let mut out = String::new(); if neg { out.push('-'); }
    out.push_str(std::str::from_utf8(&digits[..ip]).unwrap());
    if f > 0 { out.push('.'); out.push_str(std::str::from_utf8(&digits[ip..]).unwrap()); }
    out
}
/// JS `${number}` for ordinary values (integers without ".0").
fn js_num(x: f64) -> String { if x.fract() == 0.0 && x.abs() < 1e21 { format!("{}", x as i64) } else { format!("{}", x) } }

/// HSV hue like the PJSR snippets: 60*((g-b)/c % 6) with sign-preserving %, +360 if negative.
#[inline] fn hue_js(r: f64, g: f64, b: f64, mx: f64, c: f64) -> f64 {
    let mut h = if mx == r { 60.0 * (((g - b) / c) % 6.0) } else if mx == g { 60.0 * ((b - r) / c + 2.0) } else { 60.0 * ((r - g) / c + 4.0) };
    if h < 0.0 { h += 360.0; }
    h
}

// ---------------------------------------------------------------------------------------------------------------
// stats — getStats (stats.mjs:11)
// ---------------------------------------------------------------------------------------------------------------

/// getStats(ctx, viewId): params {} . Colour: per-channel exact median + MAD (unscaled), averaged; min/max over all
/// channels. Mono: median/mad of channel 0.
pub fn stats(ctx: &Ctx, _p: &Value) -> Result<Value, String> {
    use rayon::prelude::*;
    let img = ctx.img;
    let nc = if img.is_color() { 3 } else { 1 };
    let mm: Vec<(f64, f64)> = (0..nc).into_par_iter().map(|c| {
        let mut v = img.ch[c].clone();
        let med = exact_median(&mut v);
        let mut d: Vec<f64> = img.ch[c].iter().map(|&x| (x as f64 - med).abs()).collect();
        (med, exact_median64(&mut d))
    }).collect();
    let (mut mn, mut mx) = (f32::INFINITY, f32::NEG_INFINITY);
    for c in 0..img.n_channels() { for &x in &img.ch[c] { if x < mn { mn = x; } if x > mx { mx = x; } } }
    if img.is_color() {
        Ok(json!({
            "median": (mm[0].0 + mm[1].0 + mm[2].0) / 3.0, "mad": (mm[0].1 + mm[1].1 + mm[2].1) / 3.0,
            "perChannel": { "R": { "median": mm[0].0, "mad": mm[0].1 }, "G": { "median": mm[1].0, "mad": mm[1].1 }, "B": { "median": mm[2].0, "mad": mm[2].1 } },
            "min": mn as f64, "max": mx as f64 }))
    } else {
        Ok(json!({ "median": mm[0].0, "mad": mm[0].1, "min": mn as f64, "max": mx as f64 }))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// saturation — checkSaturation (quality-gates.mjs:883)
// ---------------------------------------------------------------------------------------------------------------

/// checkSaturation(ctx, viewId): params {}. Returns the JS function's return object (incl. details string).
pub fn saturation(ctx: &Ctx, _p: &Value) -> Result<Value, String> {
    let img = ctx.img;
    if !img.is_color() {
        return Ok(json!({ "medianS": 0, "p90S": 0, "p99S": 0, "maxS": 0, "subjectPixelCount": 0, "details": "Mono image — saturation check skipped" }));
    }
    let bg: Vec<f64> = { use rayon::prelude::*; (0..3).into_par_iter().map(|c| { let mut v = img.ch[c].clone(); exact_median(&mut v) }).collect() };
    let bg_lum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
    let s = |c: usize, x: usize, y: usize| img.at(c, x, y) as f64;
    let mut diffs = Vec::new();
    for y in (0..img.h).step_by(32) { for x in (0..img.w).step_by(32) {
        let lum = 0.2126 * s(0, x, y) + 0.7152 * s(1, x, y) + 0.0722 * s(2, x, y);
        diffs.push((lum - bg_lum).abs());
    } }
    sort64(&mut diffs);
    let bg_mad = diffs[diffs.len() / 2];
    let thr = bg_lum + 5.0 * bg_mad;
    let mut sv = Vec::new();
    for y in (0..img.h).step_by(8) { for x in (0..img.w).step_by(8) {
        let (r, g, b) = (s(0, x, y), s(1, x, y), s(2, x, y));
        let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if lum > thr { let mx = r.max(g).max(b); let mn = r.min(g).min(b); sv.push(if mx > 0.001 { (mx - mn) / mx } else { 0.0 }); }
    } }
    sort64(&mut sv);
    let n = sv.len();
    let q = |f: f64| if n > 0 { sv[((n as f64) * f).floor() as usize] } else { 0.0 };
    let (m, p90, p99, mxs) = (q(0.5), q(0.9), q(0.99), if n > 0 { sv[n - 1] } else { 0.0 });
    Ok(json!({ "medianS": m, "p90S": p90, "p99S": p99, "maxS": mxs, "subjectPixelCount": n,
        "details": format!("Saturation: median={}, P90={}, P99={}, max={} ({} subject pixels)", to_fixed(m, 3), to_fixed(p90, 3), to_fixed(p99, 3), to_fixed(mxs, 3), n),
        // Not in the JS return (PJSR-internal); handy for parity checks.
        "_bgLum": bg_lum, "_subjectThreshold": thr }))
}

// ---------------------------------------------------------------------------------------------------------------
// palette_balance — measurePaletteBalance (sho-palette.mjs:278)
// ---------------------------------------------------------------------------------------------------------------

/// darkCellMedians: 12x8 cell medians per channel, darkest 20% (>=3) by luminance, per-channel median a[len>>1].
fn dark_cell_medians(img: &crate::image::Image) -> [f64; 3] {
    let (w, h, nx, ny) = (img.w as i64, img.h as i64, 12i64, 8i64);
    let mut cells: Vec<(f64, [f64; 3])> = Vec::new();
    for gy in 0..ny { for gx in 0..nx {
        let (x0, y0, x1, y1) = (gx * w / nx, gy * h / ny, (gx + 1) * w / nx, (gy + 1) * h / ny);
        let m = [0, 1, 2].map(|c| rect_median(&img.ch[c], img.w, img.h, x0, y0, x1, y1));
        cells.push((0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2], m));
    } }
    cells.sort_by(|a, b| fcmp(&a.0, &b.0));
    let n = 3usize.max((cells.len() as f64 * 0.2).floor() as usize);
    [0, 1, 2].map(|c| { let mut v: Vec<f64> = cells[..n].iter().map(|q| q.1[c]).collect(); sort64(&mut v); v[v.len() / 2] })
}

/// measurePaletteBalance(ctx, viewId, opts): params { opts: { sigma (4), palette ('hoo' | other) } }.
pub fn palette_balance(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; if !img.is_color() { return Err("measurePaletteBalance: needs a color view".into()); }
    let k = opt_f64(p, "sigma").unwrap_or(4.0);
    let hoo = opt(p, "palette").and_then(|v| v.as_str()) == Some("hoo");
    let (w, h) = (img.w, img.h);
    let sx = 1usize.max(w / 400); let sy = 1usize.max(h / 270);
    let mut px: Vec<[f64; 4]> = Vec::new();
    for y in (0..h).step_by(sy) { for x in (0..w).step_by(sx) {
        let (r, g, b) = (img.at(0, x, y) as f64, img.at(1, x, y) as f64, img.at(2, x, y) as f64);
        px.push([r, g, b, 0.2126 * r + 0.7152 * g + 0.0722 * b]);
    } }
    let mut ls: Vec<f64> = px.iter().map(|q| q[3]).collect(); sort64(&mut ls);
    let med = ls[ls.len() / 2];
    let mut d: Vec<f64> = ls.iter().map(|v| (v - med).abs()).collect(); sort64(&mut d);
    let thr = med + k * 1.4826 * d[d.len() / 2];
    const FAM: [&str; 7] = ["red", "orange_gold", "yellow", "green", "cyan", "blue", "magenta"];
    let mut fam = [(0usize, 0f64); 7];
    let mut n = 0usize;
    for q in &px {
        if q[3] <= thr { continue; } // (bgR/bgG/bgB accumulated in PJSR but never reported)
        let mx = q[0].max(q[1]).max(q[2]); let mn = q[0].min(q[1]).min(q[2]); let c = mx - mn;
        let s = if mx > 0.0 { c / mx } else { 0.0 };
        let hh = if c > 1e-6 { hue_js(q[0], q[1], q[2], mx, c) } else { 0.0 };
        let f = if hh < 18.0 || hh >= 335.0 { 0 } else if hh < 50.0 { 1 } else if hh < 70.0 { 2 } else if hh < 160.0 { 3 } else if hh < 200.0 { 4 } else if hh < 255.0 { 5 } else { 6 };
        fam[f].0 += 1; fam[f].1 += s; n += 1;
    }
    let frac = |i: usize| if n > 0 { fam[i].0 as f64 / n as f64 } else { 0.0 };
    let mut families = serde_json::Map::new();
    for (i, name) in FAM.iter().enumerate() {
        families.insert(name.to_string(), json!({ "frac": frac(i), "meanSat": if fam[i].0 > 0 { fam[i].1 / fam[i].0 as f64 } else { 0.0 } }));
    }
    let bg = dark_cell_medians(img);
    let subject_fraction = n as f64 / px.len() as f64;
    // ---- Node-side post-processing (warm/cool/summary) ----
    let pc = |x: f64| format!("{}%", to_fixed(x * 100.0, 1));
    let warm = frac(0) + frac(1) + frac(2); let cool = frac(4) + frac(5);
    let mut notes: Vec<String> = Vec::new();
    if hoo {
        if cool < 0.05 { notes.push(format!("cyan/blue {} — OIII not reading: raise o_gain or hoo_o_weight", pc(cool))); }
    } else {
        if frac(3) > 0.10 { notes.push(format!("green {} of subject — Ha still reads green: increase sho_hue_shift strength or lower h_gain", pc(frac(3)))); }
        if frac(6) > 0.08 { notes.push(format!("magenta {} — fold magenta (sho_hue_shift magenta=to_red|to_blue) or lower s_gain/o_gain", pc(frac(6)))); }
        if cool < 0.05 { notes.push(format!("cyan/blue only {} — OIII is not reading: raise o_gain or use foraxx/hue_screen", pc(cool))); }
    }
    let m = (bg[0] + bg[1] + bg[2]) / 3.0;
    if m > 0.0 && (bg[0] - m).abs().max((bg[1] - m).abs()).max((bg[2] - m).abs()) / m > 0.08 {
        notes.push(format!("background cast: RGB={} — neutralize the background", bg.iter().map(|v| to_fixed(*v, 4)).collect::<Vec<_>>().join("/")));
    }
    let summary = format!("subject {} of frame | red {} gold {} yellow {} green {} cyan {} blue {} magenta {} | warm {} cool {}",
        pc(subject_fraction), pc(frac(0)), pc(frac(1)), pc(frac(2)), pc(frac(3)), pc(frac(4)), pc(frac(5)), pc(frac(6)), pc(warm), pc(cool))
        + &if notes.is_empty() { " | palette balanced".to_string() } else { format!(" | {}", notes.join("; ")) };
    Ok(json!({ "subjectSamples": n, "subjectFraction": subject_fraction, "families": families, "bgRGB": bg, "warm": warm, "cool": cool, "summary": summary }))
}

// ---------------------------------------------------------------------------------------------------------------
// color_gradient — measureColorGradient (stats.mjs:170) + measureUniformity corners + cornerStats
// ---------------------------------------------------------------------------------------------------------------

fn band_from_means(values: &[Option<f64>]) -> (usize, f64, f64, f64, i64, f64, i64) {
    let mut xs = Vec::new(); let mut ys = Vec::new();
    for (i, v) in values.iter().enumerate() { if let Some(v) = v { if v.is_nan() { continue; } xs.push(i as f64); ys.push(*v); } }
    let n = xs.len();
    if n < 3 { return (n, 0.0, 0.0, 0.0, -1, 0.0, -1); }
    let (mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0);
    for k in 0..n { sx += xs[k]; sy += ys[k]; sxx += xs[k] * xs[k]; sxy += xs[k] * ys[k]; }
    let nf = n as f64; let den = nf * sxx - sx * sx;
    let slope = if den != 0.0 { (nf * sxy - sx * sy) / den } else { 0.0 };
    let intercept = (sy - slope * sx) / nf;
    let (mut amp, mut index, mut step_max, mut step_index) = (0.0, -1i64, 0.0, -1i64);
    for k in 0..n {
        let res = (ys[k] - (slope * xs[k] + intercept)).abs();
        if res > amp { amp = res; index = xs[k] as i64; }
        if k > 0 { let j = (ys[k] - ys[k - 1]).abs(); if j > step_max { step_max = j; step_index = xs[k] as i64; } }
    }
    (n, slope, intercept, amp, index, step_max, step_index)
}

struct Cell { gx: usize, gy: usize, m: [f64; 3], lum: f64 }

fn band_from_cells(cells: &[Cell], cols: usize, rows: usize, min_bg: usize) -> Value {
    let min_n = if min_bg == 0 { 12 } else { min_bg };
    if cells.len() < min_n { return json!({ "insufficientBg": true, "bgCells": cells.len() }); }
    let chans = ["R", "G", "B"];
    let (mut axis, mut index, mut amp, mut channel, mut step_max): (Option<&str>, i64, f64, Option<&str>, f64) = (None, -1, 0.0, None, 0.0);
    for (a, (name, count)) in [("column", cols), ("row", rows)].into_iter().enumerate() {
        for c in 0..3 {
            let mut sum = vec![0f64; count]; let mut num = vec![0usize; count];
            for q in cells { let key = if a == 0 { q.gx } else { q.gy }; sum[key] += q.m[c] - q.lum; num[key] += 1; }
            let means: Vec<Option<f64>> = (0..count).map(|i| if num[i] > 0 { Some(sum[i] / num[i] as f64) } else { None }).collect();
            let f = band_from_means(&means);
            if f.3 > amp { axis = Some(name); index = f.4; amp = f.3; channel = Some(chans[c]); step_max = f.5; }
        }
    }
    json!({ "axis": axis, "index": index, "amp": amp, "channel": channel, "stepMax": step_max })
}

/// measureColorGradient(ctx, viewId, opts): params { opts: { cols (8), rows (6), minBgCells (12), corners (true), cornerSize (200) } }.
pub fn color_gradient(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img;
    if !img.is_color() { return Ok(json!({ "error": "mono image — no color gradient" })); }
    let cols = opt_f64(p, "cols").unwrap_or(8.0) as usize; let rows = opt_f64(p, "rows").unwrap_or(6.0) as usize;
    let min_bg = opt_f64(p, "minBgCells").unwrap_or(12.0) as usize;
    let (w, h) = (img.w, img.h);
    let cw = (w / cols) as i64; let ch = (h / rows) as i64;
    let bx = 24i64.max(((cw.min(ch)) as f64 * 0.6).floor() as i64);
    let mut cells: Vec<Cell> = Vec::new();
    for gy in 0..rows { for gx in 0..cols {
        let cx = gx as i64 * cw + ((cw - bx) as f64 / 2.0).floor() as i64;
        let cy = gy as i64 * ch + ((ch - bx) as f64 / 2.0).floor() as i64;
        let m = [0, 1, 2].map(|c| rect_median(&img.ch[c], w, h, cx, cy, cx + bx, cy + bx));
        cells.push(Cell { gx, gy, m, lum: (m[0] + m[1] + m[2]) / 3.0 });
    } }
    let mut lums: Vec<f64> = cells.iter().map(|c| c.lum).collect(); sort64(&mut lums);
    let med_lum = lums[lums.len() / 2];
    let mut devs: Vec<f64> = lums.iter().map(|l| (l - med_lum).abs()).collect(); sort64(&mut devs);
    let mad_lum = devs[devs.len() / 2] * 1.4826;
    let thr = med_lum + 3.0 * mad_lum;
    let bg: Vec<Cell> = cells.into_iter().filter(|c| c.lum <= thr).collect();
    let (mut mn, mut mx) = ([1f64; 3], [-1f64; 3]);
    let mut worst = Value::Null; let mut worst_amp = -1.0;
    for q in &bg {
        let cr = [q.m[0] - q.lum, q.m[1] - q.lum, q.m[2] - q.lum];
        for c in 0..3 { if cr[c] < mn[c] { mn[c] = cr[c]; } if cr[c] > mx[c] { mx[c] = cr[c]; } }
        let a = cr.map(f64::abs); let amp = a[0].max(a[1]).max(a[2]);
        if amp > worst_amp {
            worst_amp = amp;
            let dom = if a[0] >= a[1] && a[0] >= a[2] { if cr[0] > 0.0 { "red" } else { "cyan" } }
                else if a[1] >= a[2] { if cr[1] > 0.0 { "green" } else { "magenta" } } else if cr[2] > 0.0 { "blue" } else { "yellow" };
            worst = json!({ "gx": q.gx, "gy": q.gy, "dominant": dom, "amp": amp });
        }
    }
    let pp = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    let (mut lmin, mut lmax) = (1f64, -1f64);
    for q in &bg { if q.lum < lmin { lmin = q.lum; } if q.lum > lmax { lmax = q.lum; } }
    let mut out = json!({
        "score": pp[0].max(pp[1]).max(pp[2]), "chromaPP": { "R": pp[0], "G": pp[1], "B": pp[2] },
        "lumPP": lmax - lmin, "bgCells": bg.len(), "totalCells": cols * rows, "bgMedianLum": med_lum,
        "worst": worst, "band": band_from_cells(&bg, cols, rows, min_bg), "cols": cols, "rows": rows });
    if opt(p, "corners").and_then(|v| v.as_bool()) != Some(false) {
        // measureUniformity(ctx, viewId, cornerSize) corners -> cornerStats
        let sz = opt_f64(p, "cornerSize").filter(|v| *v != 0.0).unwrap_or(200.0) as i64;
        let (wi, hi) = (w as i64, h as i64);
        let corners = [(0, 0), (wi - sz, 0), (0, hi - sz), (wi - sz, hi - sz)];
        let per: Vec<[f64; 3]> = corners.iter().map(|&(x, y)| [0, 1, 2].map(|c| rect_median(&img.ch[c], w, h, x, y, x + sz, y + sz))).collect();
        let lum: Vec<f64> = per.iter().map(|m| (m[0] + m[1] + m[2]) / 3.0).collect();
        let delta = lum.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - lum.iter().cloned().fold(f64::INFINITY, f64::min);
        let mut chroma = 0f64;
        for c in 0..3 {
            let v: Vec<f64> = per.iter().enumerate().map(|(i, m)| m[c] - lum[i]).collect();
            chroma = chroma.max(v.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - v.iter().cloned().fold(f64::INFINITY, f64::min));
        }
        out["cornerLumDelta"] = json!(delta); out["cornerChroma"] = json!(chroma);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// chroma_noise — measureChromaNoise (subject-metrics.mjs:696) + summarizeChromaNoise
// ---------------------------------------------------------------------------------------------------------------

fn mad_scaled(arr: &[f64]) -> f64 {
    let n = arr.len(); if n == 0 { return 0.0; }
    let mut a = arr.to_vec(); sort64(&mut a); let med = a[n >> 1];
    let mut d: Vec<f64> = arr.iter().map(|v| (v - med).abs()).collect(); sort64(&mut d);
    d[n >> 1] * 1.4826
}
fn lap_residuals(vals: &[f64], nx: usize, ny: usize, out: &mut Vec<f64>) {
    for y in 1..ny.saturating_sub(1) { for x in 1..nx.saturating_sub(1) {
        let c = vals[y * nx + x];
        let nb = (vals[y * nx + x - 1] + vals[y * nx + x + 1] + vals[(y - 1) * nx + x] + vals[(y + 1) * nx + x]) / 4.0;
        out.push(c - nb);
    } }
}
fn median_js(a: &[f64]) -> f64 { if a.is_empty() { return 0.0; } let mut b = a.to_vec(); sort64(&mut b); b[b.len() >> 1] }

/// measureChromaNoise(ctx, viewId, opts): params { opts: { profile: { noise: { max_chroma_to_lum, max_mottle48 } } } }.
pub fn chroma_noise(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    use rayon::prelude::*;
    let img = ctx.img;
    if !img.is_color() { return Ok(json!({ "chromaNoise": 0, "error": "mono image - no chroma", "pass": true, "details": "mono image - no chroma" })); }
    let (w, h) = (img.w as i64, img.h as i64);
    let smp = |x: i64, y: i64| { let i = y as usize * img.w + x as usize; (img.ch[0][i] as f64, img.ch[1][i] as f64, img.ch[2][i] as f64) };
    let sz = 40i64.max((w as f64 * 0.05).floor() as i64);
    let mottle = |cx: f64, cy: f64, bs: i64| -> Vec<f64> {
        let side = 5 * bs;
        let x0 = 0i64.max((w - side - 1).min((cx - side as f64 / 2.0).floor() as i64));
        let y0 = 0i64.max((h - side - 1).min((cy - side as f64 / 2.0).floor() as i64));
        let (mut ca, mut cb) = (Vec::with_capacity(25), Vec::with_capacity(25));
        for by in 0..5 { for bx in 0..5 {
            let (mut sa, mut sb, mut n) = (0f64, 0f64, 0usize);
            let mut y = y0 + by * bs;
            while y < y0 + (by + 1) * bs { let mut x = x0 + bx * bs;
                while x < x0 + (bx + 1) * bs { let (r, g, b) = smp(x, y); let l = 0.3 * r + 0.59 * g + 0.11 * b; sa += r - l; sb += b - l; n += 1; x += 2; }
                y += 2; }
            ca.push(sa / n as f64); cb.push(sb / n as f64);
        } }
        let mut out = Vec::new(); lap_residuals(&ca, 5, 5, &mut out); lap_residuals(&cb, 5, 5, &mut out); out
    };
    // 36 patches, independent -> parallel (order restored before the stable sort)
    let mut patches: Vec<[f64; 5]> = (0..36usize).into_par_iter().map(|k| {
        let (gx, gy) = ((k % 6) as f64, (k / 6) as f64);
        let px = ((w as f64 * (0.18 + gx * 0.11)).floor() as i64).min(w - sz - 2);
        let py = ((h as f64 * (0.18 + gy * 0.11)).floor() as i64).min(h - sz - 2);
        let (mut ca, mut cb, mut lm) = (Vec::new(), Vec::new(), Vec::new());
        let (mut nx, mut ny) = (0usize, 0usize);
        let mut y = py; while y < py + sz { ny += 1; nx = 0; let mut x = px;
            while x < px + sz { nx += 1; let (r, g, b) = smp(x, y); let l = 0.3 * r + 0.59 * g + 0.11 * b; ca.push(r - l); cb.push(b - l); lm.push(l); x += 2; }
            y += 2; }
        let med = median_js(&lm);
        let mut cc = Vec::new(); lap_residuals(&ca, nx, ny, &mut cc); lap_residuals(&cb, nx, ny, &mut cc);
        let mut ll = Vec::new(); lap_residuals(&lm, nx, ny, &mut ll);
        let (mx, my) = (px as f64 + sz as f64 / 2.0, py as f64 + sz as f64 / 2.0);
        [med, mad_scaled(&cc), mad_scaled(&ll), mad_scaled(&mottle(mx, my, 16)), mad_scaled(&mottle(mx, my, 48))]
    }).collect();
    patches.sort_by(|a, b| fcmp(&a[0], &b[0]));
    let band = |lo: usize, hi: usize| {
        let s = &patches[lo.min(patches.len())..hi.min(patches.len())];
        let col = |j: usize| median_js(&s.iter().map(|q| q[j]).collect::<Vec<_>>());
        (s.len(), col(1), col(2), col(3), col(4))
    };
    let bj = |b: (usize, f64, f64, f64, f64)| json!({ "n": b.0, "chromaNoise": b.1, "lumNoise": b.2, "mottle16": b.3, "mottle48": b.4 });
    let (clean, dust) = (band(0, 12), band(12, 24));
    // summarizeChromaNoise
    let use_dust = dust.0 >= 3; let hb = if use_dust { dust } else { clean };
    let (cn, ln, m16, m48) = (hb.1, hb.2, hb.3, hb.4);
    let ratio = if ln > 1e-9 { cn / ln } else { 0.0 };
    let nz = opt(p, "profile").and_then(|pr| pr.get("noise"));
    let max_ratio = nz.and_then(|n| n.get("max_chroma_to_lum")).and_then(|v| v.as_f64());
    let max_mottle = nz.and_then(|n| n.get("max_mottle48")).and_then(|v| v.as_f64());
    let mut over: Vec<String> = Vec::new();
    if let Some(mr) = max_ratio { if ratio > mr { over.push(format!("chroma/lum noise {} > {}", to_fixed(ratio, 2), js_num(mr))); } }
    if let Some(mm) = max_mottle { if m48 > mm { over.push(format!("mottle48 {} > {}", to_fixed(m48, 4), js_num(mm))); } }
    let remedy = "chroma_smooth sigma 6-8 through the halo/dust mask, or reduce lift/inject strength upstream; never global desaturation.";
    let details = format!("Chroma noise {} (chroma/lum {}), mottle16={}, mottle48={} [band: {}].", to_fixed(cn, 5), to_fixed(ratio, 2), to_fixed(m16, 5), to_fixed(m48, 5), if use_dust { "dust" } else { "clean" })
        + &if !over.is_empty() { format!(" ADVISORY: {}. Remedy: {}", over.join("; "), remedy) }
           else if max_ratio.is_none() && max_mottle.is_none() { " (no profile ceiling set — informational.)".to_string() } else { " Within profile ceilings.".to_string() };
    Ok(json!({ "chromaNoise": cn, "chromaToLumNoise": ratio, "lumNoise": ln, "mottle16": m16, "mottle48": m48,
        "clean": bj(clean), "dust": bj(dust), "pass": over.is_empty(), "over": over, "details": details }))
}

// ---------------------------------------------------------------------------------------------------------------
// ha_knots / ha_knot_colour — measureHaKnots (subject-metrics.mjs:2061), measureHaKnotColour (:2088)
// ---------------------------------------------------------------------------------------------------------------

/// Core of measureHaKnots on a single plane (mono Ha; channel 0 of the given image).
fn ha_knots_on(img: &crate::image::Image, cx: f64, cy: f64, rd: f64, max_n: usize) -> Value {
    let (w, h) = (img.w, img.h); let n = w * h; let l = &img.ch[0];
    // EMPTY_PJSR(24): footprint zeros, blurred sigma 24, > 0.002 = empty
    let ne = l.iter().filter(|&&v| (v as f64) <= 1e-6).count();
    let emp: Option<Vec<f32>> = if ne > 0 && ne < n {
        let e: Vec<f32> = l.iter().map(|&v| if (v as f64) <= 1e-6 { 1.0 } else { 0.0 }).collect();
        Some(blur::gaussian(&e, w, h, 24.0))
    } else { None };
    let is_empty = |j: usize| emp.as_ref().map_or(false, |e| (e[j] as f64) > 0.002);
    let (g1, g8) = rayon::join(|| blur::gaussian(l, w, h, 1.0), || blur::gaussian(l, w, h, 8.0));
    let rm = (1.1 * rd).round(); let rm2 = rm * rm;
    let mut v: Vec<f64> = Vec::new(); let mut idx: Vec<usize> = Vec::new();
    for y in 0..h { let dy = y as f64 - cy; for x in 0..w {
        let dx = x as f64 - cx; if dx * dx + dy * dy > rm2 { continue; }
        let i = y * w + x; if is_empty(i) { continue; }
        v.push(g1[i] as f64 - g8[i] as f64); idx.push(i);
    } }
    if v.is_empty() { return json!({ "W": w, "H": h, "n": 0, "thr": null, "noise": null, "pts": [] }); }
    let mut s = v.clone(); s.sort_unstable_by(fcmp);
    let nn = s.len(); let md = s[nn >> 1];
    let mut dv: Vec<f64> = (0..nn).step_by(7).map(|i| (s[i] - md).abs()).collect(); dv.sort_unstable_by(fcmp);
    let noise = 1.4826 * dv[dv.len() >> 1];
    let thr = s[(0.995 * nn as f64).floor() as usize].max(md + 6.0 * noise);
    let pts: Vec<usize> = v.iter().zip(&idx).filter(|(a, _)| **a > thr).map(|(_, &i)| i).collect();
    let step = 1usize.max((pts.len() as f64 / max_n as f64).ceil() as usize);
    let out: Vec<[usize; 2]> = pts.iter().step_by(step).map(|&i| [i % w, i / w]).collect();
    json!({ "W": w, "H": h, "n": pts.len(), "thr": thr, "noise": noise, "pts": out })
}

/// measureHaKnots(ctx, haViewId, inv, {maxN}): params { inv: { centre, rDet }, maxN? (6000) } — run on the mono Ha image
/// (or pass ha_path to load it instead of --image).
pub fn ha_knots(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let (cx, cy, rd) = p_centre(p)?;
    let max_n = opt_f64(p, "maxN").unwrap_or(6000.0).max(1.0) as usize;
    if let Some(path) = p.get("ha_path").and_then(|v| v.as_str()) {
        let ha = load_any(path)?; return Ok(ha_knots_on(&ha, cx, cy, rd, max_n));
    }
    Ok(ha_knots_on(ctx.img, cx, cy, rd, max_n))
}

fn load_any(path: &str) -> Result<crate::image::Image, String> {
    if path.to_lowercase().ends_with(".png") { read_png(path) } else { crate::xisf::read(path, 0).map(|(i, _)| i) }
}

/// measureHaKnotColour(ctx, viewId, knots): params { knots: <ha_knots output> } on the final colour image.
/// Convenience: { ha_path, inv, maxN? } computes the knots from the Ha file first.
pub fn ha_knot_colour(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let computed;
    let knots = match p.get("knots") {
        Some(k) if !k.is_null() => k,
        _ => match p.get("ha_path").and_then(|v| v.as_str()) {
            Some(path) => { let (cx, cy, rd) = p_centre(p)?; let ha = load_any(path)?;
                computed = ha_knots_on(&ha, cx, cy, rd, opt_f64(p, "maxN").unwrap_or(6000.0).max(1.0) as usize); &computed }
            None => &Value::Null,
        },
    };
    let pts = match knots.get("pts").and_then(|v| v.as_array()) { Some(a) if !a.is_empty() => a, _ => return Ok(json!({ "evaluated": false, "reason": "no Ha knots" })) };
    let img = ctx.img; if !img.is_color() { return Err("measureHaKnotColour: needs a colour image".into()); }
    let kw = knots.get("W").cloned().unwrap_or(Value::Null); let kh = knots.get("H").cloned().unwrap_or(Value::Null);
    if kw.as_f64() != Some(img.w as f64) || kh.as_f64() != Some(img.h as f64) {
        return Ok(json!({ "evaluated": false, "reason": format!("geometry differs from prep ({}x{} vs {}x{})", img.w, img.h, kw, kh) }));
    }
    let (w, h) = (img.w as i64, img.h as i64);
    let (mut pink, mut white, mut n) = (0usize, 0usize, 0usize); let mut hs: Vec<f64> = Vec::new();
    for q in pts {
        let x = q.get(0).and_then(|v| v.as_f64()).unwrap_or(-1.0) as i64; let y = q.get(1).and_then(|v| v.as_f64()).unwrap_or(-1.0) as i64;
        if x < 1 || y < 1 || x >= w - 1 || y >= h - 1 { continue; }
        let (mut r, mut g, mut b) = (0f64, 0f64, 0f64);
        for dy in -1..=1 { for dx in -1..=1 { let i = ((y + dy) * w + x + dx) as usize; r += img.ch[0][i] as f64; g += img.ch[1][i] as f64; b += img.ch[2][i] as f64; } }
        r /= 9.0; g /= 9.0; b /= 9.0;
        let mx = r.max(g).max(b); let mn = r.min(g).min(b); let d = mx - mn;
        let s = if mx > 0.0 { d / mx } else { 0.0 };
        let hh = if d > 1e-6 { hue_js(r, g, b, mx, d) } else { 0.0 };
        n += 1; if s >= 0.10 && (hh >= 290.0 || hh < 35.0) { pink += 1; } if mx > 0.92 && s < 0.10 { white += 1; } hs.push(hh);
    }
    sort64(&mut hs);
    // n == 0: JS gives NaN fractions (-> null) and an undefined medHue (key dropped)
    let mut out = json!({ "evaluated": true, "n": n,
        "pinkFrac": if n > 0 { Some(pink as f64 / n as f64) } else { None }, "whiteFrac": if n > 0 { Some(white as f64 / n as f64) } else { None } });
    if !hs.is_empty() { out["medHue"] = json!(hs[hs.len() >> 1]); }
    Ok(out)
}

/// Outer-zone colour and presence (2026-11-10, M74 v10-v12 "brown dome"): a saturation curve that multiplied
/// near-grey saturation x4 turned the noise-level warm tint of the faint outer disc into a brown haze.
/// params { inv: { centre, rDet } }. Stride 2. sky = median Y at 1.2-1.35 rDet (non-zero pixels).
/// - relBrightness = (median Y at 0.85-1.0 rDet - sky) / (median Y at 0.3-0.5 rDet - sky)
/// - over pixels at 0.6-1.0 rDet with sky+0.005 < Y < zone p98 (stars out): warmFrac = share with S > 0.05 and
///   hue < 60 or >= 340; blueFrac = share with S > 0.05 and 185 <= hue < 250; medHue of the coloured ones.
pub fn outer_zone(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; if !img.is_color() { return Err("outer_zone: needs colour".into()); }
    let (cx, cy, rd) = p_centre(p)?;
    let (mut sky, mut inner, mut outer, mut zone): (Vec<f32>, Vec<f32>, Vec<f32>, Vec<[f32; 4]>) = (vec![], vec![], vec![], vec![]);
    for y in (0..img.h).step_by(2) { for x in (0..img.w).step_by(2) {
        let d = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt() / rd;
        if d < 0.3 || (d >= 1.0 && d < 1.2) || d >= 1.35 { continue; }
        let (r, g, b) = (img.at(0, x, y), img.at(1, x, y), img.at(2, x, y));
        let yv = 0.2126 * r + 0.7152 * g + 0.0722 * b; if yv <= 1e-6 { continue; }
        if d >= 1.2 { sky.push(yv); continue; }
        if d < 0.5 { inner.push(yv); }
        if d >= 0.85 { outer.push(yv); }
        if d >= 0.6 { zone.push([r, g, b, yv]); }
    } }
    let s0 = med(&mut sky).ok_or("outer_zone: no sky pixels")? as f64;
    let (mi, mo) = (med(&mut inner).unwrap_or(0.0) as f64, med(&mut outer).unwrap_or(0.0) as f64);
    let mut ys: Vec<f32> = zone.iter().map(|q| q[3]).collect();
    let top = pct(&mut ys, 0.98).unwrap_or(1.0);
    let (mut n, mut warm, mut blue, mut vivid) = (0usize, 0usize, 0usize, 0usize); let mut hues: Vec<f32> = vec![]; let mut blue_s: Vec<f32> = vec![];
    for q in &zone {
        if (q[3] as f64) <= s0 + 0.005 || q[3] >= top { continue; } n += 1;
        let (h, s) = hsv(q[0], q[1], q[2]); if s <= 0.05 { continue; }
        hues.push(h as f32);
        if h < 60.0 || h >= 340.0 { warm += 1; } else if (185.0..250.0).contains(&h) { blue += 1; }
        // over-saturated blues (2026-11-10, M74 v16: SHO hue/sat "outer_blue" boost -> vivid violet-blue outer arm)
        if (200.0..270.0).contains(&h) { blue_s.push(s as f32); if s > 0.35 { vivid += 1; } }
    }
    let f = |k: usize| if n > 0 { Some(k as f64 / n as f64) } else { None };
    Ok(json!({ "sky": s0, "innerExcess": mi - s0, "outerExcess": mo - s0,
        "relBrightness": if mi - s0 > 1e-6 { Some((mo - s0) / (mi - s0)) } else { None },
        "n": n, "warmFrac": f(warm), "blueFrac": f(blue), "medHue": med(&mut hues),
        "vividBlueFrac": f(vivid), "blueP90S": pct(&mut blue_s, 0.9) }))
}
