package com.coderred.redterm.androidpaste

import android.app.Service
import android.content.Intent
import android.os.CancellationSignal
import android.os.IBinder
import android.os.Process
import android.os.ResultReceiver
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

class RedtermContentReaderService : Service() {
    private val contentExecutor = Executors.newSingleThreadExecutor()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            Process.killProcess(Process.myPid())
            return START_NOT_STICKY
        }

        val uri = intent?.data
        val requestId = intent?.getStringExtra(EXTRA_REQUEST_ID)
        @Suppress("DEPRECATION")
        val receiver = intent?.getParcelableExtra(EXTRA_RESULT_RECEIVER) as? ResultReceiver
        if (uri == null || requestId == null || receiver == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        contentExecutor.execute {
            try {
                val file = persistImage(uri)
                receiver.send(
                    RESULT_OK,
                    android.os.Bundle().apply {
                        putString(EXTRA_REQUEST_ID, requestId)
                        putString(EXTRA_LOCAL_PATH, file.absolutePath)
                    }
                )
            } catch (error: Exception) {
                receiver.send(
                    RESULT_ERROR,
                    android.os.Bundle().apply {
                        putString(EXTRA_REQUEST_ID, requestId)
                        putString(EXTRA_ERROR, error.message ?: "Unable to read clipboard image")
                    }
                )
            } finally {
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        contentExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun persistImage(uri: android.net.Uri): File {
        val pasteDir = File(cacheDir, "clipboard-paste")
        check(pasteDir.mkdirs() || pasteDir.isDirectory) { "Unable to create clipboard image cache" }
        cleanupPasteCache(pasteDir)

        val temporary = File.createTempFile("redterm-", ".tmp", pasteDir)
        val cancellation = CancellationSignal()
        val activeInput = AtomicReference<Closeable?>(null)
        try {
            val header = ByteArray(12)
            var headerLength = 0
            var totalBytes = 0L
            val startedAt = System.nanoTime()
            val descriptor = contentResolver.openAssetFileDescriptor(uri, "r", cancellation)
                ?: throw IOException("Unable to open pasted image descriptor")
            descriptor.use {
                if (it.length > MAX_CLIPBOARD_IMAGE_BYTES) {
                    throw IOException("Clipboard image exceeds 10 MiB")
                }

                val input = it.createInputStream()
                activeInput.set(input)
                input.use { stream ->
                    FileOutputStream(temporary).use { output ->
                        val buffer = ByteArray(COPY_BUFFER_BYTES)
                        while (true) {
                            if (Thread.currentThread().isInterrupted || cancellation.isCanceled) {
                                throw IOException("Clipboard image copy was cancelled")
                            }
                            if (System.nanoTime() - startedAt > MAX_COPY_DURATION_NANOS) {
                                throw IOException("Clipboard image copy timed out")
                            }

                            val read = stream.read(buffer)
                            if (read < 0) break
                            if (read == 0) continue
                            totalBytes += read
                            if (totalBytes > MAX_CLIPBOARD_IMAGE_BYTES) {
                                throw IOException("Clipboard image exceeds 10 MiB")
                            }

                            if (headerLength < header.size) {
                                val headerBytes = minOf(read, header.size - headerLength)
                                buffer.copyInto(header, headerLength, 0, headerBytes)
                                headerLength += headerBytes
                            }
                            output.write(buffer, 0, read)
                        }
                    }
                }
            }
            activeInput.set(null)

            require(totalBytes > 0) { "Clipboard image is empty" }
            val mimeType = detectSupportedImageMimeType(header, headerLength)
                ?: throw IOException("Clipboard content is not a supported image")
            val extension = when (mimeType) {
                "image/png" -> "png"
                "image/jpeg" -> "jpg"
                "image/gif" -> "gif"
                "image/webp" -> "webp"
                else -> throw IOException("Unsupported clipboard image type")
            }

            val output = File(pasteDir, "pasted-image-${UUID.randomUUID()}.$extension")
            check(temporary.renameTo(output)) { "Unable to finalize pasted image" }
            cleanupPasteCache(pasteDir, output)
            return output
        } catch (error: Exception) {
            temporary.delete()
            throw error
        } finally {
            runCatching { activeInput.getAndSet(null)?.close() }
        }
    }

    private fun cleanupPasteCache(pasteDir: File, protectedFile: File? = null) {
        val now = System.currentTimeMillis()
        val files = pasteDir.listFiles()
            .orEmpty()
            .sortedWith(
                compareByDescending<File> { file -> file == protectedFile }
                    .thenByDescending { file -> file.lastModified() }
            )
        var retainedBytes = 0L
        var retainedFiles = 0

        for (file in files) {
            val expired = now - file.lastModified() > MAX_CACHE_AGE_MILLIS
            val overBudget =
                retainedFiles >= MAX_CACHE_FILES || retainedBytes + file.length() > MAX_CACHE_BYTES
            if (file != protectedFile && (file.name.endsWith(".tmp") || expired || overBudget)) {
                file.delete()
            } else {
                retainedFiles++
                retainedBytes += file.length()
            }
        }
    }

    companion object {
        const val ACTION_READ = "com.coderred.redterm.androidpaste.READ_CONTENT"
        const val ACTION_CANCEL = "com.coderred.redterm.androidpaste.CANCEL_CONTENT"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_RESULT_RECEIVER = "resultReceiver"
        const val EXTRA_LOCAL_PATH = "localPath"
        const val EXTRA_ERROR = "error"
        const val RESULT_OK = 1
        const val RESULT_ERROR = 2

        private const val COPY_BUFFER_BYTES = 64 * 1024
        private const val MAX_CLIPBOARD_IMAGE_BYTES = 10L * 1024 * 1024
        private const val MAX_COPY_DURATION_SECONDS = 10L
        private const val MAX_COPY_DURATION_NANOS = MAX_COPY_DURATION_SECONDS * 1_000_000_000
        private const val MAX_CACHE_BYTES = 50L * 1024 * 1024
        private const val MAX_CACHE_FILES = 20
        private const val MAX_CACHE_AGE_MILLIS = 24L * 60 * 60 * 1000
    }
}
