use wasm_bindgen::prelude::*;
use qrcode::{QrCode, EcLevel};
use qrcode::render::svg;
use image::{Rgba, RgbaImage, DynamicImage, GenericImageView};
use std::io::Cursor;

/// Parse hex color string (#RRGGBB or RRGGBB) to Rgba
fn parse_hex_color(hex: &str) -> Result<Rgba<u8>, String> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
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
    let actual_size = module_size * (qr_size as u32 + 8);
    let offset = module_size * 4; // Quiet zone offset
    
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
                
                match style {
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
                // Logo should be ~20-25% of QR code size
                let logo_max_size = actual_size / 4;
                let logo = logo_img.resize(
                    logo_max_size,
                    logo_max_size,
                    image::imageops::FilterType::Lanczos3
                );
                
                // Center position
                let logo_x = (actual_size - logo.width()) / 2;
                let logo_y = (actual_size - logo.height()) / 2;
                
                // Draw white background for logo (improves scanning)
                let padding = module_size;
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
