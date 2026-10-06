use wasm_bindgen::prelude::*;
use qrcode::{QrCode, EcLevel};
use qrcode::render::svg;
use image::{Rgba, RgbaImage, DynamicImage};
use std::io::Cursor;
use rxing;
use rxing::Reader; // Import the Reader trait to enable .decode_with_hints()
use rxing::Luma8LuminanceSource; // Import explicitly to avoid path issues

/// Parse hex color string (#RRGGBB or RRGGBB) to Rgba. Rejects non-ASCII
/// input up front so byte slicing below can never split a UTF-8 char (panic).
fn parse_hex_color(hex: &str) -> Result<Rgba<u8>, String> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("Invalid hex color: {}", hex));
    }
    let r = u8::from_str_radix(&hex[0..2], 16).map_err(|_| "Invalid red component")?;
    let g = u8::from_str_radix(&hex[2..4], 16).map_err(|_| "Invalid green component")?;
    let b = u8::from_str_radix(&hex[4..6], 16).map_err(|_| "Invalid blue component")?;
    Ok(Rgba([r, g, b, 255]))
}

/// Parse error correction level string to EcLevel
fn parse_ec_level(level: &str) -> EcLevel {
    match level.to_uppercase().as_str() {
        "L" => EcLevel::L,
        "M" => EcLevel::M,
        "Q" => EcLevel::Q,
        "H" => EcLevel::H,
        _ => EcLevel::M, // Default
    }
}

/// Draw a filled circle (for dots style)
fn draw_circle(img: &mut RgbaImage, cx: i32, cy: i32, radius: i32, color: Rgba<u8>) {
    let r2 = radius * radius;
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx * dx + dy * dy <= r2 {
                let px = cx + dx;
                let py = cy + dy;
                if px >= 0 && py >= 0 && (px as u32) < img.width() && (py as u32) < img.height() {
                    img.put_pixel(px as u32, py as u32, color);
                }
            }
        }
    }
}

/// Draw a rounded rectangle (for rounded style)
fn draw_rounded_rect(img: &mut RgbaImage, x: u32, y: u32, size: u32, radius: u32, color: Rgba<u8>) {
    let radius = radius.min(size / 2);
    
    for py in 0..size {
        for px in 0..size {
            let in_corner = |cx: u32, cy: u32| -> bool {
                let dx = if px < cx { cx - px } else { px - cx };
                let dy = if py < cy { cy - py } else { py - cy };
                dx * dx + dy * dy <= radius * radius
            };
            
            let inside = if px < radius && py < radius {
                // Top-left corner
                in_corner(radius, radius)
            } else if px >= size - radius && py < radius {
                // Top-right corner
                in_corner(size - radius - 1, radius)
            } else if px < radius && py >= size - radius {
                // Bottom-left corner
                in_corner(radius, size - radius - 1)
            } else if px >= size - radius && py >= size - radius {
                // Bottom-right corner
                in_corner(size - radius - 1, size - radius - 1)
            } else {
                true
            };
            
            if inside {
                let target_x = x + px;
                let target_y = y + py;
                if target_x < img.width() && target_y < img.height() {
                    img.put_pixel(target_x, target_y, color);
                }
            }
        }
    }
}

/// Largest logo box (logo + padding) as a fraction of the code width for an
/// error-correction level; the covered area (fraction²) stays well below the
/// level's recovery capacity (L 7%, M 15%, Q 25%, H 30%).
fn logo_box_fraction(ec: EcLevel) -> f32 {
    match ec {
        EcLevel::L => 0.15,
        EcLevel::M => 0.20,
        EcLevel::Q => 0.25,
        EcLevel::H => 0.30,
    }
}

/// Generate QR code as PNG bytes
/// 
/// # Arguments
/// * `data` - Text to encode
/// * `size` - Output image size in pixels
/// * `fg_color` - Foreground color as hex (#RRGGBB)
/// * `bg_color` - Background color as hex (#RRGGBB)
/// * `ec_level` - Error correction level (L, M, Q, H)
/// * `style` - Module style: "square", "dots", or "rounded"
/// * `logo_data` - Optional logo image bytes (PNG/WEBP)
#[wasm_bindgen]
pub fn generate_qr_png(
    data: &str,
    size: u32,
    fg_color: &str,
    bg_color: &str,
    ec_level: &str,
    style: &str,
    logo_data: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();
    
    let fg = parse_hex_color(fg_color)?;
    let bg = parse_hex_color(bg_color)?;
    let ec = parse_ec_level(ec_level);
    
    // Generate QR code
    let code = QrCode::with_error_correction_level(data.as_bytes(), ec)
        .map_err(|e| format!("QR generation failed: {}", e))?;
    
    let qr_size = code.width();
    let module_size = size / (qr_size as u32 + 8); // +8 for quiet zone
    if module_size == 0 {
        // Too many modules for the requested pixel size: one module < 1 px.
        return Err(format!("Image size too small: {} px for {} modules", size, qr_size + 8));
    }
    // The canvas is exactly `size` px (the size the user picked); the code is
    // centered, so the leftover from integer module sizes widens the quiet
    // zone (always >= 4 modules) instead of shrinking the image.
    let actual_size = size;
    let offset = (size - module_size * qr_size as u32) / 2;

    // Create image with background
    let mut img = RgbaImage::from_pixel(actual_size, actual_size, bg);
    
    // Render QR modules based on style
    let colors = code.to_colors();
    
    for y in 0..qr_size {
        for x in 0..qr_size {
            let idx = y * qr_size + x;
            if colors[idx] == qrcode::Color::Dark {
                let px = offset + (x as u32) * module_size;
                let py = offset + (y as u32) * module_size;
                
                // Finder patterns (three 7x7 corners) stay square in every style:
                // dotted/rounded finders are not detected by ZXing-family scanners.
                let finder = (x < 7 && y < 7) || (x >= qr_size - 7 && y < 7) || (x < 7 && y >= qr_size - 7);
                let module_style = if finder { "square" } else { style };
                match module_style {
                    "dots" => {
                        let cx = (px + module_size / 2) as i32;
                        let cy = (py + module_size / 2) as i32;
                        let radius = (module_size / 2) as i32;
                        draw_circle(&mut img, cx, cy, radius.max(1), fg);
                    }
                    "rounded" => {
                        let corner_radius = module_size / 3;
                        draw_rounded_rect(&mut img, px, py, module_size, corner_radius, fg);
                    }
                    _ => {
                        // Square (default)
                        for dy in 0..module_size {
                            for dx in 0..module_size {
                                img.put_pixel(px + dx, py + dy, fg);
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Overlay logo if provided
    if let Some(logo_bytes) = logo_data {
        if !logo_bytes.is_empty() {
            if let Ok(logo_img) = image::load_from_memory(&logo_bytes) {
                // The logo (with its padding) must stay within what error
                // correction can recover. It used to be 1/4 of the whole
                // image, which on short content hid ~18% of the modules and
                // made the code unreadable even at level H. Now its box is a
                // fraction of the code width per level (area ≈ 9% at H).
                let padding = module_size;
                let code_px = module_size * qr_size as u32;
                let box_max = (code_px as f32 * logo_box_fraction(ec)) as u32;
                let logo_max_size = box_max.saturating_sub(padding * 2).max(1);
                let logo = logo_img.resize(
                    logo_max_size,
                    logo_max_size,
                    image::imageops::FilterType::Lanczos3
                );
                
                // Center position
                let logo_x = (actual_size - logo.width()) / 2;
                let logo_y = (actual_size - logo.height()) / 2;
                
                // Draw white background for logo (improves scanning)
                let bg_x = logo_x.saturating_sub(padding);
                let bg_y = logo_y.saturating_sub(padding);
                let bg_w = logo.width() + padding * 2;
                let bg_h = logo.height() + padding * 2;
                
                for py in bg_y..(bg_y + bg_h).min(actual_size) {
                    for px in bg_x..(bg_x + bg_w).min(actual_size) {
                        img.put_pixel(px, py, bg);
                    }
                }
                
                // Overlay logo with alpha blending
                for (lx, ly, pixel) in logo.to_rgba8().enumerate_pixels() {
                    let tx = logo_x + lx;
                    let ty = logo_y + ly;
                    if tx < actual_size && ty < actual_size {
                        let alpha = pixel[3] as f32 / 255.0;
                        if alpha > 0.0 {
                            let base = img.get_pixel(tx, ty);
                            let blended = Rgba([
                                ((1.0 - alpha) * base[0] as f32 + alpha * pixel[0] as f32) as u8,
                                ((1.0 - alpha) * base[1] as f32 + alpha * pixel[1] as f32) as u8,
                                ((1.0 - alpha) * base[2] as f32 + alpha * pixel[2] as f32) as u8,
                                255,
                            ]);
                            img.put_pixel(tx, ty, blended);
                        }
                    }
                }
            }
        }
    }
    
    // Encode to PNG
    let mut output = Vec::new();
    let mut cursor = Cursor::new(&mut output);
    
    let dyn_img = DynamicImage::ImageRgba8(img);
    dyn_img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encoding failed: {}", e))?;
    
    Ok(output)
}

/// Generate QR code as SVG string (for vector output)
#[wasm_bindgen]
pub fn generate_qr_svg(
    data: &str,
    fg_color: &str,
    bg_color: &str,
    ec_level: &str,
) -> Result<String, String> {
    console_error_panic_hook::set_once();
    
    // Colors are interpolated into SVG attributes: accept only #RRGGBB.
    parse_hex_color(fg_color)?;
    parse_hex_color(bg_color)?;
    let ec = parse_ec_level(ec_level);
    
    let code = QrCode::with_error_correction_level(data.as_bytes(), ec)
        .map_err(|e| format!("QR generation failed: {}", e))?;
    
    let svg = code.render()
        .min_dimensions(200, 200)
        .dark_color(svg::Color(fg_color))
        .light_color(svg::Color(bg_color))
        .build();
    
    Ok(svg)
}

/// Decode QR code from image bytes
/// Returns the decoded text content
#[wasm_bindgen]
pub fn decode_qr(image_bytes: &[u8]) -> Result<String, String> {
    console_error_panic_hook::set_once();

    let img = image::load_from_memory(image_bytes)
        .map_err(|e| format!("Failed to load image: {}", e))?;
    decode_luma(img.to_luma8())
}

/// Decode a QR code from raw RGBA pixels (camera frames: `ImageData.data`,
/// width×height×4 bytes) — skips PNG/JPEG encoding of every video frame.
#[wasm_bindgen]
pub fn decode_qr_rgba(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    console_error_panic_hook::set_once();
    let expected = (width as usize) * (height as usize) * 4;
    if width == 0 || height == 0 || rgba.len() != expected {
        return Err(format!("Failed to load image: expected {} RGBA bytes for {}x{}, got {}", expected, width, height, rgba.len()));
    }
    let img = RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| "Failed to load image: invalid RGBA buffer".to_string())?;
    decode_luma(DynamicImage::ImageRgba8(img).to_luma8())
}

/// Shared rxing decode of a grayscale image (TRY_HARDER, all formats).
fn decode_luma(mut luma_img: image::GrayImage) -> Result<String, String> {
    // rxing's HybridBinarizer falls back to the global-histogram binarizer
    // below 40x40 px, and BinaryBitmap::get_black_matrix unwraps its error
    // (panic → WASM trap on low-contrast tiny images). Upscale tiny images
    // (nearest neighbour keeps module edges sharp) so that path is never hit.
    const MIN_DECODE_DIM: u32 = 40;
    let min_dim = luma_img.width().min(luma_img.height());
    if min_dim < MIN_DECODE_DIM {
        let k = MIN_DECODE_DIM.div_ceil(min_dim.max(1));
        luma_img = image::imageops::resize(
            &luma_img,
            luma_img.width() * k,
            luma_img.height() * k,
            image::imageops::FilterType::Nearest,
        );
    }
    let width = luma_img.width();
    let height = luma_img.height();
    let raw_pixels = luma_img.into_raw();
    
    let source = Luma8LuminanceSource::new(raw_pixels, width, height);
    
    let mut hints = rxing::DecodingHintDictionary::default();
    hints.insert(rxing::DecodeHintType::TRY_HARDER, rxing::DecodeHintValue::TryHarder(true));
    
    let result = rxing::MultiFormatReader::default().decode_with_hints(&mut rxing::BinaryBitmap::new(rxing::common::HybridBinarizer::new(source)), &hints)
         .map_err(|e| format!("Decoding failed: {}", e))?;

    Ok(result.getText().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(data: &str, ec: &str, style: &str, logo: Option<Vec<u8>>) -> Vec<u8> {
        generate_qr_png(data, 512, "#000000", "#FFFFFF", ec, style, logo).expect("generate png")
    }

    fn solid_png(w: u32, h: u32, rgba: [u8; 4]) -> Vec<u8> {
        let img = RgbaImage::from_pixel(w, h, Rgba(rgba));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn png_round_trip_all_styles_and_levels() {
        for style in ["square", "dots", "rounded"] {
            for ec in ["L", "M", "Q", "H"] {
                let text = format!("https://example.com/?s={style}&ec={ec}");
                let bytes = png(&text, ec, style, None);
                assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
                assert_eq!(decode_qr(&bytes).unwrap(), text, "style={style} ec={ec}");
                // Smallest UI size (256 px) with a longer payload: smaller modules.
                let long = format!("{text}&pad={}", "x".repeat(120));
                let small = generate_qr_png(&long, 256, "#000000", "#FFFFFF", ec, style, None).unwrap();
                assert_eq!(decode_qr(&small).unwrap(), long, "256px style={style} ec={ec}");
            }
        }
    }

    #[test]
    fn png_round_trip_unicode_and_emoji() {
        let text = "Привет, мир! 日本語 🚀✨";
        assert_eq!(decode_qr(&png(text, "M", "square", None)).unwrap(), text);
    }

    #[test]
    fn png_round_trip_with_logo_at_high_ec() {
        let logo = solid_png(64, 64, [220, 40, 40, 255]);
        let text = "logo round trip";
        assert_eq!(decode_qr(&png(text, "H", "square", Some(logo))).unwrap(), text);
    }

    #[test]
    fn logo_codes_decode_for_short_content_all_styles_and_sizes() {
        // Transparent-background logo, as users typically upload.
        let mut logo = RgbaImage::from_pixel(256, 256, Rgba([0, 0, 0, 0]));
        for (x, y, p) in logo.enumerate_pixels_mut() {
            let (dx, dy) = (x as i32 - 128, y as i32 - 128);
            if dx * dx + dy * dy < 100 * 100 {
                *p = Rgba([225, 29, 72, 255]);
            }
        }
        let mut logo_png = Vec::new();
        DynamicImage::ImageRgba8(logo).write_to(&mut Cursor::new(&mut logo_png), image::ImageFormat::Png).unwrap();
        for ec in ["Q", "H"] {
            for style in ["square", "dots", "rounded"] {
                for size in [256u32, 512, 1024] {
                    for text in ["Branded code", "https://example.com/some/longer/path?with=query"] {
                        let bytes = generate_qr_png(text, size, "#000000", "#FFFFFF", ec, style, Some(logo_png.clone())).unwrap();
                        assert_eq!(decode_qr(&bytes).as_deref(), Ok(text), "{ec} {style} {size} {text}");
                    }
                }
            }
        }
    }

    #[test]
    fn decode_qr_rgba_reads_raw_frames_and_validates_length() {
        let png_bytes = png("camera frame", "M", "square", None);
        let rgba = image::load_from_memory(&png_bytes).unwrap().to_rgba8();
        let (w, h) = rgba.dimensions();
        assert_eq!(decode_qr_rgba(rgba.as_raw(), w, h).unwrap(), "camera frame");
        assert!(decode_qr_rgba(&rgba.as_raw()[..100], w, h).unwrap_err().starts_with("Failed to load image"));
        assert!(decode_qr_rgba(&[], 0, 0).is_err());
        let blank = vec![255u8; 64 * 48 * 4];
        assert!(decode_qr_rgba(&blank, 64, 48).unwrap_err().starts_with("Decoding failed"));
    }

    #[test]
    fn png_respects_colors_and_size() {
        let bytes = generate_qr_png("abc", 256, "#112233", "#ffeedd", "M", "square", None).unwrap();
        let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!((img.width(), img.height()), (256, 256), "PNG must be exactly the requested size");
        assert_eq!(*img.get_pixel(0, 0), Rgba([0xff, 0xee, 0xdd, 255]));
        assert!(img.pixels().any(|p| *p == Rgba([0x11, 0x22, 0x33, 255])));
    }

    #[test]
    fn png_is_exactly_the_requested_size_and_decodes() {
        for size in [256u32, 512, 1024, 2048] {
            let bytes = generate_qr_png("https://example.com", size, "#000000", "#FFFFFF", "M", "dots", None).unwrap();
            let img = image::load_from_memory(&bytes).unwrap();
            assert_eq!((img.width(), img.height()), (size, size));
            assert_eq!(decode_qr(&bytes).unwrap(), "https://example.com");
        }
    }

    #[test]
    fn invalid_logo_bytes_are_ignored() {
        let text = "bad logo";
        let bytes = png(text, "H", "square", Some(vec![1, 2, 3, 4]));
        assert_eq!(decode_qr(&bytes).unwrap(), text);
    }

    #[test]
    fn capacity_limits_per_level() {
        // Byte-mode capacity of version 40: L=2953, H=1273.
        assert!(generate_qr_svg(&"a".repeat(2953), "#000000", "#FFFFFF", "L").is_ok());
        let err = generate_qr_svg(&"a".repeat(2954), "#000000", "#FFFFFF", "L").unwrap_err();
        assert!(err.contains("too long"), "{err}");
        assert!(generate_qr_svg(&"a".repeat(1273), "#000000", "#FFFFFF", "H").is_ok());
        assert!(generate_qr_png(&"a".repeat(1274), 512, "#000000", "#FFFFFF", "H", "square", None)
            .unwrap_err()
            .contains("too long"));
    }

    #[test]
    fn max_version_fits_smallest_ui_size() {
        // 177 modules + quiet zone at 256 px still renders (1 px per module).
        assert!(generate_qr_png(&"a".repeat(2953), 256, "#000000", "#FFFFFF", "L", "square", None).is_ok());
        assert!(generate_qr_png("abc", 10, "#000000", "#FFFFFF", "M", "square", None)
            .unwrap_err()
            .contains("too small"));
    }

    #[test]
    fn invalid_colors_are_errors_not_panics() {
        for bad in ["#12345", "#1234567", "zzzzzz", "", "#aéabc", "éééé"] {
            assert!(parse_hex_color(bad).is_err(), "{bad:?}");
            assert!(generate_qr_svg("x", bad, "#FFFFFF", "M").is_err(), "{bad:?}");
            assert!(generate_qr_png("x", 256, "#000000", bad, "M", "square", None).is_err(), "{bad:?}");
        }
        assert_eq!(parse_hex_color("aBcDeF").unwrap(), Rgba([0xab, 0xcd, 0xef, 255]));
    }

    #[test]
    fn svg_output_uses_colors() {
        let svg = generate_qr_svg("hello", "#123456", "#FEDCBA", "Q").unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("#123456") && svg.contains("#FEDCBA"));
    }

    #[test]
    fn unknown_ec_level_defaults_to_m() {
        assert_eq!(parse_ec_level("x"), EcLevel::M);
        assert_eq!(parse_ec_level("h"), EcLevel::H);
    }

    #[test]
    fn decode_rejects_garbage_and_blank_images() {
        assert!(decode_qr(&[0, 1, 2, 3]).unwrap_err().starts_with("Failed to load image"));
        assert!(decode_qr(&[]).is_err());
        let blank = solid_png(100, 100, [255, 255, 255, 255]);
        assert!(decode_qr(&blank).unwrap_err().starts_with("Decoding failed"));
    }

    #[test]
    fn decode_tiny_uniform_images_is_an_error_not_a_panic() {
        // < 40 px used to hit an unwrap() inside rxing's binarizer.
        for (w, h) in [(1, 1), (1, 300), (39, 39), (20, 60)] {
            for rgba in [[255, 255, 255, 255], [0, 0, 0, 255], [128, 128, 128, 0]] {
                assert!(decode_qr(&solid_png(w, h, rgba)).is_err(), "{w}x{h} {rgba:?}");
            }
        }
    }

    #[test]
    fn decode_small_qr_image_is_upscaled() {
        // Version-1 code at 1 px per module (29x29 with quiet zone) still decodes.
        let code = QrCode::with_error_correction_level(b"tiny", EcLevel::L).unwrap();
        let w = code.width() as u32;
        let colors = code.to_colors();
        let img = RgbaImage::from_fn(w + 8, w + 8, |x, y| {
            let dark = x >= 4 && y >= 4 && x < w + 4 && y < w + 4
                && colors[((y - 4) * w + (x - 4)) as usize] == qrcode::Color::Dark;
            if dark { Rgba([0, 0, 0, 255]) } else { Rgba([255, 255, 255, 255]) }
        });
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img).write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        assert_eq!(decode_qr(&out).unwrap(), "tiny");
    }
}
