import XCTest

final class MeetOddsUITests: XCTestCase {
    @MainActor private func app() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["home-headline"].waitForExistence(timeout: 15))
        return app
    }
    @MainActor func testModelAndTemplateSelection() {
        let app = app()
        XCTAssertTrue(app.buttons["start-recording"].exists)
        // The summary model is a standing preference, so it lives in Settings instead of
        // being asked in front of every recording. The template stays per-meeting.
        app.buttons["settings"].tap()
        XCTAssertTrue(app.buttons["model-chatgpt"].waitForExistence(timeout: 5))
        app.buttons["model-chatgpt"].tap()
        XCTAssertTrue(app.buttons["model-chatgpt"].isSelected)
        app.buttons["model-local"].tap()
        XCTAssertTrue(app.buttons["model-local"].isSelected)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["choose-template"].waitForExistence(timeout: 5))
        app.buttons["choose-template"].tap()
        XCTAssertTrue(app.staticTexts["Choose a template"].waitForExistence(timeout: 5))
        app.buttons.containing(.staticText, identifier: "Daily standup").firstMatch.tap()
        XCTAssertTrue(app.buttons["choose-template"].staticTexts["Daily standup"].waitForExistence(timeout: 5))
        capture("Home", app)
    }
    @MainActor func testMeetingNotesAndTranscriptRemainSeparate() {
        let app = app()
        app.swipeUp()
        let meeting = app.buttons.containing(.staticText, identifier: "Product weekly").firstMatch
        XCTAssertTrue(meeting.waitForExistence(timeout: 5)); meeting.tap()
        XCTAssertTrue(app.textViews["meeting-title"].waitForExistence(timeout: 5) || app.textFields["meeting-title"].exists)
        // The segmented header is gone; the two bottom buttons carry navigation now.
        app.buttons["detail-left"].tap()
        let notes = app.textViews["personal-notes"]
        XCTAssertTrue(notes.waitForExistence(timeout: 5))
        XCTAssertTrue((notes.value as? String)?.contains("Private:") == true)
        notes.tap(); notes.typeText(" Follow up tomorrow.")
        app.swipeDown()
        app.buttons["detail-left"].tap()
        XCTAssertTrue(app.staticTexts["Let's test the revised onboarding with ten customers before deciding."].waitForExistence(timeout: 5))
        app.buttons["detail-right"].tap()
        XCTAssertTrue(app.buttons["Share summary"].waitForExistence(timeout: 5))
        capture("Summary", app)
    }
    @MainActor func testChatGPTRequiresPairingAndExplicitSendApproval() {
        let app = app(); app.swipeUp()
        app.buttons.containing(.staticText, identifier: "Product weekly").firstMatch.tap()
        app.swipeUp()
        app.buttons["Create another version"].tap()
        XCTAssertTrue(app.staticTexts["Make it useful"].waitForExistence(timeout: 5))
        app.buttons["model-chatgpt"].tap(); app.swipeUp()
        let send = app.buttons["Send selected text & summarize"]
        XCTAssertTrue(send.waitForExistence(timeout: 5)); XCTAssertFalse(send.isEnabled)
        capture("Summary approval", app)
    }
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
