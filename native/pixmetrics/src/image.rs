//! Planar f32 image in [0,1] (PixInsight normalised range).
#[derive(Clone)]
pub struct Image {
    pub w: usize,
    pub h: usize,
    /// One plane per channel, row-major, len = w*h.
    pub ch: Vec<Vec<f32>>,
}

impl Image {
    pub fn new(w: usize, h: usize, c: usize) -> Self { Image { w, h, ch: vec![vec![0.0; w * h]; c] } }
    pub fn n_channels(&self) -> usize { self.ch.len() }
    pub fn is_color(&self) -> bool { self.ch.len() >= 3 }
    #[inline] pub fn at(&self, c: usize, x: usize, y: usize) -> f32 { self.ch[c][y * self.w + x] }
    /// Rec.709 luminance (0.2126 R + 0.7152 G + 0.0722 B), or the single channel for mono.
    pub fn luminance(&self) -> Vec<f32> {
        if !self.is_color() { return self.ch[0].clone(); }
        let (r, g, b) = (&self.ch[0], &self.ch[1], &self.ch[2]);
        (0..self.w * self.h).map(|i| 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i]).collect()
    }
    #[inline] pub fn lum_at(&self, x: usize, y: usize) -> f32 {
        let i = y * self.w + x;
        if self.is_color() { 0.2126 * self.ch[0][i] + 0.7152 * self.ch[1][i] + 0.0722 * self.ch[2][i] } else { self.ch[0][i] }
    }
}
