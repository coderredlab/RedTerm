package com.coderred.redterm.androidpaste

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ClipboardImageHeaderTest {
    @Test
    fun acceptsSupportedImageSignatures() {
        val png = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0, 0, 0, 0
        )
        val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte())
        val gif = "GIF89a".toByteArray()
        val webp = "RIFF0000WEBP".toByteArray()

        assertEquals("image/png", detectSupportedImageMimeType(png, png.size))
        assertEquals("image/jpeg", detectSupportedImageMimeType(jpeg, jpeg.size))
        assertEquals("image/gif", detectSupportedImageMimeType(gif, gif.size))
        assertEquals("image/webp", detectSupportedImageMimeType(webp, webp.size))
    }

    @Test
    fun rejectsMimeSpoofedAndTruncatedContent() {
        val text = "not-an-image".toByteArray()
        val truncatedPng = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)

        assertNull(detectSupportedImageMimeType(text, text.size))
        assertNull(detectSupportedImageMimeType(truncatedPng, truncatedPng.size))
    }
}
