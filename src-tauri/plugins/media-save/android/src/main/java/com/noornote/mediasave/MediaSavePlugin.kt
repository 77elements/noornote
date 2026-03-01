package com.noornote.mediasave

import android.app.Activity
import android.net.Uri
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.net.HttpURLConnection
import java.net.URL

@InvokeArg
class SaveMediaArgs {
    lateinit var uri: String
    lateinit var mediaUrl: String
}

@TauriPlugin
class MediaSavePlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun saveMedia(invoke: Invoke) {
        val args = invoke.parseArgs(SaveMediaArgs::class.java)

        Thread {
            try {
                val contentUri = Uri.parse(args.uri)
                val url = URL(args.mediaUrl)
                val connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = 30000
                connection.readTimeout = 30000
                connection.connect()

                if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                    invoke.reject("HTTP ${connection.responseCode}")
                    connection.disconnect()
                    return@Thread
                }

                val outputStream = activity.contentResolver.openOutputStream(contentUri)
                if (outputStream == null) {
                    invoke.reject("Failed to open output stream")
                    connection.disconnect()
                    return@Thread
                }

                connection.inputStream.use { input ->
                    outputStream.use { output ->
                        input.copyTo(output)
                    }
                }

                connection.disconnect()
                invoke.resolve(JSObject().put("success", true))
            } catch (e: Exception) {
                invoke.reject("Save failed: ${e.message}")
            }
        }.start()
    }
}
