import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    id("com.github.triplet.play")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val keystorePropertiesFile = file("../../../../keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        load(keystorePropertiesFile.inputStream())
    }
}

android {
    compileSdk = 36
    namespace = "com.coderred.redterm"
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        create("release") {
            storeFile = file(keystoreProperties.getProperty("storeFile", "../../../../redterm-upload.keystore"))
            storePassword = keystoreProperties.getProperty("storePassword", System.getenv("KEYSTORE_PASSWORD") ?: "")
            keyAlias = keystoreProperties.getProperty("keyAlias", "redterm-upload")
            keyPassword = keystoreProperties.getProperty("keyPassword", System.getenv("KEYSTORE_PASSWORD") ?: "")
        }
    }
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.coderred.redterm"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "RedTerm Dev")
            resValue("string", "main_activity_title", "RedTerm Dev")
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            ndk {
                debugSymbolLevel = "FULL"
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

play {
    val serviceAccountPath = System.getenv("PLAY_SERVICE_ACCOUNT_JSON")
        ?: "../../../../play-service-account.json"

    serviceAccountCredentials.set(file(serviceAccountPath))
    track.set("internal")
    defaultToAppBundles.set(true)
}

apply(from = "tauri.build.gradle.kts")

// Patch RustWebView.kt after Tauri regenerates Android sources, right before Kotlin compilation.
fun patchRustWebViewImeHooks() {
    val publicRoot = file("../../../..").canonicalFile
    val patchScript = publicRoot.resolve("scripts/patch-rustwebview.sh")
    check(patchScript.isFile) {
        "Missing RustWebView patch script: ${patchScript.absolutePath}"
    }
    exec {
        workingDir(publicRoot)
        commandLine(patchScript.absolutePath)
    }
}

// Wry 0.53.5 generates a private native destroy() bridge. Kotlin with the
// current Android/AppCompat classpath treats that as hiding a public destroy()
// member, so patch the bridge visibility after generation and before compile.
fun patchWryActivityDestroyBridge() {
        val wryActivityFile = file("src/main/java/com/coderred/redterm/generated/WryActivity.kt")
        if (wryActivityFile.exists()) {
            var content = wryActivityFile.readText()
            val oldDeclaration = "    private external fun destroy()"
            val newDeclaration = "    external override fun destroy()"
            if (content.contains(oldDeclaration)) {
                content = content.replace(oldDeclaration, newDeclaration)
                wryActivityFile.writeText(content)
                println("[patch-wryactivity] Patched WryActivity.kt destroy bridge")
            }
        }
}

val patchRustWebViewImeHooksTask = tasks.register("patchRustWebViewImeHooks") {
    doLast {
        patchRustWebViewImeHooks()
        patchWryActivityDestroyBridge()
    }
}

val rustBuildTasks = tasks.matching {
    it.name == "rustBuildUniversalDebug" ||
        it.name == "rustBuildUniversalRelease" ||
        it.name == "rustBuildDebug" ||
        it.name == "rustBuildRelease"
}

patchRustWebViewImeHooksTask.configure {
    mustRunAfter(rustBuildTasks)
}

rustBuildTasks.configureEach {
    finalizedBy(patchRustWebViewImeHooksTask)
}

tasks.matching {
    it.name == "compileUniversalDebugKotlin" ||
        it.name == "compileUniversalReleaseKotlin" ||
        it.name == "compileDebugKotlin" ||
        it.name == "compileReleaseKotlin"
}
    .configureEach {
        dependsOn(patchRustWebViewImeHooksTask)
        mustRunAfter(patchRustWebViewImeHooksTask)
    }
