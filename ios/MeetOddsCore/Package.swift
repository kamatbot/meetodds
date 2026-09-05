// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "MeetOddsCore", platforms: [.iOS(.v18), .macOS(.v15)], products: [.library(name: "MeetOddsCore", targets: ["MeetOddsCore"])], targets: [.target(name: "MeetOddsCore"), .testTarget(name: "MeetOddsCoreTests", dependencies: ["MeetOddsCore"])])
