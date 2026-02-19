use lopdf::content::Content;
use lopdf::{Document, Object, ObjectId};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Cursor;
use ttf_parser::Face;
use wasm_bindgen::prelude::*;

const BUILD_ID: &str = "winansi-fallback-2026-02-19-2";

// Helper to log to console
#[cfg(target_arch = "wasm32")]
macro_rules! console_log {
    ($($t:tt)*) => (web_sys::console::log_1(&format!($($t)*).into()))
}

#[cfg(not(target_arch = "wasm32"))]
macro_rules! console_log {
    ($($t:tt)*) => (println!($($t)*))
}

#[wasm_bindgen]
pub fn merge_pdfs(files: Vec<js_sys::Uint8Array>) -> Result<Vec<u8>, JsValue> {
    console_log!("Starting merge of {} files", files.len());

    if files.is_empty() {
        return Err(JsValue::from_str("No files provided"));
    }

    let mut documents: Vec<Document> = Vec::new();

    for (i, file) in files.iter().enumerate() {
        let data = file.to_vec();
        let cursor = Cursor::new(data);
        match Document::load_from(cursor) {
            Ok(doc) => {
                console_log!("Loaded doc {} with {} pages", i, doc.get_pages().len());
                documents.push(doc);
            }
            Err(e) => {
                return Err(JsValue::from_str(&format!(
                    "Failed to load PDF {}: {:?}",
                    i, e
                )))
            }
        }
    }

    if documents.is_empty() {
        return Err(JsValue::from_str("No valid documents loaded"));
    }

    // Start with the first document as the base
    let mut target_doc = documents.remove(0);

    // Ensure version is at least 1.5
    target_doc.version = "1.5".to_string();

    // Get the Pages object reference from the catalog
    let catalog_id = target_doc
        .trailer
        .get(b"Root")
        .map_err(|_| JsValue::from_str("Root missing in trailer"))?
        .as_reference()
        .map_err(|_| JsValue::from_str("Root is not a reference"))?;

    let catalog = target_doc
        .get_object(catalog_id)
        .and_then(|obj| obj.as_dict())
        .map_err(|_| JsValue::from_str("Catalog is not a dictionary"))?;

    let pages_id = catalog
        .get(b"Pages")
        .and_then(|obj| obj.as_reference())
        .map_err(|_| JsValue::from_str("Pages reference missing in Catalog"))?;

    for (i, mut doc) in documents.into_iter().enumerate() {
        // 1. Renumber objects in the source doc so they don't clash with target_doc
        doc.renumber_objects_with(target_doc.max_id + 1);

        // Update target_doc.max_id to the new high water mark
        target_doc.max_id = doc.max_id;

        // 2. Get the list of page object IDs from the source doc
        let pages = doc.get_pages();
        let page_ids: Vec<_> = pages.values().cloned().collect();

        console_log!("Merging doc {} with {} pages", i + 1, page_ids.len());

        // 3. Add all objects from source doc to target doc
        target_doc.objects.extend(doc.objects);

        // 4. Append the page IDs to the target document's page tree
        if let Some(pages_obj) = target_doc.objects.get_mut(&pages_id) {
            if let Ok(dict) = pages_obj.as_dict_mut() {
                let count = dict.get(b"Count").and_then(|o| o.as_i64()).unwrap_or(0);

                if let Ok(kids) = dict.get_mut(b"Kids") {
                    if let Ok(kids_arr) = kids.as_array_mut() {
                        for pid in &page_ids {
                            kids_arr.push(lopdf::Object::Reference(*pid));
                        }
                    }
                }

                // Update Count
                dict.set(
                    b"Count".to_vec(),
                    lopdf::Object::Integer(count + page_ids.len() as i64),
                );
            }
        }
    }

    // Prune unused objects to keep file size down
    target_doc.prune_objects();

    // Save to bytes
    let mut out_buffer = Vec::new();
    match target_doc.save_to(&mut out_buffer) {
        Ok(_) => {
            console_log!("Merge successful, output size: {} bytes", out_buffer.len());
            Ok(out_buffer)
        }
        Err(e) => Err(JsValue::from_str(&format!("Failed to save PDF: {:?}", e))),
    }
}

#[wasm_bindgen]
pub fn compress_pdf(data: js_sys::Uint8Array) -> Result<Vec<u8>, JsValue> {
    console_log!("Starting PDF compression (Extreme Mode)");

    let bytes = data.to_vec();
    let cursor = Cursor::new(bytes);

    let mut doc = Document::load_from(cursor)
        .map_err(|e| JsValue::from_str(&format!("Failed to load PDF: {:?}", e)))?;

    // 1. Ensure version is at least 1.5
    if doc.version.parse::<f32>().unwrap_or(1.0) < 1.5 {
        doc.version = "1.5".to_string();
    }

    // 2. Aggressive Metadata Removal
    doc.trailer.remove(b"Info");
    if let Ok(root_id) = doc.trailer.get(b"Root").and_then(|o| o.as_reference()) {
        if let Ok(root) = doc.get_object_mut(root_id).and_then(|o| o.as_dict_mut()) {
            root.remove(b"Metadata");
            root.remove(b"PieceInfo");
            root.remove(b"StructTreeRoot");
            root.remove(b"OCProperties");
            root.remove(b"MarkInfo");
        }
    }

    // 3. Object-level Cleanup (Metadata, Thumbnails, etc.)
    let ids: Vec<ObjectId> = doc.objects.keys().cloned().collect();
    for id in ids {
        if let Ok(obj) = doc.get_object_mut(id) {
            if let Ok(dict) = obj.as_dict_mut() {
                dict.remove(b"Metadata");
                dict.remove(b"PieceInfo");
                dict.remove(b"LastModified");
                dict.remove(b"Thumb");
                dict.remove(b"StructParents");
                dict.remove(b"A"); // Actions (can be bloat)
                dict.remove(b"AA"); // Additional Actions
            }
        }
    }

    // 4. Force re-compression of all streams
    let ids: Vec<ObjectId> = doc.objects.keys().cloned().collect();
    for id in ids {
        if let Ok(Object::Stream(ref mut stream)) = doc.get_object_mut(id) {
            let filters = stream.filters().unwrap_or_default();

            // Handle FlateDecode and LZWDecode re-compression
            if filters.len() == 1 && (filters[0] == "FlateDecode" || filters[0] == "LZWDecode") {
                use flate2::read::ZlibDecoder;
                use flate2::write::ZlibEncoder;
                use flate2::Compression;
                use std::io::prelude::*;

                let mut decompressed = Vec::new();
                let success = if filters[0] == "FlateDecode" {
                    let mut decoder = ZlibDecoder::new(&stream.content[..]);
                    decoder.read_to_end(&mut decompressed).is_ok()
                } else {
                    // LZW fallback - use lopdf's built-in decompressor if available
                    // or just let it be. Actually lopdf can decompress LZW.
                    if let Ok(data) = stream.decompressed_content() {
                        decompressed = data;
                        true
                    } else {
                        false
                    }
                };

                if success {
                    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
                    if encoder.write_all(&decompressed).is_ok() {
                        if let Ok(recompressed) = encoder.finish() {
                            if recompressed.len() < stream.content.len() {
                                stream.content = recompressed;
                                stream.dict.set("Filter", "FlateDecode");
                                stream.dict.remove(b"DecodeParms");
                            }
                        }
                    }
                }
            } else if filters.len() == 1 && filters[0] == "DCTDecode" {
                // It's a JPEG. Try to strip APP markers and comments.
                if let Some(stripped) = strip_jpeg_metadata(&stream.content) {
                    if stripped.len() < stream.content.len() {
                        stream.content = stripped;
                    }
                }
            } else if filters.is_empty() && stream.allows_compression {
                let _ = stream.compress();
            }
        }
    }

    // 5. Global Object Deduplication (Streams, Dictionaries)
    deduplicate_objects(&mut doc);

    // 6. Final cleanup and optimization
    doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceStream;
    doc.prune_objects();
    doc.delete_zero_length_streams();
    doc.renumber_objects();

    // 7. Save
    let mut out_buffer = Vec::new();
    match doc.save_to(&mut out_buffer) {
        Ok(_) => {
            console_log!(
                "Compression successful, output size: {} bytes",
                out_buffer.len()
            );
            Ok(out_buffer)
        }
        Err(e) => Err(JsValue::from_str(&format!("Failed to save PDF: {:?}", e))),
    }
}

fn deduplicate_objects(doc: &mut Document) {
    let mut hashes: HashMap<Vec<u8>, ObjectId> = HashMap::new();
    let mut replacements: HashMap<ObjectId, ObjectId> = HashMap::new();

    // Collect candidates for deduplication
    let ids: Vec<ObjectId> = doc.objects.keys().cloned().collect();
    for id in ids {
        if let Ok(obj) = doc.get_object(id) {
            if let Object::Stream(s) = obj {
                let mut hasher = Sha256::new();
                hasher.update(b"stream");
                hasher.update(&s.content);
                if let Ok(subtype) = s.dict.get(b"Subtype") {
                    hasher.update(format!("{:?}", subtype).as_bytes());
                }
                let hash = hasher.finalize().to_vec();
                if let Some(&original_id) = hashes.get(&hash) {
                    replacements.insert(id, original_id);
                } else {
                    hashes.insert(hash, id);
                }
            } else if let Object::Dictionary(d) = obj {
                // Skip pages and root
                if d.get(b"Type").and_then(Object::as_name_str).ok() == Some("Page") {
                    continue;
                }
                if d.get(b"Type").and_then(Object::as_name_str).ok() == Some("Catalog") {
                    continue;
                }

                let mut hasher = Sha256::new();
                hasher.update(b"dict");
                let mut keys: Vec<_> = d.iter().collect();
                keys.sort_by(|a, b| a.0.cmp(b.0));
                for (k, v) in keys {
                    hasher.update(k);
                    hasher.update(format!("{:?}", v).as_bytes());
                }
                let hash = hasher.finalize().to_vec();
                if let Some(&original_id) = hashes.get(&hash) {
                    replacements.insert(id, original_id);
                } else {
                    hashes.insert(hash, id);
                }
            }
        }
    }

    if !replacements.is_empty() {
        console_log!("Deduplicated {} objects", replacements.len());
        for (old_id, new_id) in &replacements {
            doc.objects.remove(old_id);
            let action = |obj: &mut Object| {
                if let Object::Reference(ref mut id) = *obj {
                    if id == old_id {
                        *id = *new_id;
                    }
                }
            };
            doc.traverse_objects(action);
        }
    }
}

/// A simple helper to strip APPx and COM markers from JPEG data
fn strip_jpeg_metadata(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None; // Not a valid JPEG
    }

    let mut result = Vec::with_capacity(data.len());
    result.push(0xFF);
    result.push(0xD8);

    let mut i = 2;
    while i < data.len() - 1 {
        if data[i] == 0xFF {
            let marker = data[i + 1];
            if marker == 0xD9 {
                // EOI
                result.push(0xFF);
                result.push(0xD9);
                break;
            }
            if marker == 0x00 || (marker >= 0xD0 && marker <= 0xD7) {
                // Just data or reset marker
                result.push(0xFF);
                result.push(marker);
                i += 2;
                continue;
            }

            // Marker with length
            if i + 3 >= data.len() {
                break;
            }
            let len = ((data[i + 2] as usize) << 8) | (data[i + 3] as usize);

            // Strip APP markers (FF E0 - FF EF) and Comment (FF FE)
            if (marker >= 0xE0 && marker <= 0xEF) || marker == 0xFE {
                i += 2 + len;
            } else {
                // Keep other markers (SOF, DHT, DQT, SOS, etc.)
                if i + 2 + len <= data.len() {
                    result.extend_from_slice(&data[i..i + 2 + len]);
                    i += 2 + len;
                } else {
                    break;
                }
            }
        } else {
            // Raw data (should not happen outside of SOS, but for safety)
            result.push(data[i]);
            i += 1;
        }
    }

    if result.len() < data.len() {
        Some(result)
    } else {
        None
    }
}

fn extract_text_impl(doc: Document) -> Result<String, String> {
    console_log!("Starting text extraction from PDF (build: {})", BUILD_ID);

    // Get all page numbers (sorted)
    let mut page_numbers: Vec<u32> = doc.get_pages().keys().cloned().collect();
    page_numbers.sort();

    // We'll implement our own extraction that respects ToUnicode CMaps for CID/Identity fonts.
    let mut out_parts: Vec<String> = Vec::new();

    // Helper: parse ToUnicode CMap stream bytes into a mapping of byte-sequence -> String
    fn parse_cmap(cmap_bytes: &[u8]) -> HashMap<Vec<u8>, String> {
        let mut map: HashMap<Vec<u8>, String> = HashMap::new();
        let text = String::from_utf8_lossy(cmap_bytes).to_string();

        // Simple helper to decode hex like "00E0" -> Vec<u8>
        let hex_to_bytes = |hex: &str| -> Option<Vec<u8>> {
            let mut out = Vec::new();
            let mut s = hex.trim();
            // strip optional <>
            if s.starts_with('<') && s.ends_with('>') {
                s = &s[1..s.len() - 1];
            }
            if s.len() % 2 != 0 {
                return None;
            }
            for i in (0..s.len()).step_by(2) {
                if let Ok(byte) = u8::from_str_radix(&s[i..i + 2], 16) {
                    out.push(byte);
                } else {
                    return None;
                }
            }
            Some(out)
        };

        // Parse beginbfchar ... endbfchar blocks
        let mut pos = 0usize;
        while let Some(beg) = text[pos..].find("beginbfchar") {
            let start = pos + beg + "beginbfchar".len();
            if let Some(end_rel) = text[start..].find("endbfchar") {
                let block = &text[start..start + end_rel];
                // find all pairs of <hex> <hex>
                let mut idx = 0usize;
                while let Some(a) = block[idx..].find('<') {
                    let a0 = idx + a;
                    if let Some(a1_rel) = block[a0..].find('>') {
                        let a1 = a0 + a1_rel;
                        let left = &block[a0..=a1];
                        // find next '<' for right
                        if let Some(b) = block[a1 + 1..].find('<') {
                            let b0 = a1 + 1 + b;
                            if let Some(b1_rel) = block[b0..].find('>') {
                                let b1 = b0 + b1_rel;
                                let right = &block[b0..=b1];
                                if let (Some(left_b), Some(right_b)) =
                                    (hex_to_bytes(left), hex_to_bytes(right))
                                {
                                    // decode right bytes as UTF-16BE if length %2 == 0
                                    let decoded = if right_b.len() % 2 == 0 {
                                        let mut u16s = Vec::new();
                                        for i in (0..right_b.len()).step_by(2) {
                                            let hi =
                                                (right_b[i] as u16) << 8 | (right_b[i + 1] as u16);
                                            u16s.push(hi);
                                        }
                                        String::from_utf16_lossy(&u16s)
                                    } else {
                                        // fallback: Latin1
                                        right_b.iter().map(|&c| c as char).collect()
                                    };
                                    map.insert(left_b, decoded);
                                }
                                idx = b1 + 1;
                                continue;
                            }
                        }
                    }
                    break;
                }
                pos = start + end_rel;
            } else {
                break;
            }
        }

        // Parse beginbfrange ... endbfrange blocks (simple cases)
        pos = 0;
        while let Some(beg) = text[pos..].find("beginbfrange") {
            let start = pos + beg + "beginbfrange".len();
            if let Some(end_rel) = text[start..].find("endbfrange") {
                let block = &text[start..start + end_rel];
                // scan lines for patterns
                for line in block.lines() {
                    let line = line.trim();
                    if !line.starts_with('<') {
                        continue;
                    }
                    // tokenize by whitespace
                    let toks: Vec<&str> = line.split_whitespace().collect();
                    if toks.len() >= 3 {
                        // start, end, target
                        if let (Some(start_b), Some(end_b)) =
                            (hex_to_bytes(toks[0]), hex_to_bytes(toks[1]))
                        {
                            // convert start/end to integer
                            let start_val =
                                start_b.iter().fold(0u32, |acc, &b| (acc << 8) | (b as u32));
                            let end_val =
                                end_b.iter().fold(0u32, |acc, &b| (acc << 8) | (b as u32));
                            let target = toks[2];
                            if target.starts_with('<') && target.ends_with('>') {
                                if let Some(target_b) = hex_to_bytes(target) {
                                    // interpret target_b as UTF-16BE or as a codepoint
                                    if target_b.len() % 2 == 0 && target_b.len() <= 4 {
                                        // treat as UTF-16BE (or single 32-bit) and increment
                                        let mut first_code = 0u32;
                                        if target_b.len() == 2 {
                                            first_code =
                                                ((target_b[0] as u32) << 8) | (target_b[1] as u32);
                                        } else if target_b.len() == 4 {
                                            first_code = ((target_b[0] as u32) << 24)
                                                | ((target_b[1] as u32) << 16)
                                                | ((target_b[2] as u32) << 8)
                                                | (target_b[3] as u32);
                                        }
                                        for i in start_val..=end_val {
                                            let cid = i;
                                            let mut key = Vec::new();
                                            // reconstruct cid as same byte-length as start_b
                                            for shift in (0..start_b.len()).rev() {
                                                let shift_bits = (shift * 8) as u32;
                                                let byte = ((cid >> shift_bits) & 0xFF) as u8;
                                                key.push(byte);
                                            }
                                            let codepoint = first_code + (i - start_val);
                                            if let Some(ch) = std::char::from_u32(codepoint) {
                                                map.insert(key, ch.to_string());
                                            } else {
                                                // attempt UTF-16 decode
                                                map.insert(key, String::new());
                                            }
                                        }
                                    }
                                }
                            } else if target.starts_with('[') {
                                // array form: <s> <e> [ <u1> <u2> ... ]
                                // extract entries between [ ]
                                if let Some(start_br) = line.find('[') {
                                    if let Some(end_br) = line.find(']') {
                                        let inside = &line[start_br + 1..end_br];
                                        let mut entries: Vec<Vec<u8>> = Vec::new();
                                        for token in inside.split_whitespace() {
                                            if let Some(b) = hex_to_bytes(token) {
                                                entries.push(b);
                                            }
                                        }
                                        let mut idx_e = 0usize;
                                        for i in start_val..=end_val {
                                            if idx_e >= entries.len() {
                                                break;
                                            }
                                            let key_val = i;
                                            let mut key = Vec::new();
                                            for shift in (0..start_b.len()).rev() {
                                                let shift_bits = (shift * 8) as u32;
                                                let byte = ((key_val >> shift_bits) & 0xFF) as u8;
                                                key.push(byte);
                                            }
                                            let right_b = &entries[idx_e];
                                            let decoded = if right_b.len() % 2 == 0 {
                                                let mut u16s = Vec::new();
                                                for j in (0..right_b.len()).step_by(2) {
                                                    let hi = (right_b[j] as u16) << 8
                                                        | (right_b[j + 1] as u16);
                                                    u16s.push(hi);
                                                }
                                                String::from_utf16_lossy(&u16s)
                                            } else {
                                                right_b.iter().map(|&c| c as char).collect()
                                            };
                                            map.insert(key, decoded);
                                            idx_e += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                pos = start + end_rel;
            } else {
                break;
            }
        }

        // Parse begincidchar ... endcidchar (maps to CMap forms that sometimes appear)
        pos = 0;
        while let Some(beg) = text[pos..].find("begincidchar") {
            let start = pos + beg + "begincidchar".len();
            if let Some(end_rel) = text[start..].find("endcidchar") {
                let block = &text[start..start + end_rel];
                for line in block.lines() {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    // expecting "<hex> <hex>" or "<hex> n"
                    let toks: Vec<&str> = line.split_whitespace().collect();
                    if toks.len() >= 2 {
                        let left = toks[0];
                        let right = toks[1];
                        if let Some(left_b) = hex_to_bytes(left) {
                            if right.starts_with('<') && right.ends_with('>') {
                                if let Some(right_b) = hex_to_bytes(right) {
                                    let decoded = if right_b.len() % 2 == 0 {
                                        let mut u16s = Vec::new();
                                        for i in (0..right_b.len()).step_by(2) {
                                            u16s.push(
                                                ((right_b[i] as u16) << 8)
                                                    | (right_b[i + 1] as u16),
                                            );
                                        }
                                        String::from_utf16_lossy(&u16s)
                                    } else {
                                        right_b.iter().map(|&c| c as char).collect()
                                    };
                                    map.insert(left_b, decoded);
                                }
                            } else {
                                // right side is likely a CID number; nothing to map to Unicode here
                            }
                        }
                    }
                }
                pos = start + end_rel;
            } else {
                break;
            }
        }

        // Parse begincidrange ... endcidrange (simple numeric ranges or array targets)
        pos = 0;
        while let Some(beg) = text[pos..].find("begincidrange") {
            let start = pos + beg + "begincidrange".len();
            if let Some(end_rel) = text[start..].find("endcidrange") {
                let block = &text[start..start + end_rel];
                for line in block.lines() {
                    let line = line.trim();
                    if !line.starts_with('<') {
                        continue;
                    }
                    let toks: Vec<&str> = line.split_whitespace().collect();
                    if toks.len() >= 3 {
                        if let (Some(start_b), Some(end_b)) =
                            (hex_to_bytes(toks[0]), hex_to_bytes(toks[1]))
                        {
                            let start_val =
                                start_b.iter().fold(0u32, |acc, &b| (acc << 8) | b as u32);
                            let end_val = end_b.iter().fold(0u32, |acc, &b| (acc << 8) | b as u32);
                            let target = toks[2];
                            if target.starts_with('<') && target.ends_with('>') {
                                if let Some(target_b) = hex_to_bytes(target) {
                                    let mut first_code = 0u32;
                                    if target_b.len() == 2 {
                                        first_code =
                                            ((target_b[0] as u32) << 8) | target_b[1] as u32;
                                    } else if target_b.len() == 4 {
                                        first_code = ((target_b[0] as u32) << 24)
                                            | ((target_b[1] as u32) << 16)
                                            | ((target_b[2] as u32) << 8)
                                            | (target_b[3] as u32);
                                    }
                                    for i in start_val..=end_val {
                                        let mut key = Vec::new();
                                        for shift in (0..start_b.len()).rev() {
                                            let shift_bits = (shift * 8) as u32;
                                            let byte = ((i >> shift_bits) & 0xFF) as u8;
                                            key.push(byte);
                                        }
                                        let codepoint = first_code + (i - start_val);
                                        if let Some(ch) = std::char::from_u32(codepoint) {
                                            map.insert(key, ch.to_string());
                                        } else {
                                            map.insert(key, String::new());
                                        }
                                    }
                                }
                            } else if target.starts_with('[') {
                                if let Some(start_br) = line.find('[') {
                                    if let Some(end_br) = line.find(']') {
                                        let inside = &line[start_br + 1..end_br];
                                        let mut entries: Vec<Vec<u8>> = Vec::new();
                                        for token in inside.split_whitespace() {
                                            if let Some(b) = hex_to_bytes(token) {
                                                entries.push(b);
                                            }
                                        }
                                        let mut idx_e = 0usize;
                                        for i in start_val..=end_val {
                                            if idx_e >= entries.len() {
                                                break;
                                            }
                                            let mut key = Vec::new();
                                            for shift in (0..start_b.len()).rev() {
                                                let shift_bits = (shift * 8) as u32;
                                                let byte = ((i >> shift_bits) & 0xFF) as u8;
                                                key.push(byte);
                                            }
                                            let right_b = &entries[idx_e];
                                            let decoded = if right_b.len() % 2 == 0 {
                                                let mut u16s = Vec::new();
                                                for j in (0..right_b.len()).step_by(2) {
                                                    u16s.push(
                                                        ((right_b[j] as u16) << 8)
                                                            | (right_b[j + 1] as u16),
                                                    );
                                                }
                                                String::from_utf16_lossy(&u16s)
                                            } else {
                                                right_b.iter().map(|&c| c as char).collect()
                                            };
                                            map.insert(key, decoded);
                                            idx_e += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                pos = start + end_rel;
            } else {
                break;
            }
        }

        map
    }

    // Helper: build mapping gid->unicode from embedded TTF 'cmap' table
    fn cmap_from_truetype_gid_map(font_bytes: &[u8]) -> Option<HashMap<u16, String>> {
        // Parse TrueType face and build gid->unicode map by probing Unicode codepoints.
        // Use Face::number_of_glyphs() as an early-exit condition to avoid scanning unnecessarily.
        if let Ok(face) = Face::parse(font_bytes, 0) {
            let mut map: HashMap<u16, String> = HashMap::new();
            let glyph_count = face.number_of_glyphs() as usize;
            console_log!("Parsing TrueType cmap: glyph_count={}", glyph_count);

            // Scan Unicode scalar range, stopping when we've discovered mappings for all glyphs
            // or when we've exhausted codepoints. This is robust across formats (4/12) and
            // handles non-BMP mappings as well.
            for codepoint in 0u32..=0x10FFFFu32 {
                if let Some(ch) = std::char::from_u32(codepoint) {
                    if let Some(gid) = face.glyph_index(ch) {
                        let gid_u16 = gid.0;
                        map.entry(gid_u16).or_insert_with(|| ch.to_string());
                        if glyph_count > 0 && map.len() >= glyph_count {
                            break;
                        }
                    }
                }
            }

            console_log!(" TrueType cmap built: entries={}", map.len());
            if !map.is_empty() {
                return Some(map);
            }
        }
        None
    }

    // Build final mapping for CID fonts using CIDToGIDMap stream if provided
    fn make_map_from_gid_map_with_cidtogid(
        gid_map: &HashMap<u16, String>,
        cidtogid: Option<&[u8]>,
    ) -> HashMap<Vec<u8>, String> {
        let mut out: HashMap<Vec<u8>, String> = HashMap::new();
        if let Some(bytes) = cidtogid {
            // bytes should be sequence of u16 big-endian entries
            let count = bytes.len() / 2;
            for cid in 0..count {
                let hi = bytes[cid * 2] as u16;
                let lo = bytes[cid * 2 + 1] as u16;
                let gid = (hi << 8) | lo;
                if let Some(u) = gid_map.get(&gid) {
                    // key length: if cid <= 0xFF use 1 byte, else 2 bytes big-endian
                    if cid <= 0xFF {
                        out.insert(vec![cid as u8], u.clone());
                    }
                    out.insert(
                        vec![(cid as u16 >> 8) as u8, (cid as u16 & 0xFF) as u8],
                        u.clone(),
                    );
                }
            }
        } else {
            // identity: CID == GID
            for (&gid, v) in gid_map.iter() {
                let cid = gid as usize;
                if cid <= 0xFF {
                    out.insert(vec![cid as u8], v.clone());
                }
                out.insert(
                    vec![(cid as u16 >> 8) as u8, (cid as u16 & 0xFF) as u8],
                    v.clone(),
                );
            }
        }
        out
    }

    // For debugging: log that we are parsing a CMap (both to console and stdout when available)
    fn log_cmap_info(font_key: &str, cmap: &HashMap<Vec<u8>, String>) {
        if !cmap.is_empty() {
            let sample: Vec<String> = cmap
                .iter()
                .take(10)
                .map(|(k, v)| format!("{}->{}", hex::encode(k), v))
                .collect();
            console_log!(
                "Font {}: CMap entries={}, sample={}",
                font_key,
                cmap.len(),
                sample.join(", ")
            );
            // also print to stdout for native tests
            println!(
                "Font {}: CMap entries={} sample={} ",
                font_key,
                cmap.len(),
                sample.join(", ")
            );
        } else {
            console_log!("Font {}: empty CMap", font_key);
            println!("Font {}: empty CMap", font_key);
        }
    }

    // Helper: decode bytes using mapping (greedy match)
    fn decode_with_map(bytes: &[u8], map: &HashMap<Vec<u8>, String>) -> String {
        if map.is_empty() {
            // fallback: Latin1 -> String
            return bytes.iter().map(|&b| b as char).collect();
        }
        let mut out = String::new();
        // compute max key len
        let max_key_len = map.keys().map(|k| k.len()).max().unwrap_or(1);
        let mut i = 0usize;
        while i < bytes.len() {
            let mut matched = false;
            let max_try = std::cmp::min(max_key_len, bytes.len() - i);
            for len in (1..=max_try).rev() {
                let slice = &bytes[i..i + len];
                if let Some(val) = map.get(slice) {
                    out.push_str(val);
                    i += len;
                    matched = true;
                    break;
                }
            }
            if !matched {
                // push replacement for single byte
                out.push(bytes[i] as char);
                i += 1;
            }
        }
        out
    }

    fn winansi_byte_to_char(b: u8) -> char {
        match b {
            0x80 => '\u{20AC}',
            0x81 => '\u{FFFD}',
            0x82 => '\u{201A}',
            0x83 => '\u{0192}',
            0x84 => '\u{201E}',
            0x85 => '\u{2026}',
            0x86 => '\u{2020}',
            0x87 => '\u{2021}',
            0x88 => '\u{02C6}',
            0x89 => '\u{2030}',
            0x8A => '\u{0160}',
            0x8B => '\u{2039}',
            0x8C => '\u{0152}',
            0x8D => '\u{FFFD}',
            0x8E => '\u{017D}',
            0x8F => '\u{FFFD}',
            0x90 => '\u{FFFD}',
            0x91 => '\u{2018}',
            0x92 => '\u{2019}',
            0x93 => '\u{201C}',
            0x94 => '\u{201D}',
            0x95 => '\u{2022}',
            0x96 => '\u{2013}',
            0x97 => '\u{2014}',
            0x98 => '\u{02DC}',
            0x99 => '\u{2122}',
            0x9A => '\u{0161}',
            0x9B => '\u{203A}',
            0x9C => '\u{0153}',
            0x9D => '\u{FFFD}',
            0x9E => '\u{017E}',
            0x9F => '\u{0178}',
            _ => b as char,
        }
    }

    fn decode_winansi(bytes: &[u8]) -> String {
        let mut out = String::new();
        for &b in bytes.iter() {
            if b < 0x80 {
                out.push(b as char);
            } else {
                out.push(winansi_byte_to_char(b));
            }
        }
        out
    }

    // Debug variant: decode and log some match attempts for diagnosis
    fn debug_decode_with_map(
        bytes: &[u8],
        map: &HashMap<Vec<u8>, String>,
        font_key: &str,
        operator: &str,
    ) -> String {
        if map.is_empty() {
            return bytes.iter().map(|&b| b as char).collect();
        }

        // Log first few bytes for diagnosis
        let first_bytes_hex = hex::encode(&bytes[..std::cmp::min(20, bytes.len())]);
        console_log!(
            "DEBUG decode: font={}, op={}, first_bytes={}",
            font_key,
            operator,
            first_bytes_hex
        );

        let mut out = String::new();
        let max_key_len = map.keys().map(|k| k.len()).max().unwrap_or(1);
        let mut i = 0usize;
        let mut logged_matches: Vec<String> = Vec::new();
        while i < bytes.len() {
            let mut matched = false;
            let max_try = std::cmp::min(max_key_len, bytes.len() - i);
            for len in (1..=max_try).rev() {
                let slice = &bytes[i..i + len];
                if let Some(val) = map.get(slice) {
                    // capture a few sample matches for logging
                    if logged_matches.len() < 12 {
                        logged_matches.push(format!("{:02X?}->{}", slice, val));
                    }
                    out.push_str(val);
                    i += len;
                    matched = true;
                    break;
                }
            }
            if !matched {
                // no match: append replacement char
                if logged_matches.len() < 12 {
                    logged_matches.push(format!(
                        "{:02X?}->(RAW:{})",
                        &bytes[i..i + 1],
                        bytes[i] as char
                    ));
                }
                out.push(bytes[i] as char);
                i += 1;
            }
        }

        // Log matching results
        console_log!("  Matches: {}", logged_matches.join(", "));
        console_log!(
            "  Output: {}",
            if out.len() > 80 { &out[..80] } else { &out }
        );

        out
    }

    // Helper function to get Resources dictionary (handles both Reference and inline Dictionary)
    fn get_resources_dict<'a>(
        doc: &'a Document,
        page_dict: &'a lopdf::Dictionary,
    ) -> Option<std::borrow::Cow<'a, lopdf::Dictionary>> {
        if let Ok(resources_obj) = page_dict.get(b"Resources") {
            // Try as reference first
            if let Ok(resources_ref) = resources_obj.as_reference() {
                doc.get_object(resources_ref)
                    .ok()
                    .and_then(|obj| obj.as_dict().ok())
                    .map(std::borrow::Cow::Borrowed)
            }
            // Fall back to inline dictionary
            else {
                resources_obj.as_dict().ok().map(std::borrow::Cow::Borrowed)
            }
        } else {
            None
        }
    }

    for page_number in page_numbers {
        // resolve page id
        let pages = doc.get_pages();
        if let Some(&page_id) = pages.get(&page_number) {
            // collect font ToUnicode maps for this page
            let mut font_maps: HashMap<String, HashMap<Vec<u8>, String>> = HashMap::new();
            let mut font_truetype_maps: HashMap<String, HashMap<Vec<u8>, String>> = HashMap::new();
            let mut font_encodings: HashMap<String, String> = HashMap::new();
            let mut font_force_winansi: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            if let Ok(page_obj) = doc.get_object(page_id) {
                if let Ok(page_dict) = page_obj.as_dict() {
                    // Get Resources dictionary (handles both Reference and inline Dictionary)
                    if let Some(resources_dict) = get_resources_dict(&doc, page_dict) {
                        if let Ok(fonts_obj) = resources_dict.get(b"Font") {
                            if let Ok(fonts_dict) = fonts_obj.as_dict() {
                                for (font_name, font_val) in fonts_dict.iter() {
                                    // font_name is Vec<u8> like b"FAAAAH"
                                    let font_key = String::from_utf8_lossy(font_name).to_string();
                                    console_log!("Found font resource: {}", font_key);
                                    // try to log BaseFont/Encoding if available
                                    if let Ok(font_ref_tmp) = font_val.as_reference() {
                                        if let Ok(font_obj_tmp) = doc.get_object(font_ref_tmp) {
                                            if let Ok(font_dict_tmp) = font_obj_tmp.as_dict() {
                                                let base = font_dict_tmp
                                                    .get(b"BaseFont")
                                                    .ok()
                                                    .map(|o| format!("{:?}", o));
                                                let enc = font_dict_tmp
                                                    .get(b"Encoding")
                                                    .ok()
                                                    .map(|o| format!("{:?}", o));
                                                if font_encodings.get(&font_key).is_none() {
                                                    if let Ok(enc_obj) =
                                                        font_dict_tmp.get(b"Encoding")
                                                    {
                                                        if let Ok(name) = enc_obj.as_name() {
                                                            let enc_name =
                                                                String::from_utf8_lossy(name)
                                                                    .to_string();
                                                            font_encodings
                                                                .insert(font_key.clone(), enc_name);
                                                        }
                                                    }
                                                }
                                                console_log!(
                                                    " Font {}: BaseFont={:?} Encoding={:?}",
                                                    font_key,
                                                    base,
                                                    enc
                                                );
                                            }
                                        }
                                    }
                                    // font_val is usually a Reference
                                    if let Ok(font_ref) = font_val.as_reference() {
                                        if let Ok(font_obj) = doc.get_object(font_ref) {
                                            if let Ok(font_dict) = font_obj.as_dict() {
                                                if let Ok(tu_ref_obj) = font_dict.get(b"ToUnicode")
                                                {
                                                    if let Ok(tu_ref) = tu_ref_obj.as_reference() {
                                                        if let Ok(tu_obj) = doc.get_object(tu_ref) {
                                                            if let Object::Stream(stream) = tu_obj {
                                                                if let Ok(cmap_bytes) =
                                                                    stream.decompressed_content()
                                                                {
                                                                    let cmap =
                                                                        parse_cmap(&cmap_bytes);
                                                                    if !cmap.is_empty() {
                                                                        font_maps.insert(
                                                                            font_key.clone(),
                                                                            cmap,
                                                                        );
                                                                        if let Some(m) =
                                                                            font_maps.get(&font_key)
                                                                        {
                                                                            log_cmap_info(
                                                                                &font_key, m,
                                                                            );
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                // Try embedded TrueType FontFile2 in FontDescriptor (store separately even if ToUnicode exists)
                                                if let Ok(fd_obj) = font_dict.get(b"FontDescriptor")
                                                {
                                                    if let Ok(fd_ref) = fd_obj.as_reference() {
                                                        if let Ok(fd) = doc.get_object(fd_ref) {
                                                            if let Ok(fd_dict) = fd.as_dict() {
                                                                // Look for FontFile2 (TrueType)
                                                                if let Ok(ff2_obj) =
                                                                    fd_dict.get(b"FontFile2")
                                                                {
                                                                    if let Ok(ff2_ref) =
                                                                        ff2_obj.as_reference()
                                                                    {
                                                                        if let Ok(ff2_stream_obj) =
                                                                            doc.get_object(ff2_ref)
                                                                        {
                                                                            if let Object::Stream(
                                                                                stream,
                                                                            ) = ff2_stream_obj
                                                                            {
                                                                                if let Ok(font_bytes) =
                                                                                    stream.decompressed_content()
                                                                                {
                                                                                    if let Some(gid_map) =
                                                                                        cmap_from_truetype_gid_map(&font_bytes)
                                                                                    {
                                                                                        // attempt to read CIDToGIDMap from the parent font dictionary
                                                                                        let cidtogid = font_dict.get(b"CIDToGIDMap");
                                                                                        let mut cidtogid_bytes: Option<Vec<u8>> = None;
                                                                                        if let Ok(Object::Stream(s)) = cidtogid.and_then(|o| o.as_reference().and_then(|r| doc.get_object(r))) {
                                                                                            if let Ok(b) = s.decompressed_content() {
                                                                                                cidtogid_bytes = Some(b);
                                                                                            }
                                                                                        }
                                                                                        let cidtogid_ref =
                                                                                            cidtogid_bytes.as_deref();
                                                                                        let tt_map =
                                                                                            make_map_from_gid_map_with_cidtogid(
                                                                                                &gid_map,
                                                                                                cidtogid_ref,
                                                                                            );
                                                                                        if !tt_map.is_empty() {
                                                                                            console_log!(
                                                                                                "Font {}: built cmap from embedded TrueType (FontFile2), entries={}",
                                                                                                font_key,
                                                                                                tt_map.len()
                                                                                            );
                                                                                            if !font_maps.contains_key(&font_key) {
                                                                                                font_maps.insert(
                                                                                                    font_key.clone(),
                                                                                                    tt_map.clone(),
                                                                                                );
                                                                                            }
                                                                                            font_truetype_maps
                                                                                                .insert(font_key.clone(), tt_map);
                                                                                        }
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                // Also check DescendantFonts (Type0)
                                                if let Ok(desc) = font_dict.get(b"DescendantFonts")
                                                {
                                                    if let Ok(arr) = desc.as_array() {
                                                        for el in arr.iter() {
                                                            if let Ok(dref) = el.as_reference() {
                                                                if let Ok(dobj) =
                                                                    doc.get_object(dref)
                                                                {
                                                                    if let Ok(ddict) =
                                                                        dobj.as_dict()
                                                                    {
                                                                        // 1) Descendant ToUnicode
                                                                        if let Ok(tu_ref_obj) =
                                                                            ddict.get(b"ToUnicode")
                                                                        {
                                                                            if let Ok(tu_ref) =
                                                                                tu_ref_obj
                                                                                    .as_reference()
                                                                            {
                                                                                if let Ok(tu_obj) =
                                                                                    doc.get_object(
                                                                                        tu_ref,
                                                                                    )
                                                                                {
                                                                                    if let Object::Stream(stream) = tu_obj {
                                                                                         if let Ok(cmap_bytes) = stream.decompressed_content() {
                                                                                             let cmap = parse_cmap(&cmap_bytes);
                                                                                             if !cmap.is_empty() {
                                                                                                 font_maps.insert(font_key.clone(), cmap);
                                                                                                 if let Some(m) = font_maps.get(&font_key) {
                                                                                                     log_cmap_info(&font_key, m);
                                                                                                 }
                                                                                                 continue;
                                                                                             }
                                                                                         }
                                                                                    }
                                                                                }
                                                                            }
                                                                        }

                                                                        // 2) Descendant FontFile2 (TrueType) fallback (store separately even if ToUnicode exists)
                                                                        if let Ok(dd_fd_obj) = ddict
                                                                            .get(b"FontDescriptor")
                                                                        {
                                                                            if let Ok(dd_fd_ref) =
                                                                                dd_fd_obj
                                                                                    .as_reference()
                                                                            {
                                                                                if let Ok(dd_fd) =
                                                                                    doc.get_object(
                                                                                        dd_fd_ref,
                                                                                    )
                                                                                {
                                                                                    if let Ok(
                                                                                        dd_fd_dict,
                                                                                    ) = dd_fd
                                                                                        .as_dict()
                                                                                    {
                                                                                        if let Ok(ff2_obj) = dd_fd_dict.get(b"FontFile2") {
                                                                                            if let Ok(ff2_ref) = ff2_obj.as_reference() {
                                                                                                if let Ok(ff2_stream_obj) =
                                                                                                    doc.get_object(ff2_ref)
                                                                                                {
                                                                                                    if let Object::Stream(stream) = ff2_stream_obj {
                                                                                                        if let Ok(font_bytes) =
                                                                                                            stream.decompressed_content()
                                                                                                        {
                                                                                                            if let Some(gid_map) =
                                                                                                                cmap_from_truetype_gid_map(&font_bytes)
                                                                                                            {
                                                                                                                // CIDToGIDMap may be on descendant dict or parent
                                                                                                                let cidtogid_obj = ddict.get(b"CIDToGIDMap").or_else(|_| font_dict.get(b"CIDToGIDMap"));
                                                                                                                let mut cidtogid_bytes: Option<Vec<u8>> = None;
                                                                                                                if let Ok(obj) = cidtogid_obj {
                                                                                                                    if let Ok(Object::Stream(s)) = obj.as_reference().and_then(|r| doc.get_object(r)) {
                                                                                                                        if let Ok(b) = s.decompressed_content() {
                                                                                                                            cidtogid_bytes = Some(b);
                                                                                                                        }
                                                                                                                    } else if let Ok(name) = obj.as_name() {
                                                                                                                        // Name 'Identity' means identity mapping
                                                                                                                        let nm = String::from_utf8_lossy(name);
                                                                                                                        if nm != "Identity" {
                                                                                                                            // unknown name: ignore
                                                                                                                        }
                                                                                                                    }
                                                                                                                }
                                                                                                                let cidtogid_ref =
                                                                                                                    cidtogid_bytes.as_deref();
                                                                                                                let tt_map =
                                                                                                                    make_map_from_gid_map_with_cidtogid(
                                                                                                                        &gid_map,
                                                                                                                        cidtogid_ref,
                                                                                                                    );
                                                                                                                if !tt_map.is_empty() {
                                                                                                                    console_log!("Font {}: built cmap from descendant TrueType (FontFile2), entries={}", font_key, tt_map.len());
                                                                                                                    log_cmap_info(&font_key, &tt_map);
                                                                                                                    if !font_maps.contains_key(&font_key) {
                                                                                                                        font_maps.insert(
                                                                                                                            font_key.clone(),
                                                                                                                            tt_map.clone(),
                                                                                                                        );
                                                                                                                    }
                                                                                                                    font_truetype_maps.insert(font_key.clone(), tt_map);
                                                                                                                }
                                                                                                            }
                                                                                                        }
                                                                                                    }
                                                                                                }
                                                                                            }
                                                                                        }
                                                                                    }
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Extract content streams for the page
            // Contents may be Reference or Array
            if let Ok(page_obj) = doc.get_object(page_id) {
                if let Ok(page_dict) = page_obj.as_dict() {
                    if let Ok(contents_obj) = page_dict.get(b"Contents") {
                        // gather bytes from one or more streams
                        let mut content_bytes: Vec<u8> = Vec::new();
                        if let Ok(content_ref) = contents_obj.as_reference() {
                            if let Ok(cobj) = doc.get_object(content_ref) {
                                if let Object::Stream(stream) = cobj {
                                    if let Ok(bts) = stream.decompressed_content() {
                                        content_bytes.extend_from_slice(&bts);
                                    }
                                }
                            }
                        } else if let Ok(arr) = contents_obj.as_array() {
                            for el in arr.iter() {
                                if let Ok(cref) = el.as_reference() {
                                    if let Ok(cobj) = doc.get_object(cref) {
                                        if let Object::Stream(stream) = cobj {
                                            if let Ok(bts) = stream.decompressed_content() {
                                                content_bytes.extend_from_slice(&bts);
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if !content_bytes.is_empty() {
                            if let Ok(content) = Content::decode(&content_bytes) {
                                let mut current_font: Option<String> = None;
                                let mut page_text = String::new();

                                // DEBUG: Add CMap information
                                page_text
                                    .push_str(&format!("=== DEBUG: Page {} ===\n", page_number));
                                page_text.push_str(&format!(
                                    "Found {} font(s) with CMaps:\n",
                                    font_maps.len()
                                ));
                                for (fname, fmap) in font_maps.iter() {
                                    page_text.push_str(&format!(
                                        "  Font '{}': {} entries\n",
                                        fname,
                                        fmap.len()
                                    ));
                                    if fmap.len() > 0 {
                                        // Show first 20 entries
                                        let mut sorted_keys: Vec<_> = fmap.keys().collect();
                                        sorted_keys.sort();
                                        page_text.push_str("    First 20 mappings:\n");
                                        for k in sorted_keys.iter().take(20) {
                                            let v = &fmap[*k];
                                            page_text.push_str(&format!(
                                                "      {:02X?} -> '{}'\n",
                                                k, v
                                            ));
                                        }
                                    }
                                }
                                page_text.push_str("=== END DEBUG ===\n\n");

                                // Track which fonts we've already attempted heuristics for on this page
                                let mut heuristics_tried: std::collections::HashSet<String> =
                                    std::collections::HashSet::new();

                                fn is_cyrillic_char(ch: char) -> bool {
                                    let c = ch as u32;
                                    (c >= 0x0400 && c <= 0x04FF)
                                        || (c >= 0x0500 && c <= 0x052F)
                                        || (c >= 0x2DE0 && c <= 0x2DFF)
                                        || (c >= 0xA640 && c <= 0xA69F)
                                }

                                fn score_text_quality(s: &str) -> i32 {
                                    let mut score: i32 = 0;
                                    let mut space_count: i32 = 0;
                                    let mut digit_count: i32 = 0;
                                    let mut digit_9_count: i32 = 0;
                                    let mut other_digit_count: i32 = 0;
                                    for ch in s.chars() {
                                        if ch == '\u{FFFD}' {
                                            score -= 5;
                                        } else if is_cyrillic_char(ch) {
                                            score += 3;
                                        } else if ch.is_ascii_digit() {
                                            digit_count += 1;
                                            if ch == '9' {
                                                digit_9_count += 1;
                                            } else {
                                                other_digit_count += 1;
                                            }
                                            score += 3;
                                        } else if ch == ' ' {
                                            space_count += 1;
                                            score += 3;
                                        } else if ch.is_ascii_punctuation() {
                                            score += 1;
                                        } else if ch.is_ascii_alphabetic() {
                                            score += 1;
                                        } else if ch.is_whitespace() {
                                            score += 1;
                                        } else if ch.is_control() {
                                            score -= 5;
                                        }
                                    }
                                    if digit_count > 10 && space_count * 2 < digit_count {
                                        score -= digit_count * 2;
                                    }
                                    if digit_9_count >= 5
                                        && other_digit_count == 0
                                        && digit_9_count > space_count * 2
                                    {
                                        score -= digit_9_count * 4;
                                    }
                                    score
                                }

                                fn text_stats(s: &str) -> (i32, i32, i32, i32) {
                                    let mut spaces = 0;
                                    let mut digits = 0;
                                    let mut digit_nines = 0;
                                    let mut cyrillic = 0;
                                    for ch in s.chars() {
                                        if ch == ' ' {
                                            spaces += 1;
                                        } else if ch.is_ascii_digit() {
                                            digits += 1;
                                            if ch == '9' {
                                                digit_nines += 1;
                                            }
                                        } else if is_cyrillic_char(ch) {
                                            cyrillic += 1;
                                        }
                                    }
                                    (spaces, digits, digit_nines, cyrillic)
                                }

                                fn should_force_truetype_by_output(
                                    orig_decoded: &str,
                                    tt_decoded: &str,
                                ) -> bool {
                                    let (os, od, on, oc) = text_stats(orig_decoded);
                                    let (ts, td, tn, tc) = text_stats(tt_decoded);

                                    if on >= 5 && on > os * 2 && (tn < on || ts > os) && tc >= oc {
                                        return true;
                                    }

                                    if od > 10 && os * 2 < od && (td < od || ts > os) && tc >= oc {
                                        return true;
                                    }

                                    false
                                }

                                fn should_force_winansi_fallback(
                                    encoding: Option<&String>,
                                    orig_map: &HashMap<Vec<u8>, String>,
                                ) -> bool {
                                    let enc = match encoding {
                                        Some(e) => e,
                                        None => return false,
                                    };
                                    if enc != "WinAnsiEncoding" {
                                        return false;
                                    }
                                    if let Some(space) = orig_map.get(&vec![0x20]) {
                                        if space != " " {
                                            return true;
                                        }
                                    }
                                    let mut bad_digits = 0;
                                    for b in 0x30u8..=0x39u8 {
                                        let expected = (b as char).to_string();
                                        if let Some(v) = orig_map.get(&vec![b]) {
                                            if v != &expected {
                                                bad_digits += 1;
                                            }
                                        }
                                    }
                                    bad_digits >= 3
                                }

                                fn should_force_truetype_winansi(
                                    encoding: Option<&String>,
                                    orig_map: &HashMap<Vec<u8>, String>,
                                    tt_map: &HashMap<Vec<u8>, String>,
                                ) -> bool {
                                    let enc = match encoding {
                                        Some(e) => e,
                                        None => return false,
                                    };
                                    if enc != "WinAnsiEncoding" {
                                        return false;
                                    }
                                    let orig_space = orig_map.get(&vec![0x20]).cloned();
                                    let tt_space = tt_map
                                        .get(&vec![0x20])
                                        .or_else(|| tt_map.get(&vec![0x00, 0x20]));
                                    if let (Some(os), Some(ts)) = (orig_space, tt_space) {
                                        if os != " " && ts == " " {
                                            return true;
                                        }
                                    }
                                    let mut bad_digits = 0;
                                    let mut good_tt_digits = 0;
                                    for b in 0x30u8..=0x39u8 {
                                        let expected = (b as char).to_string();
                                        if let Some(v) = orig_map.get(&vec![b]) {
                                            if v != &expected {
                                                bad_digits += 1;
                                            }
                                        }
                                        if let Some(v) = tt_map.get(&vec![b]) {
                                            if v == &expected {
                                                good_tt_digits += 1;
                                            }
                                        }
                                    }
                                    bad_digits >= 3 && good_tt_digits >= 3
                                }

                                fn should_switch_to_truetype(
                                    orig_map: &HashMap<Vec<u8>, String>,
                                    tt_map: &HashMap<Vec<u8>, String>,
                                ) -> bool {
                                    let space_keys = [vec![0x20], vec![0x00, 0x20]];
                                    let mut orig_bad_space = false;
                                    let mut tt_good_space = false;
                                    for key in space_keys.iter() {
                                        if let Some(v) = orig_map.get(key) {
                                            if v != " " {
                                                orig_bad_space = true;
                                            }
                                        }
                                        if let Some(v) = tt_map.get(key) {
                                            if v == " " {
                                                tt_good_space = true;
                                            }
                                        }
                                    }

                                    let mut orig_bad_digit = false;
                                    let mut tt_good_digits = 0usize;
                                    for b in 0x30u8..=0x39u8 {
                                        let expected = (b as char).to_string();
                                        let keys = [vec![b], vec![0x00, b]];
                                        for key in keys.iter() {
                                            if let Some(v) = orig_map.get(key) {
                                                if v != &expected {
                                                    orig_bad_digit = true;
                                                }
                                            }
                                            if let Some(v) = tt_map.get(key) {
                                                if v == &expected {
                                                    tt_good_digits += 1;
                                                }
                                            }
                                        }
                                    }

                                    if orig_bad_space && tt_good_space {
                                        return true;
                                    }

                                    if orig_bad_digit && tt_good_digits >= 3 {
                                        return true;
                                    }

                                    false
                                }

                                // helper: generate candidate maps (swap, promote, demote)
                                fn generate_candidates(
                                    orig: &HashMap<Vec<u8>, String>,
                                ) -> Vec<HashMap<Vec<u8>, String>> {
                                    let mut v: Vec<HashMap<Vec<u8>, String>> = Vec::new();
                                    // original
                                    v.push(orig.clone());
                                    // swapped 2-byte keys
                                    let mut swapped: HashMap<Vec<u8>, String> = HashMap::new();
                                    for (k, val) in orig.iter() {
                                        if k.len() == 2 {
                                            let nk = vec![k[1], k[0]];
                                            swapped.insert(nk, val.clone());
                                        }
                                    }
                                    if !swapped.is_empty() {
                                        v.push(swapped);
                                    }
                                    // demote: for keys of len 2 with leading 0x00, add 1-byte key
                                    let mut demoted: HashMap<Vec<u8>, String> = HashMap::new();
                                    for (k, val) in orig.iter() {
                                        if k.len() == 2 && k[0] == 0x00 {
                                            demoted.insert(vec![k[1]], val.clone());
                                        }
                                    }
                                    if !demoted.is_empty() {
                                        v.push(demoted);
                                    }
                                    // promote: for 1-byte keys, add 2-byte 0x00 prefix
                                    let mut promoted: HashMap<Vec<u8>, String> = HashMap::new();
                                    for (k, val) in orig.iter() {
                                        if k.len() == 1 {
                                            promoted.insert(vec![0x00, k[0]], val.clone());
                                        }
                                    }
                                    if !promoted.is_empty() {
                                        v.push(promoted);
                                    }
                                    v
                                }

                                // helper: pick best candidate map by decoding sample and scoring Cyrillic
                                fn pick_best_map_for_sample(
                                    orig_map: &HashMap<Vec<u8>, String>,
                                    alt_map: Option<&HashMap<Vec<u8>, String>>,
                                    sample_bytes: &[u8],
                                ) -> HashMap<Vec<u8>, String> {
                                    let mut candidates = generate_candidates(orig_map);
                                    if let Some(alt) = alt_map {
                                        candidates.extend(generate_candidates(alt));
                                        candidates.push(alt.clone());
                                    }
                                    let mut best_map = orig_map.clone();
                                    let mut best_score = score_text_quality(&decode_with_map(
                                        sample_bytes,
                                        orig_map,
                                    ));
                                    for cm in candidates.into_iter() {
                                        let decoded = decode_with_map(sample_bytes, &cm);
                                        let sc = score_text_quality(&decoded);
                                        if sc > best_score {
                                            best_score = sc;
                                            best_map = cm;
                                        }
                                    }
                                    best_map
                                }
                                for op in content.operations.iter() {
                                    match op.operator.as_ref() {
                                        "Tf" => {
                                            // set font resource
                                            if !op.operands.is_empty() {
                                                if let Ok(name) = op.operands[0].as_name() {
                                                    current_font = Some(
                                                        String::from_utf8_lossy(name).to_string(),
                                                    );
                                                }
                                            }
                                        }
                                        "Tj" => {
                                            if !op.operands.is_empty() {
                                                if let Ok(bytes) = op.operands[0].as_str() {
                                                    // lopdf returns &Vec<u8> via as_str()
                                                    let b = bytes.to_vec();
                                                    if let Some(font_name) = current_font.as_ref() {
                                                        // if we have a map for this font, consider heuristics
                                                        if let Some(orig_map) =
                                                            font_maps.get(font_name)
                                                        {
                                                            if !heuristics_tried.contains(font_name)
                                                            {
                                                                if let Some(tt_map) =
                                                                    font_truetype_maps
                                                                        .get(font_name)
                                                                {
                                                                    let encoding = font_encodings
                                                                        .get(font_name);
                                                                    if should_force_winansi_fallback(
                                                                        encoding, orig_map,
                                                                    ) {
                                                                        console_log!(
                                                                            "Heuristic for font {}: switching to WinAnsi fallback due to ASCII mismatch",
                                                                            font_name
                                                                        );
                                                                        font_maps.insert(
                                                                            font_name.clone(),
                                                                            HashMap::new(),
                                                                        );
                                                                        font_force_winansi.insert(
                                                                            font_name.clone(),
                                                                        );
                                                                        heuristics_tried.insert(
                                                                            font_name.clone(),
                                                                        );
                                                                        let s = decode_winansi(&b);
                                                                        page_text.push_str(&s);
                                                                        continue;
                                                                    }
                                                                    if should_force_truetype_winansi(
                                                                        encoding, orig_map, tt_map,
                                                                    ) {
                                                                        console_log!(
                                                                                "Heuristic for font {}: switching to TrueType map due to WinAnsiEncoding ASCII mismatch",
                                                                                font_name
                                                                            );
                                                                        font_maps.insert(
                                                                            font_name.clone(),
                                                                            tt_map.clone(),
                                                                        );
                                                                        heuristics_tried.insert(
                                                                            font_name.clone(),
                                                                        );
                                                                        let font_map = current_font
                                                                            .as_ref()
                                                                            .and_then(|f| {
                                                                                font_maps.get(f)
                                                                            });
                                                                        let s = if let Some(m) =
                                                                            font_map
                                                                        {
                                                                            debug_decode_with_map(
                                                                                    &b,
                                                                                    m,
                                                                                    current_font
                                                                                        .as_ref()
                                                                                        .unwrap_or(&"".to_string()),
                                                                                    "Tj",
                                                                                )
                                                                        } else {
                                                                            bytes
                                                                                .iter()
                                                                                .map(|&c| c as char)
                                                                                .collect()
                                                                        };
                                                                        page_text.push_str(&s);
                                                                        continue;
                                                                    }
                                                                    let decoded_orig =
                                                                        decode_with_map(
                                                                            &b, orig_map,
                                                                        );
                                                                    let decoded_tt =
                                                                        decode_with_map(&b, tt_map);
                                                                    if should_force_truetype_by_output(
                                                                            &decoded_orig,
                                                                            &decoded_tt,
                                                                        ) {
                                                                            console_log!(
                                                                                "Heuristic for font {}: switching to TrueType map based on output stats",
                                                                                font_name
                                                                            );
                                                                            font_maps.insert(
                                                                                font_name.clone(),
                                                                                tt_map.clone(),
                                                                            );
                                                                            heuristics_tried.insert(
                                                                                font_name.clone(),
                                                                            );
                                                                            let font_map = current_font
                                                                                .as_ref()
                                                                                .and_then(|f| {
                                                                                    font_maps.get(f)
                                                                                });
                                                                            let s = if let Some(m) =
                                                                                font_map
                                                                            {
                                                                                debug_decode_with_map(
                                                                                    &b,
                                                                                    m,
                                                                                    current_font
                                                                                        .as_ref()
                                                                                        .unwrap_or(&"".to_string()),
                                                                                    "Tj",
                                                                                )
                                                                            } else {
                                                                                bytes
                                                                                    .iter()
                                                                                    .map(|&c| c as char)
                                                                                    .collect()
                                                                            };
                                                                            page_text.push_str(&s);
                                                                            continue;
                                                                        }
                                                                    if should_switch_to_truetype(
                                                                        orig_map, tt_map,
                                                                    ) {
                                                                        console_log!(
                                                                                "Heuristic for font {}: switching to TrueType map based on ASCII checks",
                                                                                font_name
                                                                        );
                                                                        font_maps.insert(
                                                                            font_name.clone(),
                                                                            tt_map.clone(),
                                                                        );
                                                                        heuristics_tried.insert(
                                                                            font_name.clone(),
                                                                        );
                                                                        let font_map = current_font
                                                                            .as_ref()
                                                                            .and_then(|f| {
                                                                                font_maps.get(f)
                                                                            });
                                                                        let s = if let Some(m) =
                                                                            font_map
                                                                        {
                                                                            debug_decode_with_map(
                                                                                &b,
                                                                                m,
                                                                                current_font
                                                                                    .as_ref()
                                                                                    .unwrap_or(&"".to_string()),
                                                                                "Tj",
                                                                            )
                                                                        } else {
                                                                            bytes
                                                                                .iter()
                                                                                .map(|&c| c as char)
                                                                                .collect()
                                                                        };
                                                                        page_text.push_str(&s);
                                                                        continue;
                                                                    }
                                                                }
                                                                // quick initial decode and score
                                                                let decoded =
                                                                    decode_with_map(&b, orig_map);
                                                                let score =
                                                                    score_text_quality(&decoded);
                                                                let best = pick_best_map_for_sample(
                                                                    orig_map,
                                                                    font_truetype_maps
                                                                        .get(font_name),
                                                                    &b,
                                                                );
                                                                let new_score = score_text_quality(
                                                                    &decode_with_map(&b, &best),
                                                                );
                                                                console_log!(
                                                                    "Heuristic for font {}: initial_score={} best_score={} selected_map_len={} ",
                                                                    font_name,
                                                                    score,
                                                                    new_score,
                                                                    best.len()
                                                                );
                                                                if new_score > score
                                                                    && best != *orig_map
                                                                {
                                                                    font_maps.insert(
                                                                        font_name.clone(),
                                                                        best,
                                                                    );
                                                                }
                                                                heuristics_tried
                                                                    .insert(font_name.clone());
                                                            }
                                                        }
                                                    }
                                                    let font_map = current_font
                                                        .as_ref()
                                                        .and_then(|f| font_maps.get(f));
                                                    let s = if let Some(font_name) =
                                                        current_font.as_ref()
                                                    {
                                                        if font_force_winansi.contains(font_name) {
                                                            decode_winansi(&b)
                                                        } else if let Some(m) = font_map {
                                                            debug_decode_with_map(
                                                                &b,
                                                                m,
                                                                current_font
                                                                    .as_ref()
                                                                    .unwrap_or(&"".to_string()),
                                                                "Tj",
                                                            )
                                                        } else {
                                                            bytes
                                                                .iter()
                                                                .map(|&c| c as char)
                                                                .collect()
                                                        }
                                                    } else if let Some(m) = font_map {
                                                        debug_decode_with_map(
                                                            &b,
                                                            m,
                                                            current_font
                                                                .as_ref()
                                                                .unwrap_or(&"".to_string()),
                                                            "Tj",
                                                        )
                                                    } else {
                                                        bytes.iter().map(|&c| c as char).collect()
                                                    };
                                                    page_text.push_str(&s);
                                                }
                                            }
                                        }
                                        "TJ" => {
                                            // array of strings and numbers
                                            if !op.operands.is_empty() {
                                                if let Ok(arr) = op.operands[0].as_array() {
                                                    let font_map = current_font
                                                        .as_ref()
                                                        .and_then(|f| font_maps.get(f));
                                                    for el in arr.iter() {
                                                        if let Ok(sbytes) = el.as_str() {
                                                            let b = sbytes.to_vec();
                                                            if let Some(font_name) =
                                                                current_font.as_ref()
                                                            {
                                                                if let Some(orig_map) =
                                                                    font_maps.get(font_name)
                                                                {
                                                                    if !heuristics_tried
                                                                        .contains(font_name)
                                                                    {
                                                                        if let Some(tt_map) =
                                                                            font_truetype_maps
                                                                                .get(font_name)
                                                                        {
                                                                            let encoding =
                                                                                font_encodings
                                                                                    .get(font_name);
                                                                            if should_force_winansi_fallback(
                                                                                encoding,
                                                                                orig_map,
                                                                            ) {
                                                                                console_log!(
                                                                                    "Heuristic for font {}: switching to WinAnsi fallback due to ASCII mismatch",
                                                                                    font_name
                                                                                );
                                                                                font_maps.insert(
                                                                                    font_name.clone(),
                                                                                    HashMap::new(),
                                                                                );
                                                                                font_force_winansi
                                                                                    .insert(font_name.clone());
                                                                                heuristics_tried
                                                                                    .insert(
                                                                                        font_name.clone(),
                                                                                    );
                                                                                let s =
                                                                                    decode_winansi(&b);
                                                                                page_text
                                                                                    .push_str(&s);
                                                                                continue;
                                                                            }
                                                                            if should_force_truetype_winansi(
                                                                                encoding,
                                                                                orig_map,
                                                                                tt_map,
                                                                            ) {
                                                                                console_log!(
                                                                                    "Heuristic for font {}: switching to TrueType map due to WinAnsiEncoding ASCII mismatch",
                                                                                    font_name
                                                                                );
                                                                                font_maps.insert(
                                                                                    font_name.clone(),
                                                                                    tt_map.clone(),
                                                                                );
                                                                                heuristics_tried
                                                                                    .insert(
                                                                                        font_name.clone(),
                                                                                    );
                                                                                let font_map = current_font
                                                                                    .as_ref()
                                                                                    .and_then(|f| font_maps.get(f));
                                                                                let s =
                                                                                    if let Some(m) =
                                                                                        font_map
                                                                                    {
                                                                                        debug_decode_with_map(
                                                                                        &b,
                                                                                        m,
                                                                                        current_font
                                                                                            .as_ref()
                                                                                            .unwrap_or(&"".to_string()),
                                                                                        "TJ",
                                                                                    )
                                                                                    } else {
                                                                                        sbytes
                                                                                        .iter()
                                                                                        .map(|&c| c as char)
                                                                                        .collect()
                                                                                    };
                                                                                page_text
                                                                                    .push_str(&s);
                                                                                continue;
                                                                            }
                                                                            let decoded_orig =
                                                                                decode_with_map(
                                                                                    &b, orig_map,
                                                                                );
                                                                            let decoded_tt =
                                                                                decode_with_map(
                                                                                    &b, tt_map,
                                                                                );
                                                                            if should_force_truetype_by_output(
                                                                                &decoded_orig,
                                                                                &decoded_tt,
                                                                            ) {
                                                                                console_log!(
                                                                                    "Heuristic for font {}: switching to TrueType map based on output stats",
                                                                                    font_name
                                                                                );
                                                                                font_maps.insert(
                                                                                    font_name.clone(),
                                                                                    tt_map.clone(),
                                                                                );
                                                                                heuristics_tried
                                                                                    .insert(
                                                                                        font_name.clone(),
                                                                                    );
                                                                                let font_map = current_font
                                                                                    .as_ref()
                                                                                    .and_then(|f| font_maps.get(f));
                                                                                let s =
                                                                                    if let Some(m) =
                                                                                        font_map
                                                                                    {
                                                                                        debug_decode_with_map(
                                                                                        &b,
                                                                                        m,
                                                                                        current_font
                                                                                            .as_ref()
                                                                                            .unwrap_or(&"".to_string()),
                                                                                        "TJ",
                                                                                    )
                                                                                    } else {
                                                                                        sbytes
                                                                                        .iter()
                                                                                        .map(|&c| c as char)
                                                                                        .collect()
                                                                                    };
                                                                                page_text
                                                                                    .push_str(&s);
                                                                                continue;
                                                                            }
                                                                            if should_switch_to_truetype(
                                                                                orig_map,
                                                                                tt_map,
                                                                            )
                                                                            {
                                                                                console_log!(
                                                                                    "Heuristic for font {}: switching to TrueType map based on ASCII checks",
                                                                                    font_name
                                                                                );
                                                                                font_maps.insert(
                                                                                    font_name
                                                                                        .clone(),
                                                                                    tt_map.clone(),
                                                                                );
                                                                                heuristics_tried
                                                                                    .insert(
                                                                                        font_name
                                                                                            .clone(
                                                                                            ),
                                                                                    );
                                                                                let font_map = current_font
                                                                                    .as_ref()
                                                                                    .and_then(|f| font_maps.get(f));
                                                                                let s =
                                                                                    if let Some(m) =
                                                                                        font_map
                                                                                    {
                                                                                        debug_decode_with_map(
                                                                                        &b,
                                                                                        m,
                                                                                        current_font
                                                                                            .as_ref()
                                                                                            .unwrap_or(&"".to_string()),
                                                                                        "TJ",
                                                                                    )
                                                                                    } else {
                                                                                        sbytes
                                                                                        .iter()
                                                                                        .map(|&c| c as char)
                                                                                        .collect()
                                                                                    };
                                                                                page_text
                                                                                    .push_str(&s);
                                                                                continue;
                                                                            }
                                                                        }
                                                                        let decoded =
                                                                            decode_with_map(
                                                                                &b, orig_map,
                                                                            );
                                                                        let score =
                                                                            score_text_quality(
                                                                                &decoded,
                                                                            );
                                                                        let best = pick_best_map_for_sample(
                                                                            orig_map,
                                                                            font_truetype_maps.get(font_name),
                                                                            &b,
                                                                        );
                                                                        let new_score =
                                                                            score_text_quality(
                                                                                &decode_with_map(
                                                                                    &b, &best,
                                                                                ),
                                                                            );
                                                                        console_log!(
                                                                            "Heuristic for font {}: initial_score={} best_score={} selected_map_len={} ",
                                                                            font_name,
                                                                            score,
                                                                            new_score,
                                                                            best.len()
                                                                        );
                                                                        if new_score > score
                                                                            && best != *orig_map
                                                                        {
                                                                            font_maps.insert(
                                                                                font_name.clone(),
                                                                                best,
                                                                            );
                                                                        }
                                                                        heuristics_tried.insert(
                                                                            font_name.clone(),
                                                                        );
                                                                    }
                                                                }
                                                            }
                                                            let font_map = current_font
                                                                .as_ref()
                                                                .and_then(|f| font_maps.get(f));
                                                            let s = if let Some(font_name) =
                                                                current_font.as_ref()
                                                            {
                                                                if font_force_winansi
                                                                    .contains(font_name)
                                                                {
                                                                    decode_winansi(&b)
                                                                } else if let Some(m) = font_map {
                                                                    debug_decode_with_map(
                                                                        &b,
                                                                        m,
                                                                        current_font
                                                                            .as_ref()
                                                                            .unwrap_or(
                                                                                &"".to_string(),
                                                                            ),
                                                                        "TJ",
                                                                    )
                                                                } else {
                                                                    sbytes
                                                                        .iter()
                                                                        .map(|&c| c as char)
                                                                        .collect()
                                                                }
                                                            } else if let Some(m) = font_map {
                                                                debug_decode_with_map(
                                                                    &b,
                                                                    m,
                                                                    current_font
                                                                        .as_ref()
                                                                        .unwrap_or(&"".to_string()),
                                                                    "TJ",
                                                                )
                                                            } else {
                                                                sbytes
                                                                    .iter()
                                                                    .map(|&c| c as char)
                                                                    .collect()
                                                            };
                                                            page_text.push_str(&s);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        "\n" | "'" | "\"" | "Ts" | _ => {}
                                    }
                                }
                                out_parts.push(page_text);
                            }
                        }
                    }
                }
            }
        }
    }

    let final_text = out_parts.join("\n\n");
    console_log!("Text extraction completed, {} characters", final_text.len());
    Ok(final_text)
}

pub fn extract_text_bytes(bytes: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let doc = Document::load_from(cursor).map_err(|e| format!("Failed to load PDF: {:?}", e))?;
    extract_text_impl(doc)
}

#[wasm_bindgen]
pub fn extract_text(data: js_sys::Uint8Array) -> Result<String, JsValue> {
    let bytes = data.to_vec();
    extract_text_bytes(&bytes).map_err(|e| JsValue::from_str(&e))
}
