package com.coderred.redterm.androidpaste

import android.speech.SpeechRecognizer
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceInputControllerTest {
    @Test
    fun cancelThenStartDestroysPreviousRecognizerBeforeNewSession() {
        val calls = mutableListOf<String>()
        val firstRecognizer = FakeVoiceRecognizer("first", calls)
        val secondRecognizer = FakeVoiceRecognizer("second", calls)
        val recognizers = ArrayDeque(listOf(firstRecognizer, secondRecognizer))
        val events = mutableListOf<VoiceInputEventPayload>()
        val controller = VoiceInputController(
            recognizerFactory = { recognizers.removeFirst() },
            dispatchEvent = { event: VoiceInputEventPayload -> events.add(event) },
            runOnMainThread = { runnable: Runnable -> runnable.run() },
        )

        controller.start("ko-KR")
        firstRecognizer.emitPartial("hello")
        controller.cancel()
        controller.start("en-US")
        secondRecognizer.emitFinal("hello")

        assertEquals(
            listOf(
                "first:start:ko-KR",
                "first:cancel",
                "first:destroy",
                "second:start:en-US",
            ),
            calls,
        )
        assertEquals(
            listOf("partial:hello", "ended:null", "final:hello"),
            events.map(::eventLabel),
        )
    }

    @Test
    fun cancelDestroysRecognizerAndEmitsEnded() {
        val calls = mutableListOf<String>()
        val recognizer = FakeVoiceRecognizer("recognizer", calls)
        val events = mutableListOf<VoiceInputEventPayload>()
        val controller = VoiceInputController(
            recognizerFactory = { recognizer },
            dispatchEvent = { event: VoiceInputEventPayload -> events.add(event) },
            runOnMainThread = { runnable: Runnable -> runnable.run() },
        )

        controller.start("ko-KR")
        controller.cancel()

        assertEquals(listOf("recognizer:start:ko-KR", "recognizer:cancel", "recognizer:destroy"), calls)
        assertEquals(listOf("ended:null"), events.map(::eventLabel))
    }

    @Test
    fun speechRecognizerErrorsUseEnglishUserFacingMessages() {
        val cases = listOf(
            SpeechRecognizer.ERROR_NO_MATCH to "No speech recognized",
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS to "Microphone permission is required",
            SpeechRecognizer.ERROR_NETWORK to "Voice recognition failed because of a network error",
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT to "Voice recognition failed because of a network error",
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY to "Voice recognizer is busy",
            SpeechRecognizer.ERROR_SERVER to "Voice recognition error",
        )

        cases.forEach { (code, expected) ->
            assertEquals("error code $code", expected, speechErrorMessage(code))
        }
    }
}

private fun eventLabel(event: VoiceInputEventPayload): String = "${event.kind}:${event.transcript}"

private class FakeVoiceRecognizer(
    private val name: String,
    private val calls: MutableList<String>,
) : VoiceRecognizer {
    private var listener: VoiceRecognizerListener? = null

    override fun setListener(listener: VoiceRecognizerListener) {
        this.listener = listener
    }

    override fun start(languageTag: String) {
        calls += "$name:start:$languageTag"
    }

    override fun stop() {
        calls += "$name:stop"
    }

    override fun cancel() {
        calls += "$name:cancel"
    }

    override fun destroy() {
        calls += "$name:destroy"
    }

    fun emitPartial(text: String) {
        listener?.onPartial(text)
    }

    fun emitFinal(text: String) {
        listener?.onFinal(text)
    }
}
