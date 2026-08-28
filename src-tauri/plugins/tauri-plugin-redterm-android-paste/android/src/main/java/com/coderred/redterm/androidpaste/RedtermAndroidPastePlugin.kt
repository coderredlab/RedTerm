package com.coderred.redterm.androidpaste

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import android.speech.SpeechRecognizer
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodInfo
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.InputMethodSubtype
import android.webkit.WebView
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

@InvokeArg
class KeepScreenOnArgs {
    var enabled: Boolean = false
}

@InvokeArg
class ForegroundServiceArgs {
    var sessionCount: Int = 1
    var title: String = "RedTerm - Connection active"
    var text: String = "SSH session is kept alive in the background"
}

@InvokeArg
class KeyboardArgs {
    var visible: Boolean = true
}

@InvokeArg
class VoiceInputArgs {
    var languageTag: String = ""
}

@InvokeArg
class CredentialIdArgs {
    var credentialId: String = ""
}

@InvokeArg
class CredentialWriteArgs {
    var credentialId: String = ""
    var password: String = ""
}

internal fun detectSupportedImageMimeType(header: ByteArray, length: Int): String? {
    if (length >= 8 &&
        header[0] == 0x89.toByte() &&
        header[1] == 0x50.toByte() &&
        header[2] == 0x4e.toByte() &&
        header[3] == 0x47.toByte() &&
        header[4] == 0x0d.toByte() &&
        header[5] == 0x0a.toByte() &&
        header[6] == 0x1a.toByte() &&
        header[7] == 0x0a.toByte()
    ) {
        return "image/png"
    }
    if (length >= 3 &&
        header[0] == 0xff.toByte() &&
        header[1] == 0xd8.toByte() &&
        header[2] == 0xff.toByte()
    ) {
        return "image/jpeg"
    }
    if (length >= 6) {
        val signature = String(header, 0, 6, StandardCharsets.US_ASCII)
        if (signature == "GIF87a" || signature == "GIF89a") return "image/gif"
    }
    if (length >= 12 &&
        String(header, 0, 4, StandardCharsets.US_ASCII) == "RIFF" &&
        String(header, 8, 4, StandardCharsets.US_ASCII) == "WEBP"
    ) {
        return "image/webp"
    }
    return null
}

@TauriPlugin(
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class RedtermAndroidPastePlugin(private val activity: Activity) : Plugin(activity) {
    private data class ActiveContentRequest(
        val id: String,
        val onSuccess: (File) -> Unit,
        val onError: (String) -> Unit,
        var timeoutTask: ScheduledFuture<*>? = null,
    )

    private var webView: WebView? = null
    private var voiceInputController: VoiceInputController? = null
    private val credentialPreferences by lazy {
        activity.getSharedPreferences(CREDENTIAL_PREFERENCES, Context.MODE_PRIVATE)
    }
    private val contentRequestLock = Any()
    private var activeContentRequest: ActiveContentRequest? = null
    private val contentWatchdog: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor()

    override fun load(webView: WebView) {
        this.webView = webView

        // OnReceiveContentListener for drag-drop and system paste
        ViewCompat.setOnReceiveContentListener(
            webView,
            arrayOf("image/*"),
            OnReceiveContentListener { _, payload ->
                handleIncomingContent(payload)
                null
            }
        )

        // Hook into RustWebView's IME image commit callback (for Samsung keyboard etc.)
        try {
            val field = webView.javaClass.getDeclaredField("onImeImageCommitted")
            field.isAccessible = true
            val callback: (Uri, String) -> Unit = { uri, _ ->
                handleImeImage(uri)
            }
            field.set(webView, callback)
        } catch (_: Exception) {
            // RustWebView patch not applied or field not available
        }
    }

    override fun onDestroy() {
        voiceInputController?.cancel()
        voiceInputController = null
        cancelActiveContentRequest()
        contentWatchdog.shutdownNow()
        super.onDestroy()
    }

    private fun handleImeImage(uri: Uri) {
        enqueueImagePaste(uri)
    }

    private fun handleIncomingContent(payload: ContentInfoCompat) {
        val clip = payload.clip
        for (index in 0 until clip.itemCount) {
            val uri = clip.getItemAt(index).uri ?: continue
            enqueueImagePaste(uri)
            return
        }
    }

    private fun enqueueImagePaste(uri: Uri) {
        submitContentRequest(
            uri = uri,
            onSuccess = { file -> dispatchImagePaste(file.absolutePath) },
            onError = {},
        )
    }

    private fun submitContentRequest(
        uri: Uri,
        onSuccess: (File) -> Unit,
        onError: (String) -> Unit,
    ): Boolean {
        val requestId = UUID.randomUUID().toString()
        val request = ActiveContentRequest(requestId, onSuccess, onError)
        synchronized(contentRequestLock) {
            if (activeContentRequest != null) return false
            activeContentRequest = request
        }

        val receiver = object : ResultReceiver(Handler(Looper.getMainLooper())) {
            override fun onReceiveResult(resultCode: Int, resultData: Bundle?) {
                if (resultData?.getString(RedtermContentReaderService.EXTRA_REQUEST_ID) != requestId) {
                    return
                }
                val localPath = resultData.getString(RedtermContentReaderService.EXTRA_LOCAL_PATH)
                val error = resultData.getString(RedtermContentReaderService.EXTRA_ERROR)
                completeContentRequest(requestId) { active ->
                    if (resultCode == RedtermContentReaderService.RESULT_OK && localPath != null) {
                        active.onSuccess(File(localPath))
                    } else {
                        active.onError(error ?: "Unable to read clipboard image")
                    }
                }
            }
        }

        request.timeoutTask = contentWatchdog.schedule(
            {
                val isActive = synchronized(contentRequestLock) {
                    activeContentRequest?.id == requestId
                }
                if (!isActive) return@schedule
                cancelContentReaderProcess()
                contentWatchdog.schedule(
                    {
                        completeContentRequest(requestId) { active ->
                            active.onError("Clipboard image read timed out")
                        }
                    },
                    CONTENT_READER_KILL_GRACE_MILLIS,
                    TimeUnit.MILLISECONDS,
                )
            },
            MAX_COPY_DURATION_SECONDS,
            TimeUnit.SECONDS,
        )

        try {
            val intent = Intent(activity, RedtermContentReaderService::class.java)
                .setAction(RedtermContentReaderService.ACTION_READ)
                .setData(uri)
                .putExtra(RedtermContentReaderService.EXTRA_REQUEST_ID, requestId)
                .putExtra(RedtermContentReaderService.EXTRA_RESULT_RECEIVER, receiver)
            activity.startService(intent)
        } catch (error: Exception) {
            completeContentRequest(requestId) { active ->
                active.onError(error.message ?: "Unable to start clipboard image reader")
            }
        }
        return true
    }

    private fun completeContentRequest(
        requestId: String,
        completion: (ActiveContentRequest) -> Unit,
    ) {
        val request = synchronized(contentRequestLock) {
            val current = activeContentRequest
            if (current?.id != requestId) return
            activeContentRequest = null
            current
        }
        request.timeoutTask?.cancel(false)
        activity.runOnUiThread { completion(request) }
    }

    private fun cancelContentReaderProcess() {
        runCatching {
            activity.startService(
                Intent(activity, RedtermContentReaderService::class.java)
                    .setAction(RedtermContentReaderService.ACTION_CANCEL)
            )
        }
    }

    private fun cancelActiveContentRequest() {
        val request = synchronized(contentRequestLock) {
            val current = activeContentRequest
            activeContentRequest = null
            current
        }
        request?.timeoutTask?.cancel(false)
        if (request != null) {
            cancelContentReaderProcess()
        }
    }

    private fun dispatchImagePaste(localPath: String) {
        val webView = webView ?: return
        val payloadJson = JSONObject()
            .put("localPath", localPath)
            .toString()
        val quoted = JSONObject.quote(payloadJson)
        val script = """
            (() => {
              const detail = JSON.parse($quoted);
              window.dispatchEvent(new CustomEvent("redterm:android-image-paste", { detail }));
            })();
        """.trimIndent()

        webView.post {
            webView.evaluateJavascript(script, null)
        }
    }

    private fun dispatchVoiceInput(event: VoiceInputEventPayload) {
        val webView = webView ?: return
        val payloadJson = JSONObject()
            .put("kind", event.kind)
            .apply {
                event.transcript?.let { put("transcript", it) }
                event.errorCode?.let { put("errorCode", it) }
                event.errorMessage?.let { put("errorMessage", it) }
            }
            .toString()
        val quoted = JSONObject.quote(payloadJson)
        val script = """
            (() => {
              const detail = JSON.parse($quoted);
              window.dispatchEvent(new CustomEvent("redterm:voice-input", { detail }));
            })();
        """.trimIndent()

        webView.post {
            webView.evaluateJavascript(script, null)
        }
    }


    private fun credentialPreferenceKey(credentialId: String): String {
        require(credentialId.isNotBlank()) { "Credential id is required" }
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(credentialId.toByteArray(StandardCharsets.UTF_8))
        return digest.joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    private fun credentialEncryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getKey(CREDENTIAL_KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val specification = KeyGenParameterSpec.Builder(
            CREDENTIAL_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        keyGenerator.init(specification)
        return keyGenerator.generateKey()
    }

    @Command
    fun storeCredential(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CredentialWriteArgs::class.java)
            val cipher = Cipher.getInstance(CREDENTIAL_CIPHER)
            cipher.init(Cipher.ENCRYPT_MODE, credentialEncryptionKey())
            val ciphertext = cipher.doFinal(args.password.toByteArray(StandardCharsets.UTF_8))
            val iv = cipher.iv
            require(iv.size <= 255) { "Credential IV is too large" }

            val stored = ByteArray(1 + iv.size + ciphertext.size)
            stored[0] = iv.size.toByte()
            iv.copyInto(stored, 1)
            ciphertext.copyInto(stored, 1 + iv.size)

            val committed = credentialPreferences.edit()
                .putString(credentialPreferenceKey(args.credentialId), Base64.encodeToString(stored, Base64.NO_WRAP))
                .commit()
            check(committed) { "Failed to persist encrypted credential" }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject("Failed to store credential", ex)
        }
    }

    @Command
    fun getCredential(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CredentialIdArgs::class.java)
            val encoded = credentialPreferences.getString(credentialPreferenceKey(args.credentialId), null)
            if (encoded == null) {
                invoke.resolve(JSObject().put("found", false))
                return
            }

            val stored = Base64.decode(encoded, Base64.NO_WRAP)
            require(stored.isNotEmpty()) { "Stored credential is empty" }
            val ivLength = stored[0].toInt() and 0xff
            require(ivLength > 0 && stored.size > 1 + ivLength) { "Stored credential is malformed" }
            val iv = stored.copyOfRange(1, 1 + ivLength)
            val ciphertext = stored.copyOfRange(1 + ivLength, stored.size)

            val cipher = Cipher.getInstance(CREDENTIAL_CIPHER)
            cipher.init(Cipher.DECRYPT_MODE, credentialEncryptionKey(), GCMParameterSpec(128, iv))
            val password = String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
            invoke.resolve(
                JSObject()
                    .put("found", true)
                    .put("password", password)
            )
        } catch (ex: Exception) {
            invoke.reject("Failed to read credential", ex)
        }
    }

    @Command
    fun deleteCredential(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CredentialIdArgs::class.java)
            val committed = credentialPreferences.edit()
                .remove(credentialPreferenceKey(args.credentialId))
                .commit()
            check(committed) { "Failed to delete credential" }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject("Failed to delete credential", ex)
        }
    }

    @Command
    fun readClipboardImage(invoke: Invoke) {
        try {
            val clipboardManager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clipData = clipboardManager.primaryClip
            if (clipData == null || clipData.itemCount == 0) {
                invoke.resolve(JSObject().put("found", false))
                return
            }

            val candidates = ArrayList<Uri>(clipData.itemCount)
            for (index in 0 until clipData.itemCount) {
                clipData.getItemAt(index).uri?.let(candidates::add)
            }
            if (candidates.isEmpty()) {
                invoke.resolve(JSObject().put("found", false))
                return
            }

            readClipboardCandidate(candidates, 0, invoke)
        } catch (ex: Exception) {
            invoke.reject("Failed to read clipboard image", ex)
        }
    }
    private fun readClipboardCandidate(candidates: List<Uri>, index: Int, invoke: Invoke) {
        if (index >= candidates.size) {
            invoke.resolve(JSObject().put("found", false))
            return
        }

        val accepted = submitContentRequest(
            uri = candidates[index],
            onSuccess = { file ->
                invoke.resolve(
                    JSObject()
                        .put("found", true)
                        .put("localPath", file.absolutePath)
                )
            },
            onError = {
                readClipboardCandidate(candidates, index + 1, invoke)
            },
        )
        if (!accepted) {
            invoke.reject("Clipboard image reader is busy")
        }
    }

    @Command
    fun listVoiceInputLanguages(invoke: Invoke) {
        try {
            val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            val defaultLocaleTag = Locale.getDefault().toLanguageTag()
            val currentSubtype = imm.currentInputMethodSubtype?.toVoiceDescriptor("current")

            val result = if (Build.VERSION.SDK_INT >= 34) {
                val currentIme = imm.currentInputMethodInfo
                val subtypes = currentIme?.let { info -> enabledSubtypeDescriptors(imm, info) }.orEmpty()
                resolveVoiceInputLanguages(currentSubtype, subtypes, defaultLocaleTag)
            } else {
                val byIme = imm.enabledInputMethodList.associate { info ->
                    info.id to enabledSubtypeDescriptors(imm, info)
                }
                resolveVoiceInputLanguagesForApi24To33(currentSubtype, byIme, defaultLocaleTag)
            }

            invoke.resolve(voiceInputLanguagesJson(result.languages))
        } catch (ex: Exception) {
            invoke.reject("Failed to list voice input languages", ex)
        }
    }


    @Command
    fun startVoiceInput(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(VoiceInputArgs::class.java)
            if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                invoke.reject("Voice recognition is not available on this device")
                return
            }

            activity.runOnUiThread {
                try {
                    voiceInputController?.cancel()
                    val controller = VoiceInputController(
                        recognizerFactory = { AndroidSpeechRecognizer(activity) },
                        dispatchEvent = { dispatchVoiceInput(it) },
                        runOnMainThread = { runnable -> activity.runOnUiThread(runnable) },
                    )
                    voiceInputController = controller
                    controller.start(args.languageTag)
                    invoke.resolve()
                } catch (ex: Exception) {
                    invoke.reject("Failed to start voice input", ex)
                }
            }
        } catch (ex: Exception) {
            invoke.reject("Failed to start voice input", ex)
        }
    }

    @Command
    fun stopVoiceInput(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                voiceInputController?.stop()
                voiceInputController = null
                invoke.resolve()
            } catch (ex: Exception) {
                invoke.reject("Failed to stop voice input", ex)
            }
        }
    }

    @Command
    fun cancelVoiceInput(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                voiceInputController?.cancel()
                voiceInputController = null
                invoke.resolve()
            } catch (ex: Exception) {
                invoke.reject("Failed to cancel voice input", ex)
            }
        }
    }
    @Command
    fun startForegroundService(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ForegroundServiceArgs::class.java)
            val intent = RedtermSessionForegroundService.startIntent(
                activity,
                args.sessionCount.coerceAtLeast(1),
                args.title,
                args.text
            )

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject("Failed to start foreground service", ex)
        }
    }

    @Command
    fun stopForegroundService(invoke: Invoke) {
        try {
            val intent = RedtermSessionForegroundService.stopIntent(activity)
            activity.startService(intent)
            activity.stopService(intent)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject("Failed to stop foreground service", ex)
        }
    }

    @Command
    fun setKeepScreenOn(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(KeepScreenOnArgs::class.java)
            activity.runOnUiThread {
                activity.window.let { window ->
                    if (args.enabled) {
                        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }
            }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject("Failed to set keep screen on", ex)
        }
    }

    @Command
    fun showKeyboard(invoke: Invoke) {
        try {
            activity.runOnUiThread {
                val target = webView
                if (target == null) {
                    invoke.reject("WebView not ready")
                    return@runOnUiThread
                }

                val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                val insetsController = WindowInsetsControllerCompat(activity.window, target)
                target.post {
                    target.requestFocus()
                    imm.restartInput(target)
                    insetsController.show(WindowInsetsCompat.Type.ime())

                    if (imm.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT)) {
                        invoke.resolve()
                        return@post
                    }

                    target.postDelayed({
                        target.requestFocus()
                        imm.restartInput(target)
                        insetsController.show(WindowInsetsCompat.Type.ime())
                        // SHOW_FORCED is deprecated and leaves the IME in a non-standard state.
                        // On floating-window dim composition, that can dim only our app.
                        if (imm.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT)) {
                            invoke.resolve()
                        } else {
                            invoke.reject("Keyboard show request was ignored")
                        }
                    }, 150)
                }
            }
        } catch (ex: Exception) {
            invoke.reject("Failed to show keyboard", ex)
        }
    }

    @Command
    fun hideKeyboard(invoke: Invoke) {
        try {
            activity.runOnUiThread {
                val target = webView ?: activity.currentFocus
                if (target == null) {
                    invoke.resolve()
                    return@runOnUiThread
                }

                var resolved = false
                lateinit var layoutListener: ViewTreeObserver.OnGlobalLayoutListener

                fun resolveIfImeHidden() {
                    if (resolved) return
                    val insets = ViewCompat.getRootWindowInsets(target) ?: return
                    if (insets.isVisible(WindowInsetsCompat.Type.ime())) return

                    resolved = true
                    val observer = target.viewTreeObserver
                    if (observer.isAlive) {
                        observer.removeOnGlobalLayoutListener(layoutListener)
                    }
                    target.post { invoke.resolve() }
                }

                layoutListener = ViewTreeObserver.OnGlobalLayoutListener {
                    resolveIfImeHidden()
                }
                target.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)

                val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                val insetsController = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
                insetsController.hide(WindowInsetsCompat.Type.ime())
                imm.hideSoftInputFromWindow(target.windowToken, 0)
                target.post { resolveIfImeHidden() }
            }
        } catch (ex: Exception) {
            invoke.reject("Failed to hide keyboard", ex)
        }
    }


    private fun enabledSubtypeDescriptors(
        imm: InputMethodManager,
        info: InputMethodInfo
    ): List<VoiceSubtypeDescriptor> {
        return imm.getEnabledInputMethodSubtypeList(info, true).map { subtype ->
            subtype.toVoiceDescriptor(info.id)
        }
    }

    private fun InputMethodSubtype.toVoiceDescriptor(imeId: String): VoiceSubtypeDescriptor {
        return VoiceSubtypeDescriptor(
            imeId = imeId,
            hashCode = hashCode(),
            languageTag = languageTag.orEmpty(),
            locale = locale.orEmpty(),
            mode = mode.orEmpty(),
        )
    }
    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val CREDENTIAL_KEY_ALIAS = "redterm-credentials-v1"
        private const val CREDENTIAL_PREFERENCES = "redterm_secure_credentials"
        private const val CREDENTIAL_CIPHER = "AES/GCM/NoPadding" // gitleaks:allow
        private const val MAX_COPY_DURATION_SECONDS = 10L
        private const val CONTENT_READER_KILL_GRACE_MILLIS = 250L
    }

}
