.PHONY: project test build
project:
	xcodegen generate --spec project.yml
test:
	cd MeetOddsCore && swift test
	node --test companion/test/*.test.mjs
build: project
	xcodebuild -project MeetOdds.xcodeproj -scheme MeetOdds -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
