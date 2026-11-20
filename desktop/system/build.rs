fn main() {
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["desktop_operation"]));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // ICO supports embedding the same RGBA PNG used by the Linux window.
        let png = include_bytes!("icons/icon.png");
        let mut ico = vec![0, 0, 1, 0, 1, 0, 128, 128, 0, 0, 1, 0, 32, 0];
        ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes());
        ico.extend_from_slice(png);
        let file = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("icon.ico");
        std::fs::write(&file, ico).expect("desktop icon could not be created");
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(file));
    }
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::try_build(attributes).expect("desktop capabilities could not be built");
}
