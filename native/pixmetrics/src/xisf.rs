//! XISF 1.0 reader (monolithic files): attachment / inline / embedded data blocks, planar and normal
//! (interleaved) pixel storage, UInt8/16/32, Float32/64, compression zlib / lz4 / lz4hc / zstd with optional
//! byte shuffling (+sh). Pure Rust: builds for macOS, Windows and Linux without a C toolchain.
use crate::image::Image;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

#[derive(Debug)]
pub struct XisfInfo { pub w: usize, pub h: usize, pub c: usize, pub sample_format: String, pub color_space: String, pub id: String }

fn err<T>(m: impl Into<String>) -> Result<T, String> { Err(m.into()) }

pub fn read_header(path: &str) -> Result<(String, File), String> {
    let mut f = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut sig = [0u8; 16];
    f.read_exact(&mut sig).map_err(|e| format!("read signature: {e}"))?;
    if &sig[0..8] != b"XISF0100" { return err(format!("{path}: not an XISF 1.0 file")); }
    let hlen = u32::from_le_bytes([sig[8], sig[9], sig[10], sig[11]]) as usize;
    let mut xml = vec![0u8; hlen];
    f.read_exact(&mut xml).map_err(|e| format!("read header: {e}"))?;
    let s = String::from_utf8(xml).map_err(|_| "header not UTF-8".to_string())?;
    Ok((s.trim_end_matches('\0').to_string(), f))
}

fn sample_size(fmt: &str) -> Result<usize, String> {
    Ok(match fmt { "UInt8" => 1, "UInt16" => 2, "UInt32" | "Float32" => 4, "Float64" => 8, _ => return err(format!("unsupported sampleFormat {fmt}")) })
}

fn unshuffle(data: &[u8], item: usize) -> Vec<u8> {
    if item <= 1 { return data.to_vec(); }
    let n = data.len() / item;
    let mut out = vec![0u8; data.len()];
    for j in 0..item { for i in 0..n { out[i * item + j] = data[j * n + i]; } }
    let tail = n * item;
    out[tail..].copy_from_slice(&data[tail..]);
    out
}

fn decompress(codec_spec: &str, raw: &[u8], sample_bytes: usize) -> Result<Vec<u8>, String> {
    // compression="codec:uncompressed-size[:item-size]"
    let parts: Vec<&str> = codec_spec.split(':').collect();
    let codec = parts[0];
    let usize_ = parts.get(1).and_then(|s| s.parse::<usize>().ok()).ok_or("bad compression attribute")?;
    let item = parts.get(2).and_then(|s| s.parse::<usize>().ok()).unwrap_or(sample_bytes);
    let (base, shuffled) = match codec.strip_suffix("+sh") { Some(b) => (b, true), None => (codec, false) };
    let out = match base {
        "zlib" => miniz_oxide::inflate::decompress_to_vec_zlib(raw).map_err(|e| format!("zlib: {e:?}"))?,
        "lz4" | "lz4hc" => lz4_flex::block::decompress(raw, usize_).map_err(|e| format!("lz4: {e}"))?,
        "zstd" => {
            let mut d = ruzstd::StreamingDecoder::new(raw).map_err(|e| format!("zstd: {e}"))?;
            let mut v = Vec::with_capacity(usize_);
            d.read_to_end(&mut v).map_err(|e| format!("zstd: {e}"))?;
            v
        }
        _ => return err(format!("unsupported compression {codec}")),
    };
    if out.len() != usize_ { return err(format!("{codec}: got {} bytes, expected {usize_}", out.len())); }
    Ok(if shuffled { unshuffle(&out, item) } else { out })
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|e| e.to_string())).collect()
}
fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, &c) in T.iter().enumerate() { map[c as usize] = i as u8; }
    let mut out = Vec::new(); let mut buf = 0u32; let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' { break; }
        let v = map[c as usize]; if v == 255 { continue; }
        buf = (buf << 6) | v as u32; bits += 6;
        if bits >= 8 { bits -= 8; out.push((buf >> bits) as u8); }
    }
    Ok(out)
}

/// Read the first <Image> of a monolithic XISF file (index selects another image).
pub fn read(path: &str, index: usize) -> Result<(Image, XisfInfo), String> {
    let (xml, mut f) = read_header(path)?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("XML: {e}"))?;
    let img = doc.descendants().filter(|n| n.has_tag_name("Image")).nth(index).ok_or("no <Image> element")?;
    let geom = img.attribute("geometry").ok_or("no geometry")?;
    let g: Vec<usize> = geom.split(':').map(|s| s.parse().unwrap_or(0)).collect();
    if g.len() < 3 { return err("only 2-D images are supported"); }
    let (w, h, c) = (g[0], g[1], g[2]);
    let fmt = img.attribute("sampleFormat").unwrap_or("Float32").to_string();
    let sb = sample_size(&fmt)?;
    let storage = img.attribute("pixelStorage").unwrap_or("Planar");
    let le = img.attribute("byteOrder").unwrap_or("little") != "big";
    let loc = img.attribute("location").ok_or("no location")?;
    let lp: Vec<&str> = loc.split(':').collect();
    let raw: Vec<u8> = match lp[0] {
        "attachment" => {
            let pos: u64 = lp.get(1).and_then(|s| s.parse().ok()).ok_or("bad attachment position")?;
            let size: usize = lp.get(2).and_then(|s| s.parse().ok()).ok_or("bad attachment size")?;
            f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            let mut v = vec![0u8; size];
            f.read_exact(&mut v).map_err(|e| format!("read data block: {e}"))?;
            v
        }
        "inline" => { let t = img.text().unwrap_or(""); if lp.get(1) == Some(&"hex") { decode_hex(t)? } else { decode_b64(t)? } }
        "embedded" => {
            let d = img.children().find(|n| n.has_tag_name("Data")).ok_or("no <Data>")?;
            let t = d.text().unwrap_or("");
            if d.attribute("encoding") == Some("hex") { decode_hex(t)? } else { decode_b64(t)? }
        }
        other => return err(format!("unsupported location {other}")),
    };
    let bytes = match img.attribute("compression") { Some(cs) => decompress(cs, &raw, sb)?, None => raw };
    let n = w * h * c;
    if bytes.len() < n * sb { return err(format!("data block too short: {} < {}", bytes.len(), n * sb)); }
    // bounds for float images (PixInsight default [0,1]); integer images are normalised by their range.
    let (lo, hi) = img.attribute("bounds").and_then(|b| { let v: Vec<f64> = b.split(':').filter_map(|s| s.parse().ok()).collect(); if v.len() == 2 { Some((v[0], v[1])) } else { None } }).unwrap_or((0.0, 1.0));
    let conv = |i: usize| -> f32 {
        let s = &bytes[i * sb..i * sb + sb];
        match fmt.as_str() {
            "UInt8" => s[0] as f32 / 255.0,
            "UInt16" => (if le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) }) as f32 / 65535.0,
            "UInt32" => ((if le { u32::from_le_bytes([s[0], s[1], s[2], s[3]]) } else { u32::from_be_bytes([s[0], s[1], s[2], s[3]]) }) as f64 / 4294967295.0) as f32,
            "Float32" => { let v = if le { f32::from_le_bytes([s[0], s[1], s[2], s[3]]) } else { f32::from_be_bytes([s[0], s[1], s[2], s[3]]) } as f64; (((v - lo) / (hi - lo))) as f32 }
            _ => { let a: [u8; 8] = s.try_into().unwrap(); let v = if le { f64::from_le_bytes(a) } else { f64::from_be_bytes(a) }; ((v - lo) / (hi - lo)) as f32 }
        }
    };
    let mut out = Image::new(w, h, c);
    let np = w * h;
    if storage == "Normal" { for i in 0..np { for k in 0..c { out.ch[k][i] = conv(i * c + k); } } }
    else { for k in 0..c { let base = k * np; let plane = &mut out.ch[k]; for i in 0..np { plane[i] = conv(base + i); } } }
    let info = XisfInfo { w, h, c, sample_format: fmt, color_space: img.attribute("colorSpace").unwrap_or("Gray").to_string(), id: img.attribute("id").unwrap_or("").to_string() };
    Ok((out, info))
}

/// Minimal XISF writer (uncompressed Float32, planar) — used by tests and for round-trips.
pub fn write(path: &str, img: &Image) -> Result<(), String> {
    use std::io::Write;
    let c = img.n_channels(); let size = img.w * img.h * c * 4;
    let cs = if c >= 3 { "RGB" } else { "Gray" };
    let mk = |pos: usize| format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><xisf version=\"1.0\" xmlns=\"http://www.pixinsight.com/xisf\"><Image geometry=\"{}:{}:{}\" sampleFormat=\"Float32\" bounds=\"0:1\" colorSpace=\"{}\" location=\"attachment:{}:{}\"/></xisf>", img.w, img.h, c, cs, pos, size);
    let mut pos = (16 + mk(0).len() + 4095) / 4096 * 4096; let mut hdr = mk(pos);
    while 16 + hdr.len() > pos { pos += 4096; hdr = mk(pos); }
    let mut f = File::create(path).map_err(|e| e.to_string())?;
    let mut head = Vec::new(); head.extend_from_slice(b"XISF0100"); head.extend_from_slice(&(hdr.len() as u32).to_le_bytes()); head.extend_from_slice(&[0u8; 4]); head.extend_from_slice(hdr.as_bytes());
    head.resize(pos, 0);
    f.write_all(&head).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(size);
    for p in &img.ch { for v in p { buf.extend_from_slice(&v.to_le_bytes()); } }
    f.write_all(&buf).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unshuffle_restores_items() {
        // 3 float32 items shuffled: all byte0s, then byte1s, ...
        let orig: Vec<u8> = (0u8..12).collect();
        let mut sh = vec![0u8; 12];
        for i in 0..3 { for j in 0..4 { sh[j * 3 + i] = orig[i * 4 + j]; } }
        assert_eq!(unshuffle(&sh, 4), orig);
    }
    #[test]
    fn roundtrip_float32() {
        let mut img = Image::new(7, 5, 3);
        for k in 0..3 { for i in 0..35 { img.ch[k][i] = (i as f32 * 0.01 + k as f32 * 0.1).min(1.0); } }
        let p = std::env::temp_dir().join("pixmetrics_rt.xisf");
        write(p.to_str().unwrap(), &img).unwrap();
        let (back, info) = read(p.to_str().unwrap(), 0).unwrap();
        assert_eq!((info.w, info.h, info.c), (7, 5, 3));
        assert_eq!(back.ch, img.ch);
        let _ = std::fs::remove_file(p);
    }
}
