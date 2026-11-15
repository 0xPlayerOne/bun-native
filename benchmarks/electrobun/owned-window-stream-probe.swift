// Hosted-only feasibility test. The stream is restricted to a window this
// process owns; it is not a display capture or a presentation measurement.
import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

final class Frames: NSObject, SCStreamOutput {
  private let lock = NSLock()
  private var observed: [[String: Any]] = []

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
    observed.append(item)
    lock.unlock()
  }

  func snapshot() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return observed
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
      contentRect: NSRect(x: 100, y: 100, width: 320, height: 180), styleMask: [.titled],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
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
    for _ in 0..<50 {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true)
      target = content.windows.first(where: {
        $0.windowID == CGWindowID(window.windowNumber) && $0.owningApplication?.processID == pid
      })
      if target != nil { break }
      try await Task.sleep(for: .milliseconds(100))
    }
    guard let target else { throw ProbeError.message("owned fixture window unavailable") }
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
    try await stream.startCapture()
    do {
      try await waitFor("red", frames)
      view.layer?.backgroundColor = NSColor.blue.cgColor
      try await waitFor("blue", frames)
      try await stream.stopCapture()
    } catch {
      try? await stream.stopCapture()
      throw error
    }
    let result: [String: Any] = [
      "status": "passed",
      "scope": "owned window stream only; no display or physical presentation claim",
      "frames": frames.snapshot(),
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
