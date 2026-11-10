//! Shared helpers: PNG input, percentiles/medians matching the PJSR conventions, HSV.
use crate::image::Image;

pub fn read_png(path: &str) -> Result<Image, String> {
    let dec = png::Decoder::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    let mut rd = dec.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; rd.output_buffer_size()];
    let info = rd.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width as usize, info.height as usize);
    let spp = match info.color_type { png::ColorType::Grayscale => 1, png::ColorType::GrayscaleAlpha => 2, png::ColorType::Rgb => 3, png::ColorType::Rgba => 4, _ => return Err("indexed PNG not supported".into()) };
    let bits16 = info.bit_depth == png::BitDepth::Sixteen;
    let c = if spp >= 3 { 3 } else { 1 };
    let mut img = Image::new(w, h, c);
    for i in 0..w * h { for k in 0..c {
        let j = i * spp + k;
        img.ch[k][i] = if bits16 { u16::from_be_bytes([buf[2 * j], buf[2 * j + 1]]) as f32 / 65535.0 } else { buf[j] as f32 / 255.0 };
    } }
    Ok(img)
}

/// PJSR-style median: sort ascending, take a[len >> 1] (upper median for even lengths).
pub fn med(v: &mut Vec<f32>) -> Option<f32> { if v.is_empty() { return None; } v.sort_by(|a, b| a.partial_cmp(b).unwrap()); Some(v[v.len() >> 1]) }
/// a[floor(q * (len-1))] after sorting.
pub fn pct(v: &mut Vec<f32>, q: f64) -> Option<f32> { if v.is_empty() { return None; } v.sort_by(|a, b| a.partial_cmp(b).unwrap()); Some(v[((q * (v.len() - 1) as f64).floor() as usize).min(v.len() - 1)]) }

/// HSV hue in degrees and saturation (max-min)/max.
/// Computed in f64 like PJSR (img.sample returns doubles).
#[inline] pub fn hsv(r: f32, g: f32, b: f32) -> (f64, f64) {
    let (r, g, b) = (r as f64, g as f64, b as f64);
    let mx = r.max(g).max(b); let mn = r.min(g).min(b); let d = mx - mn;
    if mx <= 1e-6 || d <= 0.0 { return (0.0, 0.0); }
    let h = if mx == r { (((g - b) / d) % 6.0 + 6.0) % 6.0 } else if mx == g { (b - r) / d + 2.0 } else { (r - g) / d + 4.0 };
    (h * 60.0, d / mx)
}

pub fn p_f64(p: &serde_json::Value, k: &str) -> Option<f64> { p.get(k).and_then(|v| v.as_f64()) }
pub fn p_centre(p: &serde_json::Value) -> Result<(f64, f64, f64), String> {
    let inv = p.get("inv").unwrap_or(p);
    let c = inv.get("centre").and_then(|c| c.as_array()).ok_or("params.inv.centre required")?;
    let rd = inv.get("rDet").and_then(|v| v.as_f64()).ok_or("params.inv.rDet required")?;
    Ok((c[0].as_f64().unwrap_or(0.0), c[1].as_f64().unwrap_or(0.0), rd))
}

/// Baseline/progressive JPEG (8-bit; grey or RGB; CMYK unsupported) — user reference images are JPEGs.
pub fn read_jpeg(path: &str) -> Result<Image, String> {
    let f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut d = jpeg_decoder::Decoder::new(std::io::BufReader::new(f));
    let px = d.decode().map_err(|e| format!("jpeg: {e}"))?;
    let info = d.info().ok_or("jpeg: no info")?;
    let (w, h) = (info.width as usize, info.height as usize);
    let c = match info.pixel_format { jpeg_decoder::PixelFormat::L8 => 1, jpeg_decoder::PixelFormat::RGB24 => 3, jpeg_decoder::PixelFormat::L16 => 1, _ => return Err("jpeg: CMYK not supported".into()) };
    let mut img = Image::new(w, h, c);
    if info.pixel_format == jpeg_decoder::PixelFormat::L16 {
        for i in 0..w * h { img.ch[0][i] = u16::from_be_bytes([px[2 * i], px[2 * i + 1]]) as f32 / 65535.0; }
    } else { for i in 0..w * h { for k in 0..c { img.ch[k][i] = px[i * c + k] as f32 / 255.0; } } }
    Ok(img)
}

/// Any supported image by extension: .xisf, .png, .jpg/.jpeg.
pub fn read_any(path: &str) -> Result<Image, String> {
    let l = path.to_lowercase();
    if l.ends_with(".png") { read_png(path) }
    else if l.ends_with(".jpg") || l.ends_with(".jpeg") { read_jpeg(path) }
    else { crate::xisf::read(path, 0).map(|(i, _)| i) }
}
