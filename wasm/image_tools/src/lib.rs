use wasm_bindgen::prelude::*;
use std::io::Cursor;
use image::{ImageFormat, ImageEncoder};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;

#[wasm_bindgen]
pub fn convert_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();

    // Load the image from memory (automatically detects format)
    let img = image::load_from_memory(input_data)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let mut output_buffer = Vec::new();
    let mut cursor = Cursor::new(&mut output_buffer);

    match format_str.to_lowercase().as_str() {
        "jpeg" | "jpg" => {
            let encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into()
            ).map_err(|e| format!("Failed to encode JPEG: {}", e))?;
        },
        "webp" => img.write_to(&mut cursor, ImageFormat::WebP).map_err(|e| e.to_string())?,
        "png" => img.write_to(&mut cursor, ImageFormat::Png).map_err(|e| e.to_string())?,
        "gif" => img.write_to(&mut cursor, ImageFormat::Gif).map_err(|e| e.to_string())?,
        "bmp" => img.write_to(&mut cursor, ImageFormat::Bmp).map_err(|e| e.to_string())?,
        "ico" => img.write_to(&mut cursor, ImageFormat::Ico).map_err(|e| e.to_string())?,
        "tga" => img.write_to(&mut cursor, ImageFormat::Tga).map_err(|e| e.to_string())?,
        "tiff" => img.write_to(&mut cursor, ImageFormat::Tiff).map_err(|e| e.to_string())?,
        _ => return Err(format!("Unsupported target format: {}", format_str)),
    };

    Ok(output_buffer)
}
