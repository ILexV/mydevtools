//! Streaming compression for the archive explorer and the compression benchmark.
//!
//! `Encoder` compresses pushed chunks with gzip, raw deflate, zlib, Brotli or Zstandard.
//! `Decoder` is pull-based: input is written, and every `read(max)` returns at most `max`
//! output bytes, so a compression bomb can never inflate more than one window into memory.
//! Errors are strings prefixed with a code: `invalid:`, `corrupt:`, `truncated:`, `checksum:`.

use std::io::Write;

use brotli::enc::StandardAlloc;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};
use flate2::{Compression, Decompress, FlushDecompress, Status};
use wasm_bindgen::prelude::*;
use zstd::stream::raw::{InBuffer, Operation, OutBuffer};

#[wasm_bindgen]
pub fn version() -> String {
    "mydevtools_compression@0.1.0".to_string()
}

fn fail(code: &str, message: impl std::fmt::Display) -> String {
    format!("{code}: {message}")
}

fn js(error: String) -> JsValue {
    JsValue::from_str(&error)
}

/// Inclusive level range of a codec; the benchmark page reads it to build its inputs.
#[wasm_bindgen]
pub fn level_range(codec: &str) -> Result<Vec<i32>, JsValue> {
    levels(codec).map_err(js)
}

fn levels(codec: &str) -> Result<Vec<i32>, String> {
    match codec {
        "gzip" | "deflate" | "zlib" => Ok(vec![0, 9]),
        "brotli" => Ok(vec![0, 11]),
        "zstd" => Ok(vec![1, 22]),
        _ => Err(fail("invalid", format!("unknown codec {codec}"))),
    }
}

fn check_level(codec: &str, level: i32) -> Result<(), String> {
    let range = levels(codec)?;
    if level < range[0] || level > range[1] {
        return Err(fail("invalid", format!("{codec} level must be {}..{}", range[0], range[1])));
    }
    Ok(())
}

enum Enc {
    Gzip(flate2::write::GzEncoder<Vec<u8>>),
    Deflate(flate2::write::DeflateEncoder<Vec<u8>>),
    Zlib(flate2::write::ZlibEncoder<Vec<u8>>),
    Brotli(Box<brotli::CompressorWriter<Vec<u8>>>),
    Zstd(zstd::stream::write::Encoder<'static, Vec<u8>>),
    Done,
}

/// Streaming compressor. `push` returns the bytes produced so far; `finish` the rest.
/// The CRC-32 of all pushed input is kept for ZIP entries and gzip checks.
#[wasm_bindgen]
pub struct Encoder {
    enc: Enc,
    crc: crc32fast::Hasher,
}

#[wasm_bindgen]
impl Encoder {
    /// `size_hint` is the exact input size when known (negative = unknown); Zstandard records
    /// it in the frame header and Brotli tunes its window. `name` goes into the gzip header.
    #[wasm_bindgen(constructor)]
    pub fn new(codec: &str, level: i32, size_hint: f64, name: Option<String>) -> Result<Encoder, JsValue> {
        Encoder::create(codec, level, size_hint, name).map_err(js)
    }

    pub fn push(&mut self, input: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.push_bytes(input).map_err(js)
    }

    pub fn finish(&mut self) -> Result<Vec<u8>, JsValue> {
        self.finish_bytes().map_err(js)
    }

    pub fn crc32(&self) -> u32 {
        self.crc.clone().finalize()
    }
}

impl Encoder {
    fn create(codec: &str, level: i32, size_hint: f64, name: Option<String>) -> Result<Encoder, String> {
        check_level(codec, level)?;
        let known = size_hint >= 0.0 && size_hint.is_finite();
        let enc = match codec {
            "gzip" => {
                let mut builder = flate2::GzBuilder::new();
                if let Some(name) = name.filter(|n| !n.is_empty()) {
                    let bytes: Vec<u8> = name.into_bytes().into_iter().filter(|&b| b != 0).collect();
                    builder = builder.filename(bytes);
                }
                Enc::Gzip(builder.write(Vec::new(), Compression::new(level as u32)))
            }
            "deflate" => Enc::Deflate(flate2::write::DeflateEncoder::new(Vec::new(), Compression::new(level as u32))),
            "zlib" => Enc::Zlib(flate2::write::ZlibEncoder::new(Vec::new(), Compression::new(level as u32))),
            "brotli" => {
                let mut params = brotli::enc::BrotliEncoderParams::default();
                params.quality = level;
                params.lgwin = 22;
                if known {
                    params.size_hint = size_hint.min(usize::MAX as f64) as usize;
                }
                Enc::Brotli(Box::new(brotli::CompressorWriter::with_params(Vec::new(), 64 * 1024, &params)))
            }
            "zstd" => {
                let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), level).map_err(|e| fail("invalid", e))?;
                encoder.include_checksum(true).map_err(|e| fail("invalid", e))?;
                if known {
                    encoder.set_pledged_src_size(Some(size_hint as u64)).map_err(|e| fail("invalid", e))?;
                }
                Enc::Zstd(encoder)
            }
            _ => return Err(fail("invalid", format!("unknown codec {codec}"))),
        };
        Ok(Encoder { enc, crc: crc32fast::Hasher::new() })
    }

    fn push_bytes(&mut self, input: &[u8]) -> Result<Vec<u8>, String> {
        self.crc.update(input);
        let io = |e: std::io::Error| fail("invalid", e);
        Ok(match &mut self.enc {
            Enc::Gzip(w) => { w.write_all(input).map_err(io)?; std::mem::take(w.get_mut()) }
            Enc::Deflate(w) => { w.write_all(input).map_err(io)?; std::mem::take(w.get_mut()) }
            Enc::Zlib(w) => { w.write_all(input).map_err(io)?; std::mem::take(w.get_mut()) }
            Enc::Brotli(w) => { w.write_all(input).map_err(io)?; std::mem::take(w.get_mut()) }
            Enc::Zstd(w) => { w.write_all(input).map_err(io)?; std::mem::take(w.get_mut()) }
            Enc::Done => return Err(fail("invalid", "the encoder is finished")),
        })
    }

    fn finish_bytes(&mut self) -> Result<Vec<u8>, String> {
        let io = |e: std::io::Error| fail("invalid", e);
        match std::mem::replace(&mut self.enc, Enc::Done) {
            Enc::Gzip(w) => w.finish().map_err(io),
            Enc::Deflate(w) => w.finish().map_err(io),
            Enc::Zlib(w) => w.finish().map_err(io),
            Enc::Brotli(mut w) => { w.flush().map_err(io)?; Ok(w.into_inner()) }
            Enc::Zstd(w) => w.finish().map_err(io),
            Enc::Done => Err(fail("invalid", "the encoder is finished")),
        }
    }
}

/// CRC-32 (ZIP, gzip) of a byte stream, for stored ZIP entries and verification.
#[wasm_bindgen]
pub struct Crc32 {
    inner: crc32fast::Hasher,
}

#[wasm_bindgen]
impl Crc32 {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Crc32 {
        Crc32 { inner: crc32fast::Hasher::new() }
    }
    pub fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }
    pub fn value(&self) -> u32 {
        self.inner.clone().finalize()
    }
}

impl Default for Crc32 {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(PartialEq)]
enum GzPhase {
    Header,
    Body,
    Trailer,
}

struct Gzip {
    phase: GzPhase,
    inflate: Decompress,
    member_crc: crc32fast::Hasher,
    member_size: u32,
    members: u32,
    name: Option<String>,
}

/// Longest gzip header (extra field, name, comment) accepted before it counts as corrupt.
const MAX_GZIP_HEADER: usize = 1 << 20;

/// Parses one gzip member header. `Ok(None)` = more input needed.
fn parse_gzip_header(data: &[u8], ended: bool) -> Result<Option<(usize, Option<String>)>, String> {
    // A header that cannot complete is truncated at the end of input and corrupt past the cap.
    let short = || -> Result<Option<(usize, Option<String>)>, String> {
        if ended || data.len() > MAX_GZIP_HEADER { Err(fail("truncated", "gzip header is incomplete")) } else { Ok(None) }
    };
    if data.len() < 10 { return short(); }
    if data[0] != 0x1f || data[1] != 0x8b { return Err(fail("corrupt", "not a gzip stream")); }
    if data[2] != 8 { return Err(fail("corrupt", "unknown gzip compression method")); }
    let flags = data[3];
    if flags & 0xe0 != 0 { return Err(fail("corrupt", "reserved gzip flags are set")); }
    let mut pos = 10;
    if flags & 0x04 != 0 {
        if data.len() < pos + 2 { return short(); }
        let extra = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
        pos += 2;
        if data.len() < pos + extra { return short(); }
        pos += extra;
    }
    let mut name = None;
    for (flag, keep) in [(0x08u8, true), (0x10u8, false)] {
        if flags & flag == 0 { continue; }
        let Some(end) = data[pos..].iter().position(|&b| b == 0) else { return short() };
        if keep {
            let raw = &data[pos..pos + end];
            name = Some(match std::str::from_utf8(raw) {
                Ok(text) => text.to_string(),
                Err(_) => raw.iter().map(|&b| b as char).collect(),
            });
        }
        pos += end + 1;
    }
    if flags & 0x02 != 0 {
        if data.len() < pos + 2 { return short(); }
        pos += 2;
    }
    Ok(Some((pos, name)))
}

enum Dec {
    Raw(Decompress),
    Gzip(Box<Gzip>),
    Brotli(Box<BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>>),
    Zstd { decoder: Box<zstd::stream::raw::Decoder<'static>>, frame_end: bool },
}

/// Pull-based decompressor with bounded output per `read`. Write input, then call `read`
/// until it returns an empty array; after `end()`, an empty read on an unfinished stream is
/// a `truncated:` error. Concatenated gzip members and Zstandard frames are decoded in turn.
#[wasm_bindgen]
pub struct Decoder {
    dec: Dec,
    input: Vec<u8>,
    pos: usize,
    ended: bool,
    finished: bool,
    crc: crc32fast::Hasher,
}

#[wasm_bindgen]
impl Decoder {
    #[wasm_bindgen(constructor)]
    pub fn new(codec: &str) -> Result<Decoder, JsValue> {
        Decoder::create(codec).map_err(js)
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.write_bytes(chunk).map_err(js)
    }

    pub fn read(&mut self, max: usize) -> Result<Vec<u8>, JsValue> {
        self.read_bytes(max).map_err(js)
    }

    /// No more input will be written.
    pub fn end(&mut self) {
        self.ended = true;
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Bytes written but not consumed: data after the end of a deflate/zlib/Brotli stream.
    pub fn pending_input(&self) -> usize {
        self.input.len() - self.pos
    }

    /// CRC-32 of all output so far.
    pub fn output_crc32(&self) -> u32 {
        self.crc.clone().finalize()
    }

    /// Original file name from the first gzip header, if any.
    pub fn gzip_name(&self) -> Option<String> {
        match &self.dec {
            Dec::Gzip(gz) => gz.name.clone(),
            _ => None,
        }
    }
}

impl Decoder {
    fn create(codec: &str) -> Result<Decoder, String> {
        let dec = match codec {
            "deflate" => Dec::Raw(Decompress::new(false)),
            "zlib" => Dec::Raw(Decompress::new(true)),
            "gzip" => Dec::Gzip(Box::new(Gzip {
                phase: GzPhase::Header,
                inflate: Decompress::new(false),
                member_crc: crc32fast::Hasher::new(),
                member_size: 0,
                members: 0,
                name: None,
            })),
            // Strict: RFC 7932 windows only, no 1 GiB large-window streams.
            "brotli" => Dec::Brotli(Box::new(BrotliState::new_strict(
                StandardAlloc::default(),
                StandardAlloc::default(),
                StandardAlloc::default(),
            ))),
            "zstd" => {
                let mut decoder = zstd::stream::raw::Decoder::new().map_err(|e| fail("invalid", e))?;
                // 128 MiB window at most: larger frames need --long and a matching memory budget.
                decoder
                    .set_parameter(zstd::stream::raw::DParameter::WindowLogMax(27))
                    .map_err(|e| fail("invalid", e))?;
                Dec::Zstd { decoder: Box::new(decoder), frame_end: true }
            }
            _ => return Err(fail("invalid", format!("unknown codec {codec}"))),
        };
        Ok(Decoder { dec, input: Vec::new(), pos: 0, ended: false, finished: false, crc: crc32fast::Hasher::new() })
    }

    fn write_bytes(&mut self, chunk: &[u8]) -> Result<(), String> {
        if self.ended {
            return Err(fail("invalid", "input already ended"));
        }
        if self.pos > 0 {
            self.input.drain(..self.pos);
            self.pos = 0;
        }
        self.input.extend_from_slice(chunk);
        Ok(())
    }

    fn read_bytes(&mut self, max: usize) -> Result<Vec<u8>, String> {
        let mut out = vec![0u8; max.max(1)];
        let mut filled = 0;
        while !self.finished && filled < out.len() {
            if !self.step(&mut out, &mut filled)? {
                break;
            }
        }
        out.truncate(filled);
        self.crc.update(&out);
        if filled == 0 && self.ended && !self.finished {
            return Err(fail("truncated", "the compressed data ends early"));
        }
        Ok(out)
    }

    /// One decoding step; false when no progress is possible without more input.
    fn step(&mut self, out: &mut [u8], filled: &mut usize) -> Result<bool, String> {
        let input_left = self.input.len() - self.pos;
        match &mut self.dec {
            Dec::Raw(inflate) => {
                let (consumed, produced, status) = inflate_step(inflate, &self.input[self.pos..], &mut out[*filled..])?;
                self.pos += consumed;
                *filled += produced;
                if status == Status::StreamEnd {
                    self.finished = true;
                }
                Ok(consumed > 0 || produced > 0 || self.finished)
            }
            Dec::Gzip(gz) => match gz.phase {
                GzPhase::Header => {
                    if input_left == 0 {
                        if self.ended && gz.members > 0 {
                            self.finished = true;
                            return Ok(true);
                        }
                        return Ok(false);
                    }
                    let data = &self.input[self.pos..];
                    // tar.gz written to tape is often padded with zeros after the last member.
                    if gz.members > 0 && data[0] == 0 {
                        if data.iter().all(|&b| b == 0) {
                            self.pos = self.input.len();
                            if self.ended {
                                self.finished = true;
                            }
                            return Ok(self.ended);
                        }
                        return Err(fail("corrupt", "unexpected data after the gzip stream"));
                    }
                    match parse_gzip_header(data, self.ended)? {
                        None => Ok(false),
                        Some((length, name)) => {
                            if gz.members == 0 {
                                gz.name = name;
                            }
                            self.pos += length;
                            gz.phase = GzPhase::Body;
                            Ok(true)
                        }
                    }
                }
                GzPhase::Body => {
                    let (consumed, produced, status) = inflate_step(&mut gz.inflate, &self.input[self.pos..], &mut out[*filled..])?;
                    gz.member_crc.update(&out[*filled..*filled + produced]);
                    gz.member_size = gz.member_size.wrapping_add(produced as u32);
                    self.pos += consumed;
                    *filled += produced;
                    if status == Status::StreamEnd {
                        gz.phase = GzPhase::Trailer;
                    }
                    Ok(consumed > 0 || produced > 0 || gz.phase == GzPhase::Trailer)
                }
                GzPhase::Trailer => {
                    if input_left < 8 {
                        return Ok(false);
                    }
                    let t = &self.input[self.pos..self.pos + 8];
                    let crc = u32::from_le_bytes([t[0], t[1], t[2], t[3]]);
                    let size = u32::from_le_bytes([t[4], t[5], t[6], t[7]]);
                    if crc != std::mem::take(&mut gz.member_crc).finalize() {
                        return Err(fail("checksum", "gzip CRC-32 does not match"));
                    }
                    if size != gz.member_size {
                        return Err(fail("checksum", "gzip size does not match"));
                    }
                    self.pos += 8;
                    gz.members += 1;
                    gz.member_size = 0;
                    gz.inflate.reset(false);
                    gz.phase = GzPhase::Header;
                    Ok(true)
                }
            },
            Dec::Brotli(state) => {
                let mut available_in = input_left;
                let mut input_offset = self.pos;
                let mut available_out = out.len() - *filled;
                let mut output_offset = *filled;
                let mut total_out = 0usize;
                let result = BrotliDecompressStream(
                    &mut available_in,
                    &mut input_offset,
                    &self.input,
                    &mut available_out,
                    &mut output_offset,
                    out,
                    &mut total_out,
                    state,
                );
                let progressed = input_offset != self.pos || output_offset != *filled;
                self.pos = input_offset;
                *filled = output_offset;
                match result {
                    BrotliResult::ResultSuccess => {
                        self.finished = true;
                        Ok(true)
                    }
                    BrotliResult::ResultFailure => Err(fail("corrupt", "invalid Brotli data")),
                    BrotliResult::NeedsMoreInput | BrotliResult::NeedsMoreOutput => Ok(progressed),
                }
            }
            Dec::Zstd { decoder, frame_end } => {
                if input_left == 0 && *frame_end {
                    if self.ended {
                        self.finished = true;
                        return Ok(true);
                    }
                    return Ok(false);
                }
                let mut src = InBuffer::around(&self.input[self.pos..]);
                let mut dst = OutBuffer::around(&mut out[*filled..]);
                let hint = decoder.run(&mut src, &mut dst).map_err(|e| fail("corrupt", e))?;
                let consumed = src.pos();
                let produced = dst.pos();
                self.pos += consumed;
                *filled += produced;
                *frame_end = hint == 0;
                Ok(consumed > 0 || produced > 0)
            }
        }
    }
}

fn inflate_step(inflate: &mut Decompress, input: &[u8], out: &mut [u8]) -> Result<(usize, usize, Status), String> {
    let before_in = inflate.total_in();
    let before_out = inflate.total_out();
    let status = inflate
        .decompress(input, out, FlushDecompress::None)
        .map_err(|e| fail("corrupt", e))?;
    Ok(((inflate.total_in() - before_in) as usize, (inflate.total_out() - before_out) as usize, status))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(len: usize) -> Vec<u8> {
        let mut state = 0x1234_5678u32;
        (0..len)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                // Mostly text-like with some noise so every codec has work to do.
                if i % 7 == 0 { (state & 0xff) as u8 } else { b"lorem ipsum dolor sit amet "[i % 27] }
            })
            .collect()
    }

    fn compress(codec: &str, level: i32, data: &[u8], chunk: usize) -> Vec<u8> {
        let mut enc = Encoder::create(codec, level, data.len() as f64, Some("data.txt".into())).unwrap();
        let mut out = Vec::new();
        for part in data.chunks(chunk.max(1)) {
            out.extend(enc.push_bytes(part).unwrap());
        }
        out.extend(enc.finish_bytes().unwrap());
        assert_eq!(enc.crc32(), crc32fast::hash(data));
        out
    }

    fn decompress(codec: &str, data: &[u8], chunk: usize, max: usize) -> Result<Vec<u8>, String> {
        let mut dec = Decoder::create(codec)?;
        let mut out = Vec::new();
        let drain = |dec: &mut Decoder, out: &mut Vec<u8>| -> Result<(), String> {
            loop {
                let part = dec.read_bytes(max)?;
                assert!(part.len() <= max.max(1));
                if part.is_empty() {
                    return Ok(());
                }
                out.extend(part);
            }
        };
        for part in data.chunks(chunk.max(1)) {
            dec.write_bytes(part).unwrap();
            drain(&mut dec, &mut out)?;
        }
        dec.end();
        drain(&mut dec, &mut out)?;
        assert!(dec.is_finished());
        assert_eq!(dec.output_crc32(), crc32fast::hash(&out));
        Ok(out)
    }

    #[test]
    fn round_trips_every_codec_with_small_windows() {
        let data = sample(300_000);
        for (codec, levels) in [("gzip", [0, 6, 9]), ("deflate", [1, 6, 9]), ("zlib", [1, 6, 9]), ("brotli", [0, 5, 11]), ("zstd", [1, 3, 19])] {
            for level in levels {
                let packed = compress(codec, level, &data, 65_536);
                if level > 0 {
                    assert!(packed.len() < data.len(), "{codec} {level}");
                }
                assert_eq!(decompress(codec, &packed, 4_096, 1_000).unwrap(), data, "{codec} {level}");
                assert_eq!(decompress(codec, &packed, 1, 7).unwrap(), data[..].to_vec(), "{codec} {level} byte by byte");
            }
        }
    }

    #[test]
    fn empty_input_round_trips() {
        for codec in ["gzip", "deflate", "zlib", "brotli", "zstd"] {
            let packed = compress(codec, 3, &[], 1);
            assert_eq!(decompress(codec, &packed, 1024, 1024).unwrap(), Vec::<u8>::new(), "{codec}");
        }
    }

    #[test]
    fn gzip_keeps_name_and_concatenated_members() {
        let mut packed = compress("gzip", 6, b"first ", 1024);
        packed.extend(compress("gzip", 6, b"second", 1024));
        packed.extend([0u8; 512]);
        let mut dec = Decoder::create("gzip").unwrap();
        dec.write_bytes(&packed).unwrap();
        dec.end();
        let mut out = Vec::new();
        loop {
            let part = dec.read_bytes(3).unwrap();
            if part.is_empty() { break; }
            out.extend(part);
        }
        assert_eq!(out, b"first second");
        assert_eq!(dec.gzip_name().as_deref(), Some("data.txt"));
    }

    #[test]
    fn zstd_reads_concatenated_frames() {
        let mut packed = compress("zstd", 3, b"alpha ", 1024);
        packed.extend(compress("zstd", 3, b"beta", 1024));
        assert_eq!(decompress("zstd", &packed, 5, 2).unwrap(), b"alpha beta");
    }

    #[test]
    fn reports_truncated_and_corrupt_input() {
        let data = sample(50_000);
        for codec in ["gzip", "deflate", "zlib", "brotli", "zstd"] {
            let packed = compress(codec, 6, &data, 8_192);
            let error = decompress(codec, &packed[..packed.len() / 2], 1_024, 4_096).unwrap_err();
            assert!(error.starts_with("truncated:"), "{codec}: {error}");
        }
        let mut gz = compress("gzip", 6, &data, 8_192);
        let at = gz.len() - 6;
        gz[at] ^= 0xff;
        assert!(decompress("gzip", &gz, 1_024, 4_096).unwrap_err().starts_with("checksum:"));
        assert!(decompress("gzip", b"PK\x03\x04 not gzip at all", 64, 64).unwrap_err().starts_with("corrupt:"));
        let mut zst = compress("zstd", 3, &data, 8_192);
        let at = zst.len() - 2;
        zst[at] ^= 0xff;
        assert!(decompress("zstd", &zst, 1_024, 4_096).unwrap_err().starts_with("corrupt:"));
    }

    #[test]
    fn bounded_reads_cap_a_bomb() {
        // 64 MiB of zeros packs into a few KiB; each read still yields at most 1 MiB.
        let mut enc = Encoder::create("deflate", 9, -1.0, None).unwrap();
        let zeros = vec![0u8; 1 << 20];
        let mut packed = Vec::new();
        for _ in 0..64 {
            packed.extend(enc.push_bytes(&zeros).unwrap());
        }
        packed.extend(enc.finish_bytes().unwrap());
        assert!(packed.len() < 128 * 1024);
        let mut dec = Decoder::create("deflate").unwrap();
        dec.write_bytes(&packed).unwrap();
        dec.end();
        let first = dec.read_bytes(1 << 20).unwrap();
        assert_eq!(first.len(), 1 << 20);
        assert!(!dec.is_finished());
    }

    #[test]
    fn rejects_bad_levels() {
        assert!(Encoder::create("gzip", 10, -1.0, None).is_err());
        assert!(Encoder::create("brotli", 12, -1.0, None).is_err());
        assert!(Encoder::create("zstd", 0, -1.0, None).is_err());
        assert!(Encoder::create("lzma", 1, -1.0, None).is_err());
    }
}
