// swift-tools-version:5.3
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "tauri-plugin-redterm-ios-native",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v14),
    ],
    products: [
        // Products define the executables and libraries a package produces, and make them visible to other packages.
        .library(
            name: "tauri-plugin-redterm-ios-native",
            type: .static,
            targets: ["tauri-plugin-redterm-ios-native"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        // Targets are the basic building blocks of a package. A target can define a module or a test suite.
        // Targets can depend on other targets in this package, and on products in packages this package depends on.
        .target(
            name: "tauri-plugin-redterm-ios-native",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources"),
        .testTarget(
            name: "PluginTests",
            dependencies: ["tauri-plugin-redterm-ios-native"],
            path: "Tests/PluginTests")
    ]
)
