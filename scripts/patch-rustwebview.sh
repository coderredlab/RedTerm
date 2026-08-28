#!/usr/bin/env bash
# Patch RustWebView.kt to add onCreateInputConnection override for IME image support
# (Samsung keyboard clipboard panel image paste)
set -euo pipefail

FILE="src-tauri/gen/android/app/src/main/java/com/coderred/redterm/generated/RustWebView.kt"

if [[ ! -f "$FILE" ]]; then
  echo "[patch-rustwebview] File not found: $FILE (skipping)"
  exit 0
fi


echo "[patch-rustwebview] Patching $FILE ..."

# Use Python for reliable multi-line text replacement
python3 << 'PYEOF'
import re, sys

with open("src-tauri/gen/android/app/src/main/java/com/coderred/redterm/generated/RustWebView.kt", "r") as f:
    content = f.read()

# Keep imports idempotent across repeated Gradle tasks.
ime_imports = [
    "import android.view.inputmethod.EditorInfo",
    "import android.view.inputmethod.InputConnection",
    "import androidx.core.view.inputmethod.EditorInfoCompat",
    "import androidx.core.view.inputmethod.InputConnectionCompat",
    "import androidx.core.view.inputmethod.InputContentInfoCompat",
]
for import_line in ime_imports:
    content = content.replace(import_line + "\n", "")

content = content.replace(
    "import android.annotation.SuppressLint\n",
    "import android.annotation.SuppressLint\n" + "\n".join(ime_imports) + "\n",
    1,
)

if "var onImeImageCommitted:" not in content:
    hooks = """

    var onImeImageCommitted: ((android.net.Uri, String) -> Unit)? = null

    override fun onCheckIsTextEditor(): Boolean {
        return true
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val ic = super.onCreateInputConnection(outAttrs) ?: return null
        EditorInfoCompat.setContentMimeTypes(outAttrs, arrayOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/*"))
        return InputConnectionCompat.createWrapper(ic, outAttrs) { inputContentInfo: InputContentInfoCompat, flags: Int, _: android.os.Bundle? ->
            val uri = inputContentInfo.contentUri
            val mime = inputContentInfo.description.getMimeType(0) ?: "image/png"
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N_MR1 &&
                flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0) {
                try { inputContentInfo.requestPermission() } catch (_: Exception) {}
            }
            val cb = onImeImageCommitted
            if (cb != null) {
                cb(uri, mime)
                try { inputContentInfo.releasePermission() } catch (_: Exception) {}
                true
            } else { false }
        }
    }
"""
    class_end = content.rfind("\n}")
    if class_end < 0:
        sys.exit("RustWebView class closing brace not found")
    content = content[:class_end] + hooks + content[class_end:]

with open("src-tauri/gen/android/app/src/main/java/com/coderred/redterm/generated/RustWebView.kt", "w") as f:
    f.write(content)

print("[patch-rustwebview] Done")
PYEOF
