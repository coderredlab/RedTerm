package com.coderred.redterm.androidpaste

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceInputLanguageResolverTest {
    @Test
    fun voiceInputLanguagesJsonUsesStableKeysForReleaseResponse() {
        val payload = voiceInputLanguagesJson(
            listOf(
                VoiceInputLanguage("ko", "Korean"),
                VoiceInputLanguage("en-US", "English"),
            ),
        )

        val languages = payload.getJSONArray("languages")

        assertEquals(2, languages.length())
        assertEquals("ko", languages.getJSONObject(0).getString("tag"))
        assertEquals("Korean", languages.getJSONObject(0).getString("label"))
        assertEquals("en-US", languages.getJSONObject(1).getString("tag"))
        assertEquals("English", languages.getJSONObject(1).getString("label"))
    }

    @Test
    fun languageLabelUsesEnglishLocaleNamesWithoutHardcodedPairs() {
        assertEquals("Korean", languageLabel("ko-KR"))
        assertEquals("English", languageLabel("en-US"))
        assertEquals("Japanese", languageLabel("ja-JP"))
    }

    @Test
    fun currentKeyboardLanguageIsFirstAndRotationWraps() {
        val current = VoiceSubtypeDescriptor(
            imeId = "gboard",
            hashCode = 11,
            languageTag = "ko-KR",
            locale = "",
            mode = "keyboard",
        )
        val enabled = listOf(
            VoiceSubtypeDescriptor("gboard", 12, "en-US", "", "keyboard"),
            current,
            VoiceSubtypeDescriptor("gboard", 13, "ja-JP", "", "keyboard"),
        )

        val result = resolveVoiceInputLanguages(
            currentSubtype = current,
            enabledSubtypes = enabled,
            defaultLocaleTag = "ja-JP",
        )

        assertEquals(listOf("ko-KR", "en-US", "ja-JP"), result.languages.map { it.tag })
        assertEquals("Korean", result.languages[0].label)
        assertFalse(result.languageSwitchDisabled)
        assertEquals(1, result.nextIndexAfter(0))
        assertEquals(2, result.nextIndexAfter(1))
        assertEquals(0, result.nextIndexAfter(2))
    }

    @Test
    fun ignoresNonKeyboardSubtypesAndDoesNotGuessWhenMetadataIsMissing() {
        val result = resolveVoiceInputLanguages(
            currentSubtype = VoiceSubtypeDescriptor(
                imeId = "unknown",
                hashCode = 99,
                languageTag = "",
                locale = "",
                mode = "keyboard",
            ),
            enabledSubtypes = listOf(
                VoiceSubtypeDescriptor("ime", 1, "ko-KR", "", "voice"),
                VoiceSubtypeDescriptor("ime", 2, "", "", "keyboard"),
            ),
            defaultLocaleTag = "ko-KR",
        )

        assertEquals(listOf("ko-KR"), result.languages.map { it.tag })
        assertTrue(result.languageSwitchDisabled)
        assertEquals("Unable to load input language", result.statusMessage)
    }

    @Test
    fun api24To33FallbackDoesNotEnableSwitchFromAnotherImeWithSameLanguage() {
        val current = VoiceSubtypeDescriptor("current-ime", 7, "ko-KR", "", "keyboard")

        val result = resolveVoiceInputLanguagesForApi24To33(
            currentSubtype = current,
            enabledSubtypesByIme = mapOf(
                "other-ime" to listOf(
                    VoiceSubtypeDescriptor("other-ime", 8, "ko-KR", "", "keyboard"),
                    VoiceSubtypeDescriptor("other-ime", 9, "en-US", "", "keyboard"),
                ),
            ),
            defaultLocaleTag = "ja-JP",
        )

        assertEquals(listOf("ko-KR"), result.languages.map { it.tag })
        assertTrue(result.languageSwitchDisabled)
        assertEquals("Unable to load input language", result.statusMessage)
    }

    @Test
    fun api24To33FallbackKeepsSwitchWhenCurrentImeMatchesByHashCode() {
        val current = VoiceSubtypeDescriptor("current-ime", 7, "ko-KR", "", "keyboard")

        val result = resolveVoiceInputLanguagesForApi24To33(
            currentSubtype = current,
            enabledSubtypesByIme = mapOf(
                "current-ime" to listOf(
                    VoiceSubtypeDescriptor("current-ime", 7, "ko-KR", "", "keyboard"),
                    VoiceSubtypeDescriptor("current-ime", 8, "en-US", "", "keyboard"),
                ),
            ),
            defaultLocaleTag = "ja-JP",
        )

        assertEquals(listOf("ko-KR", "en-US"), result.languages.map { it.tag })
        assertEquals("Korean", result.languages[0].label)
        assertFalse(result.languageSwitchDisabled)
    }

    @Test
    fun api24To33FallbackKeepsSwitchWhenOpaqueCurrentImeMatchesOneDescriptor() {
        val current = VoiceSubtypeDescriptor("current", 7, "ko-KR", "", "keyboard")

        val result = resolveVoiceInputLanguagesForApi24To33(
            currentSubtype = current,
            enabledSubtypesByIme = mapOf(
                "gboard" to listOf(
                    VoiceSubtypeDescriptor("gboard", 7, "ko-KR", "", "keyboard"),
                    VoiceSubtypeDescriptor("gboard", 8, "en-US", "", "keyboard"),
                ),
                "other-ime" to listOf(VoiceSubtypeDescriptor("other-ime", 9, "ja-JP", "", "keyboard")),
            ),
            defaultLocaleTag = "ja-JP",
        )

        assertEquals(listOf("ko-KR", "en-US"), result.languages.map { it.tag })
        assertFalse(result.languageSwitchDisabled)
    }


    @Test
    fun api24To33FallbackDisablesSwitchWhenMultipleImesMatchCurrentDescriptor() {
        val current = VoiceSubtypeDescriptor("current", 7, "ko-KR", "", "keyboard")

        val result = resolveVoiceInputLanguagesForApi24To33(
            currentSubtype = current,
            enabledSubtypesByIme = mapOf(
                "gboard" to listOf(
                    VoiceSubtypeDescriptor("gboard", 7, "ko-KR", "", "keyboard"),
                    VoiceSubtypeDescriptor("gboard", 8, "en-US", "", "keyboard"),
                ),
                "other-ime" to listOf(
                    VoiceSubtypeDescriptor("other-ime", 7, "ko-KR", "", "keyboard"),
                    VoiceSubtypeDescriptor("other-ime", 9, "en-US", "", "keyboard"),
                ),
            ),
            defaultLocaleTag = "ja-JP",
        )

        assertEquals(listOf("ko-KR"), result.languages.map { it.tag })
        assertTrue(result.languageSwitchDisabled)
        assertEquals("Unable to load input language", result.statusMessage)
    }
    @Test
    fun api24To33FallbackDisablesSwitchWhenCurrentImeCannotBeMatched() {
        val current = VoiceSubtypeDescriptor("current-ime", 7, "ko-KR", "", "keyboard")

        val result = resolveVoiceInputLanguagesForApi24To33(
            currentSubtype = current,
            enabledSubtypesByIme = mapOf(
                "other-ime" to listOf(VoiceSubtypeDescriptor("other-ime", 8, "en-US", "", "keyboard")),
            ),
            defaultLocaleTag = "ko-KR",
        )

        assertEquals(listOf("ko-KR"), result.languages.map { it.tag })
        assertTrue(result.languageSwitchDisabled)
    }
}
