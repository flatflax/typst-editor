mod ast;
mod compile;
mod export;
mod jump;
mod typst_world;

use ast::parse_typst_ast;
use compile::compile_typst;
use export::export_pdf;
use jump::{jump_from_click, jump_from_cursor};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            compile_typst,
            export_pdf,
            jump_from_click,
            jump_from_cursor,
            parse_typst_ast
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
