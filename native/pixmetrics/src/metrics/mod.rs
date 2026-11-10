//! Metric registry. Each metric mirrors one PJSR measurement in agents/ops/*.mjs; the JSON it returns has the
//! same field names as the JS version so callers can swap implementations transparently.
use crate::image::Image;
use serde_json::Value;
use std::sync::OnceLock;

pub mod colour;
pub mod core;
pub mod stars;
pub mod texture;
pub mod zones;

/// Shared per-image cache (luminance computed once for all metrics in a batch).
pub struct Ctx<'a> { pub img: &'a Image, lum: OnceLock<Vec<f32>> }
impl<'a> Ctx<'a> {
    pub fn new(img: &'a Image) -> Self { Ctx { img, lum: OnceLock::new() } }
    pub fn lum(&self) -> &Vec<f32> { self.lum.get_or_init(|| self.img.luminance()) }
}


/// Every module exposes `dispatch(name, ctx, params) -> Option<Result>` and `NAMES`.
pub fn run(name: &str, ctx: &Ctx, p: &Value) -> Result<Value, String> {
    for d in DISPATCH { if let Some(r) = d(name, ctx, p) { return r; } }
    Err(format!("unknown metric '{name}'"))
}
type Dispatch = fn(&str, &Ctx, &Value) -> Option<Result<Value, String>>;
const DISPATCH: &[Dispatch] = &[colour::dispatch, core::dispatch, zones::dispatch, texture::dispatch, stars::dispatch];
pub fn names() -> Vec<&'static str> { [colour::NAMES, core::NAMES, zones::NAMES, texture::NAMES, stars::NAMES].concat() }
