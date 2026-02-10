use hex;
use lopdf::{Document, Object};
use std::collections::HashMap;
use std::env;
use ttf_parser::Face;

fn dump_stream_if_ref(doc: &Document, obj: &lopdf::Object) -> Option<Vec<u8>> {
    if let Ok(r) = obj.as_reference() {
        if let Ok(o) = doc.get_object(r) {
            if let Object::Stream(s) = o {
                if let Ok(b) = s.decompressed_content() {
                    return Some(b);
                }
            }
        }
    }
    None
}

fn cmap_from_truetype_gid_map(font_bytes: &[u8]) -> Option<HashMap<u16, String>> {
    if let Ok(face) = Face::parse(font_bytes, 0) {
        let mut map: HashMap<u16, String> = HashMap::new();
        for codepoint in 0u32..=0xFFFFu32 {
            if let Some(ch) = std::char::from_u32(codepoint) {
                if let Some(gid) = face.glyph_index(ch) {
                    map.entry(gid.0).or_insert_with(|| ch.to_string());
                }
            }
        }
        if !map.is_empty() {
            return Some(map);
        }
    }
    None
}

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
                    if let Ok(resources_ref) =
                        page_dict.get(b"Resources").and_then(|r| r.as_reference())
                    {
                        if let Ok(resources_obj) = doc.get_object(resources_ref) {
                            if let Ok(resources_dict) = resources_obj.as_dict() {
                                if let Ok(fonts_obj) = resources_dict.get(b"Font") {
                                    if let Ok(fonts_dict) = fonts_obj.as_dict() {
                                        for (font_name, font_val) in fonts_dict.iter() {
                                            let font_key = String::from_utf8_lossy(font_name);
                                            println!("Found font resource: {}", font_key);
                                            if let Ok(font_ref) = font_val.as_reference() {
                                                if let Ok(font_obj) = doc.get_object(font_ref) {
                                                    if let Ok(font_dict) = font_obj.as_dict() {
                                                        println!(
                                                            " Font keys: {:?}",
                                                            font_dict.keys()
                                                        );
                                                        if let Ok(tu_ref_obj) =
                                                            font_dict.get(b"ToUnicode")
                                                        {
                                                            if let Ok(tu_ref) =
                                                                tu_ref_obj.as_reference()
                                                            {
                                                                if let Ok(tu_obj) =
                                                                    doc.get_object(tu_ref)
                                                                {
                                                                    if let Object::Stream(stream) =
                                                                        tu_obj
                                                                    {
                                                                        if let Ok(cmap_bytes) = stream.decompressed_content() {
                                                                            println!("  Has ToUnicode stream, len={}", cmap_bytes.len());
                                                                            // print snippet
                                                                            println!("  Sample: {}", String::from_utf8_lossy(&cmap_bytes[..std::cmp::min(200,cmap_bytes.len())]));
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }

                                                        // Try FontFile2
                                                        if let Ok(fd_obj) =
                                                            font_dict.get(b"FontDescriptor")
                                                        {
                                                            if let Ok(fd_ref) =
                                                                fd_obj.as_reference()
                                                            {
                                                                if let Ok(fd) =
                                                                    doc.get_object(fd_ref)
                                                                {
                                                                    if let Ok(fd_dict) =
                                                                        fd.as_dict()
                                                                    {
                                                                        if let Ok(ff2_obj) = fd_dict
                                                                            .get(b"FontFile2")
                                                                        {
                                                                            if let Ok(ff2_ref) =
                                                                                ff2_obj
                                                                                    .as_reference()
                                                                            {
                                                                                if let Ok(
                                                                                    ff2_stream_obj,
                                                                                ) = doc
                                                                                    .get_object(
                                                                                        ff2_ref,
                                                                                    )
                                                                                {
                                                                                    if let Object::Stream(stream) = ff2_stream_obj {
                                                                                        if let Ok(font_bytes) = stream.decompressed_content() {
                                                                                            println!("  Found FontFile2, len={}", font_bytes.len());
                                                                                            if let Some(gid_map) = cmap_from_truetype_gid_map(&font_bytes) {
                                                                                                println!("   GID map size={}", gid_map.len());
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

                                                        // DescendantFonts
                                                        if let Ok(desc) =
                                                            font_dict.get(b"DescendantFonts")
                                                        {
                                                            if let Ok(arr) = desc.as_array() {
                                                                for el in arr.iter() {
                                                                    if let Ok(dref) =
                                                                        el.as_reference()
                                                                    {
                                                                        if let Ok(dobj) =
                                                                            doc.get_object(dref)
                                                                        {
                                                                            if let Ok(ddict) =
                                                                                dobj.as_dict()
                                                                            {
                                                                                println!("  Descendant keys: {:?}", ddict.keys());
                                                                                if let Ok(
                                                                                    tu_ref_obj,
                                                                                ) = ddict.get(
                                                                                    b"ToUnicode",
                                                                                ) {
                                                                                    if let Ok(tu_ref) = tu_ref_obj.as_reference() {
                                                                                        if let Ok(tu_obj) = doc.get_object(tu_ref) {
                                                                                            if let Object::Stream(stream) = tu_obj {
                                                                                                if let Ok(cmap_bytes) = stream.decompressed_content() {
                                                                                                    println!("   Descendant ToUnicode len={}", cmap_bytes.len());
                                                                                                    println!("   Sample: {}", String::from_utf8_lossy(&cmap_bytes[..std::cmp::min(200,cmap_bytes.len())]));
                                                                                                }
                                                                                            }
                                                                                        }
                                                                                    }
                                                                                }

                                                                                if let Ok(dd_fd_obj) = ddict.get(b"FontDescriptor") {
                                                                                    if let Ok(dd_fd_ref) = dd_fd_obj.as_reference() {
                                                                                        if let Ok(dd_fd) = doc.get_object(dd_fd_ref) {
                                                                                            if let Ok(dd_fd_dict) = dd_fd.as_dict() {
                                                                                                if let Ok(ff2_obj) = dd_fd_dict.get(b"FontFile2") {
                                                                                                    if let Ok(ff2_ref) = ff2_obj.as_reference() {
                                                                                                        if let Ok(ff2_stream_obj) = doc.get_object(ff2_ref) {
                                                                                                            if let Object::Stream(stream) = ff2_stream_obj {
                                                                                                                if let Ok(font_bytes) = stream.decompressed_content() {
                                                                                                                    println!("   Descendant FontFile2 len={}", font_bytes.len());
                                                                                                                    if let Some(gid_map) = cmap_from_truetype_gid_map(&font_bytes) {
                                                                                                                        println!("    Descendant GID map size={}", gid_map.len());
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
            }
        }
    }
}
