import Foundation

let maxClipboardImageBytes = 10 * 1024 * 1024

enum PermissionStatus {
    case granted
    case prompt
    case denied
}

func combinedPermission(_ microphone: PermissionStatus, _ speech: PermissionStatus) -> String {
    if microphone == .denied || speech == .denied {
        return "denied"
    }
    if microphone == .prompt || speech == .prompt {
        return "prompt"
    }
    return "granted"
}

func supportedImageExtension(_ data: Data) -> String? {
    let bytes = [UInt8](data.prefix(12))
    if bytes.count >= 8 && bytes[0..<8].elementsEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return "png"
    }
    if bytes.count >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return "jpg"
    }
    if bytes.count >= 6,
       let signature = String(bytes: bytes[0..<6], encoding: .ascii),
       signature == "GIF87a" || signature == "GIF89a" {
        return "gif"
    }
    if bytes.count >= 12,
       String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
       String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" {
        return "webp"
    }
    return nil
}

func copyClipboardImage(from source: URL, to directory: URL) throws -> URL {
    let sourceValues = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard sourceValues.isRegularFile == true else {
        throw NativePluginError.unsupportedImage
    }
    if let fileSize = sourceValues.fileSize, fileSize > maxClipboardImageBytes {
        throw NativePluginError.imageTooLarge
    }

    try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )

    let temporary = directory.appendingPathComponent("\(UUID().uuidString).tmp")
    var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
#if os(iOS)
    attributes[.protectionKey] = FileProtectionType.complete
#endif
    guard FileManager.default.createFile(
        atPath: temporary.path,
        contents: nil,
        attributes: attributes
    ) else {
        throw NativePluginError.cacheDirectoryUnavailable
    }

    do {
        let input = try FileHandle(forReadingFrom: source)
        let output = try FileHandle(forWritingTo: temporary)
        defer {
            try? input.close()
            try? output.close()
        }

        var header = Data()
        var totalBytes = 0
        while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty {
            totalBytes += chunk.count
            guard totalBytes <= maxClipboardImageBytes else {
                throw NativePluginError.imageTooLarge
            }
            if header.count < 12 {
                header.append(chunk.prefix(12 - header.count))
            }
            try output.write(contentsOf: chunk)
        }
        guard totalBytes > 0, let fileExtension = supportedImageExtension(header) else {
            throw NativePluginError.unsupportedImage
        }
        try output.synchronize()
        try output.close()
        try input.close()

        let file = directory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
        try FileManager.default.moveItem(at: temporary, to: file)
        return file
    } catch {
        try? FileManager.default.removeItem(at: temporary)
        throw error
    }
}

struct SpeechLifecycle {
    private enum State {
        case idle
        case listening
    }

    private var state = State.idle

    var isActive: Bool {
        state != .idle
    }

    mutating func start() throws {
        guard state == .idle else {
            throw NativePluginError.speechSessionActive
        }
        state = .listening
    }

    mutating func cancel() {
        state = .idle
    }

    mutating func finish() {
        state = .idle
    }
}

struct SpeechSessionGeneration {
    private var current = UInt64.zero

    mutating func begin() -> UInt64 {
        current &+= 1
        return current
    }

    mutating func invalidate() {
        current &+= 1
    }

    func isCurrent(_ generation: UInt64) -> Bool {
        generation == current
    }
}

enum NativePluginError: LocalizedError {
    case imageTooLarge
    case unsupportedImage
    case cacheDirectoryUnavailable
    case webViewUnavailable
    case speechRecognizerUnavailable
    case audioInputUnavailable
    case speechSessionActive
    case invalidCredentialId
    case clipboardReadTimedOut
    case keychainFailure(Int32)

    var errorDescription: String? {
        switch self {
        case .imageTooLarge:
            return "The clipboard image exceeds 10 MiB."
        case .unsupportedImage:
            return "The clipboard content is not a supported image."
        case .cacheDirectoryUnavailable:
            return "The clipboard image cache is unavailable."
        case .webViewUnavailable:
            return "The app view is not ready."
        case .speechRecognizerUnavailable:
            return "Speech recognition is currently unavailable."
        case .audioInputUnavailable:
            return "Audio input is unavailable."
        case .speechSessionActive:
            return "Voice input is already active."
        case .clipboardReadTimedOut:
            return "Reading the clipboard image timed out."
        case .invalidCredentialId:
            return "The saved credential identifier is invalid."
        case .keychainFailure(let status):
            return "The iOS Keychain operation failed (\(status))."
        }
    }
}
