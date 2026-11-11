// A second macOS display for the multi-display qualification (#299). It never
// links GPUI.
//
// `create WIDTH HEIGHT SCALE` creates a CoreGraphics virtual display through
// the private CGVirtualDisplay API (the one DeskPad, BetterDisplay and
// Chromium's virtual_display_mac_util use), WIDTHxHEIGHT points at SCALE 1 or
// 2, waits until CoreGraphics reports it online in that mode, prints one JSON
// line and keeps the display connected until stdin reaches end of file. Then
// it releases the display, waits until CoreGraphics reports it gone (a real
// display removal) and prints a second JSON line.
//
// `move PID TITLE X Y` sets the position of the accessible window TITLE of
// process PID to the global top-left point X,Y through the Accessibility API,
// so the window server, not the application, moves it to another display.
// `frame PID TITLE` reports that window's accessible position and size.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <math.h>

// Private CoreGraphics interfaces (macOS 11+). Only their selectors are used:
// the classes are looked up at run time, so a system without them fails with
// a clear message rather than at load time.
@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(copy, nonatomic) void (^terminationHandler)(id, id);
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(NSUInteger)width height:(NSUInteger)height refreshRate:(CGFloat)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) CGDirectDisplayID displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

extern CFUUIDRef CGDisplayCreateUUIDFromDisplayID(CGDirectDisplayID display);

static void emit(id value) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
    if (!data) {
        fprintf(stderr, "JSON encoding failed: %s\n", error.localizedDescription.UTF8String);
        exit(1);
    }
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

__attribute__((noreturn)) static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

static unsigned long parse_number(const char *text, unsigned long max, NSString *what) {
    char *end = NULL;
    unsigned long value = strtoul(text, &end, 10);
    if (!end || *end || value == 0 || value > max) fail([NSString stringWithFormat:@"Invalid %@", what]);
    return value;
}

static double parse_coordinate(const char *text) {
    char *end = NULL;
    double value = strtod(text, &end);
    if (!end || *end || !isfinite(value) || fabs(value) > 1048576) fail(@"Invalid coordinate");
    return value;
}

static BOOL online(CGDirectDisplayID display) {
    CGDirectDisplayID displays[32];
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(32, displays, &count) != kCGErrorSuccess) return NO;
    for (uint32_t index = 0; index < count; index++)
        if (displays[index] == display) return YES;
    return NO;
}

static NSDictionary *describe(CGDirectDisplayID display) {
    CGRect bounds = CGDisplayBounds(display);
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
    NSDictionary *described = @{
        @"width" : @(mode ? CGDisplayModeGetWidth(mode) : 0),
        @"height" : @(mode ? CGDisplayModeGetHeight(mode) : 0),
        @"pixelWidth" : @(mode ? CGDisplayModeGetPixelWidth(mode) : 0),
        @"pixelHeight" : @(mode ? CGDisplayModeGetPixelHeight(mode) : 0),
    };
    if (mode) CGDisplayModeRelease(mode);
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    NSString *text = nil;
    if (uuid) {
        text = (__bridge_transfer NSString *)CFUUIDCreateString(kCFAllocatorDefault, uuid);
        CFRelease(uuid);
    }
    return @{
        @"number" : @(display),
        @"uuid" : text ?: (id)[NSNull null],
        @"cgBounds" : @{
            @"x" : @(bounds.origin.x),
            @"y" : @(bounds.origin.y),
            @"width" : @(bounds.size.width),
            @"height" : @(bounds.size.height),
        },
        @"mode" : described,
        @"main" : @(CGDisplayIsMain(display) != 0),
    };
}

/// Whether the display's current mode is WIDTHxHEIGHT points at SCALE.
static BOOL in_mode(CGDirectDisplayID display, size_t width, size_t height, size_t scale) {
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
    if (!mode) return NO;
    BOOL matches = CGDisplayModeGetWidth(mode) == width && CGDisplayModeGetHeight(mode) == height &&
                   CGDisplayModeGetPixelWidth(mode) == width * scale &&
                   CGDisplayModeGetPixelHeight(mode) == height * scale;
    CGDisplayModeRelease(mode);
    return matches;
}

/// macOS may bring a new HiDPI-capable display up in its 1x duplicate mode;
/// select the requested scale's mode explicitly for this login session.
static void select_mode(CGDirectDisplayID display, size_t width, size_t height, size_t scale) {
    NSDictionary *options = @{(__bridge NSString *)kCGDisplayShowDuplicateLowResolutionModes : @YES};
    CFArrayRef modes = CGDisplayCopyAllDisplayModes(display, (__bridge CFDictionaryRef)options);
    if (!modes) return;
    for (CFIndex index = 0; index < CFArrayGetCount(modes); index++) {
        CGDisplayModeRef mode = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, index);
        if (CGDisplayModeGetWidth(mode) != width || CGDisplayModeGetHeight(mode) != height ||
            CGDisplayModeGetPixelWidth(mode) != width * scale)
            continue;
        CGDisplayConfigRef config = NULL;
        if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) break;
        if (CGConfigureDisplayWithDisplayMode(config, display, mode, NULL) != kCGErrorSuccess) {
            CGCancelDisplayConfiguration(config);
            break;
        }
        CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
        break;
    }
    CFRelease(modes);
}

// The connected display. ARC may release a local after its last use, which
// would disconnect the display at once, so it is held here until release.
static CGVirtualDisplay *connected_display;

static int create(size_t width, size_t height, size_t scale) {
    // A window-server connection, as the display oracle makes.
    [NSApplication sharedApplication];
    Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
    Class displayClass = NSClassFromString(@"CGVirtualDisplay");
    Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
    Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
    if (!descriptorClass || !displayClass || !settingsClass || !modeClass)
        fail(@"This macOS has no CGVirtualDisplay API");

    CGVirtualDisplayDescriptor *descriptor = (CGVirtualDisplayDescriptor *)[[descriptorClass alloc] init];
    descriptor.queue = dispatch_queue_create("bun-native.virtual-display", DISPATCH_QUEUE_SERIAL);
    descriptor.name = @"Bun Native qualification display";
    descriptor.maxPixelsWide = (unsigned int)(width * scale);
    descriptor.maxPixelsHigh = (unsigned int)(height * scale);
    // About 110 points per inch, so macOS treats a 2x mode as Retina.
    descriptor.sizeInMillimeters = CGSizeMake(25.4 * width / 110.0, 25.4 * height / 110.0);
    // A fixed vendor/product/serial gives the display a stable CoreGraphics UUID.
    descriptor.vendorID = 0xB0B;
    descriptor.productID = 0x299;
    descriptor.serialNum = 0x299;
    descriptor.terminationHandler = ^(__unused id display, __unused id reason) {
      fprintf(stderr, "The window server terminated the virtual display\n");
    };
    connected_display = [(CGVirtualDisplay *)[displayClass alloc] initWithDescriptor:descriptor];
    if (!connected_display || connected_display.displayID == kCGNullDirectDisplay)
        fail(@"CGVirtualDisplay creation failed");

    // Whether a HiDPI mode is given in points or in pixels is undocumented, so
    // a 2x display lists both sizes; maxPixels admits only WIDTHxHEIGHT points
    // at 2x, which select_mode then requires.
    CGVirtualDisplaySettings *settings = (CGVirtualDisplaySettings *)[[settingsClass alloc] init];
    settings.hiDPI = scale == 2 ? 1 : 0;
    NSMutableArray *modes = [NSMutableArray array];
    if (scale == 2)
        [modes addObject:[(CGVirtualDisplayMode *)[modeClass alloc] initWithWidth:width * 2
                                                                           height:height * 2
                                                                      refreshRate:60]];
    [modes addObject:[(CGVirtualDisplayMode *)[modeClass alloc] initWithWidth:width height:height refreshRate:60]];
    settings.modes = modes;
    if (![connected_display applySettings:settings]) fail(@"CGVirtualDisplay rejected its settings");

    CGDirectDisplayID number = connected_display.displayID;
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    NSUInteger polls = 0;
    while (!(online(number) && in_mode(number, width, height, scale))) {
        if ([deadline timeIntervalSinceNow] < 0) {
            emit(@{
                @"error" : @"the virtual display did not come online in the requested mode",
                @"display" : online(number) ? (id)describe(number) : (id)[NSNull null],
            });
            return 1;
        }
        // Ask for the mode once the display is online, and again each second.
        if (online(number) && polls++ % 20 == 0) select_mode(number, width, height, scale);
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    emit(@{@"connected" : describe(number)});

    // Stay connected until the fixture closes stdin.
    char buffer[64];
    while (fread(buffer, 1, sizeof buffer, stdin) > 0) {
    }

    connected_display = nil;
    deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    while (online(number)) {
        if ([deadline timeIntervalSinceNow] < 0) fail(@"The virtual display stayed online after release");
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    emit(@{@"disconnected" : @(number)});
    return 0;
}

static AXUIElementRef window_titled(pid_t pid, NSString *title) {
    if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"No accessibility element for the process");
    AXUIElementSetMessagingTimeout(application, 2.0);
    CFTypeRef windows = NULL;
    AXUIElementRef found = NULL;
    if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows) == kAXErrorSuccess &&
        windows) {
        for (id candidate in (__bridge NSArray *)windows) {
            AXUIElementRef window = (__bridge AXUIElementRef)candidate;
            CFTypeRef value = NULL;
            if (AXUIElementCopyAttributeValue(window, kAXTitleAttribute, &value) == kAXErrorSuccess && value) {
                BOOL same = [(__bridge id)value isEqual:title];
                CFRelease(value);
                if (same) {
                    found = (AXUIElementRef)CFRetain(window);
                    break;
                }
            }
        }
        CFRelease(windows);
    }
    CFRelease(application);
    if (!found) fail([NSString stringWithFormat:@"No accessible window titled %@", title]);
    return found;
}

static NSDictionary *frame_of(AXUIElementRef window) {
    CFTypeRef position = NULL;
    CFTypeRef size = NULL;
    CGPoint point = CGPointZero;
    CGSize extent = CGSizeZero;
    if (AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &position) != kAXErrorSuccess ||
        !position || !AXValueGetValue((AXValueRef)position, (AXValueType)kAXValueCGPointType, &point))
        fail(@"The window has no accessible position");
    if (AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &size) != kAXErrorSuccess || !size ||
        !AXValueGetValue((AXValueRef)size, (AXValueType)kAXValueCGSizeType, &extent))
        fail(@"The window has no accessible size");
    CFRelease(position);
    CFRelease(size);
    return @{@"x" : @(point.x), @"y" : @(point.y), @"width" : @(extent.width), @"height" : @(extent.height)};
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *usage = @"usage: macos-virtual-display create WIDTH HEIGHT SCALE | move PID TITLE X Y | "
                          @"frame PID TITLE | trusted";
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        if (argc == 5 && strcmp(argv[1], "create") == 0) {
            size_t scale = parse_number(argv[4], 2, @"scale");
            return create(parse_number(argv[2], 8192, @"width"), parse_number(argv[3], 8192, @"height"), scale);
        }
        if (argc == 6 && strcmp(argv[1], "move") == 0) {
            AXUIElementRef window =
                window_titled((pid_t)parse_number(argv[2], INT32_MAX, @"pid"), @(argv[3]));
            CGPoint point = CGPointMake(parse_coordinate(argv[4]), parse_coordinate(argv[5]));
            AXValueRef value = AXValueCreate((AXValueType)kAXValueCGPointType, &point);
            AXError error = AXUIElementSetAttributeValue(window, kAXPositionAttribute, value);
            CFRelease(value);
            if (error != kAXErrorSuccess) fail([NSString stringWithFormat:@"AXPosition failed (AXError %d)", (int)error]);
            emit(@{@"moved" : frame_of(window)});
            CFRelease(window);
            return 0;
        }
        if (argc == 4 && strcmp(argv[1], "frame") == 0) {
            AXUIElementRef window =
                window_titled((pid_t)parse_number(argv[2], INT32_MAX, @"pid"), @(argv[3]));
            emit(@{@"frame" : frame_of(window)});
            CFRelease(window);
            return 0;
        }
        fail(usage);
    }
    return 1;
}
