// Independent oracle for macOS global shortcuts. It never links GPUI.
// It asks the Carbon Event Manager directly whether a combination is held
// exclusively by another process, holds one itself, and posts a real key
// combination through CGEventPost while it, not the host, is the frontmost
// application.
//   trusted                         whether this process may post events
//   probe <code> <mods>             {"status": RegisterEventHotKey status}; 0 means free,
//                                   -9878 (eventHotKeyExistsErr) means held elsewhere
//   hold <code> <mods>              register exclusively, print the status, keep the
//                                   registration until stdin closes
//   press <code> <mods> <host-pid>  become frontmost and type the combination
// <code> is a virtual key code; <mods> is a comma list of command, shift, option,
// control.
//
// Becoming frontmost: since macOS 14 activation is cooperative, so a process
// that is not active cannot activate another application or itself with
// -[NSRunningApplication activateWithOptions:]; the request is ignored while
// the host stays active. A real click on a window is the user's own request
// and is honored, so `press` shows a small window of its own above normal
// windows, clicks it through CGEventPost, and waits until it is frontmost.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>

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

typedef struct {
    UInt32 carbon;
    CGEventFlags flags;
    NSArray<NSNumber *> *keys;
} Modifiers;

static Modifiers parse_modifiers(const char *text) {
    Modifiers result = {0, 0, nil};
    NSMutableArray *keys = [NSMutableArray array];
    for (NSString *name in [[NSString stringWithUTF8String:text] componentsSeparatedByString:@","]) {
        if ([name isEqualToString:@"command"]) {
            result.carbon |= cmdKey;
            result.flags |= kCGEventFlagMaskCommand;
            [keys addObject:@(kVK_Command)];
        } else if ([name isEqualToString:@"shift"]) {
            result.carbon |= shiftKey;
            result.flags |= kCGEventFlagMaskShift;
            [keys addObject:@(kVK_Shift)];
        } else if ([name isEqualToString:@"option"]) {
            result.carbon |= optionKey;
            result.flags |= kCGEventFlagMaskAlternate;
            [keys addObject:@(kVK_Option)];
        } else if ([name isEqualToString:@"control"]) {
            result.carbon |= controlKey;
            result.flags |= kCGEventFlagMaskControl;
            [keys addObject:@(kVK_Control)];
        } else {
            fail(@"Modifiers are a comma list of command, shift, option and control");
        }
    }
    result.keys = keys;
    return result;
}

static OSStatus reg(UInt32 code, UInt32 modifiers, EventHotKeyRef *out) {
    EventHotKeyID identifier = {0x426E4F72 /* BnOr */, 1};
    return RegisterEventHotKey(code, modifiers, identifier, GetEventDispatcherTarget(),
                               kEventHotKeyExclusive, out);
}

static void post(CGKeyCode code, bool down, CGEventFlags flags) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
    if (!event) fail(@"Cannot allocate a keyboard event");
    CGEventSetFlags(event, flags);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    [NSThread sleepForTimeInterval:0.02];
}

static void post_mouse(CGEventType type, CGPoint at) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, at, kCGMouseButtonLeft);
    if (!event) fail(@"Cannot allocate a mouse event");
    CGEventSetFlags(event, 0);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    [NSThread sleepForTimeInterval:0.03];
}

// Deliver this process's queued AppKit events for up to `seconds`.
static void pump(NSTimeInterval seconds) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    for (;;) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                            untilDate:until
                                               inMode:NSDefaultRunLoopMode
                                              dequeue:YES];
        if (!event) return;
        [NSApp sendEvent:event];
    }
}

static BOOL frontmost(void) {
    return NSApp.isActive && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier ==
                                 NSProcessInfo.processInfo.processIdentifier;
}

// Make this process the frontmost application with a real click on its own
// window. Returns the window, which must stay alive until the process exits.
static NSWindow *become_frontmost(pid_t host) {
    [NSApplication sharedApplication];
    if (![NSApp setActivationPolicy:NSApplicationActivationPolicyRegular])
        fail(@"The oracle cannot become a regular application");
    [NSApp finishLaunching];
    NSScreen *screen = NSScreen.screens.firstObject;
    if (!screen) fail(@"No screen");
    NSRect visible = screen.visibleFrame;
    NSRect frame = NSMakeRect(NSMidX(visible) - 120, NSMidY(visible) - 80, 240, 160);
    NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
                                                   styleMask:NSWindowStyleMaskTitled
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    window.releasedWhenClosed = NO;
    window.title = @"Hot key oracle";
    // Above every normal window, so the click lands here and not on the host.
    window.level = NSFloatingWindowLevel;
    [window orderFrontRegardless];
    NSRect content = [window contentRectForFrameRect:window.frame];
    NSPoint center = NSMakePoint(NSMidX(content), NSMidY(content));
    // AppKit's mouse-down hit test, in Cocoa screen coordinates.
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
    while ([NSWindow windowNumberAtPoint:center belowWindowWithWindowNumber:0] != window.windowNumber) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            fail(@"The oracle window is not the topmost window at its own center");
        pump(0.02);
    }
    if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))
        fail(@"An external pointer button is held");
    // Quartz global coordinates: origin at the primary display's top left.
    CGPoint at = CGPointMake(center.x, NSMaxY(screen.frame) - center.y);
    post_mouse(kCGEventMouseMoved, at);
    post_mouse(kCGEventLeftMouseDown, at);
    post_mouse(kCGEventLeftMouseUp, at);
    deadline = NSProcessInfo.processInfo.systemUptime + kWait;
    while (!frontmost()) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            fail([NSString stringWithFormat:@"A click on the oracle window did not make it frontmost "
                                             @"(frontmost pid %d, host pid %d)",
                                            NSWorkspace.sharedWorkspace.frontmostApplication
                                                .processIdentifier,
                                            host]);
        pump(0.02);
    }
    return window;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : CGPreflightPostEventAccess() ? @YES : @NO});
            return 0;
        }
        if (argc < 4) fail(@"Usage: trusted | probe|hold <code> <mods> | press <code> <mods> <host-pid>");
        const char *command = argv[1];
        UInt32 code = (UInt32)parse_number(argv[2], 0, 127);
        Modifiers modifiers = parse_modifiers(argv[3]);
        if (strcmp(command, "probe") == 0 && argc == 4) {
            EventHotKeyRef hot_key = NULL;
            OSStatus status = reg(code, modifiers.carbon, &hot_key);
            if (status == noErr) UnregisterEventHotKey(hot_key);
            emit(@{@"status" : @(status)});
            return 0;
        }
        if (strcmp(command, "hold") == 0 && argc == 4) {
            EventHotKeyRef hot_key = NULL;
            OSStatus status = reg(code, modifiers.carbon, &hot_key);
            emit(@{@"status" : @(status)});
            if (status != noErr) return 0;
            char buffer[64];
            while (fread(buffer, 1, sizeof buffer, stdin) > 0) {
            }
            UnregisterEventHotKey(hot_key);
            emit(@{@"released" : @YES});
            return 0;
        }
        if (strcmp(command, "press") == 0 && argc == 5) {
            if (!CGPreflightPostEventAccess()) fail(@"This process may not post events");
            pid_t host = (pid_t)parse_number(argv[4], 1, INT_MAX);
            NSWindow *window = become_frontmost(host);
            NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
            if (front.processIdentifier == host) fail(@"The host is frontmost");
            CGEventFlags flags = 0;
            UInt32 index = 0;
            CGEventFlags masks[4] = {0};
            for (NSNumber *key in modifiers.keys) {
                // Each modifier goes down with the flags held so far.
                CGEventFlags mask = 0;
                switch (key.intValue) {
                case kVK_Command: mask = kCGEventFlagMaskCommand; break;
                case kVK_Shift: mask = kCGEventFlagMaskShift; break;
                case kVK_Option: mask = kCGEventFlagMaskAlternate; break;
                default: mask = kCGEventFlagMaskControl; break;
                }
                flags |= mask;
                masks[index++] = mask;
                post((CGKeyCode)key.intValue, true, flags);
            }
            post((CGKeyCode)code, true, modifiers.flags);
            post((CGKeyCode)code, false, modifiers.flags);
            for (NSInteger at = (NSInteger)modifiers.keys.count - 1; at >= 0; at--) {
                flags &= ~masks[at];
                post((CGKeyCode)modifiers.keys[(NSUInteger)at].intValue, false, flags);
            }
            emit(@{
                @"frontmostPid" : @(front.processIdentifier),
                @"oraclePid" : @(NSProcessInfo.processInfo.processIdentifier),
                @"activation" : @"CGEventPost(kCGHIDEventTap) click on the oracle's own window",
                @"method" : @"CGEventPost(kCGHIDEventTap)"
            });
            [window orderOut:nil];
            return 0;
        }
        fail(@"Usage: trusted | probe|hold <code> <mods> | press <code> <mods> <host-pid>");
    }
}
