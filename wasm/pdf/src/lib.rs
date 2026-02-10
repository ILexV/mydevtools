use lopdf::Document;
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

    // We need to renumber objects to avoid collision when merging
    // lopdf doc.max_id holds the highest object ID used.

    // We will append pages from other docs to target_doc

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
        let mut page_ids: Vec<_> = pages.values().cloned().collect();
        // Sort to maintain order if needed, though get_pages returns BTreeMap so it's sorted by page number

        console_log!("Merging doc {} with {} pages", i + 1, page_ids.len());

        // 3. Add all objects from source doc to target doc
        target_doc.objects.extend(doc.objects);

        // 4. Append the page IDs to the target document's page tree
        // We assume a simple structure where we can add to the root Pages object.
        // For production robustness, we should traverse the tree, but for this tool,
        // appending to the root Pages Kids array is usually sufficient for flat merges.

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
