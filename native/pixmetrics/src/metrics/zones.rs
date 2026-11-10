//! Zone / radial-geometry metrics. Ports of agents/ops/subject-metrics.mjs:
//! measureRadialZones, measureSignalInventory (+ summarizeInventory / inventoryZones / zoneIndices),
//! measureInventoryZones, measureZoneStructure, measureEnvelopeSectors, measureSectorProfiles,
//! measureArmGapDepth, measureOuterArms, measureFaintDisc (+ summarizeFaintDisc / galaxyBlockMask / lumGrid).
//! The PJSR code strings are the reference: same strides, thresholds, sort-and-index quantiles.
use super::Ctx;
use crate::{blur, image::Image};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::rc::Rc;

pub const NAMES: &[&str] = &[
    "radial_zones", "signal_inventory", "inventory_zones", "zone_structure", "envelope_sectors",
    "sector_profiles", "arm_gap_depth", "outer_arms", "faint_disc",
];
pub fn dispatch(name: &str, ctx: &Ctx, p: &Value) -> Option<Result<Value, String>> {
    Some(match name {
        "radial_zones" => radial_zones(ctx, p),
        "signal_inventory" => signal_inventory(ctx, p),
        "inventory_zones" => inventory_zones(ctx, p),
        "zone_structure" => zone_structure(ctx, p),
        "envelope_sectors" => envelope_sectors(ctx, p),
        "sector_profiles" => sector_profiles(ctx, p),
        "arm_gap_depth" => arm_gap_depth(ctx, p),
        "outer_arms" => outer_arms(ctx, p),
        "faint_disc" => faint_disc(ctx, p),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

/// How the PJSR snippet builds the luminance Float32Array.
#[derive(Clone, Copy)]
enum LumKind {
    /// L[i] = 0.2126*R; L[i] += 0.7152*G; L[i] += 0.0722*B  (f32 store after every step)
    Seq,
    /// L[i] = 0.2126*R + 0.7152*G + 0.0722*B  (one double expression, one f32 store)
    Single,
}

fn pjsr_lum(img: &Image, kind: LumKind) -> Vec<f32> {
    if !img.is_color() { return img.ch[0].clone(); }
    let (r, g, b) = (&img.ch[0], &img.ch[1], &img.ch[2]);
    (0..img.w * img.h).into_par_iter().map(|i| match kind {
        LumKind::Seq => {
            let mut v = (0.2126f64 * r[i] as f64) as f32;
            v = (v as f64 + 0.7152f64 * g[i] as f64) as f32;
            (v as f64 + 0.0722f64 * b[i] as f64) as f32
        }
        LumKind::Single => (0.2126f64 * r[i] as f64 + 0.7152f64 * g[i] as f64 + 0.0722f64 * b[i] as f64) as f32,
    }).collect()
}

/// Full-frame luminance + cached Convolution blurs + the EMPTY_PJSR footprint mask.
struct Field { w: usize, h: usize, l: Vec<f32>, blurs: RefCell<HashMap<u64, Rc<Vec<f32>>>>, emp: RefCell<HashMap<u64, Option<Rc<Vec<f32>>>>> }
impl Field {
    fn new(img: &Image, kind: LumKind) -> Self { Field { w: img.w, h: img.h, l: pjsr_lum(img, kind), blurs: RefCell::new(HashMap::new()), emp: RefCell::new(HashMap::new()) } }
    fn blur(&self, sig: f64) -> Rc<Vec<f32>> {
        if let Some(b) = self.blurs.borrow().get(&sig.to_bits()) { return b.clone(); }
        let b = Rc::new(blur::gaussian(&self.l, self.w, self.h, sig as f32));
        self.blurs.borrow_mut().insert(sig.to_bits(), b.clone());
        b
    }
    /// EMPTY_PJSR(sig): blur of the (L <= 1e-6) indicator, only when the frame is partly empty.
    fn empty(&self, sig: f64) -> Empty {
        if let Some(e) = self.emp.borrow().get(&sig.to_bits()) { return Empty(e.clone()); }
        let n = self.w * self.h;
        let e: Vec<f32> = self.l.par_iter().map(|&v| if v <= 1e-6 { 1.0 } else { 0.0 }).collect();
        let ne = e.iter().filter(|&&v| v > 0.0).count();
        let r = if ne > 0 && ne < n { Some(Rc::new(blur::gaussian(&e, self.w, self.h, sig as f32))) } else { None };
        self.emp.borrow_mut().insert(sig.to_bits(), r.clone());
        Empty(r)
    }
}
struct Empty(Option<Rc<Vec<f32>>>);
impl Empty { #[inline] fn is(&self, j: usize) -> bool { match &self.0 { Some(e) => e[j] > 0.002, None => false } } }

fn sortf(a: &mut [f32]) { a.sort_unstable_by(|p, q| p.partial_cmp(q).unwrap()); }
fn sortd(a: &mut [f64]) { a.sort_unstable_by(|p, q| p.partial_cmp(q).unwrap()); }
/// PJSR q(a, p) = a[min(len-1, floor(len*p))] on a sorted array (None when empty = JS undefined).
fn q<T: Copy>(a: &[T], p: f64) -> Option<T> { if a.is_empty() { None } else { Some(a[((a.len() as f64 * p).floor() as usize).min(a.len() - 1)]) } }
fn f(v: f32) -> f64 { v as f64 }
fn num(v: f64) -> Value { if v.is_finite() { json!(v) } else { Value::Null } }   // JSON.stringify(NaN) = null
fn onum(v: Option<f64>) -> Value { v.map(num).unwrap_or(Value::Null) }
/// JS number literal for a value that is an integer in JS (prints 775, not 775.0).
fn jn(v: f64) -> Value { if v.is_finite() && v.fract() == 0.0 && v.abs() < 9e15 { json!(v as i64) } else { num(v) } }
fn js_round(x: f64) -> f64 { (x + 0.5).floor() }
/// Number.prototype.toFixed (ties round away from zero on the exact decimal value; Rust rounds ties to even).
fn to_fixed(x: f64, d: usize) -> String {
    if !x.is_finite() { return if x.is_nan() { "NaN".into() } else if x > 0.0 { "Infinity".into() } else { "-Infinity".into() }; }
    let long = format!("{:.*}", d + 60, x.abs());
    let dot = long.find('.').unwrap();
    let tail = &long[dot + 1 + d..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|c| c == b'0');
    let s = if tie { let t: f64 = long[..dot + 1 + d].parse().unwrap(); format!("{:.*}", d, t + 10f64.powi(-(d as i32))) } else { format!("{:.*}", d, x.abs()) };
    if x < 0.0 { format!("-{s}") } else { s }
}
fn opt_fixed(v: Option<f64>, d: usize) -> String { match v { Some(x) => to_fixed(x, d), None => "undefined".into() } }
fn fmt_num(v: f64) -> String { if v.fract() == 0.0 && v.abs() < 9e15 { format!("{}", v as i64) } else { format!("{v}") } }

fn inv_of(p: &Value) -> &Value { p.get("inv").unwrap_or(p) }
fn centre_of(v: &Value) -> Result<(f64, f64), String> {
    let c = v.get("centre").and_then(|c| c.as_array()).ok_or("params.inv.centre required")?;
    Ok((c.first().and_then(|x| x.as_f64()).unwrap_or(0.0), c.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0)))
}
fn rdet_of(v: &Value) -> Result<f64, String> { v.get("rDet").and_then(|x| x.as_f64()).ok_or_else(|| "params.inv.rDet required".into()) }
fn pair(v: Option<&Value>) -> Option<(f64, f64)> {
    let a = v?.as_array()?; Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}
fn zone_of(inv: &Value, k: &str) -> Result<(f64, f64), String> {
    pair(inv.get("zones").and_then(|z| z.get(k))).ok_or_else(|| format!("params.inv.zones.{k} required"))
}
/// option lookup: params.opts.k, else params.k
fn opt<'a>(p: &'a Value, k: &str) -> Option<&'a Value> { p.get("opts").and_then(|o| o.get(k)).or_else(|| p.get(k)) }

/// PixInsight Image.median() of a block (exact; mean of the two central values for even counts).
fn block_median(ch: &[f32], w: usize, x0: usize, y0: usize, b: usize, buf: &mut Vec<f32>) -> f64 {
    buf.clear();
    for y in y0..y0 + b { buf.extend_from_slice(&ch[y * w + x0..y * w + x0 + b]); }
    sortf(buf);
    let n = buf.len();
    if n & 1 == 1 { f(buf[n >> 1]) } else { (f(buf[n / 2 - 1]) + f(buf[n / 2])) / 2.0 }
}
/// Block-median luminance grid (lumGrid / the faint-disc / outer-arms grids), rounded to 1/scale.
fn lum_grid(img: &Image, b: usize, scale: f64) -> (usize, usize, Vec<f64>) {
    let (gw, gh) = (img.w / b, img.h / b);
    let g: Vec<f64> = (0..gh).into_par_iter().flat_map_iter(|by| {
        let mut buf = Vec::with_capacity(b * b);
        (0..gw).map(move |bx| {
            let v = if img.is_color() {
                let r0 = block_median(&img.ch[0], img.w, bx * b, by * b, b, &mut buf);
                let g0 = block_median(&img.ch[1], img.w, bx * b, by * b, b, &mut buf);
                let b0 = block_median(&img.ch[2], img.w, bx * b, by * b, b, &mut buf);
                0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0
            } else { block_median(&img.ch[0], img.w, bx * b, by * b, b, &mut buf) };
            js_round(v * scale) / scale
        }).collect::<Vec<_>>()
    }).collect();
    (gw, gh, g)
}

fn neighbours(p: usize, w: usize, h: usize) -> [Option<usize>; 4] {
    let (x, y) = (p % w, p / w);
    [if x > 0 { Some(p - 1) } else { None }, if x + 1 < w { Some(p + 1) } else { None }, if y > 0 { Some(p - w) } else { None }, if y + 1 < h { Some(p + w) } else { None }]
}
/// 4-connected labelling in scan order (labels 1..=count).
fn label(mask: &[bool], w: usize, h: usize) -> (Vec<i32>, i32) {
    let n = w * h; let mut lab = vec![0i32; n]; let mut next = 0; let mut st = Vec::new();
    for s in 0..n {
        if !mask[s] || lab[s] != 0 { continue; }
        next += 1; lab[s] = next; st.push(s);
        while let Some(p) = st.pop() { for q in neighbours(p, w, h).into_iter().flatten() { if mask[q] && lab[q] == 0 { lab[q] = next; st.push(q); } } }
    }
    (lab, next)
}

/// galaxyBlockMask(grid, w, h): largest 4-connected component of blocks 0.02 above the median block.
fn galaxy_block_mask(g: &[f64], w: usize, h: usize) -> (Vec<bool>, usize, Option<f64>) {
    let n = w * h;
    if n == 0 || g.len() < n { return (vec![false; n], 0, None); }
    let mut s = g[..n].to_vec(); sortd(&mut s); let sky = s[n / 2];
    let core: Vec<bool> = g[..n].iter().map(|&v| v - sky > 0.02).collect();
    let (lab, count) = label(&core, w, h);
    let mut sizes = vec![0usize; count as usize + 1]; for &l in &lab { sizes[l as usize] += 1; }
    let (mut best, mut best_n) = (0i32, 0usize);
    for k in 1..=count { if sizes[k as usize] > best_n { best_n = sizes[k as usize]; best = k; } }
    (lab.iter().map(|&l| best != 0 && l == best).collect(), best_n, Some(sky))
}

/// brightest block inside the component -> pixel centre (bx*B + B/2, by*B + B/2)
fn brightest_centre(bits: &[bool], g: &[f64], gw: usize, b: usize) -> (f64, f64) {
    let (mut bi, mut bv) = (0usize, f64::NEG_INFINITY);
    for i in 0..bits.len() { if bits[i] && g[i] > bv { bv = g[i]; bi = i; } }
    (((bi % gw) * b) as f64 + b as f64 / 2.0, ((bi / gw) * b) as f64 + b as f64 / 2.0)
}

// ---------------------------------------------------------------------------------------------------------------
// measureRadialZones

struct RzOpts { sigma: f64, with_noise: bool, sky_bits: Vec<u8>, grid_w: usize, b: usize }

fn radial_zones_on(fl: &Field, cx: f64, cy: f64, zones: &[(f64, f64)], o: &RzOpts) -> Value {
    let (w, h) = (fl.w, fl.h);
    let emp = fl.empty(3.0 * o.sigma);
    let g2 = fl.blur(2.0); let gs = fl.blur(o.sigma);
    let mut acc: Vec<Vec<f32>> = vec![Vec::new(); zones.len()];
    let r_max_z = zones.iter().fold(0.0f64, |m, z| if z.1 > m { z.1 } else { m });
    for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
        let (dx, dy) = (x as f64 - cx, y as f64 - cy); let r = (dx * dx + dy * dy).sqrt(); if r >= r_max_z { continue; }
        let i = y * w + x;
        if f(g2[i]) - f(gs[i]) > 0.02 || emp.is(i) { continue; }
        for (k, z) in zones.iter().enumerate() { if r >= z.0 && r < z.1 { acc[k].push(gs[i]); } }
    } }
    let zs: Vec<Value> = acc.into_par_iter().map(|mut a| {
        sortf(&mut a);
        if a.is_empty() { json!({ "n": 0 }) } else { json!({ "n": a.len(), "p10": f(q(&a, 0.1).unwrap()), "p50": f(q(&a, 0.5).unwrap()), "p90": f(q(&a, 0.9).unwrap()) }) }
    }).collect();
    let mut out = json!({ "zones": zs });
    if o.with_noise {
        let g40 = fl.blur(40.0);
        let mut hp: Vec<f64> = Vec::new();
        for y in (0..h).step_by(4) { for x in (0..w).step_by(4) {
            let (bx, by) = (x / o.b, y / o.b);
            if !o.sky_bits.is_empty() { let k = by * o.grid_w + bx; if k >= o.sky_bits.len() || o.sky_bits[k] != b'1' { continue; } }
            let i = y * w + x; if emp.is(i) { continue; } if f(g2[i]) - f(gs[i]) > 0.02 { continue; }
            hp.push(f(gs[i]) - f(g40[i]));
        } }
        sortd(&mut hp);
        let noise = match q(&hp, 0.5) {
            Some(md) => { let mut dev: Vec<f64> = hp.iter().map(|v| (v - md).abs()).collect(); sortd(&mut dev); 1.4826 * q(&dev, 0.5).unwrap() }
            None => f64::NAN,
        };
        out["noise"] = num(noise); out["noiseN"] = json!(hp.len());
    }
    out
}

fn zones_list(v: &Value) -> Result<Vec<(f64, f64)>, String> {
    v.as_array().ok_or("zones must be [[r0,r1],...]")?.iter().map(|z| pair(Some(z)).ok_or_else(|| "zone must be [r0,r1]".to_string())).collect()
}

/// measureRadialZones(ctx, viewId, centre, zones, { sigma = 8, withNoise = false, skyBits = null, gridW = 0, B = 24 })
/// params: { centre:[x,y], zones:[[r0,r1],...], opts?:{sigma, withNoise, skyBits, gridW, B} } (opts may also be top-level)
pub fn radial_zones(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let (cx, cy) = centre_of(p)?;
    let zones = zones_list(p.get("zones").ok_or("params.zones required")?)?;
    let o = RzOpts {
        sigma: opt(p, "sigma").and_then(|v| v.as_f64()).unwrap_or(8.0),
        with_noise: opt(p, "withNoise").and_then(|v| v.as_bool()).unwrap_or(false),
        sky_bits: opt(p, "skyBits").and_then(|v| v.as_str()).unwrap_or("").as_bytes().to_vec(),
        grid_w: opt(p, "gridW").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        b: opt(p, "B").and_then(|v| v.as_u64()).unwrap_or(24).max(1) as usize,
    };
    let fl = Field::new(ctx.img, LumKind::Seq);
    Ok(radial_zones_on(&fl, cx, cy, &zones, &o))
}

// ---------------------------------------------------------------------------------------------------------------
// pure helpers: summarizeInventory, inventoryZones, zoneIndices

struct Ann { r0: f64, r1: f64, n: usize, p10: f64, p50: f64, p90: f64 }

fn summarize_inventory(ann: &[Ann], sky: f64, noise: f64, sky_spread: Option<f64>) -> (f64, f64, Vec<Value>) {
    let min_snr = 3.0; let gaps_allowed = 1;
    let floor = match sky_spread { Some(s) if s.is_finite() => s, _ => 2.563 * noise };
    let prof: Vec<(f64, f64, f64, f64)> = ann.iter().map(|a| (a.r0, a.r1,
        if a.n > 0 { (a.p50 - sky) / noise } else { 0.0 }, if a.n > 0 { (a.p90 - a.p10 - floor) / noise } else { 0.0 })).collect();
    let (mut r_det, mut gaps) = (0.0, 0);
    for p in &prof {
        if p.3 >= min_snr { r_det = p.1; gaps = 0; }
        else if r_det > 0.0 { gaps += 1; if gaps > gaps_allowed { break; } }
    }
    let profile = prof.iter().map(|p| json!({ "r0": jn(p.0), "r1": jn(p.1),
        "level": jn(to_fixed(p.2, 1).parse::<f64>().unwrap_or(f64::NAN)), "structure": jn(to_fixed(p.3, 1).parse::<f64>().unwrap_or(f64::NAN)) })).collect();
    (r_det, floor, profile)
}

fn inventory_zones_geom(r_det: f64) -> [(f64, f64); 4] {
    [(0.0, js_round(0.08 * r_det).max(12.0)), (js_round(0.35 * r_det), js_round(0.55 * r_det)), (js_round(0.8 * r_det), r_det), (r_det + 150.0, r_det + 250.0)]
}

fn zstat(z: &Value) -> Option<(f64, f64, f64)> {
    if z.get("n").and_then(|v| v.as_u64()).unwrap_or(0) == 0 { return None; }
    Some((z["p10"].as_f64()?, z["p50"].as_f64()?, z["p90"].as_f64()?))
}
/// zoneIndices([core, disc, outer, sky])
fn zone_indices(z: &[Value]) -> Value {
    let g = |k: usize| z.get(k).and_then(zstat);
    let (core, disc, outer, sky) = (g(0), g(1), g(2), g(3));
    let (Some(sky), Some(core), Some(disc)) = (sky, core, disc) else { return json!({ "coreIdx": null, "outerNet": null }) };
    let s = sky.1; let sky_spread = sky.2 - sky.0;
    json!({
        "sky": s,
        "coreIdx": if disc.1 - s > 1e-6 { num((core.1 - s) / (disc.1 - s)) } else { Value::Null },
        "outerNet": outer.map(|o| num((o.2 - o.0) - sky_spread)).unwrap_or(Value::Null),
        "outerLevel": outer.map(|o| num(o.1 - s)).unwrap_or(Value::Null),
    })
}

fn zones_value(zz: &[(f64, f64); 4]) -> Value {
    let a = |z: (f64, f64)| json!([jn(z.0), jn(z.1)]);
    json!({ "core": a(zz[0]), "disc": a(zz[1]), "outer": a(zz[2]), "sky": a(zz[3]) })
}

// ---------------------------------------------------------------------------------------------------------------
// measureSignalInventory

/// measureSignalInventory(ctx, viewId): params { view?: string } (echoed as "view"). No preview JPEGs.
pub fn signal_inventory(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let img = ctx.img; let b = 24usize;
    let (gw, gh, g) = lum_grid(img, b, 1e6);
    let (big_w, big_h) = (img.w as f64, img.h as f64);
    let (bits, blocks, _) = galaxy_block_mask(&g, gw, gh);
    if blocks < 20 { return Ok(json!({ "error": "no subject component", "blocks": blocks })); }
    let (cx, cy) = brightest_centre(&bits, &g, gw, b);
    let mut sorted: Vec<f64> = g.iter().copied().filter(|&v| v > 1e-6).collect(); sortd(&mut sorted);
    let med = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let sky_bits: Vec<u8> = (0..g.len()).map(|i| if !bits[i] && g[i] > 1e-6 && g[i] <= med { b'1' } else { b'0' }).collect();
    let r_max = (cx.max(big_w - cx)).hypot(cy.max(big_h - cy)).floor();
    let step = 25.0; let mut ann: Vec<(f64, f64)> = Vec::new();
    let mut r = 0.0; while r + step <= r_max { ann.push((r, r + step)); r += step; }
    let fl = Field::new(img, LumKind::Seq);
    let z = radial_zones_on(&fl, cx, cy, &ann, &RzOpts { sigma: 8.0, with_noise: true, sky_bits, grid_w: gw, b });
    let zarr = z["zones"].as_array().cloned().unwrap_or_default();
    let outer_ann: Vec<Ann> = zarr.iter().enumerate().map(|(k, s)| {
        let st = zstat(s); Ann { r0: ann[k].0, r1: ann[k].1, n: s["n"].as_u64().unwrap_or(0) as usize,
            p10: st.map(|t| t.0).unwrap_or(f64::NAN), p50: st.map(|t| t.1).unwrap_or(f64::NAN), p90: st.map(|t| t.2).unwrap_or(f64::NAN) }
    }).collect();
    let lim = 0.85 * r_max.min(big_w.min(big_h) / 2.0 * 1.4);
    let sky_ann: Vec<&Ann> = outer_ann.iter().filter(|a| a.n > 1000 && a.r0 >= lim).collect();
    let sky = if !sky_ann.is_empty() { let mut v: Vec<f64> = sky_ann.iter().map(|a| a.p50).collect(); sortd(&mut v); v[v.len() / 2] } else { med };
    let zn = z.get("noise").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let noise = zn.max(1e-7);
    let mut spreads: Vec<f64> = sky_ann.iter().map(|a| a.p90 - a.p10).collect(); sortd(&mut spreads);
    let sky_spread = spreads.get(spreads.len() / 2).copied();
    let filtered: Vec<Ann> = outer_ann.into_iter().filter(|a| a.n > 200).collect();
    let (r_det, _floor, profile) = summarize_inventory(&filtered, sky, noise, sky_spread);
    let centre = json!([jn(cx), jn(cy)]);
    if r_det == 0.0 { return Ok(json!({ "error": "no detection", "centre": centre, "noise": noise, "sky": sky })); }
    let zz = inventory_zones_geom(r_det);
    let zr = radial_zones_on(&fl, cx, cy, &zz, &RzOpts { sigma: 8.0, with_noise: false, sky_bits: vec![], grid_w: 0, b: 24 });
    let idx = zone_indices(zr["zones"].as_array().map(|a| a.as_slice()).unwrap_or(&[]));
    let env = envelope_sectors_on(&fl, cx, cy, r_det);
    drop(fl);
    let zs = zone_structure_on(img, cx, cy, r_det, zz[3]);
    let core_idx = idx.get("coreIdx").and_then(|v| v.as_f64());
    let close = r_det + 250.0 > cx.min(cy).min(big_w - cx).min(big_h - cy);
    let text = format!("subject centre ({}, {}); arm-scale structure detected (>= 3 sigma above the sky texture) out to r = {} px{}; outer zone {}-{} px must stay VISIBLE in the final image; prep core/disc index {}.",
        fmt_num(cx), fmt_num(cy), fmt_num(r_det), if close { " (close to the frame edge)" } else { "" }, fmt_num(zz[2].0), fmt_num(zz[2].1), opt_fixed(core_idx, 2));
    Ok(json!({
        "view": p.get("view").cloned().unwrap_or(Value::Null),
        "frameW": img.w, "frameH": img.h, "centre": centre, "rDet": jn(r_det), "skySpread": onum(sky_spread),
        "prepCoreWeber": zs.get("coreWeber").cloned().unwrap_or(Value::Null), "prepEnvelope": env["excess"].clone(),
        "rFrameMax": jn(r_max), "sky": sky, "noise": noise, "zones": zones_value(&zz),
        "prepCoreIdx": idx.get("coreIdx").cloned().unwrap_or(Value::Null), "prepOuterNet": idx.get("outerNet").cloned().unwrap_or(Value::Null),
        "profile": profile, "text": text,
    }))
}

// ---------------------------------------------------------------------------------------------------------------
// measureInventoryZones

/// measureInventoryZones(ctx, viewId, inv): params { inv:{ centre, zones:{core,disc,outer,sky} } } -> zoneIndices
pub fn inventory_zones(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let inv = inv_of(p); let (cx, cy) = centre_of(inv)?;
    let zz = [zone_of(inv, "core")?, zone_of(inv, "disc")?, zone_of(inv, "outer")?, zone_of(inv, "sky")?];
    let fl = Field::new(ctx.img, LumKind::Seq);
    let zr = radial_zones_on(&fl, cx, cy, &zz, &RzOpts { sigma: 8.0, with_noise: false, sky_bits: vec![], grid_w: 0, b: 24 });
    Ok(zone_indices(zr["zones"].as_array().map(|a| a.as_slice()).unwrap_or(&[])))
}

// ---------------------------------------------------------------------------------------------------------------
// measureZoneStructure

fn zone_structure_on(img: &Image, cx: f64, cy: f64, r_det: f64, sky_z: (f64, f64)) -> Value {
    let fl = Field::new(img, LumKind::Single); let (w, h) = (fl.w, fl.h);
    let col = img.is_color();
    let emp = fl.empty(24.0);
    let (g1, g6, g8) = (fl.blur(1.0), fl.blur(6.0), fl.blur(8.0));
    let r_core = js_round(0.2 * r_det); let r0 = js_round(0.2 * r_det);
    let mut sk: Vec<f32> = Vec::new();
    for y in (0..h).step_by(4) { for x in (0..w).step_by(4) {
        let d = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt();
        if d >= sky_z.0 && d < sky_z.1 && !emp.is(y * w + x) { sk.push(g8[y * w + x]); }
    } }
    sortf(&mut sk); let sky = if sk.is_empty() { 0.0 } else { f(sk[sk.len() >> 1]) };
    let (mut s, mut s2, mut m, mut cn) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    let ylo = (cy - r_core).max(0.0); let yhi = (cy + r_core).min(h as f64);
    let xlo = (cx - r_core).max(0.0); let xhi = (cx + r_core).min(w as f64);
    let mut y = ylo;
    while y < yhi { let mut x = xlo;
        while x < xhi {
            if (x - cx) * (x - cx) + (y - cy) * (y - cy) < r_core * r_core {
                let i = y as usize * w + x as usize; let dd = f(g1[i]) - f(g6[i]); s += dd; s2 += dd * dd; m += f(g6[i]) - sky; cn += 1;
            }
            x += 1.0; }
        y += 1.0; }
    let mu = s / cn as f64; let core_weber = if cn == 0 { f64::NAN } else { (s2 / cn as f64 - mu * mu).max(0.0).sqrt() / (m / cn as f64).max(1e-4) };
    let mut out = json!({ "coreWeber": num(core_weber), "corePx": cn, "sky": sky });
    if col {
        let na = (r_det / 25.0).ceil().max(0.0) as usize;
        let mut ann: Vec<Vec<f32>> = vec![Vec::new(); na];
        let dist = |x: usize, y: usize| ((x as f64 - cx) * (x as f64 - cx) + (y as f64 - cy) * (y as f64 - cy)).sqrt();
        for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
            let r = dist(x, y); if r < r0 || r >= r_det || emp.is(y * w + x) { continue; }
            ann[(r / 25.0).floor() as usize].push(g8[y * w + x]);
        } }
        let (mut lo, mut hi) = (Vec::with_capacity(na), Vec::with_capacity(na));
        for a in ann.iter_mut() { sortf(a);
            lo.push(if a.is_empty() { 0.0 } else { f(a[(a.len() as f64 * 0.4).floor() as usize]) });
            hi.push(if a.is_empty() { 0.0 } else { f(a[(a.len() as f64 * 0.6).floor() as usize]) }); }
        let (c0, c1, c2) = (&img.ch[0], &img.ch[1], &img.ch[2]);
        let (mut arm, mut gap): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
        for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
            let r = dist(x, y); if r < r0 || r >= r_det { continue; }
            let i = y * w + x; if emp.is(i) { continue; } let k = (r / 25.0).floor() as usize;
            if f(fl.l[i]) - f(g6[i]) > 0.05 { continue; }
            let (a, b, c) = (f(c0[i]), f(c1[i]), f(c2[i]));
            let mx = a.max(b).max(c); let mn = a.min(b).min(c); let sat = if mx > 0.001 { (mx - mn) / mx } else { 0.0 };
            let gv = f(g8[i]);
            if gv >= hi[k] { arm.push(sat); } else if gv <= lo[k] { gap.push(sat); }
        } }
        sortd(&mut arm); sortd(&mut gap);
        out["armSat"] = if arm.is_empty() { Value::Null } else { json!(arm[arm.len() >> 1]) };
        out["gapSat"] = if gap.is_empty() { Value::Null } else { json!(gap[gap.len() >> 1]) };
        out["armN"] = json!(arm.len());
    }
    out
}

/// measureZoneStructure(ctx, viewId, inv): params { inv:{ centre, rDet, zones:{ sky:[r0,r1] } } }
pub fn zone_structure(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let inv = inv_of(p); let (cx, cy) = centre_of(inv)?; let rd = rdet_of(inv)?;
    Ok(zone_structure_on(ctx.img, cx, cy, rd, zone_of(inv, "sky")?))
}

// ---------------------------------------------------------------------------------------------------------------
// measureEnvelopeSectors / measureSectorProfiles

#[inline] fn sector(dx: f64, dy: f64) -> usize { (((dy.atan2(dx) + PI) / (PI / 4.0)).floor() as usize).min(7) }

fn envelope_sectors_on(fl: &Field, cx: f64, cy: f64, rd: f64) -> Value {
    let (w, h) = (fl.w, fl.h); let emp = fl.empty(24.0);
    let (g2, g8) = (fl.blur(2.0), fl.blur(8.0));
    let mut env: Vec<Vec<f32>> = vec![Vec::new(); 8]; let mut sky: Vec<Vec<f32>> = vec![Vec::new(); 8];
    for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
        let (dx, dy) = (x as f64 - cx, y as f64 - cy); let r = (dx * dx + dy * dy).sqrt(); let i = y * w + x;
        if f(g2[i]) - f(g8[i]) > 0.02 || emp.is(i) { continue; }
        let s = sector(dx, dy);
        if r > 0.9 * rd && r < 1.05 * rd { env[s].push(g8[i]); } else if r > rd + 100.0 && r < rd + 400.0 { sky[s].push(g8[i]); }
    } }
    let med = |a: &mut Vec<f32>| -> Option<f64> { if a.len() < 2000 { return None; } sortf(a); Some(f(a[a.len() >> 1])) };
    let ex: Vec<Value> = (0..8).map(|s| match (med(&mut env[s]), med(&mut sky[s])) { (Some(e), Some(k)) => json!(e - k), _ => Value::Null }).collect();
    json!({ "excess": ex })
}

/// measureEnvelopeSectors(ctx, viewId, inv): params { inv:{ centre, rDet } } -> { excess:[8] }
pub fn envelope_sectors(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let inv = inv_of(p); let (cx, cy) = centre_of(inv)?; let rd = rdet_of(inv)?;
    let fl = Field::new(ctx.img, LumKind::Seq);
    Ok(envelope_sectors_on(&fl, cx, cy, rd))
}

/// measureSectorProfiles(ctx, viewId, inv, { bin = 15 }): params { inv:{ centre, rDet }, opts?:{ bin } }
pub fn sector_profiles(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let inv = inv_of(p); let (cx, cy) = centre_of(inv)?; let rd = rdet_of(inv)?;
    let bin = opt(p, "bin").and_then(|v| v.as_f64()).unwrap_or(15.0);
    let r0 = js_round(0.4 * rd); let r1 = rd + 450.0;
    let fl = Field::new(ctx.img, LumKind::Seq); let (w, h) = (fl.w, fl.h);
    let emp = fl.empty(24.0); let (g2, g8) = (fl.blur(2.0), fl.blur(8.0));
    let nb = ((r1 - r0) / bin).ceil().max(0.0) as usize;
    let mut acc: Vec<Vec<Vec<f32>>> = vec![vec![Vec::new(); nb]; 8];
    for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
        let (dx, dy) = (x as f64 - cx, y as f64 - cy); let r = (dx * dx + dy * dy).sqrt(); if r < r0 || r >= r1 { continue; }
        let i = y * w + x; if f(g2[i]) - f(g8[i]) > 0.02 || emp.is(i) { continue; }
        let k = ((r - r0) / bin).floor() as usize; if k < nb { acc[sector(dx, dy)][k].push(g8[i]); }
    } }
    let prof: Vec<Value> = acc.into_par_iter().map(|row| Value::Array(row.into_iter().map(|mut a| {
        if a.len() < 150 { Value::Null } else { sortf(&mut a); json!(f(a[a.len() >> 1])) } }).collect())).collect();
    Ok(json!({ "r0": jn(r0), "bin": jn(bin), "profiles": prof }))
}

// ---------------------------------------------------------------------------------------------------------------
// measureArmGapDepth

/// measureArmGapDepth(ctx, viewId, inv): params { inv:{ centre, rDet, zones:{ sky } } }
pub fn arm_gap_depth(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let inv = inv_of(p); let (cx, cy) = centre_of(inv)?; let rd = rdet_of(inv)?;
    let u = (rd / 300.0).max(0.7);
    let fl = Field::new(ctx.img, LumKind::Seq); let (w, h) = (fl.w, fl.h);
    let emp = fl.empty((18.0 * u).max(24.0));
    let gs = fl.blur((u / 2.0).max(0.7)); let g = fl.blur(2.0 * u); let gw = fl.blur((6.0 * u).max(8.0));
    const NA: usize = 11;
    let mut ann: Vec<Vec<f32>> = vec![Vec::new(); NA]; let mut sk: Vec<f32> = Vec::new();
    for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
        let r = ((x as f64 - cx) * (x as f64 - cx) + (y as f64 - cy) * (y as f64 - cy)).sqrt() / rd; let i = y * w + x;
        if f(gs[i]) - f(gw[i]) > 0.08 || emp.is(i) { continue; }
        if r >= 1.15 && r < 1.3 { sk.push(g[i]); continue; }
        if r < 0.30 || r >= 0.85 { continue; }
        let k = ((r - 0.30) / 0.05).floor(); if k >= 0.0 && (k as usize) < NA { ann[k as usize].push(g[i]); }
    } }
    sortf(&mut sk);
    let sky = if sk.len() > 200 { f(q(&sk, 0.5).unwrap()) } else {
        let sz = zone_of(inv, "sky")?; let mut s2: Vec<f32> = Vec::new();
        for y in (0..h).step_by(4) { for x in (0..w).step_by(4) {
            let d = ((x as f64 - cx) * (x as f64 - cx) + (y as f64 - cy) * (y as f64 - cy)).sqrt();
            if d >= sz.0 && d < sz.1 && !emp.is(y * w + x) { s2.push(g[y * w + x]); } } }
        sortf(&mut s2); q(&s2, 0.5).map(f).unwrap_or(0.0)
    };
    let mut depths: Vec<f64> = Vec::new();
    for a in ann.iter_mut() { if a.len() < 200 { continue; } sortf(a); let hi = f(q(a, 0.8).unwrap()); let lo = f(q(a, 0.2).unwrap()); depths.push((hi - lo) / (hi - sky).max(1e-3)); }
    let mut ds = depths.clone(); sortd(&mut ds); let n = ds.len();
    let depth = if n == 0 { Value::Null } else if n % 2 == 1 { json!(ds[n >> 1]) } else { json!(0.5 * (ds[(n >> 1) - 1] + ds[n >> 1])) };
    Ok(json!({ "depth": depth, "min": if n > 0 { json!(ds[0]) } else { Value::Null }, "perAnnulus": depths, "sky": sky }))
}

// ---------------------------------------------------------------------------------------------------------------
// measureOuterArms

/// measureOuterArms(ctx, viewId, r0, r1, sigma = 8): params { r0, r1, sigma? }
pub fn outer_arms(ctx: &Ctx, p: &Value) -> Result<Value, String> {
    let r0 = p.get("r0").and_then(|v| v.as_f64()).ok_or("params.r0 required")?;
    let r1 = p.get("r1").and_then(|v| v.as_f64()).ok_or("params.r1 required")?;
    let sigma = p.get("sigma").and_then(|v| v.as_f64()).unwrap_or(8.0);
    let b = 24usize; let img = ctx.img;
    let (gw, gh, g) = lum_grid(img, b, 1e5);
    let (bits, blocks, _) = galaxy_block_mask(&g, gw, gh);
    if blocks < 20 { return Ok(json!({ "error": "no galaxy", "blocks": blocks })); }
    let (cx, cy) = brightest_centre(&bits, &g, gw, b);
    let centre = json!([jn(cx), jn(cy)]);
    let fl = Field::new(img, LumKind::Seq); let (w, h) = (fl.w, fl.h);
    let (g2, g8) = (fl.blur(2.0), fl.blur(sigma));
    let (mut v, mut sk): (Vec<f32>, Vec<f32>) = (Vec::new(), Vec::new());
    for y in (0..h).step_by(2) { for x in (0..w).step_by(2) {
        let (dx, dy) = (x as f64 - cx, y as f64 - cy); let r = (dx * dx + dy * dy).sqrt(); let i = y * w + x;
        if f(g2[i]) - f(g8[i]) > 0.02 { continue; }
        if r >= r0 && r < r1 { v.push(g8[i]); } else if r >= r1 + 150.0 && r < r1 + 250.0 { sk.push(g8[i]); }
    } }
    sortf(&mut v); sortf(&mut sk);
    let n = v.len();
    if n <= 500 { return Ok(json!({ "error": "annulus empty", "n": n, "centre": centre })); }
    let (p10, p50, p90) = (f(q(&v, 0.1).unwrap()), f(q(&v, 0.5).unwrap()), f(q(&v, 0.9).unwrap()));
    let sky = q(&sk, 0.5).map(f);
    let sky_spread = if sk.len() > 100 { Some(f(q(&sk, 0.9).unwrap()) - f(q(&sk, 0.1).unwrap())) } else { None };
    let spread = p90 - p10; let net = spread - sky_spread.unwrap_or(0.0);
    let details = format!("outer-arm net contrast {} (spread {} in r {}-{}px (median {}, sky {}, sky spread {})), core at {},{}",
        to_fixed(net, 4), to_fixed(spread, 4), fmt_num(r0), fmt_num(r1), to_fixed(p50, 3), opt_fixed(sky, 3), opt_fixed(sky_spread, 4), fmt_num(cx), fmt_num(cy));
    Ok(json!({ "n": n, "p10": p10, "p50": p50, "p90": p90, "sky": onum(sky), "skySpread": onum(sky_spread),
        "spread": spread, "net": net, "centre": centre, "r": [jn(r0), jn(r1)], "details": details }))
}

// ---------------------------------------------------------------------------------------------------------------
// measureFaintDisc

/// summarizeFaintDisc(grid, w, h)
fn summarize_faint_disc(grid: &[f64], w: usize, h: usize) -> Value {
    let n = w * h;
    if n == 0 { return json!({ "faintFraction": 0, "extent": 0, "galaxyBlocks": 0 }); }
    let mut s = grid[..n].to_vec(); sortd(&mut s); let sky = s[n / 2];
    let e: Vec<f64> = grid[..n].iter().map(|v| v - sky).collect();
    let core: Vec<bool> = e.iter().map(|&v| v > 0.02).collect();
    let (lab, count) = label(&core, w, h);
    if count == 0 { return json!({ "faintFraction": 0, "extent": 0, "galaxyBlocks": 0, "sky": sky }); }
    let mut sizes = vec![0usize; count as usize + 1]; for &l in &lab { sizes[l as usize] += 1; }
    let mut best = 1usize; for k in 2..=count as usize { if sizes[k] > sizes[best] { best = k; } }
    let best = best as i32;
    let mut dist = vec![1_000_000_000i32; n]; let mut qu: Vec<usize> = Vec::new();
    for i in 0..n { if lab[i] == best { dist[i] = 0; qu.push(i); } }
    let mut qi = 0;
    while qi < qu.len() { let p = qu[qi]; qi += 1; if dist[p] >= 50 { continue; }
        for q in neighbours(p, w, h).into_iter().flatten() { if dist[q] > dist[p] + 1 { dist[q] = dist[p] + 1; qu.push(q); } } }
    let grow: Vec<bool> = (0..n).map(|i| dist[i] <= 50 && e[i] > 0.015).collect();
    let (g2, _) = label(&grow, w, h);
    let mut keep = std::collections::HashSet::new();
    for i in 0..n { if lab[i] == best && g2[i] != 0 { keep.insert(g2[i]); } }
    let (mut gal, mut faint, mut bright) = (0usize, 0usize, 0usize);
    for i in 0..n { if keep.contains(&g2[i]) { gal += 1; if e[i] < 0.05 { faint += 1; } if e[i] > 0.10 { bright += 1; } } }
    json!({ "faintFraction": if gal > 0 { faint as f64 / gal as f64 } else { 0.0 }, "extent": gal as f64 / bright.max(1) as f64, "galaxyBlocks": gal, "sky": sky })
}

/// measureFaintDisc(ctx, viewId): no params.
pub fn faint_disc(ctx: &Ctx, _p: &Value) -> Result<Value, String> {
    let (gw, gh, g) = lum_grid(ctx.img, 24, 1e5);
    let mut s = summarize_faint_disc(&g, gw, gh);
    let ff = s["faintFraction"].as_f64().unwrap_or(0.0); let ext = s["extent"].as_f64().unwrap_or(0.0);
    s["details"] = json!(format!("faint outer disc {}% of galaxy area (extent {}x the bright body, {} blocks of 24 px)", to_fixed(ff * 100.0, 1), to_fixed(ext, 2), s["galaxyBlocks"]));
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn fixed() {
        assert_eq!(to_fixed(0.25, 1), "0.3"); assert_eq!(to_fixed(2.5, 0), "3"); assert_eq!(to_fixed(-0.25, 1), "-0.3");
        assert_eq!(to_fixed(1.005, 2), "1.00"); assert_eq!(to_fixed(0.0434, 4), "0.0434"); assert_eq!(to_fixed(338.66, 1), "338.7");
        assert_eq!(to_fixed(9.95, 1), "9.9"); // 9.95 is 9.9499999... in binary
        assert_eq!(to_fixed(-0.01, 1), "-0.0");
    }
}
