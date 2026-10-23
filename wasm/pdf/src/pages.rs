//! Page organizer: page list with sizes/rotation, and rebuilding a PDF from a
//! page plan — reorder, rotate, delete pages, or split into several files
//! (one plan per output). Pages are moved, not re-rendered: content, fonts and
//! images are kept byte for byte; objects only the dropped pages used are pruned.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::{inherited_page_attrs, load_document};

/// One page of an output: 0-based source page index and extra clockwise rotation.
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct PlanPage {
    pub page: usize,
    #[serde(default)]
    pub rotate: i64,
}

fn number(doc: &Document, obj: &Object) -> Option<f64> {
    match doc.dereference(obj).ok()?.1 {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

/// Page attribute from the page or an ancestor /Pages node.
fn page_attr(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let page = doc.get_dictionary(page_id).ok()?;
    if let Ok(v) = page.get(key) {
        return Some(v.clone());
    }
    inherited_page_attrs(doc, page_id).into_iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// Width and height in points of the visible box (CropBox, else MediaBox; A4/Letter fallback = 612×792).
fn page_size(doc: &Document, page_id: ObjectId) -> (f64, f64) {
    let rect = page_attr(doc, page_id, b"CropBox").or_else(|| page_attr(doc, page_id, b"MediaBox"));
    let arr = rect.as_ref().and_then(|o| doc.dereference(o).ok()).and_then(|(_, o)| o.as_array().ok().cloned());
    match arr.map(|a| a.iter().filter_map(|v| number(doc, v)).collect::<Vec<_>>()) {
        Some(v) if v.len() == 4 => ((v[2] - v[0]).abs(), (v[3] - v[1]).abs()),
        _ => (612.0, 792.0),
    }
}

fn page_rotation(doc: &Document, page_id: ObjectId) -> i64 {
    page_attr(doc, page_id, b"Rotate").and_then(|o| number(doc, &o)).map_or(0, |r| (r as i64).rem_euclid(360))
}

/// JSON `{"pageCount":n,"pages":[{"width":pt,"height":pt,"rotate":deg}]}`;
/// width/height are the unrotated box, `rotate` the page's /Rotate.
pub fn page_info_bytes(bytes: &[u8]) -> Result<String, String> {
    let doc = load_document(bytes)?;
    let pages = doc
        .get_pages()
        .values()
        .map(|&id| {
            let (w, h) = page_size(&doc, id);
            serde_json::json!({ "width": (w * 100.0).round() / 100.0, "height": (h * 100.0).round() / 100.0, "rotate": page_rotation(&doc, id) })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({ "pageCount": pages.len(), "pages": pages }).to_string())
}

#[wasm_bindgen]
pub fn pdf_page_info(data: js_sys::Uint8Array) -> Result<String, JsValue> {
    page_info_bytes(&data.to_vec()).map_err(|e| JsValue::from_str(&e))
}

/// First page reference of an explicit destination array, if any.
fn dest_page(doc: &Document, dest: &Object) -> Option<ObjectId> {
    let (_, dest) = doc.dereference(dest).ok()?;
    dest.as_array().ok()?.first()?.as_reference().ok()
}

/// Link annotation pointing at a page that is not in the output.
fn is_dead_link(doc: &Document, annot: &Object, dropped: &HashSet<ObjectId>) -> bool {
    let Ok((_, Object::Dictionary(d))) = doc.dereference(annot) else { return false };
    if d.get(b"Subtype").and_then(|s| s.as_name()).ok() != Some(b"Link".as_slice()) {
        return false;
    }
    let target = d.get(b"Dest").ok().and_then(|dest| dest_page(doc, dest)).or_else(|| {
        let (_, action) = doc.dereference(d.get(b"A").ok()?).ok()?;
        dest_page(doc, action.as_dict().ok()?.get(b"D").ok()?)
    });
    target.is_some_and(|id| dropped.contains(&id))
}

/// Form field still has a widget on an output page (or is not tied to a page).
fn field_alive(doc: &Document, field: &Object, dropped: &HashSet<ObjectId>, depth: u8) -> bool {
    let Ok((_, Object::Dictionary(d))) = doc.dereference(field) else { return true };
    if depth < 16 {
        if let Ok(kids) = d.get(b"Kids").and_then(|k| doc.dereference(k).map(|(_, o)| o)).and_then(|k| k.as_array()) {
            return kids.iter().any(|k| field_alive(doc, k, dropped, depth + 1));
        }
    }
    !d.get(b"P").and_then(|p| p.as_reference()).is_ok_and(|p| dropped.contains(&p))
}

/// Mutable dictionary behind `key` in the catalog (direct or by reference).
fn catalog_child_mut<'a>(doc: &'a mut Document, key: &[u8]) -> Option<&'a mut Dictionary> {
    let child = doc.catalog().ok()?.get(key).ok()?.clone();
    match child {
        Object::Reference(id) => doc.get_dictionary_mut(id).ok(),
        Object::Dictionary(_) => doc.catalog_mut().ok()?.get_mut(key).ok()?.as_dict_mut().ok(),
        _ => None,
    }
}

/// Builds one output PDF from `plan`. Reordering drops /PageLabels (index
/// based); removing pages also drops bookmarks, named destinations and the
/// tag tree, links to removed pages and form fields that lived only on them,
/// so the removed pages are not carried along by references.
fn build_output(source: &Document, page_ids: &[ObjectId], plan: &[PlanPage]) -> Result<Vec<u8>, String> {
    if plan.is_empty() {
        return Err("empty page list".to_string());
    }
    let mut seen = HashSet::new();
    for p in plan {
        if p.page >= page_ids.len() {
            return Err(format!("page {} out of range (1–{})", p.page + 1, page_ids.len()));
        }
        if !seen.insert(p.page) {
            return Err(format!("page {} listed twice", p.page + 1));
        }
        if p.rotate % 90 != 0 {
            return Err(format!("rotation {} is not a multiple of 90", p.rotate));
        }
    }

    let mut doc = source.clone();
    let pages_id = doc
        .catalog()
        .and_then(|c| c.get(b"Pages"))
        .and_then(|p| p.as_reference())
        .map_err(|_| "Pages reference missing in Catalog".to_string())?;

    let kept: Vec<ObjectId> = plan.iter().map(|p| page_ids[p.page]).collect();
    let kept_set: HashSet<ObjectId> = kept.iter().copied().collect();
    let dropped: HashSet<ObjectId> = page_ids.iter().copied().filter(|id| !kept_set.contains(id)).collect();

    for p in plan {
        let id = page_ids[p.page];
        let inherited = inherited_page_attrs(&doc, id);
        let rotate = (page_rotation(&doc, id) + p.rotate).rem_euclid(360);
        let page = doc.get_dictionary_mut(id).map_err(|_| "page is not a dictionary".to_string())?;
        for (key, value) in inherited {
            page.set(key, value);
        }
        page.set("Parent", Object::Reference(pages_id));
        if rotate == 0 {
            page.remove(b"Rotate");
        } else {
            page.set("Rotate", Object::Integer(rotate));
        }
    }
    let root = doc.get_dictionary_mut(pages_id).map_err(|_| "Pages is not a dictionary".to_string())?;
    root.set("Kids", Object::Array(kept.iter().map(|&id| Object::Reference(id)).collect()));
    root.set("Count", Object::Integer(kept.len() as i64));

    let same_order = dropped.is_empty() && plan.iter().enumerate().all(|(i, p)| p.page == i);
    if !same_order {
        if let Ok(catalog) = doc.catalog_mut() {
            catalog.remove(b"PageLabels");
        }
    }
    if !dropped.is_empty() {
        // Links on kept pages that jump to removed pages.
        for &id in &kept {
            let annots = doc.get_dictionary(id).ok().and_then(|p| p.get(b"Annots").ok().cloned());
            let Some(annots) = annots else { continue };
            let (annots_ref, list) = match doc.dereference(&annots) {
                Ok((r, Object::Array(a))) => (r, a.clone()),
                _ => continue,
            };
            let filtered: Vec<Object> = list.iter().filter(|a| !is_dead_link(&doc, a, &dropped)).cloned().collect();
            if filtered.len() == list.len() {
                continue;
            }
            match annots_ref {
                Some(rid) => {
                    doc.objects.insert(rid, Object::Array(filtered));
                }
                None => {
                    if let Ok(page) = doc.get_dictionary_mut(id) {
                        page.set("Annots", Object::Array(filtered));
                    }
                }
            }
        }
        // Form fields whose widgets were all on removed pages.
        let fields = catalog_child_mut(&mut doc, b"AcroForm").and_then(|f| f.get(b"Fields").ok().cloned());
        if let Some(Object::Array(list)) = fields {
            let alive: Vec<Object> = list.iter().filter(|f| field_alive(&doc, f, &dropped, 0)).cloned().collect();
            if let Some(form) = catalog_child_mut(&mut doc, b"AcroForm") {
                form.set("Fields", Object::Array(alive));
            }
        }
        if let Some(names) = catalog_child_mut(&mut doc, b"Names") {
            names.remove(b"Dests");
        }
        let open_action_dropped = doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"OpenAction").ok())
            .and_then(|a| dest_page(&doc, a))
            .is_some_and(|id| dropped.contains(&id));
        if let Ok(catalog) = doc.catalog_mut() {
            for key in [b"Outlines".as_slice(), b"Dests", b"StructTreeRoot"] {
                catalog.remove(key);
            }
            if open_action_dropped {
                catalog.remove(b"OpenAction");
            }
        }
    }

    doc.prune_objects();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("Failed to save PDF: {:?}", e))?;
    Ok(out)
}

/// One source PDF → one output per plan (a single plan = reorder/rotate/delete, several = split).
pub fn organize_bytes(bytes: &[u8], outputs: &[Vec<PlanPage>]) -> Result<Vec<Vec<u8>>, String> {
    if outputs.is_empty() {
        return Err("no outputs".to_string());
    }
    let doc = load_document(bytes)?;
    let page_ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    outputs
        .iter()
        .enumerate()
        .map(|(i, plan)| build_output(&doc, &page_ids, plan).map_err(|e| format!("output {}: {}", i + 1, e)))
        .collect()
}

/// `plan_json`: `[[{"page":0,"rotate":90}, …], …]` — one array per output file.
#[wasm_bindgen]
pub fn pdf_organize(data: js_sys::Uint8Array, plan_json: &str) -> Result<js_sys::Array, JsValue> {
    let outputs: Vec<Vec<PlanPage>> =
        serde_json::from_str(plan_json).map_err(|e| JsValue::from_str(&format!("invalid plan: {e}")))?;
    let files = organize_bytes(&data.to_vec(), &outputs).map_err(|e| JsValue::from_str(&e))?;
    Ok(files.iter().map(|f| js_sys::Uint8Array::from(f.as_slice())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::make_pdf;

    fn page_texts(bytes: &[u8]) -> Vec<String> {
        crate::extract_text_bytes(bytes).unwrap().split("\n\n").map(|s| s.trim().to_string()).collect()
    }

    fn plan(pages: &[(usize, i64)]) -> Vec<PlanPage> {
        pages.iter().map(|&(page, rotate)| PlanPage { page, rotate }).collect()
    }

    #[test]
    fn info_reports_inherited_size_and_rotation() {
        let info: serde_json::Value = serde_json::from_str(&page_info_bytes(&make_pdf(&["A", "B"])).unwrap()).unwrap();
        assert_eq!(info["pageCount"], 2);
        assert_eq!(info["pages"][0]["width"], 612.0);
        assert_eq!(info["pages"][0]["height"], 792.0);
        assert_eq!(info["pages"][1]["rotate"], 0);
    }

    #[test]
    fn reorder_rotate_and_delete() {
        let src = make_pdf(&["One", "Two", "Three"]);
        let out = organize_bytes(&src, &[plan(&[(2, 90), (0, 0)])]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(page_texts(&out[0]), vec!["Three", "One"]);
        let info: serde_json::Value = serde_json::from_str(&page_info_bytes(&out[0]).unwrap()).unwrap();
        assert_eq!(info["pageCount"], 2);
        assert_eq!(info["pages"][0]["rotate"], 90);
        assert_eq!(info["pages"][0]["width"], 612.0); // MediaBox inherited onto the page
        assert_eq!(info["pages"][1]["rotate"], 0);
        // Rotation accumulates and wraps: 90 + 270 = 0.
        let back = organize_bytes(&out[0], &[plan(&[(0, 270)])]).unwrap();
        let info: serde_json::Value = serde_json::from_str(&page_info_bytes(&back[0]).unwrap()).unwrap();
        assert_eq!(info["pages"][0]["rotate"], 0);
    }

    #[test]
    fn split_into_several_files_prunes_other_pages() {
        let src = make_pdf(&["One", "Two", "Three", "Four"]);
        let out = organize_bytes(&src, &[plan(&[(0, 0), (1, 0)]), plan(&[(2, 0)]), plan(&[(3, 0)])]).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(page_texts(&out[0]), vec!["One", "Two"]);
        assert_eq!(page_texts(&out[1]), vec!["Three"]);
        assert_eq!(page_texts(&out[2]), vec!["Four"]);
        let doc = Document::load_mem(&out[1]).unwrap();
        let streams = doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .filter(|s| s.dict.get(b"Type").and_then(|t| t.as_name()).ok() != Some(b"XRef".as_slice()))
            .count();
        assert_eq!(streams, 1, "only the kept page's content stream survives");
    }

    #[test]
    fn rejects_bad_plans() {
        let src = make_pdf(&["One", "Two"]);
        assert!(organize_bytes(&src, &[plan(&[(5, 0)])]).unwrap_err().contains("out of range"));
        assert!(organize_bytes(&src, &[plan(&[(0, 0), (0, 0)])]).unwrap_err().contains("twice"));
        assert!(organize_bytes(&src, &[plan(&[(0, 45)])]).unwrap_err().contains("multiple of 90"));
        assert!(organize_bytes(&src, &[vec![]]).unwrap_err().contains("empty"));
        assert!(organize_bytes(b"not a pdf", &[plan(&[(0, 0)])]).is_err());
    }
}
