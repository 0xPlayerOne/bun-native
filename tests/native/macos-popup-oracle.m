// Independent oracle for macOS popup windows. It never links GPUI.
// Window geometry, level and front-to-back order come from the WindowServer
// (CGWindowListCopyWindowInfo); titled window frames and moves go through
// Accessibility; pointer and key input is posted as real Quartz events.
// Every coordinate is in global points from the primary display's top-left.
//   trusted                       whether this process may use Accessibility
//   windows <pid>                 {"screen": [w, h], "frontmost": pid, "windows":
//                                 [{"id","layer","x","y","width","height"}]} for the
//                                 process's on-screen windows, front to back
//   frame <pid> <title>           the AX frame of the process's window titled <title>
//   move <pid> <title> <x> <y>    move that window's top-left corner
//   raise <pid> <title>           make that window main and raise it
//   activate <pid>                make the process the foreground application
//   click <x> <y>                 move the pointer there and click the left button
//   key <code>                    press and release one virtual key code
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static const NSTimeInterval kWait = 5.0;

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

static long parse_number(const char *text, long minimum, long maximum) {
    char *end = NULL;
    long value = strtol(text, &end, 10);
    if (!end || *end || value < minimum || value > maximum) fail(@"Invalid number");
    return value;
}

static NSString *utf8(const char *text) {
    NSString *value = [NSString stringWithUTF8String:text];
    if (!value) fail(@"Arguments must be UTF-8");
    return value;
}

static id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value)
        return nil;
    return CFBridgingRelease(value);
}

// The process's AX window titled `title`; waits for it to appear.
static AXUIElementRef titled(pid_t pid, NSString *title) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
    for (;;) {
        id windows = attribute(app, kAXWindowsAttribute);
        if ([windows isKindOfClass:[NSArray class]]) {
            for (id window in windows) {
                AXUIElementRef element = (__bridge AXUIElementRef)window;
                id name = attribute(element, kAXTitleAttribute);
                if ([name isKindOfClass:[NSString class]] && [name isEqualToString:title]) {
                    CFRetain(element);
                    CFRelease(app);
                    return element;
                }
            }
        }
        if (NSProcessInfo.processInfo.systemUptime >= deadline) {
            CFRelease(app);
            fail([NSString stringWithFormat:@"No window titled %@", title]);
        }
        [NSThread sleepForTimeInterval:0.02];
    }
}

static NSDictionary *frame_of(AXUIElementRef window) {
    CGPoint position = CGPointZero;
    CGSize size = CGSizeZero;
    id positionValue = attribute(window, kAXPositionAttribute);
    id sizeValue = attribute(window, kAXSizeAttribute);
    if (!positionValue || !sizeValue ||
        !AXValueGetValue((__bridge AXValueRef)positionValue, kAXValueTypeCGPoint, &position) ||
        !AXValueGetValue((__bridge AXValueRef)sizeValue, kAXValueTypeCGSize, &size))
        fail(@"The window has no Accessibility frame");
    return @{@"x" : @(position.x), @"y" : @(position.y), @"width" : @(size.width),
             @"height" : @(size.height)};
}

static NSArray *windows_of(pid_t pid) {
    NSMutableArray *result = [NSMutableArray array];
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) fail(@"The WindowServer returned no window list");
    for (NSDictionary *info in (__bridge NSArray *)list) {
        if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
        CGRect bounds = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds], &bounds))
            continue;
        [result addObject:@{
            @"id" : info[(__bridge NSString *)kCGWindowNumber],
            @"layer" : info[(__bridge NSString *)kCGWindowLayer],
            @"x" : @(bounds.origin.x),
            @"y" : @(bounds.origin.y),
            @"width" : @(bounds.size.width),
            @"height" : @(bounds.size.height),
        }];
    }
    CFRelease(list);
    return result;
}

static void post(CGEventRef event) {
    if (!event) fail(@"Cannot allocate a Quartz event");
    CGEventSetFlags(event, 0);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    [NSThread sleepForTimeInterval:0.03];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        if (argc < 2) fail(@"Usage: see the header of macos-popup-oracle.m");
        if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
        const char *command = argv[1];
        if (strcmp(command, "windows") == 0 && argc == 3) {
            pid_t pid = (pid_t)parse_number(argv[2], 1, INT32_MAX);
            CGRect screen = CGDisplayBounds(CGMainDisplayID());
            emit(@{
                @"screen" : @[ @(screen.size.width), @(screen.size.height) ],
                @"frontmost" : @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
                @"windows" : windows_of(pid),
            });
        } else if (strcmp(command, "frame") == 0 && argc == 4) {
            AXUIElementRef window = titled((pid_t)parse_number(argv[2], 1, INT32_MAX), utf8(argv[3]));
            emit(frame_of(window));
            CFRelease(window);
        } else if (strcmp(command, "move") == 0 && argc == 6) {
            AXUIElementRef window = titled((pid_t)parse_number(argv[2], 1, INT32_MAX), utf8(argv[3]));
            CGPoint target = CGPointMake(parse_number(argv[4], -100000, 100000),
                                         parse_number(argv[5], -100000, 100000));
            AXValueRef value = AXValueCreate(kAXValueTypeCGPoint, &target);
            AXError status = AXUIElementSetAttributeValue(window, kAXPositionAttribute, value);
            CFRelease(value);
            if (status != kAXErrorSuccess) fail(@"The window refused the move");
            emit(frame_of(window));
            CFRelease(window);
        } else if (strcmp(command, "raise") == 0 && argc == 4) {
            AXUIElementRef window = titled((pid_t)parse_number(argv[2], 1, INT32_MAX), utf8(argv[3]));
            AXUIElementSetAttributeValue(window, kAXMainAttribute, kCFBooleanTrue);
            if (AXUIElementPerformAction(window, kAXRaiseAction) != kAXErrorSuccess)
                fail(@"The window refused to raise");
            emit(@{@"raised" : @YES});
            CFRelease(window);
        } else if (strcmp(command, "activate") == 0 && argc == 3) {
            pid_t pid = (pid_t)parse_number(argv[2], 1, INT32_MAX);
            NSRunningApplication *app =
                [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            if (!app) fail(@"The process is not a running application");
            [app activateWithOptions:NSApplicationActivateAllWindows];
            NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
            while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) {
                if (NSProcessInfo.processInfo.systemUptime >= deadline)
                    fail(@"The process cannot become the foreground application");
                [NSThread sleepForTimeInterval:0.01];
            }
            emit(@{@"frontmost" : @(pid)});
        } else if (strcmp(command, "click") == 0 && argc == 4) {
            CGPoint at = CGPointMake(parse_number(argv[2], -100000, 100000),
                                     parse_number(argv[3], -100000, 100000));
            post(CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, at, kCGMouseButtonLeft));
            post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, at, kCGMouseButtonLeft));
            post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, at, kCGMouseButtonLeft));
            emit(@{@"clicked" : @[ @(at.x), @(at.y) ]});
        } else if (strcmp(command, "key") == 0 && argc == 3) {
            CGKeyCode code = (CGKeyCode)parse_number(argv[2], 0, 127);
            post(CGEventCreateKeyboardEvent(NULL, code, true));
            post(CGEventCreateKeyboardEvent(NULL, code, false));
            emit(@{@"key" : @(code)});
        } else {
            fail(@"Usage: see the header of macos-popup-oracle.m");
        }
    }
    return 0;
}
