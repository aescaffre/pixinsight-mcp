//! LocalHistogramEqualization (CLAHE), a faithful port of PixInsight's standard LHE module
//! (PCL src/modules/processes/contrib/zvrastil/LocalHistogramEqualization, (c) 2011-2021 Zbynek Vrastil,
//! (c) 2003-2021 Pleiades Astrophoto S.L., BSD-style PCL licence: "This product is based on software from
//! the PixInsight project, developed by Pleiades Astrophoto and its contributors (https://pixinsight.com/).")
//!
//! Same per-pixel algorithm and integer arithmetic as the C++ (sliding circular-kernel histogram with the
//! module's boundary mirroring, iterative clip + redistribution, clipped-CDF mapping, amount blend), so the
//! output matches PixInsight. The speed comes from precomputed bin indices, rayon row parallelism and
//! branch-free clip/CDF loops that the compiler vectorises (the 12-bit histogram is rebuilt per pixel).
//! Colour images: CIE L* in the default sRGB (D50) working space, processed, then put back with the
//! a*/b* of each pixel (PCL GetLightness / SetLightness).
use rayon::prelude::*;

pub struct LheParams { pub radius: i32, pub bins: u32, pub slope_limit: f64, pub amount: f64, pub circular: bool }

struct Kernel { r: i32, size: i32, mask: Vec<bool>, front: Vec<i32>, back: Vec<i32> }

fn build_kernel(radius: i32, circular: bool) -> Kernel {
    let size = radius * 2 - 1;
    let mut mask = vec![false; (size * size) as usize];
    let mut front = vec![0i32; size as usize];
    let mut back = vec![0i32; size as usize];
    for y in 0..size {
        let mut first = false;
        for x in 0..size {
            let i = (y * size + x) as usize;
            mask[i] = if circular {
                let dx = x - radius + 1; let dy = y - radius + 1;
                (((dx * dx + dy * dy) as f64).sqrt()) <= (radius - 1) as f64 + 1e-6
            } else { true };
            if !first && mask[i] { first = true; front[y as usize] = x - radius + 1; back[y as usize] = x - radius + 1; }
            else if first && mask[i] { front[y as usize] = x - radius + 1; }
        }
    }
    Kernel { r: radius - 1, size, mask, front, back }
}

/// Clip (PCL ClipHistogram) and map `value` through the clipped CDF (PCL ComputeCDF). `clip` is scratch.
#[inline]
fn clip_and_cdf(hist: &[u32], clip: &mut [i32], n_values: u32, limit: f64, value: usize) -> f64 {
    let hs = hist.len();
    for (c, &h) in clip.iter_mut().zip(hist) { *c = h as i32; }
    let mut hist_limit = (limit * n_values as f64 / (hs - 1) as f64 + 0.5) as i32;
    if hist_limit == 0 { hist_limit = 1; }
    let mut clipped: i32 = 0;
    let mut iterations = 0;
    loop {
        let before = clipped;
        // branch-free: sum of excess over the limit, then clamp (same result as the C++ if/assign)
        let mut sum: i32 = 0;
        for c in clip.iter_mut() { let d = *c - hist_limit; sum = sum.wrapping_add(d.max(0)); *c = (*c).min(hist_limit); }
        clipped = sum;
        if iterations == 0 || clipped < before {
            let cv = clipped as u32;
            let d = (cv / hs as u32) as i32;
            let m = cv % hs as u32;
            if d != 0 { for c in clip.iter_mut() { *c = c.wrapping_add(d); } }
            if m != 0 { let s = ((hs as u32 - 1) / m) as usize; let mut i = 0; while i < hs { clip[i] = clip[i].wrapping_add(1); i += s; } }
        }
        iterations += 1;
        if !(iterations == 1 || clipped < before) { break; }
    }
    let cdf_min = clip.iter().find(|&&c| c != 0).map(|&c| c as u32).unwrap_or(0);
    let mut cdf: u32 = 0;
    for &c in &clip[..=value] { cdf = cdf.wrapping_add(c as u32); }
    let mut cdf_max = cdf;
    for &c in &clip[value + 1..] { cdf_max = cdf_max.wrapping_add(c as u32); }
    cdf.wrapping_sub(cdf_min) as f64 / cdf_max.wrapping_sub(cdf_min) as f64
}

/// LHE on one mono plane (values in [0,1]); returns the new plane.
pub fn lhe_plane(src: &[f32], w: usize, h: usize, p: &LheParams) -> Vec<f32> {
    let hs = p.bins as usize;
    let factor = (hs - 1) as f64;
    let bin = |v: f32| -> u16 { (((v as f64) * factor) as u32).min(hs as u32 - 1) as u16 };   // (uint32)(L*factor), Range 0..hs-1
    let bins: Vec<u16> = src.par_iter().map(|&v| bin(v)).collect();
    let k = build_kernel(p.radius, p.circular);
    let (wi, hi) = (w as i32, h as i32);
    let mut out = vec![0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let y = y as i32;
        let mut hist = vec![0u32; hs];
        let mut clip = vec![0i32; hs];
        let mut n: u32 = 0;
        for x in 0..wi {
            if x == 0 {
                // InitHistogram
                for v in hist.iter_mut() { *v = 0; } n = 0;
                for ky in -k.r..=k.r {
                    let mut yy = y + ky; if yy < 0 { yy = -yy; } if yy >= hi { yy = 2 * hi - yy; }
                    if yy < 0 || yy >= hi { continue; }
                    let off = (yy * wi) as usize;
                    for kx in -k.r..=k.r {
                        let mut xx = kx; if xx < 0 { xx = -xx; }
                        if xx < 0 || xx >= wi { continue; }
                        if k.mask[((ky + k.r) * k.size + kx + k.r) as usize] {
                            let b = bins[off + xx as usize] as usize; hist[b] = hist[b].wrapping_add(1); n = n.wrapping_add(1);
                        }
                    }
                }
            } else {
                // AdvanceHistogram (the module mirrors x on the right edge with 2*Height: reproduced)
                for ky in -k.r..=k.r {
                    let mut yy = y + ky; if yy < 0 { yy = -yy; } if yy >= hi { yy = 2 * hi - yy; }
                    if yy < 0 || yy >= hi { continue; }
                    let off = (yy * wi) as usize;
                    let kr = (ky + k.r) as usize;
                    let mut xx = x + k.back[kr] - 1; if xx < 0 { xx = -xx; } if xx >= wi { xx = 2 * hi - xx; }
                    if xx >= 0 && xx < wi { let b = bins[off + xx as usize] as usize; hist[b] = hist[b].wrapping_sub(1); n = n.wrapping_sub(1); }
                    let mut xx = x + k.front[kr]; if xx < 0 { xx = -xx; } if xx >= wi { xx = 2 * hi - xx; }
                    if xx >= 0 && xx < wi { let b = bins[off + xx as usize] as usize; hist[b] = hist[b].wrapping_add(1); n = n.wrapping_add(1); }
                }
            }
            let i = (y * wi + x) as usize;
            let l = src[i] as f64;
            let o = clip_and_cdf(&hist, &mut clip, n, p.slope_limit, bins[i] as usize);
            row[x as usize] = (p.amount * o + (1.0 - p.amount) * l) as f32;
        }
    });
    out
}

// ---- PCL RGBColorSystem, default sRGB (D50) working space ----
const EPS: f64 = 8.856451679035631e-03;      // CIEEpsilon 216/24389
const K116: f64 = 7.787037037037037e+00;     // CIEKappa/116
const C16_116: f64 = 1.379310344827586e-01;  // 16/116
const C1_3: f64 = 3.333333333333333e-01;

#[inline] fn xyz_lab(x: f64) -> f64 { if x > EPS { x.powf(C1_3) } else { K116 * x + C16_116 } }
#[inline] fn lab_xyz(x: f64) -> f64 { let x3 = x * x * x; if x3 > EPS { x3 } else { (x - C16_116) / K116 } }
#[inline] fn range(x: f64) -> f64 { x.max(0.0).min(1.0) }
#[inline] fn srgb_to_linear(x: f64) -> f64 { if x > 0.04045 { ((x + 0.055) / 1.055).powf(2.4) } else { x / 12.92 } }
#[inline] fn linear_to_srgb(x: f64) -> f64 { if x > 0.0031308 { 1.055 * x.powf(1.0 / 2.4) - 0.055 } else { 12.92 * x } }

pub struct Rgbws { m: [f64; 9], mi: [f64; 9], mx: f64, mz: f64, za: f64, zb: f64, ma: f64, mb: f64 }

impl Rgbws {
    pub fn srgb() -> Self {
        let x: [f32; 3] = [0.648431, 0.321152, 0.155886];
        let y: [f32; 3] = [0.330856, 0.597871, 0.066044];
        let yy: [f32; 3] = [0.222491, 0.716888, 0.060621];
        // Y /= Y.Sum() in float (FVector), as PCL does
        let s = yy[0] as f64 + yy[1] as f64 + yy[2] as f64;
        let yn: [f32; 3] = [(yy[0] as f64 / s) as f32, (yy[1] as f64 / s) as f32, (yy[2] as f64 / s) as f32];
        let (x, y, yn) = (x.map(|v| v as f64), y.map(|v| v as f64), yn.map(|v| v as f64));
        let m = [yn[0] * x[0] / y[0], yn[1] * x[1] / y[1], yn[2] * x[2] / y[2],
                 yn[0], yn[1], yn[2],
                 yn[0] * (1.0 - x[0] - y[0]) / y[0], yn[1] * (1.0 - x[1] - y[1]) / y[1], yn[2] * (1.0 - x[2] - y[2]) / y[2]];
        let d1 = m[4] * m[8] - m[5] * m[7]; let d2 = m[5] * m[6] - m[3] * m[8]; let d3 = m[3] * m[7] - m[4] * m[6];
        let d = m[0] * d1 + m[1] * d2 + m[2] * d3;
        let mi = [d1 / d, (m[7] * m[2] - m[8] * m[1]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
                  d2 / d, (m[8] * m[0] - m[6] * m[2]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
                  d3 / d, (m[6] * m[1] - m[7] * m[0]) / d, (m[0] * m[4] - m[1] * m[3]) / d];
        let a_min = 5.0 * (xyz_lab(0.0) - xyz_lab(1.0)); let a_max = 5.0 * (xyz_lab(1.0) - xyz_lab(0.0));
        let b_min = 2.0 * (xyz_lab(0.0) - xyz_lab(1.0)); let b_max = 2.0 * (xyz_lab(1.0) - xyz_lab(0.0));
        Rgbws { m, mi, mx: m[0] + m[1] + m[2], mz: m[6] + m[7] + m[8], za: -a_min, zb: -b_min, ma: a_max - a_min, mb: b_max - b_min }
    }
    #[inline] fn xyz(&self, r: f64, g: f64, b: f64) -> (f64, f64, f64) {
        let (r, g, b) = (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)); let m = &self.m;
        (range((r * m[0] + g * m[1] + b * m[2]) / self.mx), range(r * m[3] + g * m[4] + b * m[5]), range((r * m[6] + g * m[7] + b * m[8]) / self.mz))
    }
    /// PCL Lightness(): CIE L* normalised to [0,1]
    #[inline] pub fn lightness(&self, r: f64, g: f64, b: f64) -> f64 { let (_, y, _) = self.xyz(r, g, b); 1.16 * xyz_lab(y) - 0.16 }
    /// PCL SetLightness for one RGB pixel: keep a*, b*, replace L*
    #[inline] pub fn set_lightness(&self, r: f64, g: f64, b: f64, l: f64) -> (f64, f64, f64) {
        let (x, y, z) = self.xyz(r, g, b); let (x, y, z) = (xyz_lab(x), xyz_lab(y), xyz_lab(z));
        let a = range((5.0 * (x - y) + self.za) / self.ma); let bb = range((2.0 * (y - z) + self.zb) / self.mb);
        let y = (l + 0.16) / 1.16; let x = (self.ma * a - self.za) / 5.0 + y; let z = y - (self.mb * bb - self.zb) / 2.0;
        let (x, y, z) = (lab_xyz(x) * self.mx, lab_xyz(y), lab_xyz(z) * self.mz); let mi = &self.mi;
        let r = range(x * mi[0] + y * mi[1] + z * mi[2]); let g = range(x * mi[3] + y * mi[4] + z * mi[5]); let b = range(x * mi[6] + y * mi[7] + z * mi[8]);
        (linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(b))
    }
}

/// LHE on an image (mono: the plane; colour: CIE L*), optionally blended through a mask (1 = processed).
pub fn lhe_image(img: &mut crate::image::Image, p: &LheParams, mask: Option<&[f32]>) {
    let (w, h) = (img.w, img.h);
    if img.is_color() {
        let ws = Rgbws::srgb();
        let l: Vec<f32> = (0..w * h).into_par_iter().map(|i| ws.lightness(img.ch[0][i] as f64, img.ch[1][i] as f64, img.ch[2][i] as f64) as f32).collect();
        let nl = lhe_plane(&l, w, h, p);
        let (r, rest) = img.ch.split_at_mut(1); let (g, b) = rest.split_at_mut(1);
        r[0].par_iter_mut().zip(g[0].par_iter_mut()).zip(b[0].par_iter_mut()).enumerate().for_each(|(i, ((r, g), b))| {
            let (r0, g0, b0) = (*r as f64, *g as f64, *b as f64);
            let (nr, ng, nb) = ws.set_lightness(r0, g0, b0, nl[i] as f64);
            let (nr, ng, nb) = (nr as f32 as f64, ng as f32 as f64, nb as f32 as f64);
            match mask { Some(m) => { let k = m[i] as f64; *r = (r0 * (1.0 - k) + nr * k) as f32; *g = (g0 * (1.0 - k) + ng * k) as f32; *b = (b0 * (1.0 - k) + nb * k) as f32; }
                         None => { *r = nr as f32; *g = ng as f32; *b = nb as f32; } }
        });
    } else {
        let nl = lhe_plane(&img.ch[0], w, h, p);
        let src = &mut img.ch[0];
        src.par_iter_mut().enumerate().for_each(|(i, v)| { let n = nl[i] as f64; *v = match mask { Some(m) => { let k = m[i] as f64; (*v as f64 * (1.0 - k) + n * k) as f32 } None => n as f32 }; });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kernel_shape_matches_module() {
        let k = build_kernel(3, true);   // size 5, r 2: a disc of radius 2 -> rows 1,3,5,3,1 wide
        let widths: Vec<usize> = (0..5).map(|y| (0..5).filter(|&x| k.mask[y * 5 + x]).count()).collect();
        assert_eq!(widths, vec![1, 3, 5, 3, 1]);
        assert_eq!((k.back[2], k.front[2]), (-2, 2));
    }
    #[test]
    fn flat_image_is_stable_and_bounded() {
        let w = 40; let h = 30; let src: Vec<f32> = (0..w * h).map(|i| ((i % w) as f32 / w as f32) * 0.5 + 0.2).collect();
        let p = LheParams { radius: 8, bins: 256, slope_limit: 2.0, amount: 1.0, circular: true };
        let out = lhe_plane(&src, w, h, &p);
        assert!(out.iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0));
    }
    #[test]
    fn lightness_roundtrip() {
        let ws = Rgbws::srgb();
        let (r, g, b) = (0.6, 0.4, 0.2); let l = ws.lightness(r, g, b);
        let (r2, g2, b2) = ws.set_lightness(r, g, b, l);
        assert!((r - r2).abs() < 1e-6 && (g - g2).abs() < 1e-6 && (b - b2).abs() < 1e-6, "{r2} {g2} {b2}");
    }
}
