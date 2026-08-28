package com.coderred.redterm.androidpaste

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

interface VoiceRecognizer {
    fun setListener(listener: VoiceRecognizerListener)
    fun start(languageTag: String)
    fun stop()
    fun cancel()
    fun destroy()
}

interface VoiceRecognizerListener {
    fun onPartial(text: String)
    fun onFinal(text: String)
    fun onError(code: Int, message: String)
    fun onStarted()
    fun onEnded()
}

data class VoiceInputEventPayload(
    val kind: String,
    val transcript: String? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)

class VoiceInputController(
    private val recognizerFactory: () -> VoiceRecognizer,
    private val dispatchEvent: (VoiceInputEventPayload) -> Unit,
    private val runOnMainThread: (Runnable) -> Unit,
) {
    private var recognizer: VoiceRecognizer? = null

    fun start(languageTag: String) {
        runOnMainThread(Runnable {
            val active = recognizerFactory()
            recognizer = active
            active.setListener(object : VoiceRecognizerListener {
                override fun onPartial(text: String) = dispatchEvent(VoiceInputEventPayload("partial", text))

                override fun onFinal(text: String) = dispatchEvent(VoiceInputEventPayload("final", text))

                override fun onError(code: Int, message: String) = dispatchEvent(
                    VoiceInputEventPayload("error", errorCode = code.toString(), errorMessage = message)
                )

                override fun onStarted() = dispatchEvent(VoiceInputEventPayload("started"))

                override fun onEnded() = dispatchEvent(VoiceInputEventPayload("ended"))
            })
            active.start(languageTag)
        })
    }

    fun stop() {
        runOnMainThread(Runnable {
            recognizer?.stop()
            recognizer?.destroy()
            recognizer = null
            dispatchEvent(VoiceInputEventPayload("ended"))
        })
    }

    fun cancel() {
        runOnMainThread(Runnable {
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null
            dispatchEvent(VoiceInputEventPayload("ended"))
        })
    }
}

class AndroidSpeechRecognizer(private val context: Context) : VoiceRecognizer {
    private val recognizer = SpeechRecognizer.createSpeechRecognizer(context)

    override fun setListener(listener: VoiceRecognizerListener) {
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = listener.onStarted()
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = listener.onEnded()
            override fun onError(error: Int) = listener.onError(error, speechErrorMessage(error))

            override fun onResults(results: Bundle?) {
                val text = results
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    .orEmpty()
                if (text.isBlank()) {
                    listener.onError(SpeechRecognizer.ERROR_NO_MATCH, "No speech recognized")
                } else {
                    listener.onFinal(text)
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    .orEmpty()
                if (text.isNotBlank()) listener.onPartial(text)
            }

            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
    }

    override fun start(languageTag: String) {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            if (languageTag.isNotBlank()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
        }
        recognizer.startListening(intent)
    }

    override fun stop() = recognizer.stopListening()

    override fun cancel() = recognizer.cancel()

    override fun destroy() = recognizer.destroy()
}

fun speechErrorMessage(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized"
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required"
    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Voice recognition failed because of a network error"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Voice recognizer is busy"
    else -> "Voice recognition error"
}
