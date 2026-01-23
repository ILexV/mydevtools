use wasm_bindgen::prelude::*;
use std::io::Cursor;
use image::{ImageFormat, ImageEncoder};
use image::codecs::jpeg::JpegEncoder;

#[wasm_bindgen]
pub fn compress_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();

    let img = image::load_from_memory(input_data)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let mut output_buffer = Vec::new(); // We need a Growable buffer. Cursor<Vec<u8>> works if we access inner.
    // However, `png::Encoder` needs a writer. `Cursor<&mut Vec<u8>>` or just `&mut Vec<u8>`?
    // `Vec<u8>` implements Write.
    
    match format_str.to_lowercase().as_str() {
        "jpeg" | "jpg" => {
            let mut cursor = Cursor::new(&mut output_buffer);
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
             // If quality < 90, perform lossy quantization (256 colors)
             if quality < 90 {
                let width = img.width();
                let height = img.height();
                let rgba = img.to_rgba8();
                let raw_pixels = rgba.as_raw();

                // color_quant::NeuQuant::new(speed, max_colors, pixels)
                // speed: 1 (highest quality) - 30 (fastest). 10 is good default.
                let nq = color_quant::NeuQuant::new(10, 256, raw_pixels);
                
                // Map pixels to indices
                let ind_data: Vec<u8> = raw_pixels.chunks(4).map(|pix| nq.index_of(pix) as u8).collect();
                
                // Extract palette
                // color_quant returns [r, g, b, a, r, g, b, a, ...]
                let color_map = nq.color_map_rgba();
                
                // Prepare PNG encoder
                let mut encoder = png::Encoder::new(&mut output_buffer, width, height);
                encoder.set_color(png::ColorType::Indexed);
                encoder.set_depth(png::BitDepth::Eight);
                
                // Convert RGBA palette to RGB palette + TRNS chunk
                let mut palette = Vec::with_capacity(256 * 3);
                let mut trns = Vec::with_capacity(256);
                
                for chunk in color_map.chunks(4) {
                    palette.push(chunk[0]);
                    palette.push(chunk[1]);
                    palette.push(chunk[2]);
                    trns.push(chunk[3]);
                }
                
                encoder.set_palette(palette);
                encoder.set_trns(trns);
                
                let mut writer = encoder.write_header().map_err(|e| format!("PNG Header error: {}", e))?;
                writer.write_image_data(&ind_data).map_err(|e| format!("PNG Write error: {}", e))?;
                writer.finish().map_err(|e| format!("PNG finish error: {}", e))?;
                
             } else {
                 let mut cursor = Cursor::new(&mut output_buffer);
                 let encoder = image::codecs::png::PngEncoder::new_with_quality(
                    &mut cursor,
                    image::codecs::png::CompressionType::Best,
                    image::codecs::png::FilterType::Adaptive,
                );
                 img.write_with_encoder(encoder).map_err(|e| e.to_string())?;
             }
        },
        "webp" => {
             let mut cursor = Cursor::new(&mut output_buffer);
             img.write_to(&mut cursor, ImageFormat::WebP).map_err(|e| e.to_string())?;
        },
        _ => return Err(format!("Unsupported target format: {}", format_str)),
    };

    Ok(output_buffer)
}
