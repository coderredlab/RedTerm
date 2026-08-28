package com.coderred.redterm.androidpaste

import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.util.Locale

data class VoiceSubtypeDescriptor(
    val imeId: String,
    val hashCode: Int,
    val languageTag: String,
    val locale: String,
    val mode: String,
)

data class VoiceInputLanguage(val tag: String, val label: String)

fun voiceInputLanguagesJson(languages: List<VoiceInputLanguage>): JSObject {
    val languageItems = JSArray()
    languages.forEach { language ->
        languageItems.put(
            JSObject()
                .put("tag", language.tag)
                .put("label", language.label)
        )
    }
    return JSObject().put("languages", languageItems)
}

data class VoiceInputLanguageResult(
    val languages: List<VoiceInputLanguage>,
    val languageSwitchDisabled: Boolean,
    val statusMessage: String?,
) {
    fun nextIndexAfter(currentIndex: Int): Int {
        if (languages.isEmpty()) return 0
        return (currentIndex + 1) % languages.size
    }
}

fun resolveVoiceInputLanguages(
    currentSubtype: VoiceSubtypeDescriptor?,
    enabledSubtypes: List<VoiceSubtypeDescriptor>,
    defaultLocaleTag: String,
): VoiceInputLanguageResult {
    val currentTag = currentSubtype?.normalizedLanguageTag().orEmpty()
    val keyboardLanguages = enabledSubtypes
        .filter { it.mode == "keyboard" }
        .mapNotNull { it.normalizedLanguageTag().takeIf(String::isNotBlank) }
        .distinct()
        .toMutableList()

    if (currentTag.isNotBlank()) {
        keyboardLanguages.remove(currentTag)
        keyboardLanguages.add(0, currentTag)
    }

    if (keyboardLanguages.isEmpty()) {
        return VoiceInputLanguageResult(
            languages = listOf(VoiceInputLanguage(defaultLocaleTag, languageLabel(defaultLocaleTag))),
            languageSwitchDisabled = true,
            statusMessage = "Unable to load input language",
        )
    }

    return VoiceInputLanguageResult(
        languages = keyboardLanguages.map { VoiceInputLanguage(it, languageLabel(it)) },
        languageSwitchDisabled = keyboardLanguages.size <= 1,
        statusMessage = null,
    )
}

fun resolveVoiceInputLanguagesForApi24To33(
    currentSubtype: VoiceSubtypeDescriptor?,
    enabledSubtypesByIme: Map<String, List<VoiceSubtypeDescriptor>>,
    defaultLocaleTag: String,
): VoiceInputLanguageResult {
    val current = currentSubtype ?: return resolveVoiceInputLanguages(null, emptyList(), defaultLocaleTag)
    val currentTag = current.normalizedLanguageTag().takeIf(String::isNotBlank) ?: defaultLocaleTag
    val matched = enabledSubtypesByIme[current.imeId]?.takeIf { subtypes ->
        subtypes.containsCurrentSubtype(current)
    } ?: enabledSubtypesByIme.values
        .filter { subtypes -> subtypes.containsCurrentSubtype(current) }
        .singleOrNull()

    if (matched == null) {
        return VoiceInputLanguageResult(
            languages = listOf(VoiceInputLanguage(currentTag, languageLabel(currentTag))),
            languageSwitchDisabled = true,
            statusMessage = "Unable to load input language",
        )
    }

    return resolveVoiceInputLanguages(current, matched, defaultLocaleTag)
}

fun VoiceSubtypeDescriptor.normalizedLanguageTag(): String {
    if (languageTag.isNotBlank()) return languageTag
    if (locale.isBlank()) return ""
    return locale.replace('_', '-')
}

private fun List<VoiceSubtypeDescriptor>.containsCurrentSubtype(
    current: VoiceSubtypeDescriptor
): Boolean {
    val currentTag = current.normalizedLanguageTag()
    if (currentTag.isBlank()) return false
    return any { subtype ->
        subtype.hashCode == current.hashCode &&
            subtype.mode == current.mode &&
            subtype.normalizedLanguageTag() == currentTag
    }
}

fun languageLabel(tag: String): String {
    val normalized = tag.ifBlank { Locale.getDefault().toLanguageTag() }
    val language = Locale.forLanguageTag(normalized).getDisplayLanguage(Locale.ENGLISH)
    return language.ifBlank { normalized }
}
