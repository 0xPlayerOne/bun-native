// Hosted-only feasibility test of matching owned-window and bounded-display
// streams. It does not measure input latency or physical presentation.
import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

final class Frames: NSObject, SCStreamOutput {
  private let lock = NSLock()
  private var observed: [[String: Any]] = []
  private var rgbByColor: [String: Data] = [:]

  func stream(
    _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen, sample.isValid,
      let metadata = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let frame = metadata.first,
      let rawStatus = frame[.status] as? Int,
      let status = SCFrameStatus(rawValue: rawStatus), status == .complete,
      let image = CMSampleBufferGetImageBuffer(sample),
      CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA,
      CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess
    else { return }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(image) else { return }
    let width = CVPixelBufferGetWidth(image)
    let height = CVPixelBufferGetHeight(image)
    guard width == 320, height == 180 else { return }
    // Sample inside the 240-by-36 label region used by the existing observer.
    let offset = 28 * CVPixelBufferGetBytesPerRow(image) + 132 * 4
    let pixel = base.advanced(by: offset).assumingMemoryBound(to: UInt8.self)
    let blue = Int(pixel[0])
    let green = Int(pixel[1])
    let red = Int(pixel[2])
    let color =
      red > 160 && green < 80 && blue < 80
      ? "red"
      : blue > 160 && red < 80 && green < 80
        ? "blue" : red < 80 && green < 80 && blue < 80 ? "black" : "other"
    let item: [String: Any] = [
      "color": color, "width": width, "height": height,
      "displayTime": frame[.displayTime] as? UInt64 ?? 0,
      "receivedUptime": ProcessInfo.processInfo.systemUptime,
    ]
    lock.lock()
    if color != "other" && rgbByColor[color] == nil {
      var rgb = Data(count: width * height * 3)
      rgb.withUnsafeMutableBytes { destination in
        guard let dest = destination.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
          return
        }
        let source = base.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(image)
        for y in 0..<height {
          for x in 0..<width {
            let sourceIndex = y * stride + x * 4
            let destIndex = (y * width + x) * 3
            dest[destIndex] = source[sourceIndex]
            dest[destIndex + 1] = source[sourceIndex + 1]
            dest[destIndex + 2] = source[sourceIndex + 2]
          }
        }
      }
      rgbByColor[color] = rgb
    }
    observed.append(item)
    lock.unlock()
  }

  func snapshot() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return observed
  }

  func pixels(_ color: String) -> Data? {
    lock.lock()
    defer { lock.unlock() }
    return rgbByColor[color]
  }

  func discard(_ color: String) {
    lock.lock()
    rgbByColor.removeValue(forKey: color)
    lock.unlock()
  }
}

@main struct Probe {
  @MainActor static func main() {
    if CommandLine.arguments == [CommandLine.arguments[0], "--comparison-self-test"] {
      do {
        try comparisonSelfTest()
        print("comparison self-test passed")
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
      FileHandle.standardError.write(Data("hosted-only diagnostic\n".utf8))
      exit(1)
    }
    guard CGPreflightScreenCaptureAccess() else {
      FileHandle.standardError.write(
        Data("screen capture unavailable; no permission prompt requested\n".utf8))
      exit(1)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    Task { @MainActor in
      do {
        try await run()
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    app.run()
  }
  @MainActor static func run() async throws {
    let app = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 100, y: 100, width: 320, height: 180), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.hasShadow = false
    window.level = .floating
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 180))
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.red.cgColor
    let label = NSTextField(labelWithString: "Initial")
    label.frame = NSRect(x: 12, y: 134, width: 240, height: 36)
    label.font = NSFont.systemFont(ofSize: 18)
    label.textColor = .white
    view.addSubview(label)
    window.contentView = view
    window.title = "Bun Native stream diagnostic"
    window.orderFrontRegardless()
    app.activate(ignoringOtherApps: true)
    defer { window.close() }
    let pid = ProcessInfo.processInfo.processIdentifier
    var target: SCWindow?
    var display: SCDisplay?
    for _ in 0..<50 {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true)
      target = content.windows.first(where: {
        $0.windowID == CGWindowID(window.windowNumber) && $0.owningApplication?.processID == pid
      })
      if let target {
        let matchingDisplays = content.displays.filter { $0.frame.contains(target.frame) }
        if matchingDisplays.count == 1 {
          display = matchingDisplays[0]
          break
        }
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    guard let target else { throw ProbeError.message("owned fixture window unavailable") }
    guard let display else { throw ProbeError.message("fixture is not inside exactly one display") }
    let sourceRect = target.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    guard sourceRect.width == 320, sourceRect.height == 180,
      CGRect(origin: .zero, size: display.frame.size).contains(sourceRect)
    else { throw ProbeError.message("unexpected fixture/display geometry") }
    let filter = SCContentFilter(desktopIndependentWindow: target)
    let config = SCStreamConfiguration()
    config.width = 320
    config.height = 180
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    config.queueDepth = 3
    config.showsCursor = false
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    let frames = Frames()
    try stream.addStreamOutput(
      frames, type: .screen,
      sampleHandlerQueue: DispatchQueue(label: "bun-native.owned-window-stream"))
    let displayConfig = SCStreamConfiguration()
    displayConfig.sourceRect = sourceRect
    displayConfig.width = 320
    displayConfig.height = 180
    displayConfig.pixelFormat = kCVPixelFormatType_32BGRA
    displayConfig.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    displayConfig.queueDepth = 3
    displayConfig.showsCursor = false
    let displayFilter = SCContentFilter(display: display, excludingWindows: [])
    let displayStream = SCStream(filter: displayFilter, configuration: displayConfig, delegate: nil)
    let displayFrames = Frames()
    try displayStream.addStreamOutput(
      displayFrames, type: .screen,
      sampleHandlerQueue: DispatchQueue(label: "bun-native.bounded-display-stream"))
    var comparisons: [String: [String: Any]] = [:]
    var negative: [String: Any] = [:]
    var externalEvidence: [String: Any] = [:]
    try await stream.startCapture()
    do {
      try await displayStream.startCapture()
      try await waitFor("red", frames)
      try await waitFor("red", displayFrames)
      guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--external-helper",
        let runnerTemp = ProcessInfo.processInfo.environment["RUNNER_TEMP"]
      else { throw ProbeError.message("missing hosted external stream helper") }
      let work = URL(fileURLWithPath: runnerTemp, isDirectory: true)
        .appendingPathComponent("stream-control", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
      try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false)
      let ready = work.appendingPathComponent("ready.json")
      let changed = work.appendingPathComponent("changed.json")
      let armed = work.appendingPathComponent("armed")
      let external = Process()
      external.executableURL = URL(fileURLWithPath: CommandLine.arguments[2])
      external.arguments = [
        String(pid), String(target.windowID), "12", "10", "240", "36", ready.path,
        changed.path, armed.path,
      ]
      try external.run()
      defer {
        if external.isRunning {
          external.terminate()
          external.waitUntilExit()
        }
      }
      try await waitForFile(ready, process: external)
      guard
        let readyData = try JSONSerialization.jsonObject(with: Data(contentsOf: ready))
          as? [String: Any], readyData["status"] as? String == "ready"
      else { throw ProbeError.message("invalid external stream readiness") }
      view.layer?.backgroundColor = NSColor.blue.cgColor
      label.stringValue = "Clicked"
      try Data().write(to: armed, options: .withoutOverwriting)
      try await waitFor("blue", frames)
      try await waitFor("blue", displayFrames)
      try await waitForFile(changed, process: external)
      external.waitUntilExit()
      guard external.terminationStatus == 0,
        let data = try JSONSerialization.jsonObject(with: Data(contentsOf: changed))
          as? [String: Any],
        data["status"] as? String == "changed",
        (data["windowID"] as? NSNumber)?.uint32Value == target.windowID,
        (data["ownerPID"] as? NSNumber)?.int32Value == pid,
        data["region"] as? [Int] == [12, 10, 240, 36],
        let baseline = data["baseline"] as? [String: Any],
        let changedData = data["changed"] as? [String: Any],
        let match = changedData["match"] as? [String: Any],
        let baselineHash = baseline["sha256"] as? String, baselineHash.count == 64,
        let changedHash = match["sha256"] as? String, changedHash.count == 64,
        baselineHash != changedHash
      else { throw ProbeError.message("external stream control failed") }
      externalEvidence = data
      for color in ["red", "blue"] {
        guard let windowPixels = frames.pixels(color),
          let displayPixels = displayFrames.pixels(color)
        else { throw ProbeError.message("missing pixel data for \(color)") }
        let detail = try compare(windowPixels, displayPixels)
        comparisons[color] = detail
        guard detail["labelChangedPixels"] as? Int == 0,
          (detail["referenceLightPixels"] as? Int ?? 0) > 10,
          (detail["displayLightPixels"] as? Int ?? 0) > 10
        else {
          let data = try JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])
          throw ProbeError.message(
            "label RGB pixels differ for \(color): \(String(data: data, encoding: .utf8) ?? "unavailable")"
          )
        }
      }
      guard let unobstructed = frames.pixels("blue") else {
        throw ProbeError.message("missing blue reference")
      }
      displayFrames.discard("black")
      // The overlay is owned by this probe and covers the exact label region.
      let blocker = NSWindow(
        contentRect: NSRect(
          x: window.frame.minX + 12, y: window.frame.minY + 134, width: 240, height: 36),
        styleMask: [.borderless], backing: .buffered, defer: false)
      blocker.isReleasedWhenClosed = false
      blocker.hasShadow = false
      blocker.level = NSWindow.Level(rawValue: window.level.rawValue + 1)
      blocker.backgroundColor = .black
      blocker.orderFrontRegardless()
      defer { blocker.close() }
      try await waitFor("black", displayFrames)
      guard let obstructed = displayFrames.pixels("black") else {
        throw ProbeError.message("missing obstruction frame")
      }
      negative = try compare(unobstructed, obstructed)
      guard let changed = negative["labelChangedPixels"] as? Int, changed >= 240 * 36 / 2 else {
        throw ProbeError.message("label comparator did not detect the deliberate obstruction")
      }
      try await displayStream.stopCapture()
      try await stream.stopCapture()
    } catch {
      try? await displayStream.stopCapture()
      try? await stream.stopCapture()
      throw error
    }
    let result: [String: Any] = [
      "status": "passed",
      "scope":
        "exact label-region RGB correspondence and an owned obstruction control; no input or physical presentation claim",
      "windowFrames": frames.snapshot(),
      "displayFrames": displayFrames.snapshot(),
      "sourceRect": [sourceRect.minX, sourceRect.minY, sourceRect.width, sourceRect.height],
      "labelRegion": [12, 10, 240, 36],
      "comparisons": comparisons,
      "obstructionControl": negative,
      "externalStream": externalEvidence,
    ]
    let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  static func compare(_ windowPixels: Data, _ displayPixels: Data) throws -> [String: Any] {
    guard windowPixels.count == 320 * 180 * 3, displayPixels.count == windowPixels.count
    else { throw ProbeError.message("unexpected pixel data size") }
    let windowBytes = [UInt8](windowPixels)
    let displayBytes = [UInt8](displayPixels)
    var changed = 0
    var labelChanged = 0
    var referenceLight = 0
    var displayLight = 0
    var minX = 320
    var minY = 180
    var maxX = -1
    var maxY = -1
    var maxDelta = 0
    var first: [String: Any] = [:]
    for index in 0..<(320 * 180) {
      let offset = index * 3
      let x = index % 320
      let y = index / 320
      let inLabel = x >= 12 && x < 252 && y >= 10 && y < 46
      if inLabel {
        if windowBytes[offset] > 200 && windowBytes[offset + 1] > 200
          && windowBytes[offset + 2] > 200
        {
          referenceLight += 1
        }
        if displayBytes[offset] > 200 && displayBytes[offset + 1] > 200
          && displayBytes[offset + 2] > 200
        {
          displayLight += 1
        }
      }
      if windowBytes[offset..<(offset + 3)] != displayBytes[offset..<(offset + 3)] {
        changed += 1
        if inLabel { labelChanged += 1 }
        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x)
        maxY = max(maxY, y)
        for channel in 0..<3 {
          maxDelta = max(
            maxDelta, abs(Int(windowBytes[offset + channel]) - Int(displayBytes[offset + channel])))
        }
        if first.isEmpty {
          first = [
            "x": x, "y": y, "windowBGR": Array(windowBytes[offset..<(offset + 3)]),
            "displayBGR": Array(displayBytes[offset..<(offset + 3)]),
          ]
        }
      }
    }
    let bounds: Any = changed == 0 ? NSNull() : [minX, minY, maxX, maxY]
    return [
      "changedPixels": changed, "labelChangedPixels": labelChanged,
      "referenceLightPixels": referenceLight, "displayLightPixels": displayLight,
      "changedBounds": bounds, "maxChannelDelta": maxDelta,
      "firstDifference": first,
    ]
  }
  static func comparisonSelfTest() throws {
    let baseline = Data(repeating: 0, count: 320 * 180 * 3)
    var changed = baseline
    changed[(179 * 320 + 0) * 3] = 1
    changed[(28 * 320 + 132) * 3] = 255
    let result = try compare(baseline, changed)
    guard result["changedPixels"] as? Int == 2,
      result["labelChangedPixels"] as? Int == 1,
      result["maxChannelDelta"] as? Int == 255,
      result["changedBounds"] as? [Int] == [0, 28, 132, 179]
    else { throw ProbeError.message("comparison self-test failed") }
    var light = baseline
    let lightOffset = (28 * 320 + 132) * 3
    for channel in 0..<3 { light[lightOffset + channel] = 255 }
    let lightResult = try compare(light, light)
    guard lightResult["referenceLightPixels"] as? Int == 1,
      lightResult["displayLightPixels"] as? Int == 1,
      lightResult["labelChangedPixels"] as? Int == 0
    else { throw ProbeError.message("light-pixel self-test failed") }
    do {
      _ = try compare(baseline, Data())
      throw ProbeError.message("comparison accepted an invalid buffer")
    } catch ProbeError.message("unexpected pixel data size") {
      // The malformed-buffer control must fail before indexing.
    }
  }
  static func waitFor(_ color: String, _ frames: Frames) async throws {
    for _ in 0..<100 {
      if frames.pixels(color) != nil { return }
      try await Task.sleep(for: .milliseconds(50))
    }
    let data = try JSONSerialization.data(withJSONObject: frames.snapshot(), options: [.sortedKeys])
    let diagnostics = String(data: data, encoding: .utf8) ?? "unavailable"
    throw ProbeError.message("missing expected \(color) frame; observed \(diagnostics)")
  }
  static func waitForFile(_ path: URL, process: Process) async throws {
    for _ in 0..<500 {
      if FileManager.default.fileExists(atPath: path.path) { return }
      if !process.isRunning {
        throw ProbeError.message("external stream exited before \(path.lastPathComponent)")
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw ProbeError.message("external stream timed out before \(path.lastPathComponent)")
  }
  enum ProbeError: Error { case message(String) }
}
