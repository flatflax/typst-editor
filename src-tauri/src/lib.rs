mod ast;
mod asset;
mod compile;
mod export;
mod geometry;
mod jump;
mod typst_world;

use std::sync::Mutex;

use ast::parse_typst_ast;
use asset::read_image_as_data_url;
use compile::{block_geometry, compile_typst};
use export::export_pdf;
use jump::{jump_from_click, jump_from_cursor};
use typst_world::TauriWorld;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Held for the app's lifetime (plan.md M14's follow-up (a)) so
        // `compile_typst` can apply incremental `Source::edit`s instead of
        // reconstructing a `TauriWorld` from scratch on every keystroke —
        // see compile.rs's module doc comment.
        .manage(Mutex::new(TauriWorld::new(String::new(), None)))
        .invoke_handler(tauri::generate_handler![
            block_geometry,
            compile_typst,
            export_pdf,
            jump_from_click,
            jump_from_cursor,
            parse_typst_ast,
            read_image_as_data_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
