import AVFoundation
import Foundation
import Security
import Speech
import Tauri
import UIKit
import WebKit

private struct ClipboardImageArgs: Decodable {
    let stagingDirectory: String
}

private struct ClipboardImageResult: Encodable {
    let found: Bool
    let localPath: String?
}

private struct KeepScreenOnArgs: Decodable {
    let enabled: Bool
}

private struct KeyboardVisibilityArgs: Decodable {
    let visible: Bool
}

private struct VoiceInputArgs: Decodable {
    let languageTag: String
}

private struct VoicePermissionStates: Encodable {
    let microphone: String
}

private struct VoiceInputLanguage: Encodable {
    let tag: String
    let label: String
}

private struct CredentialIdArgs: Decodable {
    let credentialId: String
}

private struct CredentialWriteArgs: Decodable {
    let credentialId: String
    let password: String
}

private struct CredentialReadResult: Encodable {
    let found: Bool
    let password: String?
}

final class RedtermNativePlugin: Plugin {
    private weak var webView: WKWebView?
    private let speechInput = SpeechInputController()

    override func load(webview: WKWebView) {
        webView = webview
        speechInput.emit = { [weak webview] payload in
            guard let webview = webview else { return }
            DispatchQueue.main.async {
                webview.callAsyncJavaScript(
                    "window.dispatchEvent(new CustomEvent('redterm:voice-input', { detail: payload }));",
                    arguments: ["payload": payload],
                    in: nil,
                    in: .page,
                    completionHandler: nil
                )
            }
        }
    }

    @objc public func readClipboardImage(_ invoke: Invoke) {
        DispatchQueue.main.async {
            do {
                let args = try invoke.parseArgs(ClipboardImageArgs.self)
                let directory = try validatedClipboardDirectory(args.stagingDirectory)
                let loader = ClipboardImageLoader(
                    providers: UIPasteboard.general.itemProviders,
                    directory: directory
                ) { result in
                    switch result {
                    case .success(let file):
                        invoke.resolve(ClipboardImageResult(
                            found: file != nil,
                            localPath: file?.path
                        ))
                    case .failure(let error):
                        invoke.reject(error.localizedDescription)
                    }
                }
                loader.start()
            } catch {
                invoke.reject(error.localizedDescription)
            }
        }
    }

    @objc public func setKeepScreenOn(_ invoke: Invoke) {
        runOnMain(invoke) {
            let args = try invoke.parseArgs(KeepScreenOnArgs.self)
            UIApplication.shared.isIdleTimerDisabled = args.enabled
            invoke.resolve()
        }
    }

    @objc public func dismissKeyboard(_ invoke: Invoke) {
        runOnMain(invoke) { [weak self] in
            guard let webView = self?.webView else {
                throw NativePluginError.webViewUnavailable
            }
            webView.endEditing(true)
            invoke.resolve()
        }
    }

    @objc public func setKeyboardVisible(_ invoke: Invoke) {
        runOnMain(invoke) { [weak self] in
            let args = try invoke.parseArgs(KeyboardVisibilityArgs.self)
            guard let webView = self?.webView else {
                throw NativePluginError.webViewUnavailable
            }
            if args.visible {
                webView.evaluateJavaScript("document.querySelector('textarea.hidden-input')?.focus();")
            } else {
                webView.endEditing(true)
            }
            invoke.resolve()
        }
    }

    @objc public func checkVoiceInputPermissions(_ invoke: Invoke) {
        runOnMain(invoke) {
            invoke.resolve(VoicePermissionStates(
                microphone: combinedPermission(
                    microphonePermissionStatus(),
                    speechPermissionStatus()
                )
            ))
        }
    }

    @objc public func requestVoiceInputPermissions(_ invoke: Invoke) {
        runOnMain(invoke) {
            let group = DispatchGroup()
            var microphone = PermissionStatus.prompt
            var speech = PermissionStatus.prompt

            group.enter()
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    microphone = granted ? .granted : .denied
                    group.leave()
                }
            }

            group.enter()
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    speech = permissionStatus(status)
                    group.leave()
                }
            }

            group.notify(queue: .main) {
                invoke.resolve(VoicePermissionStates(
                    microphone: combinedPermission(microphone, speech)
                ))
            }
        }
    }

    @objc public func listVoiceInputLanguages(_ invoke: Invoke) {
        runOnMain(invoke) {
            let displayLocale = Locale.current
            let languages = SFSpeechRecognizer.supportedLocales()
                .map { locale in
                    VoiceInputLanguage(
                        tag: locale.identifier.replacingOccurrences(of: "_", with: "-"),
                        label: displayLocale.localizedString(forIdentifier: locale.identifier)
                            ?? locale.localizedString(forIdentifier: locale.identifier)
                            ?? locale.identifier
                    )
                }
                .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
            invoke.resolve(languages)
        }
    }

    @objc public func startVoiceInput(_ invoke: Invoke) {
        runOnMain(invoke) { [weak self] in
            let args = try invoke.parseArgs(VoiceInputArgs.self)
            guard let self = self else {
                throw NativePluginError.webViewUnavailable
            }
            try self.speechInput.start(languageTag: args.languageTag)
            invoke.resolve()
        }
    }

    @objc public func stopVoiceInput(_ invoke: Invoke) {
        runOnMain(invoke) { [weak self] in
            self?.speechInput.stop()
            invoke.resolve()
        }
    }

    @objc public func cancelVoiceInput(_ invoke: Invoke) {
        runOnMain(invoke) { [weak self] in
            self?.speechInput.cancel()
            invoke.resolve()
        }
    }

    @objc public func storeCredential(_ invoke: Invoke) {
        runOnMain(invoke) {
            let args = try invoke.parseArgs(CredentialWriteArgs.self)
            try validateCredentialId(args.credentialId)
            guard let value = args.password.data(using: .utf8), value.count <= 64 * 1024 else {
                throw NativePluginError.keychainFailure(errSecParam)
            }

            let query = credentialQuery(args.credentialId)
            let updateStatus = SecItemUpdate(
                query as CFDictionary,
                [kSecValueData as String: value] as CFDictionary
            )
            if updateStatus == errSecItemNotFound {
                var insert = query
                insert[kSecValueData as String] = value
                insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                let addStatus = SecItemAdd(insert as CFDictionary, nil)
                guard addStatus == errSecSuccess else {
                    throw NativePluginError.keychainFailure(addStatus)
                }
            } else if updateStatus != errSecSuccess {
                throw NativePluginError.keychainFailure(updateStatus)
            }
            invoke.resolve()
        }
    }

    @objc public func getCredential(_ invoke: Invoke) {
        runOnMain(invoke) {
            let args = try invoke.parseArgs(CredentialIdArgs.self)
            try validateCredentialId(args.credentialId)
            var query = credentialQuery(args.credentialId)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne

            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecItemNotFound {
                invoke.resolve(CredentialReadResult(found: false, password: nil))
                return
            }
            guard status == errSecSuccess,
                  let data = item as? Data,
                  let password = String(data: data, encoding: .utf8) else {
                throw NativePluginError.keychainFailure(status)
            }
            invoke.resolve(CredentialReadResult(found: true, password: password))
        }
    }

    @objc public func deleteCredential(_ invoke: Invoke) {
        runOnMain(invoke) {
            let args = try invoke.parseArgs(CredentialIdArgs.self)
            try validateCredentialId(args.credentialId)
            let status = SecItemDelete(credentialQuery(args.credentialId) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw NativePluginError.keychainFailure(status)
            }
            invoke.resolve()
        }
    }

    private func runOnMain(_ invoke: Invoke, operation: @escaping () throws -> Void) {
        DispatchQueue.main.async {
            do {
                try operation()
            } catch {
                invoke.reject(error.localizedDescription)
            }
        }
    }
}

@_cdecl("init_plugin_redterm_ios_native")
func initPlugin() -> Plugin {
    RedtermNativePlugin()
}

private let credentialService = "com.coderred.redterm.saved-connections"
private func validatedClipboardDirectory(_ path: String) throws -> URL {
    guard let cacheRoot = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
    ).first?.resolvingSymlinksInPath().standardizedFileURL else {
        throw NativePluginError.cacheDirectoryUnavailable
    }
    let directory = URL(fileURLWithPath: path, isDirectory: true)
        .resolvingSymlinksInPath()
        .standardizedFileURL
    let cachePrefix = cacheRoot.path.hasSuffix("/") ? cacheRoot.path : cacheRoot.path + "/"
    guard directory.lastPathComponent == "clipboard-paste",
          directory.path.hasPrefix(cachePrefix) else {
        throw NativePluginError.cacheDirectoryUnavailable
    }
    return directory
}


private func validateCredentialId(_ credentialId: String) throws {
    guard !credentialId.isEmpty, credentialId.utf8.count <= 256 else {
        throw NativePluginError.invalidCredentialId
    }
}

private func credentialQuery(_ credentialId: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: credentialService,
        kSecAttrAccount as String: credentialId,
    ]
}

private final class ClipboardImageLoader {
    private struct Candidate {
        let provider: NSItemProvider
        let typeIdentifier: String
    }

    private let stateQueue = DispatchQueue(label: "com.coderred.redterm.clipboard-image")
    private let candidates: [Candidate]
    private let directory: URL
    private let completion: (Result<URL?, Error>) -> Void
    private var index = 0
    private var activeToken: UUID?
    private var activeProgress: Progress?
    private var lastError: Error?
    private var finished = false

    init(
        providers: [NSItemProvider],
        directory: URL,
        completion: @escaping (Result<URL?, Error>) -> Void
    ) {
        let supportedTypes = [
            "public.png",
            "public.jpeg",
            "com.compuserve.gif",
            "org.webmproject.webp",
        ]
        candidates = Array(providers.compactMap { provider in
            supportedTypes.first(where: provider.hasItemConformingToTypeIdentifier)
                .map { Candidate(provider: provider, typeIdentifier: $0) }
        }.prefix(4))
        self.directory = directory
        self.completion = completion
    }

    func start() {
        stateQueue.async {
            self.loadNext()
        }
    }

    private func loadNext() {
        guard !finished else { return }
        guard index < candidates.count else {
            if let lastError = lastError {
                finish(.failure(lastError))
            } else {
                finish(.success(nil))
            }
            return
        }

        let candidate = candidates[index]
        index += 1
        let token = UUID()
        activeToken = token
        activeProgress = candidate.provider.loadFileRepresentation(
            forTypeIdentifier: candidate.typeIdentifier
        ) { [self] source, error in
            guard let source = source else {
                stateQueue.async {
                    guard self.activeToken == token, !self.finished else { return }
                    self.activeToken = nil
                    self.activeProgress = nil
                    self.lastError = error ?? NativePluginError.unsupportedImage
                    self.loadNext()
                }
                return
            }

            let copyResult = Result {
                try cleanupClipboardImageCache(directory)
                return try copyClipboardImage(from: source, to: directory)
            }
            stateQueue.async {
                guard self.activeToken == token, !self.finished else {
                    if case .success(let file) = copyResult {
                        try? FileManager.default.removeItem(at: file)
                    }
                    return
                }
                self.activeToken = nil
                self.activeProgress = nil
                switch copyResult {
                case .success(let file):
                    self.finish(.success(file))
                case .failure(let error):
                    self.lastError = error
                    self.loadNext()
                }
            }
        }

        stateQueue.asyncAfter(deadline: .now() + 10) {
            guard self.activeToken == token, !self.finished else { return }
            self.activeProgress?.cancel()
            self.activeProgress = nil
            self.activeToken = nil
            self.lastError = NativePluginError.clipboardReadTimedOut
            self.loadNext()
        }
    }

    private func finish(_ result: Result<URL?, Error>) {
        guard !finished else { return }
        finished = true
        activeProgress?.cancel()
        activeProgress = nil
        activeToken = nil
        DispatchQueue.main.async {
            self.completion(result)
        }
    }
}

private func cleanupClipboardImageCache(_ directory: URL) throws {
    try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )

    let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
    let files = try FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: Array(keys),
        options: [.skipsHiddenFiles]
    )
        .sorted { left, right in
            let leftDate = try? left.resourceValues(forKeys: keys).contentModificationDate
            let rightDate = try? right.resourceValues(forKeys: keys).contentModificationDate
            return (leftDate ?? .distantPast) > (rightDate ?? .distantPast)
        }

    let expiration = Date().addingTimeInterval(-24 * 60 * 60)
    var retainedCount = 0
    var retainedBytes = 0
    for file in files {
        let values = try file.resourceValues(forKeys: keys)
        let size = values.fileSize ?? 0
        let expired = (values.contentModificationDate ?? .distantPast) < expiration
        let overBudget = retainedCount >= 20 || retainedBytes + size > 50 * 1024 * 1024
        if expired || overBudget {
            try? FileManager.default.removeItem(at: file)
        } else {
            retainedCount += 1
            retainedBytes += size
        }
    }
}

private func microphonePermissionStatus() -> PermissionStatus {
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted:
        return .granted
    case .denied:
        return .denied
    case .undetermined:
        return .prompt
    @unknown default:
        return .prompt
    }
}

private func speechPermissionStatus() -> PermissionStatus {
    permissionStatus(SFSpeechRecognizer.authorizationStatus())
}

private func permissionStatus(_ status: SFSpeechRecognizerAuthorizationStatus) -> PermissionStatus {
    switch status {
    case .authorized:
        return .granted
    case .denied, .restricted:
        return .denied
    case .notDetermined:
        return .prompt
    @unknown default:
        return .prompt
    }
}

private final class SpeechInputController {
    var emit: (([String: Any]) -> Void)?

    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var lifecycle = SpeechLifecycle()
    private var sessionGeneration = SpeechSessionGeneration()
    private var tapInstalled = false

    func start(languageTag: String) throws {
        try lifecycle.start()
        let generation = sessionGeneration.begin()

        do {
            let locale = languageTag.isEmpty
                ? Locale.current
                : Locale(identifier: languageTag)
            guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
                throw NativePluginError.speechRecognizerUnavailable
            }

            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.duckOthers, .defaultToSpeaker]
            )
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            recognitionRequest = request

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NativePluginError.audioInputUnavailable
            }
            inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
                request.append(buffer)
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()

            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    self?.handleRecognition(result: result, error: error, generation: generation)
                }
            }
            emit?(["kind": "started"])
        } catch {
            cancel(emitEnded: false)
            throw error
        }
    }

    func stop() {
        cancel(emitEnded: true)
    }

    func cancel() {
        cancel(emitEnded: true)
    }

    private func cancel(emitEnded: Bool) {
        guard lifecycle.isActive else { return }
        sessionGeneration.invalidate()
        lifecycle.cancel()
        stopCapture()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        deactivateAudioSession()
        if emitEnded {
            emit?(["kind": "ended"])
        }
    }

    private func handleRecognition(
        result: SFSpeechRecognitionResult?,
        error: Error?,
        generation: UInt64
    ) {
        guard sessionGeneration.isCurrent(generation), lifecycle.isActive else { return }

        if let result = result {
            emit?([
                "kind": result.isFinal ? "final" : "partial",
                "transcript": result.bestTranscription.formattedString,
            ])
            if result.isFinal {
                finish()
                return
            }
        }

        if let error = error {
            emit?([
                "kind": "error",
                "errorCode": "speech-recognition",
                "errorMessage": error.localizedDescription,
            ])
            finish()
        }
    }

    private func finish() {
        guard lifecycle.isActive else { return }
        lifecycle.finish()
        stopCapture()
        recognitionRequest = nil
        recognitionTask = nil
        deactivateAudioSession()
        emit?(["kind": "ended"])
    }

    private func stopCapture() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }
}
