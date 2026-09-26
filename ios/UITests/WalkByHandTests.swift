// Walking by hand on the simulator: a tap on the map walks by hand (MapLibre's own recognisers once
// swallowed it - Kerem's iPhone 8, 2026-09-26), a press-and-drag keeps walking, and away from the
// routes the panel's Go to buttons put the walker on one, which then plays.
//   xcodebuild test -project ios/Fieldscape.xcodeproj -scheme Fieldscape -destination 'platform=iOS Simulator,name=Fieldscape iPhone'
import XCTest

final class WalkByHandTests: XCTestCase {
    func testTapWalksByHand() {
        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "location") { alert in
            for b in ["Allow While Using App", "Allow Once", "Allow"] where alert.buttons[b].exists { alert.buttons[b].tap(); return true }
            return false
        }
        app.launch()
        sleep(8)                                    /* features and map style load */
        app.tap()                                   /* lets the interruption monitor run */
        let map = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        map.tap()
        XCTAssertTrue(app.staticTexts["BY HAND"].waitForExistence(timeout: 5), "a tap on the map should walk by hand")
        map.press(forDuration: 0.6, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.3)))
        XCTAssertTrue(app.staticTexts["BY HAND"].exists)
        /* far from the routes: the Go to buttons take the walker onto one */
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.08)).tap()
        let go = app.buttons["Go to Koşuyolu Parkı"]
        XCTAssertTrue(go.waitForExistence(timeout: 5), "away from routes, the panel offers them")
        go.tap()
        let route = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Route Koşuyolu'")).firstMatch
        XCTAssertTrue(route.waitForExistence(timeout: 8), "going to a route plays it")
        /* stay while the recordings download and decode (memory is sampled from outside) */
        if ProcessInfo.processInfo.environment["FS_HOLD"] != nil { sleep(60) }
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; add(shot)
        app.buttons["Stop the sound"].tap()
        XCTAssertTrue(app.buttons["Play the sound"].waitForExistence(timeout: 3), "Stop turns into Sound")
    }
}
