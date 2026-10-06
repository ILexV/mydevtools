use image::codecs::jpeg::JpegEncoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Rgb, RgbImage};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

/// Largest width/height accepted by `resize_image` (pixels per side).
pub const MAX_DIMENSION: u32 = 16_384;
/// Largest output pixel count accepted by `resize_image` (~64 MP, ≈256 MiB RGBA).
pub const MAX_PIXELS: u64 = 64 * 1024 * 1024;
/// ICO entries are at most 256×256; larger sources are downscaled to fit.
const ICO_MAX_SIDE: u32 = 256;

/// Re-encode an image into `format_str` (jpeg/jpg/png/webp/gif/bmp/ico/tiff/tga).
/// Quality 1-100 applies to JPEG; PNG below 90 is palette-quantized (lossy).
#[wasm_bindgen]
pub fn compress_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();
    let img = decode(input_data)?;
    encode_dynamic_image(&img, format_str, quality)
}

/// Image format conversion — same pipeline as `compress_image`.
#[wasm_bindgen]
pub fn convert_image(input_data: &[u8], format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    compress_image(input_data, format_str, quality)
}

/// Resize to exactly width×height (Lanczos3) and encode (quality 90). Rejects
/// zero or oversized dimensions before allocating, so a typo cannot OOM the tab.
#[wasm_bindgen]
pub fn resize_image(input_data: &[u8], width: u32, height: u32, format_str: &str) -> Result<Vec<u8>, String> {
    console_error_panic_hook::set_once();
    validate_dimensions(width, height)?;
    let img = decode(input_data)?;
    let resized = img.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
    encode_dynamic_image(&resized, format_str, 90)
}

/// Decode any supported input. TGA has no magic number, so unrecognized bytes
/// are tried as TGA (otherwise .tga uploads always failed). The EXIF/TIFF
/// orientation tag is applied to the pixels: re-encoding drops the metadata,
/// so a rotated phone photo would otherwise come out sideways.
fn decode(input_data: &[u8]) -> Result<DynamicImage, String> {
    if input_data.is_empty() {
        return Err("Failed to load image: empty input".to_string());
    }
    let fail = |e: image::ImageError| format!("Failed to load image: {}", e);
    let mut reader = ImageReader::new(Cursor::new(input_data))
        .with_guessed_format()
        .map_err(|e| format!("Failed to load image: {}", e))?;
    if reader.format().is_none() {
        reader.set_format(ImageFormat::Tga);
    }
    let mut decoder = reader.into_decoder().map_err(fail)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(fail)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("Invalid dimensions: width and height must be positive".to_string());
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION || (width as u64) * (height as u64) > MAX_PIXELS {
        return Err(format!(
            "Dimensions too large: {}x{} (max {} px per side, {} MP)",
            width,
            height,
            MAX_DIMENSION,
            MAX_PIXELS / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 8-bit RGB(A)/Luma copy of `img` — most encoders reject 16-bit/float buffers.
fn to_8bit(img: &DynamicImage) -> DynamicImage {
    match img {
        DynamicImage::ImageLuma8(_)
        | DynamicImage::ImageLumaA8(_)
        | DynamicImage::ImageRgb8(_)
        | DynamicImage::ImageRgba8(_) => img.clone(),
        _ if img.color().has_alpha() => DynamicImage::ImageRgba8(img.to_rgba8()),
        _ => DynamicImage::ImageRgb8(img.to_rgb8()),
    }
}

/// JPEG has no alpha channel: composite transparent pixels over white instead
/// of dropping alpha (which would turn transparent areas black).
fn flatten_on_white(img: &DynamicImage) -> DynamicImage {
    if !img.color().has_alpha() {
        return match img {
            DynamicImage::ImageLuma8(_) | DynamicImage::ImageRgb8(_) => img.clone(),
            _ => DynamicImage::ImageRgb8(img.to_rgb8()),
        };
    }
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
        let a = src[3] as u32;
        let blend = |c: u8| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
        *dst = Rgb([blend(src[0]), blend(src[1]), blend(src[2])]);
    }
    DynamicImage::ImageRgb8(out)
}

fn write_as(img: &DynamicImage, format: ImageFormat, label: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), format)
        .map_err(|e| format!("Failed to encode {}: {}", label, e))?;
    Ok(out)
}

fn encode_dynamic_image(img: &DynamicImage, format_str: &str, quality: u8) -> Result<Vec<u8>, String> {
    let quality = quality.clamp(1, 100);
    match format_str.to_lowercase().as_str() {
        "jpeg" | "jpg" => {
            let flat = flatten_on_white(img);
            let mut out = Vec::new();
            let encoder = JpegEncoder::new_with_quality(&mut out, quality);
            flat.write_with_encoder(encoder)
                .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
            Ok(out)
        }
        "png" if quality < 90 => encode_png_quantized(img),
        "png" => {
            let mut out = Vec::new();
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                &mut out,
                image::codecs::png::CompressionType::Best,
                image::codecs::png::FilterType::Adaptive,
            );
            img.write_with_encoder(encoder).map_err(|e| format!("Failed to encode PNG: {}", e))?;
            Ok(out)
        }
        // image-rs only ships a lossless WebP encoder; quality has no effect.
        "webp" => write_as(&DynamicImage::ImageRgba8(img.to_rgba8()), ImageFormat::WebP, "WebP"),
        "gif" => write_as(&DynamicImage::ImageRgba8(img.to_rgba8()), ImageFormat::Gif, "GIF"),
        "bmp" => write_as(&to_8bit(img), ImageFormat::Bmp, "BMP"),
        "tiff" | "tif" => write_as(&to_8bit(img), ImageFormat::Tiff, "TIFF"),
        "tga" => write_as(&to_8bit(img), ImageFormat::Tga, "TGA"),
        "ico" => {
            let fitted = if img.width() > ICO_MAX_SIDE || img.height() > ICO_MAX_SIDE {
                img.resize(ICO_MAX_SIDE, ICO_MAX_SIDE, image::imageops::FilterType::Lanczos3)
            } else {
                img.clone()
            };
            write_as(&DynamicImage::ImageRgba8(fitted.to_rgba8()), ImageFormat::Ico, "ICO")
        }
        _ => Err(format!("Unsupported target format: {}", format_str)),
    }
}

/// Lossy PNG: NeuQuant to a 256-colour palette with per-entry alpha (tRNS).
fn encode_png_quantized(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let rgba = img.to_rgba8();
    let raw_pixels = rgba.as_raw();
    let nq = color_quant::NeuQuant::new(10, 256, raw_pixels);
    let ind_data: Vec<u8> = raw_pixels.chunks(4).map(|pix| nq.index_of(pix) as u8).collect();
    let color_map = nq.color_map_rgba();

    let mut encoder = png::Encoder::new(&mut out, img.width(), img.height());
    encoder.set_color(png::ColorType::Indexed);
    encoder.set_depth(png::BitDepth::Eight);
    let mut palette = Vec::with_capacity(256 * 3);
    let mut trns = Vec::with_capacity(256);
    for chunk in color_map.chunks(4) {
        palette.extend_from_slice(&chunk[..3]);
        trns.push(chunk[3]);
    }
    encoder.set_palette(palette);
    encoder.set_trns(trns);

    let mut writer = encoder.write_header().map_err(|e| format!("PNG Header error: {}", e))?;
    writer.write_image_data(&ind_data).map_err(|e| format!("PNG Write error: {}", e))?;
    writer.finish().map_err(|e| format!("PNG finish error: {}", e))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, ImageBuffer, Luma, Rgba};

    fn rgba_png(w: u32, h: u32, alpha: u8) -> Vec<u8> {
        let img = ImageBuffer::from_fn(w, h, |x, y| Rgba([(x * 7) as u8, (y * 5) as u8, 128, alpha]));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn rgb_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = ImageBuffer::from_fn(w, h, |x, y| Rgb([(x * 3) as u8, (y * 3) as u8, 200]));
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg)
            .unwrap();
        out
    }

    fn gray16_png(w: u32, h: u32) -> Vec<u8> {
        let img: ImageBuffer<Luma<u16>, Vec<u16>> = ImageBuffer::from_fn(w, h, |x, _| Luma([(x * 1000) as u16]));
        let mut out = Vec::new();
        DynamicImage::ImageLuma16(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn sniff(bytes: &[u8]) -> ImageFormat {
        image::guess_format(bytes).expect("recognizable output")
    }

    #[test]
    fn converts_to_every_offered_target_with_correct_signature() {
        let src = rgba_png(40, 30, 200);
        let cases = [
            ("png", ImageFormat::Png),
            ("jpeg", ImageFormat::Jpeg),
            ("jpg", ImageFormat::Jpeg),
            ("webp", ImageFormat::WebP),
            ("gif", ImageFormat::Gif),
            ("bmp", ImageFormat::Bmp),
            ("ico", ImageFormat::Ico),
            ("tiff", ImageFormat::Tiff),
        ];
        for (fmt, expected) in cases {
            let out = convert_image(&src, fmt, 90).unwrap_or_else(|e| panic!("{fmt}: {e}"));
            assert_eq!(sniff(&out), expected, "{fmt}");
            let back = image::load_from_memory(&out).unwrap();
            assert_eq!(back.dimensions(), (40, 30), "{fmt} keeps dimensions");
        }
        // TGA has no magic number: decode explicitly.
        let tga = convert_image(&src, "tga", 90).unwrap();
        let back = image::load_from_memory_with_format(&tga, ImageFormat::Tga).unwrap();
        assert_eq!(back.dimensions(), (40, 30));
    }

    #[test]
    fn jpeg_from_transparent_png_flattens_on_white() {
        let src = rgba_png(16, 16, 0); // fully transparent
        let out = compress_image(&src, "jpeg", 90).unwrap();
        assert_eq!(sniff(&out), ImageFormat::Jpeg);
        let px = image::load_from_memory(&out).unwrap().to_rgb8();
        let p = px.get_pixel(8, 8);
        assert!(p.0.iter().all(|&c| c > 240), "transparent → white, got {:?}", p);
    }

    #[test]
    fn sixteen_bit_source_encodes_to_8bit_targets() {
        let src = gray16_png(20, 10);
        for fmt in ["jpeg", "bmp", "tga", "tiff", "gif", "webp", "ico", "png"] {
            let out = convert_image(&src, fmt, 80).unwrap_or_else(|e| panic!("{fmt}: {e}"));
            assert!(!out.is_empty(), "{fmt}");
        }
    }

    #[test]
    fn ico_downscales_large_sources_to_256() {
        let src = rgba_png(600, 300, 255);
        let out = convert_image(&src, "ico", 90).unwrap();
        let back = image::load_from_memory(&out).unwrap();
        assert_eq!(back.dimensions(), (256, 128));
    }

    #[test]
    fn jpeg_quality_controls_size() {
        let src = rgb_jpeg(128, 128);
        let low = compress_image(&src, "jpeg", 10).unwrap();
        let high = compress_image(&src, "jpeg", 95).unwrap();
        assert!(low.len() < high.len(), "q10 {} < q95 {}", low.len(), high.len());
    }

    #[test]
    fn png_below_90_is_palette_quantized() {
        let src = rgba_png(64, 64, 255);
        let out = compress_image(&src, "png", 50).unwrap();
        let decoder = png::Decoder::new(Cursor::new(&out));
        let reader = decoder.read_info().unwrap();
        assert_eq!(reader.info().color_type, png::ColorType::Indexed);
        let lossless = compress_image(&src, "png", 95).unwrap();
        let reader = png::Decoder::new(Cursor::new(&lossless)).read_info().unwrap();
        assert_ne!(reader.info().color_type, png::ColorType::Indexed);
    }

    #[test]
    fn quality_zero_is_clamped_not_rejected() {
        let src = rgb_jpeg(8, 8);
        assert!(compress_image(&src, "jpeg", 0).is_ok());
    }

    #[test]
    fn resize_produces_exact_dimensions() {
        let src = rgba_png(100, 50, 255);
        for fmt in ["jpeg", "png", "webp"] {
            let out = resize_image(&src, 37, 81, fmt).unwrap();
            let back = image::load_from_memory(&out).unwrap();
            assert_eq!(back.dimensions(), (37, 81), "{fmt}");
        }
    }

    #[test]
    fn resize_rejects_zero_and_oversized_dimensions() {
        let src = rgba_png(4, 4, 255);
        assert!(resize_image(&src, 0, 10, "png").unwrap_err().contains("Invalid dimensions"));
        assert!(resize_image(&src, 10, 0, "png").unwrap_err().contains("Invalid dimensions"));
        // A negative JS number wraps to a huge u32 — must be rejected, not allocated.
        assert!(resize_image(&src, u32::MAX - 4, 10, "png").unwrap_err().contains("too large"));
        assert!(resize_image(&src, MAX_DIMENSION, MAX_DIMENSION, "png").unwrap_err().contains("too large"));
        assert!(resize_image(&src, MAX_DIMENSION + 1, 1, "png").is_err());
        assert!(resize_image(&src, MAX_DIMENSION, 1, "png").is_ok());
    }

    #[test]
    fn tga_input_is_decoded_despite_missing_magic() {
        let tga = convert_image(&rgba_png(40, 30, 255), "tga", 90).unwrap();
        let png = convert_image(&tga, "png", 100).unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().dimensions(), (40, 30));
        assert!(resize_image(&tga, 20, 15, "jpeg").is_ok());
    }

    /// JPEG 4×2 with an EXIF APP1 segment carrying Orientation = 6 (rotate 90° CW).
    fn jpeg_with_orientation_6() -> Vec<u8> {
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode_image(&DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 2, Rgb([200, 10, 10]))))
            .unwrap();
        let mut tiff = b"II*\0\x08\0\0\0".to_vec(); // little-endian, IFD at 8
        tiff.extend_from_slice(&[1, 0]); // 1 entry
        tiff.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]); // Orientation=6
        tiff.extend_from_slice(&[0, 0, 0, 0]); // no next IFD
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        let len = (app1.len() + 2) as u16;
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]); // skip the encoder's SOI
        out
    }

    #[test]
    fn exif_orientation_is_applied_before_reencoding() {
        let src = jpeg_with_orientation_6();
        for fmt in ["jpeg", "png", "webp"] {
            let out = compress_image(&src, fmt, 90).unwrap();
            assert_eq!(image::load_from_memory(&out).unwrap().dimensions(), (2, 4), "{fmt}");
        }
    }

    #[test]
    fn invalid_input_and_format_return_errors() {
        assert!(compress_image(&[], "png", 80).unwrap_err().contains("empty input"));
        assert!(compress_image(b"not an image at all", "png", 80)
            .unwrap_err()
            .starts_with("Failed to load image"));
        let mut truncated = rgba_png(32, 32, 255);
        truncated.truncate(truncated.len() / 2);
        assert!(compress_image(&truncated, "png", 80).is_err());
        let src = rgba_png(4, 4, 255);
        assert!(convert_image(&src, "heic", 80).unwrap_err().contains("Unsupported target format"));
    }
}
