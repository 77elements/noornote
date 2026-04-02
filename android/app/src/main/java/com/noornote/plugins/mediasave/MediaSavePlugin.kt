package com.noornote.plugins.mediasave

import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL

@CapacitorPlugin(name = "MediaSave")
class MediaSavePlugin : Plugin() {

    @PluginMethod
    fun saveMedia(call: PluginCall) {
        val contentUriStr = call.getString("uri") ?: return call.reject("uri required")
        val mediaUrl = call.getString("mediaUrl") ?: return call.reject("mediaUrl required")

        Thread {
            try {
                val contentUri = Uri.parse(contentUriStr)
                val url = URL(mediaUrl)
                val connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "GET"
                connection.connectTimeout = 30000
                connection.readTimeout = 30000
                connection.connect()

                if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                    call.reject("HTTP ${connection.responseCode}")
                    connection.disconnect()
                    return@Thread
                }

                val outputStream = activity.contentResolver.openOutputStream(contentUri)
                if (outputStream == null) {
                    call.reject("Failed to open output stream")
                    connection.disconnect()
                    return@Thread
                }

                connection.inputStream.use { input ->
                    outputStream.use { output ->
                        input.copyTo(output)
                    }
                }

                connection.disconnect()
                call.resolve(JSObject().put("success", true))
            } catch (e: Exception) {
                call.reject("Save failed: ${e.message}")
            }
        }.start()
    }

    @PluginMethod
    fun saveToDownloads(call: PluginCall) {
        val filename = call.getString("filename") ?: return call.reject("filename required")
        val data = call.getString("data") ?: return call.reject("data required")
        val mimeType = call.getString("mimeType") ?: "application/zip"

        Thread {
            try {
                val bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT)

                val contentValues = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                }

                val uri = activity.contentResolver.insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    contentValues
                ) ?: run {
                    call.reject("Failed to create file in Downloads")
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

                call.resolve(JSObject().put("success", true).put("uri", uri.toString()))
            } catch (e: Exception) {
                call.reject("Save to Downloads failed: ${e.message}")
            }
        }.start()
    }
}
