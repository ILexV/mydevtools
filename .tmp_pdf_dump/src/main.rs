use lopdf::Document;
use std::env;

fn main() {
    let path = env::args().nth(1).expect("Provide PDF path");
    let doc = Document::load(&path).expect("Failed to load PDF");
    let mut pages: Vec<u32> = doc.get_pages().keys().cloned().collect();
    pages.sort();

    let mut out = String::new();
    for p in pages {
        out.push_str(&format!("--- PAGE {} ---\n", p));
        if let Some(&pid) = doc.get_pages().get(&p) {
            if let Ok(page_obj) = doc.get_object(pid) {
                if let Ok(page_dict) = page_obj.as_dict() {
                    if let Ok(contents_obj) = page_dict.get(b"Contents") {
                        let mut content_bytes = Vec::new();
                        if let Ok(cref) = contents_obj.as_reference() {
                            if let Ok(cobj) = doc.get_object(cref) {
                                if let lopdf::Object::Stream(s) = cobj {
                                    if let Ok(b) = s.decompressed_content() {
                                        content_bytes.extend_from_slice(&b);
                                    }
                                }
                            }
                        } else if let Ok(arr) = contents_obj.as_array() {
                            for el in arr.iter() {
                                if let Ok(r) = el.as_reference() {
                                    if let Ok(cobj) = doc.get_object(r) {
                                        if let lopdf::Object::Stream(s) = cobj {
                                            if let Ok(b) = s.decompressed_content() {
                                                content_bytes.extend_from_slice(&b);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        out.push_str(&format!("content_bytes_len={}\n", content_bytes.len()));
                        // dump hex of first 200 bytes
                        let dump: String = content_bytes
                            .iter()
                            .take(200)
                            .map(|b| format!("{:02X}", b))
                            .collect::<Vec<_>>()
                            .join(" ");
                        out.push_str(&format!("content_hex_snippet={}\n", dump));
                    }
                }
            }
        }
    }
    std::fs::write("content_dump.txt", out).expect("write failed");
    println!("Wrote content_dump.txt");
}
