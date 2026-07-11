// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClaudexBar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "ClaudexBarCore", targets: ["ClaudexBarCore"]),
        .executable(name: "claudexbar-macos", targets: ["claudexbar-macos"])
    ],
    targets: [
        .target(
            name: "ClaudexBarCore",
            path: "Sources/ClaudexBarCore"
        ),
        .executableTarget(
            name: "claudexbar-macos",
            dependencies: ["ClaudexBarCore"],
            path: "Sources/claudexbar-macos"
        ),
        .testTarget(
            name: "ClaudexBarCoreTests",
            dependencies: ["ClaudexBarCore"],
            path: "Tests/ClaudexBarCoreTests"
        )
    ]
)
