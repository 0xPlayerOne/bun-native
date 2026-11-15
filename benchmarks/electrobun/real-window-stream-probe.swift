import CoreGraphics
import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import ScreenCaptureKit

struct Captured {
  let rgb: Data
  let received: Double
  let displayTime: UInt64
}

final class Matches: @unchecked Sendable {
  private let lock = NSLock()
  private var window: Captured?
  private var display: Captured?
  private var baseline: (Captured, Captured)?
  private var changed: (Captured, Captured)?
  private var counts = ["window": 0, "display": 0, "different": 0]
  private var armed = false

  func add(_ sample: Captured, kind: String) {
    lock.lock()
    defer { lock.unlock() }
    counts[kind, default: 0] += 1
    if kind == "window" { window = sample } else { display = sample }
    guard let window, let display else { return }
    guard window.rgb == display.rgb else {
      counts["different", default: 0] += 1
      return
    }
    if baseline == nil {
      baseline = (window, display)
    } else if armed, changed == nil, window.rgb != baseline!.0.rgb {
      changed = (window, display)
    }
  }

  func arm() {
    lock.lock()
    defer { lock.unlock() }
    armed = true
    if let window, let display, let baseline, window.rgb == display.rgb,
      window.rgb != baseline.0.rgb
    {
      changed = (window, display)
    }
  }

  func state() -> (ready: [String: Any]?, changed: [String: Any]?) {
    lock.lock()
    defer { lock.unlock() }
    func metadata(_ pair: (Captured, Captured)) -> [String: Any] {
      [
        "sha256": SHA256.hash(data: pair.0.rgb).map { String(format: "%02x", $0) }.joined(),
        "windowReceivedUptime": pair.0.received, "displayReceivedUptime": pair.1.received,
        "windowDisplayTimeRaw": pair.0.displayTime, "displayDisplayTimeRaw": pair.1.displayTime,
      ]
    }
    let first = baseline.map { metadata($0) }
    let second = changed.map { metadata($0) }
    return (first, second.map { ["match": $0, "counts": counts] })
  }
}

final class Output: NSObject, SCStreamOutput {
  let kind: String
  let region: CGRect
  let dimensions: (Int, Int)
  let matches: Matches
  init(_ kind: String, _ region: CGRect, _ dimensions: (Int, Int), _ matches: Matches) {
    self.kind = kind
    self.region = region
    self.dimensions = dimensions
    self.matches = matches
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen, sample.isValid,
      let metadata = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let frame = metadata.first, let rawStatus = frame[.status] as? Int,
      let status = SCFrameStatus(rawValue: rawStatus), status == .complete,
      let image = CMSampleBufferGetImageBuffer(sample),
      CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA,
      CVPixelBufferGetWidth(image) == dimensions.0, CVPixelBufferGetHeight(image) == dimensions.1,
      CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess
    else { return }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(image)?.assumingMemoryBound(to: UInt8.self) else {
      return
    }
    let x0 = Int(region.minX)
    let y0 = Int(region.minY)
    let width = Int(region.width)
    let height = Int(region.height)
    let stride = CVPixelBufferGetBytesPerRow(image)
    var rgb = Data(count: width * height * 3)
    rgb.withUnsafeMutableBytes { raw in
      guard let destination = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
      for y in 0..<height {
        for x in 0..<width {
          let src = (y0 + y) * stride + (x0 + x) * 4
          let dst = (y * width + x) * 3
          destination[dst] = base[src]
          destination[dst + 1] = base[src + 1]
          destination[dst + 2] = base[src + 2]
        }
      }
    }
    matches.add(
      Captured(
        rgb: rgb, received: ProcessInfo.processInfo.systemUptime,
        displayTime: frame[.displayTime] as? UInt64 ?? 0), kind: kind)
  }
}

@main struct Probe {
  static func main() async {
    if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
      do {
        try selfTest()
        print("stream state self-test passed")
        return
      } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
      }
    }
    do { try await run() } catch {
      FileHandle.standardError.write(Data("\(error)\n".utf8))
      exit(1)
    }
  }
  static func run() async throws {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
      throw Failure.reason("hosted-only diagnostic")
    }
    guard CGPreflightScreenCaptureAccess() else {
      throw Failure.reason("screen capture unavailable; no permission requested")
    }
    let a = CommandLine.arguments
    guard a.count == 10, let pid = Int32(a[1]), pid > 0, let id = UInt32(a[2]), id > 0,
      let x = Int(a[3]), let y = Int(a[4]), let w = Int(a[5]), let h = Int(a[6]),
      x >= 0, y >= 0, w > 0, h > 0, w <= 1024, h <= 1024
    else { throw Failure.reason("invalid bounded request") }
    let ready = URL(fileURLWithPath: a[7])
    let result = URL(fileURLWithPath: a[8])
    let arm = URL(fileURLWithPath: a[9])
    guard let temp = ProcessInfo.processInfo.environment["RUNNER_TEMP"], temp.hasPrefix("/") else {
      throw Failure.reason("missing runner temp")
    }
    let prefix = URL(fileURLWithPath: temp).resolvingSymlinksInPath().path + "/"
    for path in [ready, result, arm] {
      let parent = path.deletingLastPathComponent().resolvingSymlinksInPath().path + "/"
      guard parent.hasPrefix(prefix), !FileManager.default.fileExists(atPath: path.path) else {
        throw Failure.reason("output outside owned runner temp or exists")
      }
    }
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard
      let window = content.windows.first(where: {
        $0.windowID == id && $0.owningApplication?.processID == pid
      })
    else { throw Failure.reason("owned window unavailable") }
    let displays = content.displays.filter { $0.frame.contains(window.frame) }
    guard displays.count == 1 else { throw Failure.reason("window not wholly on one display") }
    let display = displays[0]
    let bounds = window.frame
    guard bounds.width.rounded() == bounds.width, bounds.height.rounded() == bounds.height,
      bounds.width >= 128, bounds.height >= 128, bounds.width <= 8192, bounds.height <= 8192
    else { throw Failure.reason("invalid frame") }
    let dimensions = (Int(bounds.width), Int(bounds.height))
    let region = CGRect(x: x, y: y, width: w, height: h)
    guard CGRect(origin: .zero, size: bounds.size).contains(region) else {
      throw Failure.reason("label outside window")
    }
    let displayRect = bounds.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    guard CGRect(origin: .zero, size: display.frame.size).contains(displayRect) else {
      throw Failure.reason("window outside display")
    }
    func config(_ isDisplay: Bool) -> SCStreamConfiguration {
      let c = SCStreamConfiguration()
      c.width = dimensions.0
      c.height = dimensions.1
      c.pixelFormat = kCVPixelFormatType_32BGRA
      c.minimumFrameInterval = CMTime(value: 1, timescale: 60)
      c.queueDepth = 3
      c.showsCursor = false
      if isDisplay { c.sourceRect = displayRect }
      return c
    }
    let windowStream = SCStream(
      filter: SCContentFilter(desktopIndependentWindow: window), configuration: config(false),
      delegate: nil)
    let displayStream = SCStream(
      filter: SCContentFilter(display: display, excludingWindows: []), configuration: config(true),
      delegate: nil)
    let matches = Matches()
    let windowOutput = Output("window", region, dimensions, matches)
    let displayOutput = Output("display", region, dimensions, matches)
    try windowStream.addStreamOutput(
      windowOutput, type: .screen,
      sampleHandlerQueue: DispatchQueue(label: "bun-native.real-window-stream"))
    try displayStream.addStreamOutput(
      displayOutput, type: .screen,
      sampleHandlerQueue: DispatchQueue(label: "bun-native.real-display-stream"))
    try await windowStream.startCapture()
    do {
      try await displayStream.startCapture()
      var readyWritten = false
      var isArmed = false
      for _ in 0..<500 {
        let state = matches.state()
        if !readyWritten, let first = state.ready {
          let data = try JSONSerialization.data(
            withJSONObject: ["status": "ready", "baseline": first], options: [.sortedKeys])
          try data.write(to: ready, options: [.atomic])
          readyWritten = true
        }
        if readyWritten, !isArmed, FileManager.default.fileExists(atPath: arm.path) {
          matches.arm()
          isArmed = true
        }
        if isArmed, let changed = matches.state().changed {
          let latest = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
          guard
            latest.windows.contains(where: {
              $0.windowID == id && $0.owningApplication?.processID == pid && $0.frame == bounds
            })
          else { throw Failure.reason("owned window changed during stream") }
          let data = try JSONSerialization.data(
            withJSONObject: [
              "status": "changed", "baseline": state.ready!, "changed": changed,
              "windowID": id, "ownerPID": pid, "region": [x, y, w, h],
              "windowSize": [dimensions.0, dimensions.1],
              "scope":
                "exact matched label bytes on two streams; no OCR, OS input attribution or physical presentation claim",
            ], options: [.sortedKeys])
          try data.write(to: result, options: [.atomic])
          break
        }
        try await Task.sleep(for: .milliseconds(20))
      }
      guard FileManager.default.fileExists(atPath: result.path) else {
        throw Failure.reason("matching changed label not observed")
      }
      try await displayStream.stopCapture()
      try await windowStream.stopCapture()
    } catch {
      try? await displayStream.stopCapture()
      try? await windowStream.stopCapture()
      throw error
    }
  }
  static func selfTest() throws {
    let matches = Matches()
    func sample(_ byte: UInt8) -> Captured {
      Captured(rgb: Data([byte]), received: 1, displayTime: 2)
    }
    matches.add(sample(1), kind: "window")
    guard matches.state().ready == nil else { throw Failure.reason("unpaired sample accepted") }
    matches.add(sample(1), kind: "display")
    guard matches.state().ready != nil else { throw Failure.reason("matching baseline rejected") }
    matches.add(sample(2), kind: "window")
    matches.add(sample(2), kind: "display")
    guard matches.state().changed == nil else { throw Failure.reason("unarmed change accepted") }
    matches.arm()
    guard matches.state().changed != nil else {
      throw Failure.reason("armed matching change rejected")
    }
    let outOfOrder = Matches()
    outOfOrder.add(sample(1), kind: "window")
    outOfOrder.add(sample(1), kind: "display")
    outOfOrder.add(sample(2), kind: "window")
    outOfOrder.arm()
    guard outOfOrder.state().changed == nil else {
      throw Failure.reason("unmatched armed change accepted")
    }
    outOfOrder.add(sample(2), kind: "display")
    guard outOfOrder.state().changed != nil else {
      throw Failure.reason("later matching change rejected")
    }
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    try Data([42]).write(to: path, options: [.atomic])
    guard try Data(contentsOf: path) == Data([42]) else {
      throw Failure.reason("atomic result-file control failed")
    }
  }
  enum Failure: Error { case reason(String) }
}
