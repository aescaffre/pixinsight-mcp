//! Texture / detail / background metrics. Ports of agents/ops/subject-metrics.mjs:
//!   scale_bands       measureScaleBands(ctx, viewId, { rDisc })
//!   disc_mottle       measureDiscMottle(ctx, viewId, { radius })
//!   background_noise  measureBackgroundNoise(ctx, viewId, { profile })
//!   background_floor  measureBackgroundFloor(ctx, viewId)
//!   subject_detail    measureSubjectDetail(ctx, viewId, { roi, profile, faintStructureGoal })
//!   dust_coverage     measureDustCoverage(ctx, viewId, ifnCfg)
//!   subject_roi       locateSubjectROI(ctx, viewId)
//! Params: the JS option object, either flat ({"rDisc":562}) or wrapped ({"opts":{...}}); dust_coverage also
//! accepts {"ifnCfg":{...}}.
//!
//! PixInsight conventions mirrored here:
//!   * Image.median() / Image.MAD() on a colour image pool ALL selected channels (whole image = all 3 planes);
//!     the median is exact, the mean of the two central samples for an even count (pcl::Median); MAD is the raw
//!     median of |x - median|.
//!   * Block luminance = 0.2126/0.7152/0.0722 combination of the per-channel block medians (selectedRect).
//!   * Luminance computed in doubles from the f32 samples (img.sample returns doubles); Float32Array buffers
//!     round to f32 exactly where the PJSR stores into one.
use super::Ctx;
use crate::blur;
use crate::image::Image;
use rayon::prelude::*;
use serde_json::{json, Value};

pub const NAMES: &[&str] = &["scale_bands", "disc_mottle", "background_noise", "background_floor", "subject_detail", "dust_coverage", "subject_roi", "sobel_texture"];
pub fn dispatch(name: &str, ctx: &Ctx, p: &Value) -> Option<Result<Value, String>> {
    Some(match name {
        "scale_bands" => scale_bands(ctx, p),
        "disc_mottle" => disc_mottle(ctx, p),
        "background_noise" => background_noise(ctx, p),
        "background_floor" => background_floor(ctx, p),
        "subject_detail" => subject_detail(ctx, p),
        "dust_coverage" => dust_coverage(ctx, p),
        "subject_roi" => subject_roi(ctx, p),
        "sobel_texture" => sobel_texture(ctx, p),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------- helpers

fn opt<'a>(p: &'a Value, k: &str) -> Option<&'a Value> {
    p.get("opts").and_then(|o| o.get(k)).filter(|v| !v.is_null()).or_else(|| p.get(k).filter(|v| !v.is_null()))
}
/// JS Number.isFinite(v) && v > 0
fn opt_pos(p: &Value, k: &str) -> Option<f64> { opt(p, k).and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v > 0.0) }
/// JS Math.round (half up toward +inf).
#[inline] fn js_round(x: f64) -> f64 { (x + 0.5).floor() }
/// Finite -> number, NaN/inf -> null (JSON.stringify behaviour).
fn num(x: f64) -> Value { if x.is_finite() { json!(x) } else { Value::Null } }
fn cmp_f32(a: &f32, b: &f32) -> std::cmp::Ordering { a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal) }
fn cmp_f64(a: &f64, b: &f64) -> std::cmp::Ordering { a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal) }
fn sort64(v: &mut [f64]) { v.sort_by(cmp_f64); }
/// JS a.toFixed(d) (finite values).
fn fx(x: f64, d: usize) -> String { format!("{:.*}", d, x) }

/// pcl::Median: exact, mean of the two central samples for an even count. Reorders `v`.
fn pcl_median(v: &mut [f32]) -> f64 {
    let n = v.len(); if n == 0 { return 0.0; }
    let h = n / 2;
    let (left, m, _) = v.select_nth_unstable_by(h, cmp_f32);
    let hi = *m as f64;
    if n & 1 == 1 { return hi; }
    let lo = left.iter().cloned().fold(f32::NEG_INFINITY, f32::max) as f64;
    (lo + hi) / 2.0
}
/// Image.median() over the whole image (all channels pooled).
fn img_median(img: &Image) -> f64 { let mut v: Vec<f32> = img.ch.iter().flat_map(|c| c.iter().cloned()).collect(); pcl_median(&mut v) }
/// Image.MAD() over the whole image (all channels pooled) around its median, unscaled.
fn img_mad(img: &Image, m: f64) -> f64 {
    let mut v: Vec<f32> = img.ch.iter().flat_map(|c| c.iter().map(|&x| (x as f64 - m).abs() as f32)).collect();
    // |x - m| computed in double then held as f32 for the select; the selected values are converted back to f64.
    // (PCL keeps them in double; the f32 rounding is < 1e-8 relative.)
    pcl_median(&mut v)
}
/// Block luminance median: selectedRect (x0,y0)-(x0+bw,y0+bh), per-channel median, Rec.709 weights (mono: median).
fn block_lum_median(img: &Image, x0: usize, y0: usize, bw: usize, bh: usize) -> f64 {
    let mut buf = Vec::with_capacity(bw * bh);
    let mut med = |c: usize| { buf.clear(); for y in y0..y0 + bh { buf.extend_from_slice(&img.ch[c][y * img.w + x0..y * img.w + x0 + bw]); } pcl_median(&mut buf) };
    if img.is_color() { let a = med(0); let b = med(1); let c = med(2); 0.2126 * a + 0.7152 * b + 0.0722 * c } else { med(0) }
}
/// Grid of block luminance medians (gw x gh blocks of B px), row-major. `round5`: Math.round(v*1e5)/1e5.
fn block_grid(img: &Image, b: usize, round5: bool) -> (usize, usize, Vec<f64>) {
    let (gw, gh) = (img.w / b, img.h / b);
    let g: Vec<f64> = (0..gw * gh).into_par_iter().map(|k| {
        let v = block_lum_median(img, (k % gw) * b, (k / gw) * b, b, b);
        if round5 { js_round(v * 1e5) / 1e5 } else { v }
    }).collect();
    (gw, gh, g)
}
/// Luminance in doubles from the samples (getLum / L in the PJSR).
#[inline] fn lum709(img: &Image, x: usize, y: usize) -> f64 {
    let i = y * img.w + x;
    if img.is_color() { 0.2126 * img.ch[0][i] as f64 + 0.7152 * img.ch[1][i] as f64 + 0.0722 * img.ch[2][i] as f64 } else { img.ch[0][i] as f64 }
}
/// gateThreshold(profile, "group.field", default) from agents/llm/gate-contract.mjs.
fn gate_threshold(profile: Option<&Value>, key: &str, def: f64) -> f64 {
    let (group, field) = key.split_once('.').unwrap();
    let g = match profile.and_then(|p| p.get(group)) { Some(g) if g.is_object() => g, _ => return def };
    let v = match g.get(field) { Some(v) if !v.is_null() => v, _ => return def };
    match g.get("_calibration").and_then(|c| c.as_str()) { Some(s) if !s.trim().is_empty() => v.as_f64().unwrap_or(def), _ => def }
}

// ---------------------------------------------------------------------------------------------- scale_bands

/// measureScaleBands: fine (g0.7k - g3k) / blob (g3k - g6k) luminance std over disc pixels, k = rDisc/300.
pub fn scale_bands(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; const B: usize = 48;
    let (gw, gh, g) = block_grid(img, B, false);
    if g.is_empty() { return Ok(json!({ "error": "no disc", "discBlocks": 0 })); }
    let mut s = g.clone(); sort64(&mut s); let sky = s[s.len() / 2];
    let (mut x0, mut y0, mut x1, mut y1, mut nd) = (usize::MAX, usize::MAX, 0usize, 0usize, 0usize);
    for y in 0..gh { for x in 0..gw { if g[y * gw + x] - sky > 0.05 { nd += 1; x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y); } } }
    if nd < 20 { return Ok(json!({ "error": "no disc", "discBlocks": nd })); }
    let (mut px0, mut py0, mut bw, mut bh) = (x0 * B, y0 * B, (x1 - x0 + 1) * B, (y1 - y0 + 1) * B);
    if (bw * bh) as f64 > 16e6 {
        let k = (16e6 / (bw * bh) as f64).sqrt();
        let nw = ((bw as f64 * k / B as f64).floor() as usize) * B; let nh = ((bh as f64 * k / B as f64).floor() as usize) * B;
        px0 += (((bw - nw) as f64 / 2.0 / B as f64).floor() as usize) * B; py0 += (((bh - nh) as f64 / 2.0 / B as f64).floor() as usize) * B;
        bw = nw; bh = nh;
    }
    let n = bw * bh;
    let l: Vec<f32> = (0..n).map(|i| lum709(img, px0 + i % bw, py0 + i / bw) as f32).collect();
    let rd = opt_pos(p, "rDisc").unwrap_or_else(|| ((nd * B * B) as f64 / std::f64::consts::PI).sqrt());
    let ks = (rd / 300.0).max(0.6);
    let g07 = blur::gaussian(&l, bw, bh, (0.7 * ks) as f32);
    let g3 = blur::gaussian(&l, bw, bh, (3.0 * ks) as f32);
    let g6 = blur::gaussian(&l, bw, bh, (6.0 * ks) as f32);
    let (mut sf, mut sf2, mut sm, mut sm2, mut cnt) = (0f64, 0f64, 0f64, 0f64, 0usize);
    for y in 0..bh { for x in 0..bw {
        let (gx, gy) = ((px0 + x) / B, (py0 + y) / B);
        if gx >= gw || gy >= gh || g[gy * gw + gx] - sky <= 0.05 { continue; }
        let i = y * bw + x; if l[i] as f64 - g6[i] as f64 > 0.05 { continue; }
        let f = g07[i] as f64 - g3[i] as f64; let m = g3[i] as f64 - g6[i] as f64;
        sf += f; sf2 += f * f; sm += m; sm2 += m * m; cnt += 1;
    } }
    let c = cnt as f64;
    let sd_f = (sf2 / c - (sf / c) * (sf / c)).max(0.0).sqrt(); let sd_m = (sm2 / c - (sm / c) * (sm / c)).max(0.0).sqrt();
    // JS Math.max(0, NaN) = NaN -> JSON null; Rust f64::max ignores NaN, so restore it for cnt == 0.
    let (sd_f, sd_m) = if cnt == 0 { (f64::NAN, f64::NAN) } else { (sd_f, sd_m) };
    Ok(json!({ "fine": num(sd_f), "blob": num(sd_m), "ratio": if sd_m > 0.0 { num(sd_f / sd_m) } else { json!(0) }, "pixels": cnt, "discBlocks": nd,
               "rDisc": js_round(rd) as i64, "scaleK": ks, "box": [px0, py0, bw, bh] }))
}

// ---------------------------------------------------------------------------------------------- disc_mottle

/// galaxyBlockMask: largest 4-connected component of blocks > sky + 0.02 (first-found wins ties).
fn galaxy_block_mask(grid: &[f64], w: usize, h: usize) -> (Vec<bool>, usize, f64) {
    let n = w * h; let mut s = grid.to_vec(); sort64(&mut s); let sky = s[n / 2];
    let core: Vec<bool> = grid.iter().map(|v| v - sky > 0.02).collect();
    let mut lab = vec![0u32; n]; let (mut next, mut best, mut best_n) = (0u32, 0u32, 0usize); let mut st = Vec::new();
    for s0 in 0..n {
        if !core[s0] || lab[s0] != 0 { continue; }
        next += 1; let mut cnt = 0; lab[s0] = next; st.push(s0);
        while let Some(p) = st.pop() {
            let (x, y) = (p % w, p / w); cnt += 1;
            let mut nb = [usize::MAX; 4];
            if x > 0 { nb[0] = p - 1; } if x + 1 < w { nb[1] = p + 1; } if y > 0 { nb[2] = p - w; } if y + 1 < h { nb[3] = p + w; }
            for q in nb { if q != usize::MAX && core[q] && lab[q] == 0 { lab[q] = next; st.push(q); } }
        }
        if cnt > best_n { best_n = cnt; best = next; }
    }
    (lab.iter().map(|&l| best != 0 && l == best).collect(), best_n, sky)
}

/// JS (+x.toFixed(d)) — parse the formatted string back.
fn tofixed_num(x: f64, d: usize) -> f64 { fx(x, d).parse().unwrap() }

/// measureDiscMottle: std(gauss(s)-gauss(l)) / mean(gauss(l)-sky) over the galaxy disc, mid and outer zones.
pub fn disc_mottle(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w, img.h); const B: usize = 24;
    let (gw, gh, g) = block_grid(img, B, true);
    if g.is_empty() { return Ok(json!({ "error": "no galaxy", "blocks": 0 })); }
    let (bits, blocks, sky) = galaxy_block_mask(&g, gw, gh);
    if blocks < 20 { return Ok(json!({ "error": "no galaxy", "blocks": blocks })); }
    let r = opt_pos(p, "radius").unwrap_or_else(|| ((blocks * B * B) as f64 / std::f64::consts::PI).sqrt());
    let s_s = (r / 300.0).max(0.6); let s_l = (r / 38.0).max(4.0); let s_6 = (r / 75.0).max(2.0);
    // Sigmas are interpolated into the PJSR via toFixed(3).
    let (sig_s, sig_l, sig_6) = (tofixed_num(s_s, 3), tofixed_num(s_l, 3), tofixed_num(s_6, 3));
    let n = w * h;
    // L[i] = 0.2126*c0; L[i] += 0.7152*c1; L[i] += 0.0722*c2 — each step rounded into the Float32Array.
    let l: Vec<f32> = if img.is_color() {
        (0..n).into_par_iter().map(|i| {
            let a = (0.2126 * img.ch[0][i] as f64) as f32; let b = (a as f64 + 0.7152 * img.ch[1][i] as f64) as f32;
            (b as f64 + 0.0722 * img.ch[2][i] as f64) as f32 }).collect()
    } else { img.ch[0].clone() };
    let gs = blur::gaussian(&l, w, h, sig_s as f32);
    let gl = blur::gaussian(&l, w, h, sig_l as f32);
    let g6 = blur::gaussian(&l, w, h, sig_6 as f32);
    let in_gal = |x: usize, y: usize| { let (bx, by) = (x / B, y / B); bx < gw && by < gh && bits[by * gw + bx] };
    let mut e: Vec<f64> = Vec::new();
    for y in (0..h).step_by(4) { for x in (0..w).step_by(4) { if in_gal(x, y) { e.push(gl[y * w + x] as f64 - sky); } } }
    sort64(&mut e);
    let top = e[((e.len() as f64 * 0.99).floor() as usize).min(e.len() - 1)];
    // per-row partial sums, then reduced in row order (sum order differs from the serial JS only at the 1e-16 level)
    let rows: Vec<[f64; 8]> = (0..h).into_par_iter().map(|y| {
        let mut a = [0f64; 8];
        for x in 0..w {
            if !in_gal(x, y) { continue; } let i = y * w + x;
            if l[i] as f64 - g6[i] as f64 > 0.06 { continue; }
            let ev = gl[i] as f64 - sky;
            let k = if ev < 0.25 * top { 4 } else if ev < 0.6 * top { 0 } else { continue };
            if ev <= 0.0 { continue; }
            let dd = gs[i] as f64 - gl[i] as f64;
            a[k] += dd; a[k + 1] += dd * dd; a[k + 2] += ev; a[k + 3] += 1.0;
        }
        a
    }).collect();
    let mut z = [0f64; 8]; for a in &rows { for k in 0..8 { z[k] += a[k]; } }
    let web = |a: &[f64]| -> Option<f64> { if a[3] < 100.0 { return None; } let mu = a[0] / a[3]; Some((a[1] / a[3] - mu * mu).max(0.0).sqrt() / (a[2] / a[3]).max(1e-3)) };
    let (mid, outer) = (web(&z[0..4]), web(&z[4..8]));
    let fs = |v: Option<f64>| v.map(|x| fx(x, 3)).unwrap_or_else(|| "undefined".into());
    let radius = js_round(r);
    let sigmas = [tofixed_num(s_s, 2), tofixed_num(s_l, 2)];
    let details = format!("disc mottle mid {} outer {} (galaxy r~{}px, bands {}-{}px)", fs(mid), fs(outer), radius, sigmas[0], sigmas[1]);
    Ok(json!({ "mid": mid, "outer": outer, "midPx": z[3] as u64, "outerPx": z[7] as u64, "radius": radius as i64, "sigmas": sigmas, "details": details }))
}

// ---------------------------------------------------------------------------------------------- background_noise

/// measureBackgroundNoise: pixel-scale grain (MAD of pixel - mean of dist-2 neighbours) on a 6x6 patch grid.
pub fn background_noise(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w, img.h);
    let lum = |x: usize, y: usize| -> f64 { let i = y * w + x;
        if img.is_color() { 0.3 * img.ch[0][i] as f64 + 0.59 * img.ch[1][i] as f64 + 0.11 * img.ch[2][i] as f64 } else { img.ch[0][i] as f64 } };
    let sz = 40usize.max((w as f64 * 0.05).floor() as usize);
    let mut ms = Vec::new(); let mut hs = Vec::new();
    for gy in 0..6 { for gx in 0..6 {
        let px = (w as f64 * (0.18 + gx as f64 * 0.11)).floor() as usize; let py = (h as f64 * (0.18 + gy as f64 * 0.11)).floor() as usize;
        if px + sz > w || py + sz > h { return Err(format!("measureBackgroundNoise: patch {px},{py}+{sz} outside the {w}x{h} image (PJSR would read out of bounds)")); }
        let mut med = Vec::new(); let mut hf = Vec::new();
        let mut y = py + 2; while y + 2 < py + sz { let mut x = px + 2; while x + 2 < px + sz {
            let c = lum(x, y); med.push(c);
            let nb = (lum(x - 2, y) + lum(x + 2, y) + lum(x, y - 2) + lum(x, y + 2)) / 4.0; hf.push((c - nb).abs());
            x += 2; } y += 2; }
        sort64(&mut med); sort64(&mut hf);
        ms.push(med.get(med.len() >> 1).cloned().unwrap_or(0.0)); hs.push(hf.get(hf.len() >> 1).cloned().unwrap_or(0.0) * 1.4826);
    } }
    let mut idx: Vec<usize> = (0..ms.len()).collect(); idx.sort_by(|&a, &b| cmp_f64(&ms[a], &ms[b]));
    let mut clean: Vec<f64> = (0..12).map(|k| hs[idx[k]]).collect(); sort64(&mut clean);
    let mut dust: Vec<f64> = (12..24.min(idx.len())).map(|k| hs[idx[k]]).collect(); sort64(&mut dust);
    let n = clean[clean.len() >> 1]; let bg_median = ms[idx[6]]; let dn = if dust.is_empty() { 0.0 } else { dust[dust.len() >> 1] };
    let profile = opt(p, "profile");
    let hard = gate_threshold(profile, "noise.bg_hard", 0.022); let goal = 0.015; let dust_hard = gate_threshold(profile, "noise.dust_hard", 0.040);
    let pass = n <= hard && dn <= dust_hard;
    let msg = if n > hard { format!("*** FAILS NOISE GATE (dark sky) *** Background grain too high: bgNoise={} (hard gate {}, goal {}). Apply ONE light NoiseXTerminator pass (denoise 0.25–0.35); do not over-smooth (core-contrast still needs resolved detail). Re-check after.", fx(n, 4), hard, goal) }
        else if dn > dust_hard { format!("*** FAILS NOISE GATE (dust grain) *** The lifted dust is grainy: dustNoise={} (hard gate {}) even though dark sky is clean (bgNoise={}). The dark-sky metric is blind to this — apply a FINAL NoiseXTerminator pass (denoise 0.30, detail 0.10) on the dust AFTER lift_dust. Re-check after.", fx(dn, 4), dust_hard, fx(n, 4)) }
        else if n > goal || dn > 0.030 { format!("Background acceptable but slightly grainy: bgNoise={} (goal {}), dustNoise={}.", fx(n, 4), goal, fx(dn, 4)) }
        else { format!("Background noise GOOD: bgNoise={}, dustNoise={}.", fx(n, 4), fx(dn, 4)) };
    Ok(json!({ "bgNoise": n, "bgMedian": bg_median, "dustNoise": dn, "pass": pass, "details": msg }))
}

// ---------------------------------------------------------------------------------------------- background_floor

/// measureBackgroundFloor: 64 px block medians below global median + 3 sigma(MAD) = background.
pub fn background_floor(ctx: &Ctx, _p: &Value) -> Result<Value, String> {
    let img = ctx.img; const B: usize = 64;
    let g_med = img_median(img); let g_mad = img_mad(img, g_med);
    let thr = g_med + 3.0 * 1.4826 * g_mad;
    let (_, _, all) = block_grid(img, B, false);
    let n_blocks = all.len();
    let mut meds: Vec<f64> = all.into_iter().filter(|&m| m < thr).collect(); sort64(&mut meds);
    let n = meds.len();
    let q = |p: f64| if n > 0 { meds[((p * n as f64).floor() as usize).min(n - 1)] } else { 0.0 };
    let black = meds.iter().filter(|&&m| m < 0.015).count();
    let bbf = if n > 0 { black as f64 / n as f64 } else { 0.0 };
    let details = format!("sky level {} (p10 {}, p90 {}), black background blocks {}% of {}", fx(q(0.5), 4), fx(q(0.1), 4), fx(q(0.9), 4), fx(bbf * 100.0, 1), n);
    Ok(json!({ "bgLevel": q(0.5), "p10": q(0.1), "p90": q(0.9), "blackBlockFraction": bbf, "bgBlocks": n, "totalBlocks": n_blocks,
               "globalMedian": g_med, "blockSize": B, "details": details }))
}

// ---------------------------------------------------------------------------------------------- subject_detail

fn stratified_indices(n: usize, max: usize) -> Vec<usize> {
    if n == 0 || max == 0 { return vec![]; }
    if n <= max { return (0..n).collect(); }
    let k = n as f64 / max as f64;
    (0..max).map(|j| ((j as f64 * k + k / 2.0).floor() as usize).min(n - 1)).collect()
}
struct Sobel { e: f64, n: usize, skipped: usize, total: usize, star_dominated: bool }
fn block_sobel_energy(img: &Image, x0: usize, y0: usize, size: usize, step: usize, bmed: f64) -> Sobel {
    let (mut tot, mut n, mut skipped, mut total, mut bmax) = (0f64, 0usize, 0usize, 0usize, 0f64);
    let mut y = y0 + 1;
    while y < y0 + size - 1 { let mut x = x0 + 1; while x < x0 + size - 1 {
        total += 1;
        let (tl, tc, tr) = (lum709(img, x - 1, y - 1), lum709(img, x, y - 1), lum709(img, x + 1, y - 1));
        let (ml, mc, mr) = (lum709(img, x - 1, y), lum709(img, x, y), lum709(img, x + 1, y));
        let (bl, bc, br) = (lum709(img, x - 1, y + 1), lum709(img, x, y + 1), lum709(img, x + 1, y + 1));
        let wm = [tl, tc, tr, ml, mc, mr, bl, bc, br].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        if wm > bmax { bmax = wm; }
        if wm > bmed + 0.25 || wm > 0.85 { skipped += 1; x += step; continue; }
        let gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br; let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
        tot += gx * gx + gy * gy; n += 1;
        x += step; } y += step; }
    let sd = total > 0 && (skipped as f64 / total as f64 > 0.5 || (bmed > 0.0005 && bmax / bmed > 12.0 && skipped > 0));
    Sobel { e: if n > 0 { tot / n as f64 } else { 0.0 }, n, skipped, total, star_dominated: sd }
}

/// measureSubjectDetail: subject brightness / contrast / star-rejected Sobel detail over 32 px blocks.
pub fn subject_detail(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w, img.h);
    let roi = opt(p, "roi").and_then(|r| {
        let g = |k: &str| r.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        if g("w") > 0.0 && g("h") > 0.0 { Some((g("x"), g("y"), g("w"), g("h"))) } else { None } });
    let bg_median = img_median(img); let bg_mad = img_mad(img, bg_median);
    let subject_threshold = bg_median + 3.0 * 1.4826 * bg_mad;
    let strong = bg_median + 8.0 * 1.4826 * bg_mad;
    const BS: usize = 32;
    let mut pos = Vec::new();
    let mut by = 0; while (by as i64) < h as i64 - BS as i64 { let mut bx = 0; while (bx as i64) < w as i64 - BS as i64 { pos.push((bx, by)); bx += BS; } by += BS; }
    let meds: Vec<f64> = pos.par_iter().map(|&(bx, by)| block_lum_median(img, bx, by, BS, BS)).collect();
    let (mut subj, mut bgb, mut roib) = (Vec::new(), Vec::new(), Vec::new());
    let (mut bg_s, mut subj_s) = (Vec::new(), Vec::new());
    for (k, &(bx, by)) in pos.iter().enumerate() {
        let m = meds[k];
        let in_roi = match roi { None => true, Some((rx, ry, rw, rh)) => bx as f64 >= rx && by as f64 >= ry && (bx + BS) as f64 <= rx + rw && (by + BS) as f64 <= ry + rh };
        if m > strong { if in_roi { subj.push((bx, by, m)); } subj_s.push(m); } else { bg_s.push(m); bgb.push((bx, by, m)); }
        if roi.is_some() && in_roi { roib.push((bx, by, m)); }
    }
    if roi.is_some() && subj.is_empty() { subj = roib; }
    sort64(&mut subj_s); let subject_brightness = if subj_s.is_empty() { 0.0 } else { subj_s[subj_s.len() / 2] };
    sort64(&mut bg_s); let bg_med = if bg_s.is_empty() { bg_median } else { bg_s[bg_s.len() / 2] };
    let contrast_ratio = if bg_med > 0.001 { subject_brightness / bg_med } else { 0.0 };
    let step = 4;
    let idx = stratified_indices(subj.len(), 50);
    let res: Vec<Sobel> = idx.par_iter().map(|&i| { let (x, y, m) = subj[i]; block_sobel_energy(img, x, y, BS, step, m) }).collect();
    let (mut raw_sum, mut raw_n, mut used, mut star_blocks, mut skipped_win, mut total_win) = (0f64, 0usize, 0usize, 0usize, 0usize, 0usize);
    let mut block_e = Vec::new();
    for (j, r) in res.iter().enumerate() {
        skipped_win += r.skipped; total_win += r.total;
        if r.star_dominated || r.n == 0 { star_blocks += 1; continue; }
        block_e.push((r.e, subj[idx[j]].2)); raw_sum += r.e * r.n as f64; raw_n += r.n; used += 1;
    }
    let mut bg_sorted = bgb.clone(); bg_sorted.sort_by(|a, b| cmp_f64(&a.2, &b.2)); // stable, like V8
    let n_noise = 50.min(bg_sorted.len());
    let noise_idx = stratified_indices(bg_sorted.len().min(200), n_noise);
    let nres: Vec<Sobel> = noise_idx.par_iter().map(|&i| { let (x, y, m) = bg_sorted[i]; block_sobel_energy(img, x, y, BS, step, m) }).collect();
    let (mut noise_sum, mut noise_count) = (0f64, 0usize);
    for r in &nres { if r.n > 0 && !r.star_dominated { noise_sum += r.e; noise_count += 1; } }
    let noise_energy = if noise_count > 0 { noise_sum / noise_count as f64 } else { 0.0 };
    let (mut cred_sum, mut weber_sum) = (0f64, 0f64);
    for &(e, m) in &block_e { cred_sum += (e - noise_energy).max(0.0); let m2 = m * m; weber_sum += if m2 > 1e-8 { e / m2 } else { 0.0 }; }
    let detail_raw = if raw_n > 0 { raw_sum / raw_n as f64 } else { 0.0 };
    let nb = block_e.len() as f64;
    let detail_credible = if nb > 0.0 { cred_sum / nb } else { 0.0 };
    let detail_weber = if nb > 0.0 { weber_sum / nb } else { 0.0 };
    let noise_dominated = detail_raw > 0.0 && (detail_credible <= 0.0 || detail_raw / detail_credible > 2.5);
    let raw = json!({
        "subjectBrightness": subject_brightness, "detailScore": detail_raw, "detailRaw": detail_raw, "detailCredible": detail_credible,
        "detailWeber": detail_weber, "noiseEnergy": noise_energy, "noiseDominated": noise_dominated, "blocksUsed": used,
        "starBlocksSkipped": star_blocks, "starWindowFraction": if total_win > 0 { skipped_win as f64 / total_win as f64 } else { 0.0 },
        "contrastRatio": contrast_ratio, "subjectCount": subj.len(), "backgroundMedian": bg_med, "subjectThreshold": subject_threshold,
        "totalBlocks": ((w as f64 / BS as f64) * (h as f64 / BS as f64)).floor() as i64
    });
    // Assessment text (thresholds from gate-contract.mjs, same as the JS wrapper).
    let contrast_min = if opt(p, "faintStructureGoal").and_then(|v| v.as_str()) == Some("outer_halo") { 2.0 } else { 3.0 };
    let profile = opt(p, "profile");
    let detail_min = gate_threshold(profile, "detail.min_detail", 0.001); const SUBJECT_MIN: f64 = 0.25;
    let mut a = Vec::new();
    if subject_brightness < SUBJECT_MIN { a.push(format!("*** WILL FAIL GATE *** SUBJECTS TOO DIM (brightness={}, HARD GATE: {}, goal: >0.35). Stretch harder, apply shadow-lifting curves, boost through masks. For PNe: outer halo must be visible.", fx(subject_brightness, 3), SUBJECT_MIN)); }
    else if subject_brightness < 0.35 { a.push(format!("Subjects moderately bright ({}, passes gate {}, goal: >0.35). Push harder — shadow-lift or masked boost.", fx(subject_brightness, 3), SUBJECT_MIN)); }
    else { a.push(format!("Subject brightness GOOD ({}).", fx(subject_brightness, 3))); }
    if contrast_ratio < contrast_min { a.push(format!("*** WILL FAIL GATE *** LOW CONTRAST (ratio={}×, HARD GATE: {}×, goal: >5×). Use masked curves/LHE to boost subjects selectively.", fx(contrast_ratio, 1), contrast_min)); }
    else if contrast_ratio < 5.0 { a.push(format!("Moderate contrast ({}×, passes gate {}×, goal: >5×). Could improve.", fx(contrast_ratio, 1), contrast_min)); }
    else { a.push(format!("Contrast GOOD ({}×).", fx(contrast_ratio, 1))); }
    if detail_raw < detail_min { a.push(format!("*** WILL FAIL GATE *** VERY LOW DETAIL (score={}, HARD GATE: {}, goal: >0.005). Subjects look like smooth blobs. Apply LHE (r=32-128) through luminance masks.", fx(detail_raw, 6), detail_min)); }
    else if detail_raw < 0.005 { a.push(format!("Moderate detail ({}, passes gate {}, goal: >0.005). Fine-scale LHE can help.", fx(detail_raw, 6), detail_min)); }
    else { a.push(format!("Detail GOOD ({}).", fx(detail_raw, 6))); }
    let details = a.join(" ") + if noise_dominated { " NOISE-DOMINATED detail (raw/credible > 2.5): the energy is mostly grain, not structure." } else { "" };
    Ok(json!({
        "subjectBrightness": subject_brightness, "detailScore": detail_raw, "detailRaw": detail_raw, "detailCredible": detail_credible,
        "detailWeber": detail_weber, "noiseDominated": noise_dominated, "noiseEnergy": noise_energy, "contrastRatio": contrast_ratio,
        "subjectCount": subj.len(), "backgroundMedian": bg_med, "details": details, "raw": raw
    }))
}

// ---------------------------------------------------------------------------------------------- dust_coverage

/// Shared coarse peak scan (step 24 from 4, 99.9th percentile; falls back to the max when <= bg).
fn coarse_peak(img: &Image, bg: f64) -> f64 {
    let (w, h) = (img.w, img.h); let mut c = Vec::new();
    let mut y = 4; while y + 4 < h { let mut x = 4; while x + 4 < w { c.push(lum709(img, x, y)); x += 24; } y += 24; }
    if c.is_empty() { return f64::NAN; }
    sort64(&mut c);
    let mut pk = c[((c.len() as f64 * 0.999).floor() as usize).min(c.len() - 1)];
    if pk <= bg { pk = c[c.len() - 1]; }
    pk
}

/// measureDustCoverage: faint-dust / IFN coverage, saturation and warmth of the field below the bright core.
pub fn dust_coverage(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w, img.h);
    let bg = img_median(img); let peak = coarse_peak(img, bg);
    let core_thr = bg + 0.60 * (peak - bg);
    let step = 3; let (dust_lo, dust_hi) = (bg * 1.20, core_thr);
    let ys: Vec<usize> = (step..h.saturating_sub(step)).step_by(step).collect();
    let rows: Vec<(Vec<f64>, usize, usize, f64)> = ys.par_iter().map(|&y| {
        let (mut lum, mut nd, mut nw, mut ss) = (Vec::new(), 0usize, 0usize, 0f64);
        let mut x = step; while x + step < w {
            let l = lum709(img, x, y);
            if l < core_thr {
                lum.push(l);
                if l > dust_lo && l < dust_hi {
                    nd += 1;
                    if img.is_color() {
                        let i = y * w + x; let (rr, gg, bb) = (img.ch[0][i] as f64, img.ch[1][i] as f64, img.ch[2][i] as f64);
                        let mx = rr.max(gg).max(bb); let mn = rr.min(gg).min(bb);
                        ss += if mx > 0.0001 { (mx - mn) / mx } else { 0.0 };
                        if rr >= bb * 1.03 { nw += 1; }
                    }
                }
            }
            x += step; }
        (lum, nd, nw, ss)
    }).collect();
    let (mut lum, mut n_dust, mut n_warm, mut sat_sum) = (Vec::new(), 0usize, 0usize, 0f64);
    for (l, nd, nw, ss) in rows { lum.extend(l); n_dust += nd; n_warm += nw; sat_sum += ss; }
    let n_field = lum.len();
    sort64(&mut lum);
    let pct = |q: f64| if lum.is_empty() { Value::Null } else { json!(lum[((lum.len() as f64 * q).floor() as usize).min(lum.len() - 1)]) };
    let cov = if n_field > 0 { n_dust as f64 / n_field as f64 } else { 0.0 };
    let warm = if n_dust > 0 { n_warm as f64 / n_dust as f64 } else { 0.0 };
    let msat = if n_dust > 0 { sat_sum / n_dust as f64 } else { 0.0 };
    let (p90, p95) = (pct(0.90), pct(0.95));
    let raw = json!({ "bg": bg, "peak": num(peak), "coreThr": num(core_thr), "fieldP90": p90, "fieldP95": p95, "dustCoverage": cov,
                      "warmDustFraction": warm, "dustMeanSat": msat, "nField": n_field, "nDust": n_dust });
    let cfg = p.get("ifnCfg").or_else(|| p.get("opts")).unwrap_or(p);
    let c = |k: &str, d: f64| cfg.get(k).and_then(|v| v.as_f64()).unwrap_or(d);
    let (min_sat, min_p95, min_cov, min_warm) = (c("min_dust_mean_sat", 0.24), c("min_field_p95", 0.15), c("min_dust_coverage", 0.24), c("min_warm_fraction", 0.35));
    let p95v = p95.as_f64().unwrap_or(0.0);
    let greyed = msat < min_sat; let crushed = p95v < min_p95; let thin = cov < min_cov;
    let pass = !(greyed && crushed && warm >= min_warm);
    let mut msgs = Vec::new();
    if !pass {
        msgs.push(format!("*** FAILS IFN/DUST GATE *** The brown dust (warmFraction={}%) is BOTH greyed and crushed: dustMeanSat={} (min {}) AND fieldP95={} (min {}). The frame reads empty. Lift the faint dust SELECTIVELY (lift_dust: masked shadow/midtone recovery in the bg*1.2..core band) and BOOST its warm saturation — do NOT use a global additive lift (it greys the field).", fx(warm * 100.0, 0), fx(msat, 3), min_sat, fx(p95v, 3), min_p95));
    } else {
        if greyed { msgs.push(format!("(advisory) dust is muted: dustMeanSat={} (goal >= {}). Boost warm saturation through a dust mask.", fx(msat, 3), min_sat)); }
        if crushed { msgs.push(format!("(advisory) dust peaks low: fieldP95={} (goal >= {}). Lift faint dust selectively (lift_dust).", fx(p95v, 3), min_p95)); }
        if thin { msgs.push(format!("(advisory) dust coverage thin: {}% of field (goal >= {}%).", fx(cov * 100.0, 1), fx(min_cov * 100.0, 0))); }
        if !greyed && !crushed && !thin { msgs.push(format!("Dust GOOD: coverage={}%, meanSat={}, P95={}.", fx(cov * 100.0, 1), fx(msat, 3), fx(p95v, 3))); }
    }
    Ok(json!({ "dustCoverage": cov, "warmDustFraction": warm, "dustMeanSat": msat, "fieldP95": p95, "fieldP90": p90, "bg": bg, "coreThr": num(core_thr),
               "pass": pass, "details": msgs.join(" "), "raw": raw }))
}

// ---------------------------------------------------------------------------------------------- subject_roi

/// locateSubjectROI: luminance-weighted centroid of compact above-threshold pixels + 90% radius.
pub fn subject_roi(ctx: &Ctx, _p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w, img.h);
    let bg_median = img_median(img);
    let mut diffs = Vec::new();
    for y in (0..h).step_by(32) { for x in (0..w).step_by(32) { diffs.push((lum709(img, x, y) - bg_median).abs()); } }
    sort64(&mut diffs);
    let bg_mad = diffs[diffs.len() / 2];
    let thr = bg_median + 5.0 * bg_mad;
    let (step, pd) = (8usize, 3usize);
    let (mut swx, mut swy, mut sw, mut count, mut total) = (0f64, 0f64, 0f64, 0usize, 0usize);
    let mut coords = Vec::new();
    let mut y = step; while y + step < h { let mut x = step; while x + step < w {
        total += 1;
        let l = lum709(img, x, y);
        if l > thr {
            let mut bn = 0;
            if x >= pd && lum709(img, x - pd, y) > thr { bn += 1; }
            if x + pd < w && lum709(img, x + pd, y) > thr { bn += 1; }
            if y >= pd && lum709(img, x, y - pd) > thr { bn += 1; }
            if y + pd < h && lum709(img, x, y + pd) > thr { bn += 1; }
            if bn >= 2 { swx += x as f64 * l; swy += y as f64 * l; sw += l; count += 1; coords.push((x, y)); }
        }
        x += step; } y += step; }
    let cx = if sw > 0.0 { js_round(swx / sw) } else { js_round(w as f64 / 2.0) };
    let cy = if sw > 0.0 { js_round(swy / sw) } else { js_round(h as f64 / 2.0) };
    let mut d: Vec<f64> = coords.iter().map(|&(x, y)| { let (dx, dy) = (x as f64 - cx, y as f64 - cy); (dx * dx + dy * dy).sqrt() }).collect();
    sort64(&mut d);
    let mut radius = if d.is_empty() { w.min(h) as f64 / 4.0 } else { d[(d.len() as f64 * 0.90).floor() as usize] };
    let max_r = w.min(h) as f64 * 0.45;
    if radius > max_r { radius = max_r; } if radius < 50.0 { radius = 50.0; }
    radius = js_round(radius);
    let frac = if total > 0 { count as f64 / total as f64 } else { 0.0 };
    let confidence = if frac > 0.03 && count > 500 { "high" } else if frac > 0.01 { "medium" } else { "low" };
    if confidence == "medium" { radius = js_round(radius * 1.2); }
    Ok(json!({ "cx": cx as i64, "cy": cy as i64, "radius": radius as i64, "confidence": confidence, "subjectPixelCount": count, "subjectFraction": frac,
               "bgMedian": bg_median, "bgMAD": bg_mad, "subjectThreshold": thr }))
}

// ---------------------------------------------------------------------------------------------- sobel_texture

/// The before/after detail measurements of shellDetailEnhance and multiScaleEnhance (agents/ops/compound-enhance.mjs),
/// which ran as PJSR sample() loops (~250 s per call at 61 MP).
/// Params: kSigma (threshold = median + kSigma*1.4826*MAD, PixInsight pooled median/MAD) or threshold (absolute, e.g. the
/// "before" threshold reused for "after"); upper (optional exclusive upper bound, 0.98 in shellDetailEnhance); step (8);
/// block (16; 0 = skip the local-std pass) with blockStep 2 and minFrac 0.3; knee + softness (optional: protEngaged).
/// Sobel on Rec.709 luminance at grid points x,y = 1, 1+step, ... < dim-1. Returns gradientEnergy (mean gx²+gy²), count,
/// maxLum (max over all grid points, from 0), protEngaged (count with exp(-softness*max(0,l-knee)/oneMinusKnee) < 0.5),
/// localStd (median of block std devs, sorted[floor(n/2)]), median, mad, threshold.
pub fn sobel_texture(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w, img.h);
    let step = opt(p, "step").and_then(|v| v.as_u64()).unwrap_or(8).max(1) as usize;
    let (median, mad) = match opt(p, "threshold").and_then(|v| v.as_f64()) {
        Some(_) => (f64::NAN, f64::NAN),
        None => { let m = img_median(img); (m, img_mad(img, m)) }
    };
    let thr = match opt(p, "threshold").and_then(|v| v.as_f64()) { Some(t) => t, None => median + opt(p, "kSigma").and_then(|v| v.as_f64()).unwrap_or(8.0) * 1.4826 * mad };
    let upper = opt(p, "upper").and_then(|v| v.as_f64());
    let knee = opt(p, "knee").and_then(|v| v.as_f64());
    let softness = opt(p, "softness").and_then(|v| v.as_f64()).unwrap_or(4.0);
    let omk = knee.map(|k| (1.0 - k).max(0.01));
    let ys: Vec<usize> = (1..h.saturating_sub(1)).step_by(step).collect();
    // per grid row: (energy, count, max, protEngaged); summed in row order (JS sums sequentially; differences ~1e-15)
    let rows: Vec<(f64, usize, f64, usize)> = ys.par_iter().map(|&y| {
        let (mut e, mut n, mut mx, mut pe) = (0f64, 0usize, 0f64, 0usize);
        let mut x = 1; while x + 1 < w {
            let l = lum709(img, x, y);
            if l > mx { mx = l; }
            if l > thr && upper.map_or(true, |u| l < u) {
                let (tl, tc, tr) = (lum709(img, x - 1, y - 1), lum709(img, x, y - 1), lum709(img, x + 1, y - 1));
                let (ml, mr) = (lum709(img, x - 1, y), lum709(img, x + 1, y));
                let (bl, bc, br) = (lum709(img, x - 1, y + 1), lum709(img, x, y + 1), lum709(img, x + 1, y + 1));
                let gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
                let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
                e += gx * gx + gy * gy; n += 1;
                if let (Some(k), Some(o)) = (knee, omk) { if (-softness * (l - k).max(0.0) / o).exp() < 0.5 { pe += 1; } }
            }
            x += step;
        }
        (e, n, mx, pe)
    }).collect();
    let (mut energy, mut count, mut maxl, mut prot) = (0f64, 0usize, 0f64, 0usize);
    for (e, n, mx, pe) in rows { energy += e; count += n; if mx > maxl { maxl = mx; } prot += pe; }
    // local std over blocks: for (by = 0; by < H - bs; by += bs) ... px/py step blockStep inside the block
    let bs = opt(p, "block").and_then(|v| v.as_u64()).unwrap_or(16) as usize;
    let mut local_std = Value::Null;
    if bs > 0 && w > bs && h > bs {
        let bstep = opt(p, "blockStep").and_then(|v| v.as_u64()).unwrap_or(2).max(1) as usize;
        let min_frac = opt(p, "minFrac").and_then(|v| v.as_f64()).unwrap_or(0.3);
        let bys: Vec<usize> = (0..h - bs).step_by(bs).collect();
        let mut sds: Vec<f64> = bys.par_iter().flat_map_iter(|&by| {
            let mut out = Vec::new();
            let mut bx = 0; while bx < w - bs {
                let (mut s, mut s2, mut n, mut sh) = (0f64, 0f64, 0usize, 0usize);
                let mut py = by; while py < by + bs { let mut px = bx; while px < bx + bs {
                    let l = lum709(img, px, py); s += l; s2 += l * l; n += 1;
                    if l > thr && upper.map_or(true, |u| l < u) { sh += 1; }
                    px += bstep; } py += bstep; }
                if !((sh as f64) < n as f64 * min_frac) {
                    let mn = s / n as f64; let v = s2 / n as f64 - mn * mn;
                    if v > 0.0 { out.push(v.sqrt()); }
                }
                bx += bs;
            }
            out
        }).collect();
        sort64(&mut sds);
        local_std = json!(if sds.is_empty() { 0.0 } else { sds[sds.len() / 2] });
    }
    Ok(json!({ "gradientEnergy": if count > 0 { energy / count as f64 } else { 0.0 }, "count": count, "maxLum": maxl, "protEngaged": prot,
               "localStd": local_std, "median": num(median), "mad": num(mad), "threshold": thr }))
}
