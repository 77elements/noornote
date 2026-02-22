const COMMANDS: &[&str] = &[
    "is_amber_installed",
    "login",
    "sign_event",
    "nip04_encrypt",
    "nip04_decrypt",
    "nip44_encrypt",
    "nip44_decrypt",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .unwrap();
}
