package com.noornote.amber

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.core.net.toUri
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// ── Argument classes (auto-deserialized from JSON via @InvokeArg) ──

@InvokeArg
class SignEventArgs {
    lateinit var eventJson: String
    lateinit var pubkey: String
    lateinit var packageName: String
}

@InvokeArg
class CryptoArgs {
    lateinit var data: String
    lateinit var pubkey: String
    lateinit var currentUser: String
    lateinit var packageName: String
}

// ── Plugin ──

@TauriPlugin
class AmberPlugin(private val activity: Activity) : Plugin(activity) {

    private val TAG = "AmberPlugin"
    private var amberPackageName: String = ""

    // ── Detect Amber ──

    @Command
    fun isAmberInstalled(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:".toUri())
        intent.addCategory(Intent.CATEGORY_DEFAULT)

        // Try MATCH_ALL first (most permissive), fallback to 0
        var infos = activity.packageManager.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        if (infos.isEmpty()) {
            infos = activity.packageManager.queryIntentActivities(intent, 0)
        }

        Log.d(TAG, "isAmberInstalled: queryIntentActivities found ${infos.size} results")
        invoke.resolve(JSObject().put("installed", infos.size > 0))
    }

    // ── Login (get_public_key) ──

    @Command
    fun login(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:".toUri())
            intent.addCategory(Intent.CATEGORY_DEFAULT)
            intent.putExtra("type", "get_public_key")
            intent.putExtra("permissions", """[{"type":"sign_event","kind":22242},{"type":"nip04_encrypt"},{"type":"nip04_decrypt"},{"type":"nip44_encrypt"},{"type":"nip44_decrypt"},{"type":"decrypt_zap_event"}]""")
            Log.d(TAG, "login: launching nostrsigner intent")
            startActivityForResult(invoke, intent, "loginResult")
        } catch (e: ActivityNotFoundException) {
            Log.e(TAG, "login: Amber not found", e)
            invoke.reject("Amber signer app not found. Install it from F-Droid or Obtainium.")
        } catch (e: Exception) {
            Log.e(TAG, "login: failed", e)
            invoke.reject("Amber login failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    @ActivityCallback
    private fun loginResult(invoke: Invoke, result: ActivityResult) {
        Log.d(TAG, "loginResult: resultCode=${result.resultCode}")
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val pubkey = data?.getStringExtra("result") ?: ""
            val packageName = data?.getStringExtra("package") ?: ""
            amberPackageName = packageName
            Log.d(TAG, "loginResult: pubkey=${pubkey.take(8)}..., package=$packageName")
            invoke.resolve(JSObject()
                .put("pubkey", pubkey)
                .put("packageName", packageName))
        } else {
            Log.d(TAG, "loginResult: cancelled or failed, resultCode=${result.resultCode}")
            invoke.reject("Login cancelled (resultCode=${result.resultCode})")
        }
    }

    // ── Sign Event ──

    @Command
    fun signEvent(invoke: Invoke) {
        val args = invoke.parseArgs(SignEventArgs::class.java)
        amberPackageName = args.packageName

        val silentResult = tryContentResolverSign(args.eventJson, args.pubkey)
        if (silentResult != null) {
            invoke.resolve(JSObject()
                .put("signature", silentResult.first)
                .put("event", silentResult.second))
            return
        }

        try {
            val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:${args.eventJson}".toUri())
            intent.addCategory(Intent.CATEGORY_DEFAULT)
            intent.putExtra("type", "sign_event")
            intent.putExtra("current_user", args.pubkey)
            intent.setPackage(args.packageName)
            startActivityForResult(invoke, intent, "signEventResult")
        } catch (e: Exception) {
            Log.e(TAG, "signEvent: failed", e)
            invoke.reject("Sign event failed: ${e.message}")
        }
    }

    @ActivityCallback
    private fun signEventResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val signature = data?.getStringExtra("result") ?: ""
            val eventJson = data?.getStringExtra("event") ?: ""
            invoke.resolve(JSObject()
                .put("signature", signature)
                .put("event", eventJson))
        } else {
            invoke.reject("Sign request rejected")
        }
    }

    private fun tryContentResolverSign(eventJson: String, pubkey: String): Pair<String, String>? {
        if (amberPackageName.isEmpty()) return null
        return try {
            val uri = Uri.parse("content://$amberPackageName.SIGN_EVENT")
            val cursor = activity.contentResolver.query(
                uri,
                arrayOf(eventJson, "", pubkey),
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

    @Command
    fun nip04Encrypt(invoke: Invoke) {
        cryptoOperation(invoke, "NIP04_ENCRYPT", "nip04_encrypt", "nip04EncryptResult")
    }

    @ActivityCallback
    private fun nip04EncryptResult(invoke: Invoke, result: ActivityResult) {
        handleCryptoResult(invoke, result)
    }

    @Command
    fun nip04Decrypt(invoke: Invoke) {
        cryptoOperation(invoke, "NIP04_DECRYPT", "nip04_decrypt", "nip04DecryptResult")
    }

    @ActivityCallback
    private fun nip04DecryptResult(invoke: Invoke, result: ActivityResult) {
        handleCryptoResult(invoke, result)
    }

    // ── NIP-44 Encrypt/Decrypt ──

    @Command
    fun nip44Encrypt(invoke: Invoke) {
        cryptoOperation(invoke, "NIP44_ENCRYPT", "nip44_encrypt", "nip44EncryptResult")
    }

    @ActivityCallback
    private fun nip44EncryptResult(invoke: Invoke, result: ActivityResult) {
        handleCryptoResult(invoke, result)
    }

    @Command
    fun nip44Decrypt(invoke: Invoke) {
        cryptoOperation(invoke, "NIP44_DECRYPT", "nip44_decrypt", "nip44DecryptResult")
    }

    @ActivityCallback
    private fun nip44DecryptResult(invoke: Invoke, result: ActivityResult) {
        handleCryptoResult(invoke, result)
    }

    // ── Shared Crypto Logic ──

    private fun cryptoOperation(
        invoke: Invoke,
        contentResolverType: String,
        intentType: String,
        callbackName: String
    ) {
        val args = invoke.parseArgs(CryptoArgs::class.java)
        amberPackageName = args.packageName

        val silentResult = tryContentResolverCrypto(contentResolverType, args.data, args.pubkey, args.currentUser)
        if (silentResult != null) {
            invoke.resolve(JSObject().put("result", silentResult))
            return
        }

        try {
            val intent = Intent(Intent.ACTION_VIEW, "nostrsigner:${args.data}".toUri())
            intent.addCategory(Intent.CATEGORY_DEFAULT)
            intent.putExtra("type", intentType)
            intent.putExtra("current_user", args.currentUser)
            intent.putExtra("pubkey", args.pubkey)
            intent.setPackage(args.packageName)
            startActivityForResult(invoke, intent, callbackName)
        } catch (e: Exception) {
            Log.e(TAG, "cryptoOperation ($intentType): failed", e)
            invoke.reject("Crypto operation failed: ${e.message}")
        }
    }

    private fun tryContentResolverCrypto(type: String, data: String, pubkey: String, currentUser: String): String? {
        if (amberPackageName.isEmpty()) return null
        return try {
            val uri = Uri.parse("content://$amberPackageName.$type")
            val cursor = activity.contentResolver.query(
                uri,
                arrayOf(data, pubkey, currentUser),
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

    private fun handleCryptoResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val resultStr = data?.getStringExtra("result") ?: ""
            invoke.resolve(JSObject().put("result", resultStr))
        } else {
            invoke.reject("Operation rejected")
        }
    }
}
