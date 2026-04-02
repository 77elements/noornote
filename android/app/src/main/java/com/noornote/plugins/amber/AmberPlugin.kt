package com.noornote.plugins.amber

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.core.net.toUri
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "Amber")
class AmberPlugin : Plugin() {

    private val TAG = "AmberPlugin"
    private var amberPackageName: String = ""

    // ── Detect Amber ──

    @PluginMethod
    fun isAmberInstalled(call: PluginCall) {
        val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:".toUri())
        intent.addCategory(Intent.CATEGORY_DEFAULT)

        var infos = activity.packageManager.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        if (infos.isEmpty()) {
            infos = activity.packageManager.queryIntentActivities(intent, 0)
        }

        Log.d(TAG, "isAmberInstalled: found ${infos.size} results")
        call.resolve(JSObject().put("installed", infos.size > 0))
    }

    // ── Login (get_public_key) ──

    @PluginMethod
    fun login(call: PluginCall) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:".toUri())
            intent.addCategory(Intent.CATEGORY_DEFAULT)
            intent.putExtra("type", "get_public_key")
            intent.putExtra("permissions", """[{"type":"sign_event","kind":22242},{"type":"nip04_encrypt"},{"type":"nip04_decrypt"},{"type":"nip44_encrypt"},{"type":"nip44_decrypt"},{"type":"decrypt_zap_event"}]""")
            startActivityForResult(call, intent, "loginResult")
        } catch (e: ActivityNotFoundException) {
            call.reject("Amber signer app not found. Install it from F-Droid or Obtainium.")
        } catch (e: Exception) {
            call.reject("Amber login failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    @ActivityCallback
    private fun loginResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val pubkey = data?.getStringExtra("result") ?: ""
            val packageName = data?.getStringExtra("package") ?: ""
            amberPackageName = packageName
            call.resolve(JSObject()
                .put("pubkey", pubkey)
                .put("packageName", packageName))
        } else {
            call.reject("Login cancelled")
        }
    }

    // ── Sign Event ──

    @PluginMethod
    fun signEvent(call: PluginCall) {
        val eventJson = call.getString("eventJson") ?: return call.reject("eventJson required")
        val pubkey = call.getString("pubkey") ?: return call.reject("pubkey required")
        val packageName = call.getString("packageName") ?: ""
        amberPackageName = packageName

        val silentResult = tryContentResolverSign(eventJson, pubkey)
        if (silentResult != null) {
            call.resolve(JSObject()
                .put("signature", silentResult.first)
                .put("event", silentResult.second))
            return
        }

        try {
            val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:$eventJson".toUri())
            intent.addCategory(Intent.CATEGORY_DEFAULT)
            intent.putExtra("type", "sign_event")
            intent.putExtra("current_user", pubkey)
            intent.setPackage(packageName)
            startActivityForResult(call, intent, "signEventResult")
        } catch (e: Exception) {
            call.reject("Sign event failed: ${e.message}")
        }
    }

    @ActivityCallback
    private fun signEventResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            call.resolve(JSObject()
                .put("signature", data?.getStringExtra("result") ?: "")
                .put("event", data?.getStringExtra("event") ?: ""))
        } else {
            call.reject("Sign request rejected")
        }
    }

    private fun tryContentResolverSign(eventJson: String, pubkey: String): Pair<String, String>? {
        if (amberPackageName.isEmpty()) return null
        return try {
            val uri = Uri.parse("content://$amberPackageName.SIGN_EVENT")
            val cursor = activity.contentResolver.query(
                uri, arrayOf(eventJson, "", pubkey),
                null, null, null
            )
            cursor?.use {
                if (it.getColumnIndex("rejected") > -1) return null
                if (it.moveToFirst()) {
                    val sig = it.getString(it.getColumnIndex("result")) ?: return null
                    val event = it.getString(it.getColumnIndex("event")) ?: return null
                    Pair(sig, event)
                } else null
            }
        } catch (e: Exception) { null }
    }

    // ── NIP-04 Encrypt/Decrypt ──

    @PluginMethod
    fun nip04Encrypt(call: PluginCall) {
        cryptoOperation(call, "NIP04_ENCRYPT", "nip04_encrypt", "nip04EncryptResult")
    }

    @ActivityCallback
    private fun nip04EncryptResult(call: PluginCall, result: ActivityResult) {
        handleCryptoResult(call, result)
    }

    @PluginMethod
    fun nip04Decrypt(call: PluginCall) {
        cryptoOperation(call, "NIP04_DECRYPT", "nip04_decrypt", "nip04DecryptResult")
    }

    @ActivityCallback
    private fun nip04DecryptResult(call: PluginCall, result: ActivityResult) {
        handleCryptoResult(call, result)
    }

    // ── NIP-44 Encrypt/Decrypt ──

    @PluginMethod
    fun nip44Encrypt(call: PluginCall) {
        cryptoOperation(call, "NIP44_ENCRYPT", "nip44_encrypt", "nip44EncryptResult")
    }

    @ActivityCallback
    private fun nip44EncryptResult(call: PluginCall, result: ActivityResult) {
        handleCryptoResult(call, result)
    }

    @PluginMethod
    fun nip44Decrypt(call: PluginCall) {
        cryptoOperation(call, "NIP44_DECRYPT", "nip44_decrypt", "nip44DecryptResult")
    }

    @ActivityCallback
    private fun nip44DecryptResult(call: PluginCall, result: ActivityResult) {
        handleCryptoResult(call, result)
    }

    // ── Shared Crypto Logic ──

    private fun cryptoOperation(
        call: PluginCall,
        contentResolverType: String,
        intentType: String,
        callbackName: String
    ) {
        val data = call.getString("data") ?: return call.reject("data required")
        val pubkey = call.getString("pubkey") ?: return call.reject("pubkey required")
        val currentUser = call.getString("currentUser") ?: return call.reject("currentUser required")
        val packageName = call.getString("packageName") ?: ""
        amberPackageName = packageName

        val silentResult = tryContentResolverCrypto(contentResolverType, data, pubkey, currentUser)
        if (silentResult != null) {
            call.resolve(JSObject().put("result", silentResult))
            return
        }

        try {
            val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:$data".toUri())
            intent.addCategory(Intent.CATEGORY_DEFAULT)
            intent.putExtra("type", intentType)
            intent.putExtra("current_user", currentUser)
            intent.putExtra("pubkey", pubkey)
            intent.setPackage(packageName)
            startActivityForResult(call, intent, callbackName)
        } catch (e: Exception) {
            call.reject("Crypto operation failed: ${e.message}")
        }
    }

    private fun tryContentResolverCrypto(type: String, data: String, pubkey: String, currentUser: String): String? {
        if (amberPackageName.isEmpty()) return null
        return try {
            val uri = Uri.parse("content://$amberPackageName.$type")
            val cursor = activity.contentResolver.query(
                uri, arrayOf(data, pubkey, currentUser),
                null, null, null
            )
            cursor?.use {
                if (it.getColumnIndex("rejected") > -1) return null
                if (it.moveToFirst()) {
                    it.getString(it.getColumnIndex("result"))
                } else null
            }
        } catch (e: Exception) { null }
    }

    private fun handleCryptoResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) {
            call.resolve(JSObject().put("result", result.data?.getStringExtra("result") ?: ""))
        } else {
            call.reject("Operation rejected")
        }
    }
}
