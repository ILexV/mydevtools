use wasm_bindgen::prelude::*;
use std::io::Cursor;
use image::{ImageFormat, ImageEncoder};
use image::codecs::jpeg::JpegEncoder;

#[wasm_bindgen]
pub fn compress_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();

    let img = image::load_from_memory(input_data)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    encode_dynamic_image(&img, format_str, quality)
}

#[wasm_bindgen]
pub fn convert_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    compress_image(input_data, format_str, quality)
}

#[wasm_bindgen]
pub fn resize_image(input_data: &[u8], width: u32, height: u32, format_str: &str) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();

    let img = image::load_from_memory(input_data)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    // Use Lanczos3 for high quality resizing
    let resized = img.resize_exact(width, height, image::imageops::FilterType::Lanczos3);

    // Default quality 90 for resize output
    encode_dynamic_image(&resized, format_str, 90)
}

fn encode_dynamic_image(img: &image::DynamicImage, format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    let mut output_buffer = Vec::new();
    
    match format_str.to_lowercase().as_str() {
        "jpeg" | "jpg" => {
            let mut cursor = Cursor::new(&mut output_buffer);
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into()
            ).map_err(|e| format!("Failed to encode JPEG: {}", e))?;
        },
        "png" => {
             if quality < 90 {
                let width = img.width();
                let height = img.height();
                let rgba = img.to_rgba8();
                let raw_pixels = rgba.as_raw();

                let nq = color_quant::NeuQuant::new(10, 256, raw_pixels);
                
                let ind_data: Vec<u8> = raw_pixels.chunks(4).map(|pix| nq.index_of(pix) as u8).collect();
                let color_map = nq.color_map_rgba();
                
                let mut encoder = png::Encoder::new(&mut output_buffer, width, height);
                encoder.set_color(png::ColorType::Indexed);
                encoder.set_depth(png::BitDepth::Eight);
                
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
