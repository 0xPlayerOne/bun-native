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
    guard width > 0, height > 0 else { return }
    let offset = (height / 2) * CVPixelBufferGetBytesPerRow(image) + (width / 2) * 4
    let pixel = base.advanced(by: offset).assumingMemoryBound(to: UInt8.self)
    let blue = Int(pixel[0])
    let green = Int(pixel[1])
    let red = Int(pixel[2])
    let color =
      red > 160 && green < 80 && blue < 80
      ? "red" : blue > 160 && red < 80 && green < 80 ? "blue" : "other"
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
}

@main struct Probe {
  @MainActor static func main() {
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
    try await stream.startCapture()
    do {
      try await displayStream.startCapture()
      try await waitFor("red", frames)
      try await waitFor("red", displayFrames)
      view.layer?.backgroundColor = NSColor.blue.cgColor
      try await waitFor("blue", frames)
      try await waitFor("blue", displayFrames)
      for color in ["red", "blue"] {
        guard let windowPixels = frames.pixels(color),
          let displayPixels = displayFrames.pixels(color),
          windowPixels.count == 320 * 180 * 3, windowPixels == displayPixels
        else { throw ProbeError.message("owned-window and display RGB pixels differ for \(color)") }
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
        "owned fixture and bounded display RGB correspondence; no input or physical presentation claim",
      "windowFrames": frames.snapshot(),
      "displayFrames": displayFrames.snapshot(),
      "sourceRect": [sourceRect.minX, sourceRect.minY, sourceRect.width, sourceRect.height],
      "rgbCorrespondence": ["red": true, "blue": true],
    ]
    let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  static func waitFor(_ color: String, _ frames: Frames) async throws {
    for _ in 0..<100 {
      if frames.snapshot().contains(where: { ($0["color"] as? String) == color }) { return }
      try await Task.sleep(for: .milliseconds(50))
    }
    let data = try JSONSerialization.data(withJSONObject: frames.snapshot(), options: [.sortedKeys])
    let diagnostics = String(data: data, encoding: .utf8) ?? "unavailable"
    throw ProbeError.message("missing expected \(color) frame; observed \(diagnostics)")
  }
  enum ProbeError: Error { case message(String) }
}
