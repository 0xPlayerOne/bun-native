// Independent oracle for macOS global shortcuts. It never links GPUI.
// It asks the Carbon Event Manager directly whether a combination is held
// exclusively by another process, holds one itself, and posts a real key
// combination through CGEventPost while Finder, not the host, is frontmost.
//   trusted                         whether this process may post events
//   probe <code> <mods>             {"status": RegisterEventHotKey status}; 0 means free,
//                                   -9878 (eventHotKeyExistsErr) means held elsewhere
//   hold <code> <mods>              register exclusively, print the status, keep the
//                                   registration until stdin closes
//   press <code> <mods> <host-pid>  make Finder frontmost and type the combination
// <code> is a virtual key code; <mods> is a comma list of command, shift, option,
// control.
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
            NSRunningApplication *finder =
                [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.finder"]
                    .firstObject;
            if (!finder) fail(@"Finder is not running");
            [finder activateWithOptions:NSApplicationActivateAllWindows];
            NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
            while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !=
                   finder.processIdentifier) {
                if (NSProcessInfo.processInfo.systemUptime >= deadline)
                    fail(@"Finder cannot become the foreground application");
                [NSThread sleepForTimeInterval:0.01];
            }
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
                @"frontmost" : front.bundleIdentifier ?: @"",
                @"frontmostPid" : @(front.processIdentifier),
                @"method" : @"CGEventPost(kCGHIDEventTap)"
            });
            return 0;
        }
        fail(@"Usage: trusted | probe|hold <code> <mods> | press <code> <mods> <host-pid>");
    }
}
