#![cfg(mobile)]

use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.noornote.mediasave";

pub struct MediaSave<R: Runtime>(PluginHandle<R>);

pub trait MediaSaveExt<R: Runtime> {
    fn media_save(&self) -> &MediaSave<R>;
}

impl<R: Runtime, T: Manager<R>> MediaSaveExt<R> for T {
    fn media_save(&self) -> &MediaSave<R> {
        self.state::<MediaSave<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("media-save")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MediaSavePlugin")?;
            app.manage(MediaSave(handle));
            Ok(())
        })
        .build()
}
