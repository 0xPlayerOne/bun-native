// Independent AppKit/CoreGraphics display oracle for the macOS display fixture (#299).
// It never links GPUI. `screens` reads NSScreen and CoreGraphics; `modes` lists a
// display's desktop modes; `set` applies one for the login session, so the change
// outlives this process until the fixture restores the original mode.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

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
}

__attribute__((noreturn)) static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

static NSDictionary *rect(NSRect value) {
    return @{
        @"x" : @(value.origin.x),
        @"y" : @(value.origin.y),
        @"width" : @(value.size.width),
        @"height" : @(value.size.height),
    };
}

static NSString *uuid_for(CGDirectDisplayID display) {
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    if (!uuid) return nil;
    CFStringRef text = CFUUIDCreateString(kCFAllocatorDefault, uuid);
    CFRelease(uuid);
    if (!text) return nil;
    return (__bridge_transfer NSString *)text;
}

static CGDirectDisplayID parse_display(const char *text) {
    char *end = NULL;
    unsigned long value = strtoul(text, &end, 10);
    if (!end || *end || value == 0 || value > UINT32_MAX) fail(@"Invalid display number");
    return (CGDirectDisplayID)value;
}

static NSArray *desktop_modes(CGDirectDisplayID display) {
    CFArrayRef all = CGDisplayCopyAllDisplayModes(display, NULL);
    if (!all) fail(@"CoreGraphics returned no display modes");
    NSMutableArray *modes = [NSMutableArray array];
    for (CFIndex index = 0; index < CFArrayGetCount(all); index++) {
        CGDisplayModeRef mode = (CGDisplayModeRef)CFArrayGetValueAtIndex(all, index);
        if (CGDisplayModeIsUsableForDesktopGUI(mode)) [modes addObject:(__bridge id)mode];
    }
    CFRelease(all);
    return modes;
}

static NSDictionary *describe_mode(CGDisplayModeRef mode, NSUInteger index) {
    return @{
        @"index" : @(index),
        @"width" : @(CGDisplayModeGetWidth(mode)),
        @"height" : @(CGDisplayModeGetHeight(mode)),
        @"pixelWidth" : @(CGDisplayModeGetPixelWidth(mode)),
        @"pixelHeight" : @(CGDisplayModeGetPixelHeight(mode)),
        @"refresh" : @(CGDisplayModeGetRefreshRate(mode)),
    };
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) fail(@"usage: macos-display-oracle screens | modes N | set N INDEX");
        NSString *command = @(argv[1]);
        if ([command isEqualToString:@"screens"] && argc == 2) {
            [NSApplication sharedApplication];
            NSMutableArray *screens = [NSMutableArray array];
            for (NSScreen *screen in NSScreen.screens) {
                NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
                if (!number) fail(@"An NSScreen has no NSScreenNumber");
                CGDirectDisplayID display = number.unsignedIntValue;
                NSString *uuid = uuid_for(display);
                [screens addObject:@{
                    @"number" : number,
                    @"uuid" : uuid ? (id)uuid : (id)[NSNull null],
                    @"frame" : rect(screen.frame),
                    @"visibleFrame" : rect(screen.visibleFrame),
                    @"backingScaleFactor" : @(screen.backingScaleFactor),
                    @"cgBounds" : rect(NSRectFromCGRect(CGDisplayBounds(display))),
                    @"main" : @(CGDisplayIsMain(display) != 0),
                }];
            }
            emit(screens);
            return 0;
        }
        if ([command isEqualToString:@"modes"] && argc == 3) {
            CGDirectDisplayID display = parse_display(argv[2]);
            CGDisplayModeRef current = CGDisplayCopyDisplayMode(display);
            if (!current) fail(@"CoreGraphics returned no current display mode");
            NSArray *modes = desktop_modes(display);
            NSMutableArray *described = [NSMutableArray array];
            NSInteger currentIndex = -1;
            for (NSUInteger index = 0; index < modes.count; index++) {
                CGDisplayModeRef mode = (__bridge CGDisplayModeRef)modes[index];
                if (CFEqual(mode, current)) currentIndex = (NSInteger)index;
                [described addObject:describe_mode(mode, index)];
            }
            emit(@{
                @"current" : describe_mode(current, (NSUInteger)MAX(currentIndex, 0)),
                @"currentIndex" : @(currentIndex),
                @"modes" : described,
            });
            CGDisplayModeRelease(current);
            return 0;
        }
        if ([command isEqualToString:@"set"] && argc == 4) {
            CGDirectDisplayID display = parse_display(argv[2]);
            char *end = NULL;
            unsigned long index = strtoul(argv[3], &end, 10);
            NSArray *modes = desktop_modes(display);
            if (!end || *end || index >= modes.count) fail(@"Invalid display mode index");
            CGDisplayModeRef mode = (__bridge CGDisplayModeRef)modes[index];
            CGDisplayConfigRef config = NULL;
            CGError error = CGBeginDisplayConfiguration(&config);
            if (error != kCGErrorSuccess) fail(@"CGBeginDisplayConfiguration failed");
            error = CGConfigureDisplayWithDisplayMode(config, display, mode, NULL);
            if (error != kCGErrorSuccess) {
                CGCancelDisplayConfiguration(config);
                fail([NSString stringWithFormat:@"CGConfigureDisplayWithDisplayMode failed: %d", error]);
            }
            error = CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
            if (error != kCGErrorSuccess)
                fail([NSString stringWithFormat:@"CGCompleteDisplayConfiguration failed: %d", error]);
            emit(@{ @"applied" : describe_mode(mode, index) });
            return 0;
        }
        fail(@"usage: macos-display-oracle screens | modes N | set N INDEX");
    }
    return 1;
}
