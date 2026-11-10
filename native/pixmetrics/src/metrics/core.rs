//! Core / highlight / burn metrics. Ports of agents/ops/subject-metrics.mjs (measureCoreAmp, measureCoreSpectrum,
//! measureCoreContrast, measureCoreTexture, measureCoreTroughs) and agents/ops/quality-gates.mjs (assessBurn,
//! scanBurntRegions, measureShellTexture, checkHighlightTexture, checkRinging).
//! Arithmetic mirrors the PJSR: img.sample() values are doubles, Float32Array buffers stay f32 (incl. the
//! stepwise `L[i] += k * c[i]` luminance accumulation), JS Math.round = floor(x + 0.5).
use super::Ctx;
use crate::{blur, image::Image};
use rayon::prelude::*;
use serde_json::{json, Value};

pub const NAMES: &[&str] = &[
    "core_amp", "core_spectrum", "core_contrast", "core_texture", "core_troughs",
    "burn", "scan_burnt_regions", "shell_texture", "highlight_texture", "ringing",
];

pub fn dispatch(name: &str, ctx: &Ctx, p: &Value) -> Option<Result<Value, String>> {
    Some(match name {
        "core_amp" => core_amp(ctx, p),
        "core_spectrum" => core_spectrum(ctx, p),
        "core_contrast" => core_contrast(ctx, p),
        "core_texture" => core_texture(ctx, p),
        "core_troughs" => core_troughs(ctx, p),
        "burn" => Ok(assess_burn(ctx.img, p.get("opts").unwrap_or(&Value::Null))),
        "scan_burnt_regions" => Ok(scan_burnt_regions(ctx.img, p.get("opts").unwrap_or(&Value::Null))),
        "shell_texture" => Ok(shell_texture(ctx.img, p.get("opts").unwrap_or(&Value::Null))),
        "highlight_texture" => highlight_texture(ctx, p),
        "ringing" => Ok(ringing(ctx.img)),
        _ => return None,
    })
}

// ---------------------------------------------------------------- helpers (private)

#[inline] fn js_round(x: f64) -> f64 { (x + 0.5).floor() }
fn fixed(x: f64, d: usize) -> String { format!("{:.*}", d, x) }
/// JS Number -> String for the common cases (integers without ".0", otherwise shortest round-trip).
fn jsnum(x: f64) -> String { if x.fract() == 0.0 && x.abs() < 1e15 { format!("{}", x as i64) } else { format!("{}", x) } }
/// `+(x).toFixed(d)`
fn tofixed_num(x: f64, d: usize) -> f64 { fixed(x, d).parse().unwrap_or(x) }
/// JSON number that prints as an integer when integral (JS has a single number type).
fn jv(x: f64) -> Value { if x.fract() == 0.0 && x.abs() < 9e15 { json!(x as i64) } else { json!(x) } }
fn sort_f64(v: &mut [f64]) { v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); }
fn num(v: Option<&Value>) -> Option<f64> { v.and_then(|x| x.as_f64()) }
fn opt_f64(o: &Value, k: &str, d: f64) -> f64 { num(o.get(k)).unwrap_or(d) }

struct Inv { cx: f64, cy: f64, rd: f64, sky: Option<(f64, f64)> }
fn inv(p: &Value) -> Result<Inv, String> {
    let inv = p.get("inv").ok_or("params.inv required")?;
    let c = inv.get("centre").and_then(|c| c.as_array()).ok_or("params.inv.centre required")?;
    let rd = num(inv.get("rDet")).ok_or("params.inv.rDet required")?;
    let sky = inv.get("zones").and_then(|z| z.get("sky")).and_then(|s| s.as_array())
        .and_then(|a| Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?)));
    Ok(Inv { cx: c[0].as_f64().unwrap_or(0.0), cy: c[1].as_f64().unwrap_or(0.0), rd, sky })
}

/// PJSR `getSamples` luminance with the stepwise accumulation used by most metrics:
/// L = f32(0.2126 c0); L = f32(L + 0.7152 c1); L = f32(L + 0.0722 c2) — over the rect [x0,x1) x [y0,y1).
fn lum_stepwise(img: &Image, x0: usize, y0: usize, x1: usize, y1: usize) -> Vec<f32> {
    let cw = x1 - x0; let mut l = vec![0f32; cw * (y1 - y0)];
    for y in y0..y1 { for x in x0..x1 {
        let i = y * img.w + x; let o = (y - y0) * cw + (x - x0);
        l[o] = if img.is_color() {
            let mut v = (0.2126 * img.ch[0][i] as f64) as f32;
            v = (v as f64 + 0.7152 * img.ch[1][i] as f64) as f32;
            (v as f64 + 0.0722 * img.ch[2][i] as f64) as f32
        } else { img.ch[0][i] };
    } }
    l
}
/// img.sample-based luminance (doubles).
#[inline] fn lum_d(img: &Image, x: usize, y: usize) -> f64 {
    let i = y * img.w + x;
    if img.is_color() { 0.2126 * img.ch[0][i] as f64 + 0.7152 * img.ch[1][i] as f64 + 0.0722 * img.ch[2][i] as f64 } else { img.ch[0][i] as f64 }
}
/// Image.median() with the default (all-channel) selection: exact median of every sample, mean of the two
/// central values for an even count.
fn median_all(img: &Image) -> f64 {
    let mut v: Vec<f32> = img.ch.iter().flat_map(|c| c.iter().copied()).collect();
    let n = v.len(); if n == 0 { return 0.0; }
    let cmp = |a: &f32, b: &f32| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    let (_, hi, _) = v.select_nth_unstable_by(n / 2, cmp); let hi = *hi as f64;
    if n % 2 == 1 { return hi; }
    let lo = v[..n / 2].iter().copied().fold(f32::MIN, f32::max) as f64;
    0.5 * (lo + hi)
}

#[inline] fn kmirror(i: isize, n: isize) -> usize {
    if n == 1 { return 0; } let mut j = i;
    while j < 0 || j >= n { if j < 0 { j = -j - 1; } if j >= n { j = 2 * n - j - 1; } }
    j as usize
}
/// Same result as crate::blur::gaussian(src, w, h, sigma) (same kernel, mirror boundary and f32 summation order)
/// but evaluated only on the grid xs x ys: the PJSR blurs the whole frame and then reads a small region/stride.
fn blur_grid(src: &[f32], w: usize, h: usize, sigma: f64, xs: &[usize], ys: &[usize]) -> Vec<f32> {
    let nx = xs.len(); if nx == 0 || ys.is_empty() { return Vec::new(); }
    let k = blur::kernel(sigma as f32); let r = (k.len() / 2) as isize;
    let mut need = vec![false; h];
    for &y in ys { for j in 0..k.len() { need[kmirror(y as isize + j as isize - r, h as isize)] = true; } }
    let rows: Vec<usize> = (0..h).filter(|&y| need[y]).collect();
    let mut slot = vec![usize::MAX; h]; for (i, &y) in rows.iter().enumerate() { slot[y] = i; }
    let mut tmp = vec![0f32; rows.len() * nx];
    tmp.par_chunks_mut(nx).zip(rows.par_iter()).for_each(|(row, &y)| {
        let s = &src[y * w..(y + 1) * w];
        for (xi, &x) in xs.iter().enumerate() {
            let mut acc = 0f32;
            let xs0 = x as isize - r;
            if xs0 >= 0 && (xs0 as usize) + k.len() <= w {
                let seg = &s[xs0 as usize..xs0 as usize + k.len()];
                for (kv, sv) in k.iter().zip(seg) { acc += kv * sv; }
            } else {
                for (j, kv) in k.iter().enumerate() { acc += kv * s[kmirror(xs0 + j as isize, w as isize)]; }
            }
            row[xi] = acc;
        }
    });
    let mut out = vec![0f32; ys.len() * nx];
    out.par_chunks_mut(nx).zip(ys.par_iter()).for_each(|(row, &y)| {
        for (j, kv) in k.iter().enumerate() {
            let t = slot[kmirror(y as isize + j as isize - r, h as isize)];
            let t = &tmp[t * nx..(t + 1) * nx];
            for xi in 0..nx { row[xi] += kv * t[xi]; }
        }
    });
    out
}
fn range(a: usize, b: usize, step: usize) -> Vec<usize> { (a..b.max(a)).step_by(step).collect() }

/// Sky = median (a[len>>1]) of the stride-4 grid of a blurred frame inside zones.sky [d0, d1).
fn zone_sky(l: &[f32], w: usize, h: usize, sigma: f64, cx: f64, cy: f64, d0: f64, d1: f64) -> f64 {
    let xs = range(0, w, 4); let ys = range(0, h, 4);
    // only rows that intersect the annulus are needed (rows entirely outside give no samples)
    let ys: Vec<usize> = ys.into_iter().filter(|&y| (y as f64 - cy).abs() < d1).collect();
    let g = blur_grid(l, w, h, sigma, &xs, &ys);
    let mut sk = Vec::new();
    for (yi, &y) in ys.iter().enumerate() { for (xi, &x) in xs.iter().enumerate() {
        let d = ((x as f64 - cx) * (x as f64 - cx) + (y as f64 - cy) * (y as f64 - cy)).sqrt();
        if d >= d0 && d < d1 { sk.push(g[yi * xs.len() + xi] as f64); }
    } }
    sort_f64(&mut sk); if sk.is_empty() { 0.0 } else { sk[sk.len() >> 1] }
}

// ---------------------------------------------------------------- core_amp

/// measureCoreAmp(ctx, viewId, inv) — params { inv: { centre, rDet } } -> { sky, std600, std300 }
fn core_amp(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let v = inv(p)?; let (w, h) = (img.w, img.h);
    let r = js_round(0.22 * v.rd); let pad = js_round(0.1 * v.rd);
    let sig = [f64::max(0.7, v.rd / 600.0), f64::max(0.7, v.rd / 300.0)];
    let mut sk = Vec::new();
    for y in (0..h).step_by(16) { for x in (0..w).step_by(16) { let l = lum_d(img, x, y); if l > 1e-6 { sk.push(l); } } }
    sort_f64(&mut sk);
    let sky = if sk.is_empty() { 0.0 } else { sk[(0.2 * sk.len() as f64).floor() as usize] };
    let x0 = (v.cx - r - pad).max(0.0) as usize; let y0 = (v.cy - r - pad).max(0.0) as usize;
    let x1 = (v.cx + r + pad).min(w as f64) as usize; let y1 = (v.cy + r + pad).min(h as f64) as usize;
    if x1 <= x0 || y1 <= y0 { return Err("measureCoreAmp: empty core rect".into()); }
    let (cw, chh) = (x1 - x0, y1 - y0);
    let l = lum_stepwise(img, x0, y0, x1, y1);
    let mut out = serde_json::Map::new(); out.insert("sky".into(), json!(sky));
    for (k, &s) in sig.iter().enumerate() {
        let a = blur::gaussian(&l, cw, chh, s as f32); let b = blur::gaussian(&l, cw, chh, (4.0 * s) as f32);
        let (mut s1, mut s2, mut m) = (0f64, 0f64, 0f64);
        for y in 0..chh { for x in 0..cw {
            let dx = (x + x0) as f64 - v.cx; let dy = (y + y0) as f64 - v.cy;
            if dx * dx + dy * dy >= r * r { continue; }
            let i = y * cw + x; let q = (a[i] as f64 - b[i] as f64) / f64::max(b[i] as f64 - sky, 0.02);
            s1 += q; s2 += q * q; m += 1.0;
        } }
        let mu = s1 / m;
        out.insert((if k == 0 { "std600" } else { "std300" }).into(), json!((f64::max(0.0, s2 / m - mu * mu)).sqrt()));
    }
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------- core_spectrum

/// measureCoreSpectrum(ctx, viewId, inv, { coreFrac = 0.22 }) — params { inv, opts?: { coreFrac } }
/// -> { u, fine, mid, coarse, spectrum, midCoarse }
fn core_spectrum(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let v = inv(p)?; let o = p.get("opts").cloned().unwrap_or(Value::Null);
    let core_frac = opt_f64(&o, "coreFrac", 0.22);
    let rc = js_round(core_frac * v.rd); let u = f64::max(0.6, v.rd / 300.0); let pad = (u * 8.0 * 3.0).ceil();
    let (w, h) = (img.w, img.h);
    let x0 = (v.cx - rc - pad).max(0.0) as usize; let y0 = (v.cy - rc - pad).max(0.0) as usize;
    let x1 = (v.cx + rc + pad).min(w as f64) as usize; let y1 = (v.cy + rc + pad).min(h as f64) as usize;
    if x1 <= x0 || y1 <= y0 { return Err("measureCoreSpectrum: empty core rect".into()); }
    let (cw, chh) = (x1 - x0, y1 - y0);
    let l = lum_stepwise(img, x0, y0, x1, y1);
    let g: Vec<Vec<f32>> = [u, 2.0 * u, 4.0 * u, 8.0 * u].par_iter().map(|&s| blur::gaussian(&l, cw, chh, s as f32)).collect();
    let sd = |a: &[f32], b: &[f32]| -> f64 {
        let (mut s, mut s2, mut k) = (0f64, 0f64, 0f64);
        for y in 0..chh { for x in 0..cw {
            let dx = (x + x0) as f64 - v.cx; let dy = (y + y0) as f64 - v.cy;
            if dx * dx + dy * dy >= rc * rc { continue; }
            let i = y * cw + x; let d = a[i] as f64 - b[i] as f64; s += d; s2 += d * d; k += 1.0;
        } }
        let m = s / k; f64::max(0.0, s2 / k - m * m).sqrt()
    };
    let (fine, mid, coarse) = (sd(&g[0], &g[1]), sd(&g[1], &g[2]), sd(&g[2], &g[3]));
    Ok(json!({ "u": u, "fine": fine, "mid": mid, "coarse": coarse,
        "spectrum": if coarse > 0.0 { Some(fine / coarse) } else { None },
        "midCoarse": if coarse > 0.0 { Some(mid / coarse) } else { None } }))
}

// ---------------------------------------------------------------- core_troughs

/// measureCoreTroughs(ctx, viewId, inv, { fracs = [1/250, 1/60, 1/30], coreFrac = 0.25 })
/// params { inv: { centre, rDet, zones: { sky:[d0,d1] } }, opts?: { fracs, coreFrac } }
/// -> { scales: [{ sigma, p2, p5, p50, p95, p98, darkFrac, asym }], sky, n }
fn core_troughs(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let v = inv(p)?; let (d0, d1) = v.sky.ok_or("params.inv.zones.sky required")?;
    let o = p.get("opts").cloned().unwrap_or(Value::Null);
    let fracs: Vec<f64> = o.get("fracs").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
        .unwrap_or_else(|| vec![1.0 / 250.0, 1.0 / 60.0, 1.0 / 30.0]);
    if fracs.is_empty() { return Err("opts.fracs empty".into()); }
    let core_frac = opt_f64(&o, "coreFrac", 0.25);
    let rc = js_round(core_frac * v.rd);
    let sig: Vec<f64> = fracs.iter().map(|f| f64::max(0.7, tofixed_num(f * v.rd, 2))).collect();
    let (w, h) = (img.w, img.h);
    let l = lum_stepwise(img, 0, 0, w, h);
    let sky = zone_sky(&l, w, h, f64::max(8.0, sig[sig.len() - 1] * 4.0), v.cx, v.cy, d0, d1);
    // core box loop bounds: y from max(0, cy-rC) while < min(H, cy+rC)
    let bx0 = (v.cx - rc).max(0.0); let bx1 = (v.cx + rc).min(w as f64);
    let by0 = (v.cy - rc).max(0.0); let by1 = (v.cy + rc).min(h as f64);
    let xs: Vec<usize> = { let mut a = Vec::new(); let mut x = bx0; while x < bx1 { a.push(x as usize); x += 1.0; } a };
    let ys: Vec<usize> = { let mut a = Vec::new(); let mut y = by0; while y < by1 { a.push(y as usize); y += 1.0; } a };
    let fx = |i: usize| bx0 + i as f64; let fy = |i: usize| by0 + i as f64;
    let mut scales = Vec::new();
    for &s in &sig {
        let ga = blur_grid(&l, w, h, s, &xs, &ys); let gb = blur_grid(&l, w, h, s * 4.0, &xs, &ys);
        let mut rel = Vec::new();
        for yi in 0..ys.len() { for xi in 0..xs.len() {
            let (x, y) = (fx(xi), fy(yi));
            if (x - v.cx) * (x - v.cx) + (y - v.cy) * (y - v.cy) >= rc * rc { continue; }
            let i = yi * xs.len() + xi;
            rel.push((ga[i] as f64 - gb[i] as f64) / f64::max(gb[i] as f64 - sky, 0.02));
        } }
        sort_f64(&mut rel); let n = rel.len();
        if n == 0 { scales.push(json!({ "sigma": s, "p2": null, "p5": null, "p50": null, "p95": null, "p98": null, "darkFrac": null, "asym": null })); continue; }
        let dark = rel.iter().take_while(|&&r| r < -0.25).count();
        let q = |f: f64| rel[((f * n as f64).floor() as usize).min(n - 1)];
        scales.push(json!({ "sigma": s, "p2": q(0.02), "p5": q(0.05), "p50": q(0.5), "p95": q(0.95), "p98": q(0.98),
            "darkFrac": dark as f64 / n as f64, "asym": -q(0.02) / f64::max(q(0.98), 1e-4) }));
    }
    Ok(json!({ "scales": scales, "sky": sky, "n": jv(rc) }))
}

// ---------------------------------------------------------------- core_texture

/// measureCoreTexture(ctx, viewId, inv, { fracs = [1/120, 1/50], coreFrac = 0.25 })
/// params { inv: { centre, rDet, zones: { sky } }, opts?: { fracs, coreFrac } }
/// -> { scales: [{ sigma, coherence, lumTex, chromaTex }], sky }
fn core_texture(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let v = inv(p)?; let (d0, d1) = v.sky.ok_or("params.inv.zones.sky required")?;
    let o = p.get("opts").cloned().unwrap_or(Value::Null);
    let fracs: Vec<f64> = o.get("fracs").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
        .unwrap_or_else(|| vec![1.0 / 120.0, 1.0 / 50.0]);
    if fracs.is_empty() { return Err("opts.fracs empty".into()); }
    let core_frac = opt_f64(&o, "coreFrac", 0.25);
    let rc = js_round(core_frac * v.rd);
    let sig: Vec<f64> = fracs.iter().map(|f| f64::max(0.8, tofixed_num(f * v.rd, 2))).collect();
    let (w, h, n, col) = (img.w, img.h, img.w * img.h, img.is_color());
    let mut l = vec![0f32; n]; let (mut a, mut bc) = (Vec::new(), Vec::new());
    if col {
        a = vec![0f32; n]; bc = vec![0f32; n];
        for i in 0..n {
            let (c0, c1, c2) = (img.ch[0][i] as f64, img.ch[1][i] as f64, img.ch[2][i] as f64);
            l[i] = (0.2126 * c0 + 0.7152 * c1 + 0.0722 * c2) as f32; a[i] = (c0 - c1) as f32; bc[i] = (0.5 * (c0 + c1) - c2) as f32;
        }
    } else { l.copy_from_slice(&img.ch[0]); }
    let sky = zone_sky(&l, w, h, f64::max(8.0, sig[sig.len() - 1] * 4.0), v.cx, v.cy, d0, d1);
    let x0 = (v.cx - rc).max(1.0); let x1 = (v.cx + rc).min(w as f64 - 1.0);
    let y0 = (v.cy - rc).max(1.0); let y1 = (v.cy + rc).min(h as f64 - 1.0);
    let span = |a0: f64, a1: f64| { let mut r = Vec::new(); let mut t = a0; while t < a1 { r.push(t as usize); t += 1.0; } r };
    let xs = span(x0, x1); let ys = span(y0, y1);
    if xs.is_empty() || ys.is_empty() { return Err("measureCoreTexture: empty core box".into()); }
    // ga is read at x-1..x+1, y-1..y+1: evaluate it on the box grown by one pixel
    let xse: Vec<usize> = (xs[0] - 1..=xs[xs.len() - 1] + 1).collect();
    let yse: Vec<usize> = (ys[0] - 1..=ys[ys.len() - 1] + 1).collect();
    let (nxe, nx) = (xse.len(), xs.len());
    let mut scales = Vec::new();
    for &s in &sig {
        let gae = blur_grid(&l, w, h, s, &xse, &yse); let gb = blur_grid(&l, w, h, 4.0 * s, &xs, &ys);
        let gae_at = |x: usize, y: usize| gae[(y + 1 - ys[0]) * nxe + (x + 1 - xs[0])] as f64;
        let (mut jxx, mut jxy, mut jyy) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        for &y in &ys { for &x in &xs {
            let i = y * w + x;
            let gx = 0.5 * (gae_at(x + 1, y) - gae_at(x - 1, y)); let gy = 0.5 * (gae_at(x, y + 1) - gae_at(x, y - 1));
            jxx[i] = (gx * gx) as f32; jxy[i] = (gx * gy) as f32; jyy[i] = (gy * gy) as f32;
        } }
        let bj: Vec<Vec<f32>> = [&jxx, &jxy, &jyy].par_iter().map(|src| blur_grid(src, w, h, 3.0 * s, &xs, &ys)).collect();
        drop((jxx, jxy, jyy));
        let chroma: Option<Vec<Vec<f32>>> = if col {
            Some([(&a, s), (&a, 4.0 * s), (&bc, s), (&bc, 4.0 * s)].par_iter().map(|(src, sg)| blur_grid(src, w, h, *sg, &xs, &ys)).collect())
        } else { None };
        let (mut num_, mut den, mut lt, mut lt2, mut cnt) = (0f64, 0f64, 0f64, 0f64, 0f64);
        let (mut ca, mut ca2, mut cb, mut cb2) = (0f64, 0f64, 0f64, 0f64);
        for (yi, &y) in ys.iter().enumerate() { for (xi, &x) in xs.iter().enumerate() {
            if (x as f64 - v.cx) * (x as f64 - v.cx) + (y as f64 - v.cy) * (y as f64 - v.cy) >= rc * rc { continue; }
            let k = yi * nx + xi;
            let (jx, jc, jy) = (bj[0][k] as f64, bj[1][k] as f64, bj[2][k] as f64);
            let tr = jx + jy; let df = ((jx - jy) * (jx - jy) + 4.0 * jc * jc).sqrt(); num_ += df; den += tr;
            let lvl = f64::max(gb[k] as f64 - sky, 0.02); let q = (gae_at(x, y) - gb[k] as f64) / lvl; lt += q; lt2 += q * q; cnt += 1.0;
            if let Some(c) = &chroma {
                let va = (c[0][k] as f64 - c[1][k] as f64) / lvl; let vb = (c[2][k] as f64 - c[3][k] as f64) / lvl;
                ca += va; ca2 += va * va; cb += vb; cb2 += vb * vb;
            }
        } }
        let sd = |s1: f64, s2: f64| { let m = s1 / cnt; f64::max(0.0, s2 / cnt - m * m).sqrt() };
        scales.push(json!({ "sigma": s, "coherence": if den > 0.0 { Some(num_ / den) } else { None }, "lumTex": sd(lt, lt2),
            "chromaTex": if col { Some((sd(ca, ca2) * sd(ca, ca2) + sd(cb, cb2) * sd(cb, cb2)).sqrt()) } else { None } }));
    }
    Ok(json!({ "scales": scales, "sky": sky }))
}

// ---------------------------------------------------------------- core_contrast

/// measureCoreContrast(ctx, viewId, classification, coreBurnCfg) — params { classification?, coreBurnCfg? }
/// Returns the full JS wrapper object (gate logic + details + raw).
fn core_contrast(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let (w, h) = (img.w as isize, img.h as isize); let col = img.is_color();
    let lf = |x: isize, y: isize| lum_d(img, x as usize, y as usize);
    let bg = median_all(img);
    let mut coarse = Vec::new();
    let mut y = 4; while y < h - 4 { let mut x = 4; while x < w - 4 { coarse.push(lf(x, y)); x += 24; } y += 24; }
    if coarse.is_empty() { return Err("measureCoreContrast: image too small".into()); }
    sort_f64(&mut coarse);
    let mut peak = coarse[((coarse.len() as f64 * 0.999).floor() as usize).min(coarse.len() - 1)];
    if peak <= bg { peak = coarse[coarse.len() - 1]; }
    let core_thr = bg + 0.60 * (peak - bg); let shell_lo = bg + 0.15 * (peak - bg);
    let step: isize = 3;
    let rows: Vec<isize> = { let mut r = Vec::new(); let mut y = step; while y < h - step { r.push(y); y += step; } r };
    // serial scan (same f64 summation order as the PJSR loop)
    let mut a = [0f64; 10]; // cE cL cN sE sL sN cSat cWhite cStruct cSmooth
    for &y in &rows {
        let mut x = step;
        while x < w - step {
            let l = lf(x, y);
            if l >= shell_lo {
                let lr = lf(x + step, y); let ld = lf(x, y + step);
                let grad = (l - lr).abs() + (l - ld).abs();
                if l >= core_thr {
                    a[0] += grad; a[1] += l; a[2] += 1.0;
                    if grad > 0.012 { a[8] += 1.0; }
                    if grad < 0.004 && l > 0.55 { a[9] += 1.0; }
                    if col {
                        let i = y as usize * img.w + x as usize;
                        let (rr, gg, bb) = (img.ch[0][i] as f64, img.ch[1][i] as f64, img.ch[2][i] as f64);
                        let mx = rr.max(gg).max(bb); let mn = rr.min(gg).min(bb);
                        let sat = if mx > 0.0001 { (mx - mn) / mx } else { 0.0 };
                        a[6] += sat; if sat < 0.08 && mx > 0.85 { a[7] += 1.0; }
                    }
                } else { a[3] += grad; a[4] += l; a[5] += 1.0; }
            }
            x += step;
        }
    }
    let s = a;
    let (c_e, c_l, c_n, s_e, s_l, s_n, c_sat, c_white, c_struct, c_smooth) = (s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9]);
    let core_mean_grad = if c_n > 0.0 { c_e / c_n } else { 0.0 }; let core_mean_lum = if c_n > 0.0 { c_l / c_n } else { 0.0 };
    let shell_mean_grad = if s_n > 0.0 { s_e / s_n } else { 0.0 }; let shell_mean_lum = if s_n > 0.0 { s_l / s_n } else { 0.0 };
    let core_rel = if core_mean_lum > 0.001 { core_mean_grad / core_mean_lum } else { 0.0 };
    let shell_rel = if shell_mean_lum > 0.001 { shell_mean_grad / shell_mean_lum } else { 0.0 };
    let (wf, hf, sf) = (w as f64, h as f64, step as f64);
    let total_sampled = (((wf - 2.0 * sf) / sf) * ((hf - 2.0 * sf) / sf)).floor();
    let ratio_raw = if shell_rel > 0.0001 { core_rel / shell_rel } else { 0.0 };
    let core_sat_raw = if col && c_n > 0.0 { c_sat / c_n } else { -1.0 };
    let white_raw = if col && c_n > 0.0 { c_white / c_n } else { 0.0 };
    let struct_raw = if c_n > 0.0 { c_struct / c_n } else { 0.0 };
    let halo_raw = if c_n > 0.0 { c_smooth / c_n } else { 0.0 };
    let core_fraction = if total_sampled > 0.0 { c_n / total_sampled } else { 0.0 };
    let raw = json!({ "coreRelContrast": core_rel, "shellRelContrast": shell_rel, "ratio": ratio_raw, "coreLum": core_mean_lum,
        "shellLum": shell_mean_lum, "coreSat": core_sat_raw, "coreWhiteFraction": white_raw, "coreStructFrac": struct_raw,
        "haloFrac": halo_raw, "corePixels": jv(c_n), "coreFraction": core_fraction, "peak": peak, "bg": bg });

    // ---- JS wrapper (thresholds + messages), verbatim logic
    let cb = p.get("coreBurnCfg").cloned().unwrap_or(Value::Null);
    let cbn = |k: &str| num(cb.get(k));
    let hard = cbn("rel_contrast_hard").unwrap_or(0.22);
    let (goal, ratio_hard) = (0.30, 0.55);
    let white_hard = cbn("white_hard").unwrap_or(0.15);
    let sat_low = 0.10;
    let cr = core_rel; let ratio = ratio_raw; let core_white = white_raw; let core_sat = core_sat_raw;
    let classification = p.get("classification").and_then(|c| c.as_str()).unwrap_or("").to_lowercase();
    let sat_gate = ["emission", "planetary", "pne", "hii"].iter().any(|k| classification.contains(k));
    let white_burnt = core_white > white_hard;
    let desat_burnt = sat_gate && core_sat >= 0.0 && core_sat < sat_low;
    let (core_struct, halo) = (struct_raw, halo_raw);
    let min_struct = cbn("min_struct_frac"); let max_halo = cbn("max_halo_frac");
    let struct_burnt = min_struct.map_or(false, |m| core_struct < m);
    let halo_burnt = max_halo.map_or(false, |m| halo > m);
    let struct_ok = min_struct.unwrap_or(0.80); let halo_ok = max_halo.unwrap_or(0.03);
    let structured = core_struct >= struct_ok && halo <= halo_ok && !white_burnt;
    let rel_blocking_off = cb.get("rel_contrast_blocking") == Some(&Value::Bool(false));
    let rel_blocking = cr < hard && !structured && !rel_blocking_off;
    let rel_advisory = cr < hard && (structured || rel_blocking_off);
    let pass = !rel_blocking && !white_burnt && !desat_burnt && !struct_burnt && !halo_burnt;
    let mut msgs: Vec<String> = Vec::new();
    if struct_burnt {
        msgs.push(format!("*** FAILS CORE GATE (FLAT CENTER) *** Only {}% of the bright core has real structure (min {}%) — the blue center is a flat/washed blob even if relContrast passes (relContrast averages a structured halo). Recover internal structure in the CENTER (masked LHE/HDRMT into the core, or graft a structured-core champion); do not just brighten it.", fixed(core_struct * 100.0, 0), jsnum(min_struct.unwrap() * 100.0)));
    }
    if halo_burnt {
        msgs.push(format!("*** FAILS CORE GATE (HALO) *** {}% of the core is a smooth bright zone (limit {}%) — a halo/blown ring around the center. Compress the bright pedestal (continuous_clamp) or protect the core from over-injection; the dust-fill must not bleed a bright ring around the nebula.", fixed(halo * 100.0, 1), jsnum(max_halo.unwrap() * 100.0)));
    }
    if white_burnt {
        msgs.push(format!("*** FAILS CORE GATE (WHITE BURN) *** {}% of the bright core is white-clipped + desaturated (limit {}%). The center reads as a blown white patch even if gradient energy passes. Compress the core pedestal (continuous_clamp) and recover color/structure so the center is not white.", fixed(core_white * 100.0, 1), jsnum(white_hard * 100.0)));
    } else if desat_burnt {
        msgs.push(format!("*** FAILS CORE GATE (DESATURATED) *** Core saturation collapsed to {} (min {}) — a colored object's bright core should keep hue, not go grey/white. Restore core color (often a sign of SCNR/clamp over-processing or missing color calibration).", fixed(core_sat, 3), jsnum(sat_low)));
    }
    if rel_advisory {
        msgs.push(format!("relC advisory: structured core (struct {}%, halo {}%) — relContrast={} is below {} but the core has real structure, so this is a warning, not a failure.", fixed(core_struct * 100.0, 0), fixed(halo * 100.0, 1), fixed(cr, 3), jsnum(hard)));
    } else if cr < hard {
        msgs.push(format!("*** FAILS CORE-CONTRAST GATE *** Bright core is FLAT/perceptually burnt: relContrast={} (hard gate {}, goal {}). Core mean lum={} but structure is washed out vs brightness. Recover local contrast (HDRMT/LHE into the center; compress the bright pedestal).", fixed(cr, 3), jsnum(hard), jsnum(goal), fixed(core_mean_lum, 3)));
    } else if cr < goal {
        msgs.push(format!("Core contrast moderate: relContrast={} (passes {}, goal {}).", fixed(cr, 3), jsnum(hard), jsnum(goal)));
    } else if pass {
        msgs.push(format!("Core GOOD: relContrast={}, whiteFraction={}%{}.", fixed(cr, 3), fixed(core_white * 100.0, 1), if core_sat >= 0.0 { format!(", sat={}", fixed(core_sat, 3)) } else { String::new() }));
    }
    if ratio < ratio_hard {
        msgs.push(format!("(Diagnostic) core flatter than shell: ratio={} (core {} vs shell {}).", fixed(ratio, 2), fixed(cr, 3), fixed(shell_rel, 3)));
    }
    Ok(json!({ "coreRelContrast": cr, "shellRelContrast": shell_rel, "ratio": ratio, "coreLum": core_mean_lum, "coreSat": core_sat,
        "coreWhiteFraction": core_white, "coreStructFrac": core_struct, "haloFrac": halo, "coreFraction": core_fraction,
        "peak": peak, "bg": bg, "pass": pass, "relAdvisory": rel_advisory, "structuredCore": structured, "details": msgs.join(" "), "raw": raw }))
}

// ---------------------------------------------------------------- burn

const BURN_CLIP: f64 = 0.95; // agents/llm/gate-contract.mjs
const BRIGHT_BLOCK_LEVEL: f64 = 0.80;

/// assessBurn(ctx, viewId, opts) — params { opts?: { clip=0.95, bright=0.80, blockSize=50, blockBurntPct=3 } }
fn assess_burn(img: &Image, o: &Value) -> Value {
    let clip = opt_f64(o, "clip", BURN_CLIP); let bright = opt_f64(o, "bright", BRIGHT_BLOCK_LEVEL);
    let bs = opt_f64(o, "blockSize", 50.0) as usize; let frac = opt_f64(o, "blockBurntPct", 3.0) / 100.0;
    let (w, h, col) = (img.w, img.h, img.is_color());
    let bys: Vec<usize> = if h > bs { (0..h - bs).step_by(bs.max(1)).collect() } else { vec![] };
    // per block: (bx, by, nClip, nBright, nWhite, n, chN[3])
    let rows: Vec<Vec<(usize, usize, usize, usize, usize, usize, [usize; 3])>> = bys.par_iter().map(|&by| {
        let mut out = Vec::new();
        if w <= bs { return out; }
        for bx in (0..w - bs).step_by(bs.max(1)) {
            let (mut nc, mut nb, mut nw, mut n, mut chn) = (0, 0, 0, 0, [0usize; 3]);
            for y in (by..by + bs).step_by(3) { for x in (bx..bx + bs).step_by(3) {
                n += 1; let i = y * w + x;
                let m = if col {
                    let (r0, g0, b0) = (img.ch[0][i] as f64, img.ch[1][i] as f64, img.ch[2][i] as f64);
                    let lum = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
                    if r0 > clip { chn[0] += 1; } if g0 > clip { chn[1] += 1; } if b0 > clip { chn[2] += 1; }
                    if r0.min(g0).min(b0) > 0.90 { nw += 1; }
                    lum.max(r0).max(g0).max(b0)
                } else { img.ch[0][i] as f64 };
                if m > clip { nc += 1; } if m > bright { nb += 1; }
            } }
            out.push((bx, by, nc, nb, nw, n, chn));
        }
        out
    }).collect();
    let (mut total, mut clip_b, mut bright_b, mut ch_total, mut white_n, mut bright_s) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    let mut chn = [0usize; 3]; let mut worst: Vec<(usize, usize, f64)> = Vec::new();
    for row in &rows { for &(bx, by, nc, nb, nw, n, c) in row {
        total += 1; for k in 0..3 { chn[k] += c[k]; } ch_total += n;
        if n > 0 && nc as f64 / n as f64 > frac { clip_b += 1; worst.push((bx, by, nc as f64 / n as f64)); }
        if n > 0 && nb as f64 / n as f64 > frac { bright_b += 1; white_n += nw; bright_s += n; }
    } }
    worst.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)); // stable, like V8
    let wl: Vec<Value> = worst.iter().take(10).map(|&(x, y, f)| json!({ "x": x, "y": y, "pctBurnt": jv(js_round(f * 100.0)) })).collect();
    let pc = |k: usize| if ch_total > 0 { chn[k] as f64 / ch_total as f64 } else { 0.0 };
    json!({ "totalBlocks": total, "blockSize": bs, "clip": clip, "bright": bright, "clipBlocks": clip_b, "brightBlocks": bright_b,
        "brightFraction": if total > 0 { bright_b as f64 / total as f64 } else { 0.0 }, "worstClipBlocks": wl,
        "perChannelExceedance": { "R": pc(0), "G": pc(1), "B": pc(2) },
        "coreWhiteFraction": if bright_s > 0 { white_n as f64 / bright_s as f64 } else { 0.0 } })
}

/// scanBurntRegions(ctx, viewId, opts) — params { opts?: { clip | threshold, bright, blockSize, blockBurntPct } }
fn scan_burnt_regions(img: &Image, o: &Value) -> Value {
    let mut o2 = if o.is_object() { o.clone() } else { json!({}) };
    if o2.get("clip").map_or(true, |v| v.is_null()) {
        if let Some(t) = o.get("threshold").filter(|v| !v.is_null()) { o2["clip"] = t.clone(); }
    }
    let a = assess_burn(img, &o2);
    let clip_blocks = a["clipBlocks"].as_u64().unwrap_or(0); let pass = clip_blocks == 0;
    let pct = opt_f64(o, "blockBurntPct", 3.0);
    let (bs, clip, bright, total) = (a["blockSize"].as_u64().unwrap_or(0), a["clip"].as_f64().unwrap_or(0.0), a["bright"].as_f64().unwrap_or(0.0), a["totalBlocks"].as_u64().unwrap_or(0));
    let mut d = Vec::new();
    if !pass {
        d.push(format!("BURNT REGIONS: {} block(s) of {}×{}px have >{}% pixels above {}. ZERO burnt blocks allowed.", clip_blocks, bs, bs, jsnum(pct), jsnum(clip)));
        let wl = a["worstClipBlocks"].as_array().cloned().unwrap_or_default();
        if !wl.is_empty() { d.push(format!("Locations: {}", wl.iter().map(|b| format!("[{},{}] {}%", b["x"], b["y"], jsnum(b["pctBurnt"].as_f64().unwrap_or(0.0)))).collect::<Vec<_>>().join(", "))); }
        d.push("Apply min($T, 0.80) through core mask, or reduce stretch/LHE/curves strength.".into());
    } else {
        d.push(format!("Clean: 0/{} blocks burnt ({}×{}px, threshold {})", total, bs, bs, jsnum(clip)));
    }
    d.push(format!("Bright blocks (>{}): {}/{} ({}%)", jsnum(bright), a["brightBlocks"], total, fixed(a["brightFraction"].as_f64().unwrap_or(0.0) * 100.0, 1)));
    json!({ "pass": pass, "burntBlockCount": clip_blocks, "totalBlocks": total, "worstBlocks": a["worstClipBlocks"], "brightBlocks": a["brightBlocks"],
        "brightFraction": a["brightFraction"], "perChannelExceedance": a["perChannelExceedance"], "coreWhiteFraction": a["coreWhiteFraction"], "details": d.join(" ") })
}

// ---------------------------------------------------------------- shell texture / highlight texture

/// measureShellTexture(ctx, vid, opts) — params { opts?: { roi?: { cx, cy, radius } } }
/// -> { shellLocalStdDev, shellTonalSpan, shellGradientEnergy, shellPixelCount, blockCount, shellZone{low,high}, roi{cx,cy,radius}, bgMedian }
///    or { error:'too_few_subject_pixels', count, roiCx, roiCy, roiR }
fn shell_texture(img: &Image, o: &Value) -> Value {
    let (wu, hu) = (img.w, img.h); let (w, h) = (wu as f64, hu as f64);
    // fractional coordinates are truncated like img.sample(x, y) does
    let gl = |x: f64, y: f64| lum_d(img, x as usize, y as usize);
    let bg = median_all(img);
    let mut diffs = Vec::new();
    for y in (0..hu).step_by(32) { for x in (0..wu).step_by(32) { diffs.push((lum_d(img, x, y) - bg).abs()); } }
    sort_f64(&mut diffs);
    let mad = diffs[(diffs.len() as f64 / 2.0).floor() as usize];
    let thr = bg + 5.0 * mad;
    let roi = o.get("roi");
    let mut rcx = roi.and_then(|r| num(r.get("cx"))).unwrap_or(-1.0);
    let mut rcy = roi.and_then(|r| num(r.get("cy"))).unwrap_or(-1.0);
    let mut rr = roi.and_then(|r| num(r.get("radius"))).unwrap_or(-1.0);
    if rcx < 0.0 {
        let (step, pd) = (8usize, 3usize);
        let (mut swx, mut swy, mut sw) = (0f64, 0f64, 0f64); let mut coords: Vec<(usize, usize)> = Vec::new();
        let mut y = step; while y + step < hu { let mut x = step; while x + step < wu {
            let l = lum_d(img, x, y);
            if l > thr {
                let mut bn = 0;
                if x >= pd && lum_d(img, x - pd, y) > thr { bn += 1; }
                if x + pd < wu && lum_d(img, x + pd, y) > thr { bn += 1; }
                if y >= pd && lum_d(img, x, y - pd) > thr { bn += 1; }
                if y + pd < hu && lum_d(img, x, y + pd) > thr { bn += 1; }
                if bn >= 2 { swx += x as f64 * l; swy += y as f64 * l; sw += l; coords.push((x, y)); }
            }
            x += step; } y += step; }
        rcx = if sw > 0.0 { js_round(swx / sw) } else { js_round(w / 2.0) };
        rcy = if sw > 0.0 { js_round(swy / sw) } else { js_round(h / 2.0) };
        let mut dists: Vec<f64> = coords.iter().map(|&(x, y)| { let (dx, dy) = (x as f64 - rcx, y as f64 - rcy); (dx * dx + dy * dy).sqrt() }).collect();
        sort_f64(&mut dists);
        rr = if !dists.is_empty() { dists[(dists.len() as f64 * 0.90).floor() as usize] } else { w.min(h) / 4.0 };
        rr = f64::max(50.0, rr.min(w.min(h) * 0.45));
        rr = js_round(rr);
    }
    let mut subj = Vec::new();
    let mut y = f64::max(0.0, rcy - rr); while y < h.min(rcy + rr) { let mut x = f64::max(0.0, rcx - rr); while x < w.min(rcx + rr) {
        let (dx, dy) = (x - rcx, y - rcy);
        if dx * dx + dy * dy <= rr * rr { let l = gl(x, y); if l > thr { subj.push(l); } }
        x += 4.0; } y += 4.0; }
    sort_f64(&mut subj);
    if subj.len() < 100 { return json!({ "error": "too_few_subject_pixels", "count": subj.len(), "roiCx": jv(rcx), "roiCy": jv(rcy), "roiR": jv(rr) }); }
    let ns = subj.len() as f64;
    let lo = subj[(ns * 0.20).floor() as usize]; let hi = subj[(ns * 0.92).floor() as usize];
    let bsz = 16.0;
    let mut bstd = Vec::new();
    let mut by = f64::max(0.0, rcy - rr); while by < (h - bsz).min(rcy + rr) { let mut bx = f64::max(0.0, rcx - rr); while bx < (w - bsz).min(rcx + rr) {
        let (ddx, ddy) = (bx + bsz / 2.0 - rcx, by + bsz / 2.0 - rcy);
        if ddx * ddx + ddy * ddy <= rr * rr {
            let mut vals = Vec::with_capacity(64); let mut sc = 0usize;
            let mut py = by; while py < by + bsz { let mut px = bx; while px < bx + bsz {
                if !(px >= w || py >= h) { let l = gl(px, py); vals.push(l); if l >= lo && l <= hi { sc += 1; } }
                px += 2.0; } py += 2.0; }
            if !((sc as f64) < vals.len() as f64 * 0.40) {
                let (mut s1, mut s2) = (0f64, 0f64); for &v in &vals { s1 += v; s2 += v * v; }
                let m = s1 / vals.len() as f64; let var = s2 / vals.len() as f64 - m * m;
                if var > 0.0 { bstd.push(var.sqrt()); }
            }
        }
        bx += bsz; } by += bsz; }
    sort_f64(&mut bstd);
    let local_std = if bstd.is_empty() { 0.0 } else { bstd[(bstd.len() as f64 / 2.0).floor() as usize] };
    let shell: Vec<f64> = subj.iter().copied().filter(|&v| v >= lo && v <= hi).collect(); // already sorted
    let span = if shell.len() > 10 { let n = shell.len() as f64; shell[(n * 0.90).floor() as usize] - shell[(n * 0.10).floor() as usize] } else { 0.0 };
    let (mut ge, mut gc) = (0f64, 0usize);
    let mut y = f64::max(1.0, rcy - rr); while y < (h - 1.0).min(rcy + rr) { let mut x = f64::max(1.0, rcx - rr); while x < (w - 1.0).min(rcx + rr) {
        let (dx, dy) = (x - rcx, y - rcy);
        if dx * dx + dy * dy <= rr * rr {
            let cl = gl(x, y);
            if !(cl < lo || cl > hi) {
                let (tl, tc, tr) = (gl(x - 1.0, y - 1.0), gl(x, y - 1.0), gl(x + 1.0, y - 1.0));
                let (ml, mr) = (gl(x - 1.0, y), gl(x + 1.0, y));
                let (bl, bc, br) = (gl(x - 1.0, y + 1.0), gl(x, y + 1.0), gl(x + 1.0, y + 1.0));
                let gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
                let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
                ge += gx * gx + gy * gy; gc += 1;
            }
        }
        x += 4.0; } y += 4.0; }
    json!({ "shellLocalStdDev": local_std, "shellTonalSpan": span, "shellGradientEnergy": if gc > 0 { ge / gc as f64 } else { 0.0 },
        "shellPixelCount": shell.len(), "blockCount": bstd.len(), "shellZone": { "low": lo, "high": hi },
        "roi": { "cx": jv(rcx), "cy": jv(rcy), "radius": jv(rr) }, "bgMedian": bg })
}

fn load_any(path: &str) -> Result<Image, String> {
    if path.to_lowercase().ends_with(".png") { crate::util::read_png(path) } else { crate::xisf::read(path, 0).map(|(i, _)| i) }
}

/// checkHighlightTexture(ctx, viewId, opts) — params { opts?: { roi, referenceMetrics, currentMetrics, minRetention, warnRetention },
/// reference_path?: file standing in for opts.referenceId }. Returns the full JS wrapper object.
fn highlight_texture(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let o = p.get("opts").cloned().unwrap_or(json!({}));
    let current = match o.get("currentMetrics").filter(|v| v.is_object()) { Some(c) => c.clone(), None => shell_texture(ctx.img, &o) };
    if let Some(err) = current.get("error").filter(|e| !e.is_null()) {
        let too_few = err.as_str() == Some("too_few_subject_pixels");
        let details = if too_few { format!("Too few subject pixels ({}) in ROI for texture measurement — advisory only", current.get("count").map(|c| c.to_string()).unwrap_or("undefined".into())) }
            else { format!("Measurement error: {}", err.as_str().map(|s| s.to_string()).unwrap_or(err.to_string())) };
        return Ok(json!({ "pass": true, "verdict": "unmeasurable", "details": details, "current": null, "reference": null, "roi": current }));
    }
    let roi = current.get("roi").cloned().unwrap_or(Value::Null);
    let mut reference: Option<Value> = None;
    if let Some(r) = o.get("referenceMetrics").filter(|r| r.is_object() && r.get("error").map_or(true, |e| e.is_null())) { reference = Some(r.clone()); }
    else if let Some(path) = p.get("reference_path").and_then(|v| v.as_str()) {
        let rimg = load_any(path)?; let r = shell_texture(&rimg, &o);
        if r.get("error").map_or(true, |e| e.is_null()) { reference = Some(r); }
    }
    let g = |v: &Value, k: &str| num(v.get(k)).unwrap_or(0.0);
    let (cur_std, cur_span, cur_grad) = (g(&current, "shellLocalStdDev"), g(&current, "shellTonalSpan"), g(&current, "shellGradientEnergy"));
    let (mut rt, mut rs, mut rg): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    if let Some(r) = &reference {
        let (a, b, c) = (g(r, "shellLocalStdDev"), g(r, "shellTonalSpan"), g(r, "shellGradientEnergy"));
        rt = Some(if a > 0.0001 { cur_std / a } else { 1.0 });
        rs = Some(if b > 0.001 { cur_span / b } else { 1.0 });
        rg = Some(if c > 0.0001 { cur_grad / c } else { 1.0 });
    }
    let (pass, verdict); let mut d: Vec<String> = Vec::new();
    if reference.is_some() {
        let worst = rt.unwrap_or(1.0).min(rs.unwrap_or(1.0));
        let min_ret = opt_f64(&o, "minRetention", 0.40); let warn_ret = opt_f64(&o, "warnRetention", 0.60);
        if worst < min_ret {
            pass = false; verdict = "collapsed";
            d.push(format!("HIGHLIGHT TEXTURE COLLAPSED: worst retention={}% (limit: {}%). texture={}%, span={}%, gradient={}%. Restore pre-operation checkpoint and use less destructive processing.",
                fixed(worst * 100.0, 0), fixed(min_ret * 100.0, 0), fixed(rt.unwrap() * 100.0, 0), fixed(rs.unwrap() * 100.0, 0), fixed(rg.unwrap_or(1.0) * 100.0, 0)));
        } else if worst < warn_ret {
            pass = true; verdict = "degraded";
            d.push(format!("Highlight texture degraded: retention={}% (warning at {}%). Consider gentler processing.", fixed(worst * 100.0, 0), fixed(warn_ret * 100.0, 0)));
        } else {
            pass = true; verdict = "preserved";
            d.push(format!("Highlight texture preserved: retention={}%.", fixed(worst * 100.0, 0)));
        }
    } else {
        pass = true; verdict = if cur_std < 0.010 { "low_advisory" } else { "ok_advisory" };
        d.push(format!("Highlight texture (advisory, no reference): localStdDev={} (heuristic floor: 0.010), tonalSpan={} (heuristic floor: 0.05).", fixed(cur_std, 4), fixed(cur_span, 3)));
        if cur_std < 0.010 { d.push("Advisory: localStdDev is very low — bright shell may lack visible texture. Provide a reference_id for blocking assessment.".into()); }
    }
    let sz = current.get("shellZone").cloned().unwrap_or(json!({}));
    d.push(format!("Shell zone [{}–{}], {} pixels, {} blocks measured.", fixed(g(&sz, "low"), 3), fixed(g(&sz, "high"), 3),
        current.get("shellPixelCount").map(|v| v.to_string()).unwrap_or("undefined".into()), current.get("blockCount").map(|v| v.to_string()).unwrap_or("undefined".into())));
    let pick = |v: &Value| json!({ "shellLocalStdDev": v.get("shellLocalStdDev"), "shellTonalSpan": v.get("shellTonalSpan"), "shellGradientEnergy": v.get("shellGradientEnergy") });
    Ok(json!({ "pass": pass, "verdict": verdict, "mode": if reference.is_some() { "relative" } else { "advisory" },
        "textureRetention": rt, "spanRetention": rs, "gradientRetention": rg, "current": pick(&current),
        "reference": reference.as_ref().map(pick), "roi": roi, "shellZone": current.get("shellZone"), "details": d.join(" ") }))
}

// ---------------------------------------------------------------- ringing

/// checkRinging(ctx, viewId) — no params. -> { pass, oscillations, maxAmplitude, center, details, profileSample }
fn ringing(img: &Image) -> Value {
    let (w, h, col) = (img.w, img.h, img.is_color());
    let bsz = 64usize;
    let mut best = 0f64; let (mut bxc, mut byc) = (0usize, 0usize);
    let mean = |c: usize, bx: usize, by: usize| { let mut s = 0f64; for y in by..by + bsz { for x in bx..bx + bsz { s += img.ch[c][y * w + x] as f64; } } s / (bsz * bsz) as f64 };
    if h > bsz && w > bsz {
        let bys: Vec<usize> = (0..h - bsz).step_by(bsz).collect();
        let means: Vec<Vec<(usize, f64)>> = bys.par_iter().map(|&by| (0..w - bsz).step_by(bsz).map(|bx| {
            let m = if col { 0.2126 * mean(0, bx, by) + 0.7152 * mean(1, bx, by) + 0.0722 * mean(2, bx, by) } else { mean(0, bx, by) };
            (bx, m) }).collect()).collect();
        for (k, row) in means.iter().enumerate() { for &(bx, m) in row { if m > best { best = m; bxc = bx + bsz / 2; byc = bys[k] + bsz / 2; } } }
    }
    let (bx, by) = (bxc as f64, byc as f64);
    let max_r = 150f64.min(bx.min(w as f64 - bx - 1.0).min(by.min(h as f64 - by - 1.0))).max(0.0) as usize;
    let mut prof = Vec::new();
    for ri in 1..=max_r {
        let (mut sum, mut cnt) = (0f64, 0usize);
        for ai in 0..36 {
            let ang = ai as f64 * 2.0 * std::f64::consts::PI / 36.0;
            let px = js_round(bx + ri as f64 * ang.cos()); let py = js_round(by + ri as f64 * ang.sin());
            if px >= 0.0 && px < w as f64 && py >= 0.0 && py < h as f64 {
                let i = py as usize * w + px as usize;
                if col { let mut l = 0f64; l += img.ch[0][i] as f64 * 0.2126; l += img.ch[1][i] as f64 * 0.7152; l += img.ch[2][i] as f64 * 0.0722; sum += l; }
                else { sum += img.ch[0][i] as f64; }
                cnt += 1;
            }
        }
        prof.push(if cnt > 0 { sum / cnt as f64 } else { 0.0 });
    }
    let der: Vec<f64> = (1..prof.len()).map(|i| prof[i] - prof[i - 1]).collect();
    let (mut osc, mut max_amp, mut last, mut run_start) = (0usize, 0f64, 0i32, 0usize);
    for i in 0..der.len() {
        let s = if der[i] > 0.001 { 1 } else if der[i] < -0.001 { -1 } else { 0 };
        if s != 0 && last != 0 && s != last {
            let mut amp = 0f64; for j in run_start..=i { amp += der[j].abs(); }
            if amp > 0.01 { osc += 1; if amp > max_amp { max_amp = amp; } }
            run_start = i;
        }
        if s != 0 { last = s; }
    }
    let pass = osc == 0;
    let details = if !pass { format!("RINGING DETECTED: {} oscillation(s) (limit: 0) around brightest region at [{},{}], max amplitude={}", osc, bxc, byc, fixed(max_amp, 4)) }
        else { format!("No ringing: {} oscillations around [{},{}]", osc, bxc, byc) };
    json!({ "pass": pass, "oscillations": osc, "maxAmplitude": max_amp, "center": [bxc, byc], "details": details,
        "profileSample": prof.iter().take(30).copied().collect::<Vec<f64>>() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blur_grid_matches_full_gaussian() {
        let (w, h) = (97usize, 61usize);
        let src: Vec<f32> = (0..w * h).map(|i| ((i * 7919 % 1013) as f32) / 1013.0).collect();
        for &s in &[0.8f64, 3.3, 12.0, 40.0] {
            let full = blur::gaussian(&src, w, h, s as f32);
            let xs: Vec<usize> = (0..w).step_by(3).collect(); let ys: Vec<usize> = (5..h).step_by(4).collect();
            let g = blur_grid(&src, w, h, s, &xs, &ys);
            for (yi, &y) in ys.iter().enumerate() { for (xi, &x) in xs.iter().enumerate() {
                assert_eq!(g[yi * xs.len() + xi].to_bits(), full[y * w + x].to_bits(), "sigma {s} at {x},{y}");
            } }
        }
    }
}
