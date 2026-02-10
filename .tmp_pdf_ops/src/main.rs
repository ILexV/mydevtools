use lopdf::{content::Content, Document, Object};
use std::env;

fn main() {
    let path = env::args().nth(1).expect("Provide PDF path");
    let doc = Document::load(&path).expect("Failed to load PDF");

    let mut pages: Vec<u32> = doc.get_pages().keys().cloned().collect();
    pages.sort();

    for p in pages {
        println!("--- PAGE {} ---", p);
        if let Some(&page_id) = doc.get_pages().get(&p) {
            if let Ok(page_obj) = doc.get_object(page_id) {
                if let Ok(page_dict) = page_obj.as_dict() {
                    if let Ok(contents_obj) = page_dict.get(b"Contents") {
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

                        println!("content_bytes_len={}", content_bytes.len());
                        if !content_bytes.is_empty() {
                            // print first 200 bytes hex
                            let snippet: Vec<String> = content_bytes
                                .iter()
                                .take(200)
                                .map(|b| format!("{:02X}", b))
                                .collect();
                            println!("content_hex_snippet={}", snippet.join(" "));
                        }

                        // decode operations
                        if !content_bytes.is_empty() {
                            if let Ok(content) = Content::decode(&content_bytes) {
                                for op in content.operations.iter().take(200) {
                                    println!("OP: {} {:?}", op.operator, op.operands);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
