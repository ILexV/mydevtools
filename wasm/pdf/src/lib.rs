use lopdf::{Document, Object, ObjectId};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

// Helper to log to console
macro_rules! console_log {
    ($($t:tt)*) => (web_sys::console::log_1(&format!($($t)*).into()))
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
