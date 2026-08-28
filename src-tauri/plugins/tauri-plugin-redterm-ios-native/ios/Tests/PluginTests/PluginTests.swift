import XCTest
@testable import tauri_plugin_redterm_ios_native

final class NativeBridgeTests: XCTestCase {
    func testCombinedPermissionUsesMostRestrictiveState() {
        XCTAssertEqual(combinedPermission(.granted, .granted), "granted")
        XCTAssertEqual(combinedPermission(.prompt, .granted), "prompt")
        XCTAssertEqual(combinedPermission(.granted, .denied), "denied")
    }

    func testSupportedImageExtensionUsesFileSignature() {
        XCTAssertEqual(
            supportedImageExtension(Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
            "png"
        )
        XCTAssertEqual(supportedImageExtension(Data([0xff, 0xd8, 0xff, 0x00])), "jpg")
        XCTAssertNil(supportedImageExtension(Data("not-an-image".utf8)))
    }

    func testClipboardCopierStoresInsideProvidedDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let directory = root.appendingPathComponent("clipboard-paste", isDirectory: true)
        let source = root.appendingPathComponent("source.png")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        try png.write(to: source)

        let file = try copyClipboardImage(from: source, to: directory)

        XCTAssertEqual(file.deletingLastPathComponent().standardizedFileURL, directory.standardizedFileURL)
        XCTAssertEqual(try Data(contentsOf: file), png)
    }

    func testClipboardCopierRejectsUnsupportedAndOversizedFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let directory = root.appendingPathComponent("clipboard-paste", isDirectory: true)
        let unsupported = root.appendingPathComponent("unsupported.bin")
        let oversized = root.appendingPathComponent("oversized.png")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("not-an-image".utf8).write(to: unsupported)
        try Data(repeating: 0, count: maxClipboardImageBytes + 1).write(to: oversized)

        XCTAssertThrowsError(try copyClipboardImage(from: unsupported, to: directory))
        XCTAssertThrowsError(try copyClipboardImage(from: oversized, to: directory))
    }

    func testSpeechLifecycleRejectsConcurrentSessionsAndResetsAfterCancel() throws {
        var lifecycle = SpeechLifecycle()

        try lifecycle.start()
        XCTAssertThrowsError(try lifecycle.start())
        lifecycle.cancel()
        XCTAssertNoThrow(try lifecycle.start())
    }

    func testSpeechSessionGenerationRejectsCancelledSessionCallbacks() {
        var generation = SpeechSessionGeneration()
        let cancelledSession = generation.begin()

        generation.invalidate()
        let currentSession = generation.begin()

        XCTAssertFalse(generation.isCurrent(cancelledSession))
        XCTAssertTrue(generation.isCurrent(currentSession))
    }
}
