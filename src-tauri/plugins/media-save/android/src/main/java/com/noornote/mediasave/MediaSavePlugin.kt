package com.noornote.mediasave

import android.app.Activity
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
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

@InvokeArg
class SaveToDownloadsArgs {
    lateinit var filename: String
    lateinit var data: String // Base64-encoded
    var mimeType: String = "application/zip"
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

    @Command
    fun saveToDownloads(invoke: Invoke) {
        val args = invoke.parseArgs(SaveToDownloadsArgs::class.java)

        Thread {
            try {
                val bytes = android.util.Base64.decode(args.data, android.util.Base64.DEFAULT)

                val contentValues = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, args.filename)
                    put(MediaStore.Downloads.MIME_TYPE, args.mimeType)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                }

                val uri = activity.contentResolver.insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    contentValues
                )

                if (uri == null) {
                    invoke.reject("Failed to create file in Downloads")
                    return@Thread
                }

                activity.contentResolver.openOutputStream(uri)?.use { output ->
                    output.write(bytes)
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    contentValues.clear()
                    contentValues.put(MediaStore.Downloads.IS_PENDING, 0)
                    activity.contentResolver.update(uri, contentValues, null, null)
                }

                invoke.resolve(JSObject().put("success", true).put("uri", uri.toString()))
            } catch (e: Exception) {
                invoke.reject("Save to Downloads failed: ${e.message}")
            }
        }.start()
    }
}
