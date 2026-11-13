mod ai;
mod club_logo;
mod db;
mod discord;
mod faces;
mod faces_pack;
mod faces_progress;
mod faces_remote;
mod facepack;
mod fm;
mod fm_bridge;
mod fm_compat;
mod fm_memory;
mod images;
mod photos_engine;
mod photos_pipeline;
mod photos_remote;
mod photos_scenes;
mod save_backup;

use std::sync::Mutex;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Toutes les données du joueur sont dans ce fichier, sur son PC.
            // Windows : %APPDATA%\app.fmimmersion.desktop\fm-immersion.db
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join("fm-immersion.db"))?;
            app.manage(db::Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_query,
            db::db_batch,
            fm::fm_read_snapshot,
            fm::fm_read_snapshot_since,
            fm::fm_read_reference,
            fm::fm_default_folder,
            fm::fm_list_saves,
            save_backup::fm_backup_list,
            save_backup::fm_backup_make,
            save_backup::fm_backup_open,
            fm::fm_read_status,
            fm::fm_history_list,
            fm::fm_history_read,
            fm_bridge::fm_bridge_status,
            fm_compat::fm_compat_status,
            fm_bridge::fm_bridge_latest,
            fm_bridge::fm_bridge_install,
            fm_bridge::fm_bridge_default_game_dir,
            fm_bridge::fm_bridge_options,
            fm_bridge::fm_bridge_set_option,
            fm_memory::fm_memory_probe,
            fm_memory::fm_memory_find,
            fm_memory::fm_memory_search,
            fm_memory::fm_memory_abilities,
            fm_memory::fm_memory_division,
            fm_memory::fm_memory_staff,
            faces::faces_status,
            faces::faces_install,
            faces::faces_uninstall,
            faces::faces_progress,
            faces::faces_default_workshop,
            faces::faces_ageswap_status,
            faces::faces_ageswap_set,
            faces_remote::faces_remote_check,
            faces_remote::faces_remote_download,
            photos_remote::photos_remote_status,
            photos_remote::photos_remote_download,
            photos_remote::photos_remote_cancel,
            photos_remote::photos_remote_remove,
            photos_remote::photos_set_dir,
            photos_engine::photos_engine_status,
            photos_engine::photos_engine_install,
            photos_engine::photos_engine_start,
            photos_engine::photos_engine_stop,
            photos_engine::photos_engine_test,
            photos_engine::photos_gpu_busy,
            photos_pipeline::photos_scenes,
            photos_pipeline::photos_generate,
            photos_pipeline::photos_library,
            photos_pipeline::photos_library_find,
            photos_pipeline::photos_library_read,
            photos_pipeline::photos_library_delete,
            ai::ai_key_set,
            ai::ai_key_status,
            ai::ai_complete,
            ai::ai_ollama_models,
            discord::discord_send,
            discord::discord_send_image,
            discord::discord_send_certificate,
            discord::discord_post,
            discord::discord_edit,
            discord::discord_live_image,
            fm::fm_read_live,
            fm::fm_read_request,
            fm::fm_write_coach_photo,
            fm::fm_write_press,
            fm::fm_read_press_answer,
            facepack::fm_face,
            club_logo::fm_club_logo,
            images::image_save,
            images::certificate_save
        ])
        .build(tauri::generate_context!())
        .expect("impossible de démarrer FM Immersion")
        .run(|_app, event| {
            // L'IA s'arrête avec l'appli : le modèle Ollama libère la mémoire vidéo.
            if let tauri::RunEvent::Exit = event {
                ai::unload_all();
                // Le moteur des photos (ComfyUI) ne survit pas à l'appli.
                photos_engine::stop();
            }
        });
}
