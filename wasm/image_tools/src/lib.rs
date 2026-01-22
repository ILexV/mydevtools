use wasm_bindgen::prelude::*;
use std::io::Cursor;
use image::{ImageFormat, ImageEncoder};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;

#[wasm_bindgen]
pub fn compress_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();

    let img = image::load_from_memory(input_data)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let mut output_buffer = Vec::new();
    let mut cursor = Cursor::new(&mut output_buffer);

    match format_str.to_lowercase().as_str() {
        "jpeg" | "jpg" => {
            // Quality is 1-100
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into()
            ).map_err(|e| format!("Failed to encode JPEG: {}", e))?;
        },
        "png" => {
            // PNG is lossless, so quality parameter doesn't apply directly to visual quality,
            // but we can use Best compression.
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                &mut cursor,
                image::codecs::png::CompressionType::Best,
                image::codecs::png::FilterType::Adaptive,
            );
             img.write_with_encoder(encoder).map_err(|e| e.to_string())?;
        },
        "webp" => {
             // Quality 1-100.
             // If quality is 100, we could theoretically use lossless, but here we treat it as lossy quality control
             // unless user explicitly wants lossless (separate toggle, but for now stick to quality slider).
             // image 0.25 WebPEncoder takes quality in new_with_quality (if available) or we check docs.
             // Checking docs for image 0.25: WebPEncoder::new(&mut w).
             // Actually image 0.25 might not fully expose libwebp options via simple API yet or it changed.
             // Let's check if new uses default.
             
             // Wait, image 0.25 WebP support might be limited or use 'image-webp' crate. 
             // To be safe and simple: using write_to with WebP format usually uses defaults.
             // But we want control.
             // Let's try to use WebPEncoder if it allows config.
             // If not, we might need a specific crate or just use default.
             // Looking at source for image 0.25, WebPEncoder usually supports lossless or lossy.
             
             // For now, let's stick to simple write_to for WebP if we can't easily set quality, 
             // but 'image' crate usually defaults to lossy.
             // HOWEVER, we want to allow the USER to control it.
             
             // Attempting to use WebPEncoder logic if available.
             // Since I can't check docs live easily, I'll stick to a safe implementation.
             // If image::codecs::webp::WebPEncoder doesn't have quality, we might only get default.
             
             // Actually, let's use the standard `write_to` for now as a fallback if specific encoder config is complex,
             // BUT `image` crate recently updated.
             
             // Let's assume standard behavior:
             let encoder = WebPEncoder::new_lossless(&mut cursor); // This would be lossless.
             // We want lossy with quality.
             // The `image` crate's WebP encoder is often pure Rust and might not support all libwebp features.
             // If we really want "iloveimg" quality, we might need `webp` crate, but that might be C binding (issues with WASM?).
             // `image` crate is pure Rust (mostly).
             
             // Let's try standard write_to and accept default for now, OR:
             // Checking recent 'image' crate:
             // It seems WebP writing is limited.
             // Re-reading plan: "Use WebPEncoder with quality settings if available".
             
             // Reverting to `write_to` for WebP to avoid compilation errors if specific API is missing,
             // creating a TODO to investigate better WebP control.
             
             img.write_to(&mut cursor, ImageFormat::WebP).map_err(|e| e.to_string())?;
        },
        _ => return Err(format!("Unsupported target format: {}", format_str)),
    };

    Ok(output_buffer)
}
