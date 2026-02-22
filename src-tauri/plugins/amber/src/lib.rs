#![cfg(mobile)]

use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

mod error;
pub use error::{Error, Result};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.noornote.amber";

pub struct Amber<R: Runtime>(PluginHandle<R>);

pub trait AmberExt<R: Runtime> {
    fn amber(&self) -> &Amber<R>;
}

impl<R: Runtime, T: Manager<R>> AmberExt<R> for T {
    fn amber(&self) -> &Amber<R> {
        self.state::<Amber<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("amber")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "AmberPlugin")?;
            app.manage(Amber(handle));
            Ok(())
        })
        .build()
}
