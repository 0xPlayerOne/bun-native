// Bounded macOS keyboard and input-source controller for the screen-reader and
// IME fixtures (#241). It never links GPUI.
//
// `activate PID` brings that process to the front and waits until it is.
// `key PID NAME` posts one key press and release through CGEventPost, only
// while PID is the frontmost application. NAME is one of tab, shift+tab,
// space, return, end, home, left, right, shift+end, backspace, or a single
// letter a-z.
// `sources PREFIX` lists the installed input sources whose ID starts with
// PREFIX, with their enabled, selectable and selected states.
// `current` prints the selected keyboard input source.
// `select ID` enables the input source with that ID (including its parent
// input method when it is an input mode) and selects it, then verifies the
// selection. Every command prints one JSON object.
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>

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

static pid_t parse_pid(const char *text) {
    char *end = NULL;
    long value = strtol(text, &end, 10);
    if (!end || *end || value <= 0 || value > INT_MAX) fail(@"Invalid process id");
    return (pid_t)value;
}

static void wait_frontmost(pid_t pid, double seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) {
        if ([deadline timeIntervalSinceNow] < 0)
            fail([NSString stringWithFormat:@"Process %d is not the frontmost application (frontmost: %@)", pid,
                                            NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier
                                                ?: NSWorkspace.sharedWorkspace.frontmostApplication.localizedName]);
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
}

static NSDictionary *source_info(TISInputSourceRef source) {
    NSString *identifier = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    NSString *name = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyLocalizedName);
    NSString *kind = (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceType);
    CFBooleanRef enabled = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsEnabled);
    CFBooleanRef selectable = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsSelectCapable);
    CFBooleanRef selected = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsSelected);
    return @{
        @"id": identifier ?: @"",
        @"name": name ?: @"",
        @"type": kind ?: @"",
        @"enabled": @(enabled && CFBooleanGetValue(enabled)),
        @"selectable": @(selectable && CFBooleanGetValue(selectable)),
        @"selected": @(selected && CFBooleanGetValue(selected)),
    };
}

static NSArray *sources(NSString *prefix) {
    NSArray *all = CFBridgingRelease(TISCreateInputSourceList(NULL, true));
    NSMutableArray *result = [NSMutableArray array];
    for (id source in all) {
        NSDictionary *info = source_info((__bridge TISInputSourceRef)source);
        if ([info[@"id"] hasPrefix:prefix]) [result addObject:@{@"ref": source, @"info": info}];
    }
    return result;
}

static NSDictionary *current(void) {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    if (!source) fail(@"No current keyboard input source");
    NSDictionary *info = source_info(source);
    CFRelease(source);
    return info;
}

static void post_key(pid_t pid, CGKeyCode code, CGEventFlags flags) {
    wait_frontmost(pid, 2);
    CGEventSourceRef origin = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(origin, code, down == 1);
        if (!event) fail(@"CGEventCreateKeyboardEvent failed");
        CGEventSetFlags(event, flags);
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)
            fail(@"The frontmost application changed before input");
        CGEventPost(kCGSessionEventTap, event);
        CFRelease(event);
        usleep(20000);
    }
    if (origin) CFRelease(origin);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) fail(@"usage: activate PID | key PID NAME | sources PREFIX | current | select ID");
        NSString *command = [NSString stringWithUTF8String:argv[1]];
        if ([command isEqualToString:@"activate"] && argc == 3) {
            pid_t pid = parse_pid(argv[2]);
            NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            if (!app) fail(@"No running application with that process id");
            [app activateWithOptions:NSApplicationActivateAllWindows];
            wait_frontmost(pid, 5);
            emit(@{@"activated": @(pid)});
        } else if ([command isEqualToString:@"key"] && argc == 4) {
            pid_t pid = parse_pid(argv[2]);
            NSString *name = [NSString stringWithUTF8String:argv[3]];
            NSDictionary *named = @{
                @"tab": @[@(kVK_Tab), @0],
                @"shift+tab": @[@(kVK_Tab), @(kCGEventFlagMaskShift)],
                @"space": @[@(kVK_Space), @0],
                @"return": @[@(kVK_Return), @0],
                @"end": @[@(kVK_End), @0],
                @"home": @[@(kVK_Home), @0],
                @"left": @[@(kVK_LeftArrow), @0],
                @"right": @[@(kVK_RightArrow), @0],
                @"shift+end": @[@(kVK_End), @(kCGEventFlagMaskShift)],
                @"backspace": @[@(kVK_Delete), @0],
            };
            NSDictionary *letters = @{
                @"a": @(kVK_ANSI_A), @"b": @(kVK_ANSI_B), @"c": @(kVK_ANSI_C), @"d": @(kVK_ANSI_D),
                @"e": @(kVK_ANSI_E), @"f": @(kVK_ANSI_F), @"g": @(kVK_ANSI_G), @"h": @(kVK_ANSI_H),
                @"i": @(kVK_ANSI_I), @"j": @(kVK_ANSI_J), @"k": @(kVK_ANSI_K), @"l": @(kVK_ANSI_L),
                @"m": @(kVK_ANSI_M), @"n": @(kVK_ANSI_N), @"o": @(kVK_ANSI_O), @"p": @(kVK_ANSI_P),
                @"q": @(kVK_ANSI_Q), @"r": @(kVK_ANSI_R), @"s": @(kVK_ANSI_S), @"t": @(kVK_ANSI_T),
                @"u": @(kVK_ANSI_U), @"v": @(kVK_ANSI_V), @"w": @(kVK_ANSI_W), @"x": @(kVK_ANSI_X),
                @"y": @(kVK_ANSI_Y), @"z": @(kVK_ANSI_Z),
            };
            NSArray *key = named[name];
            if (!key && letters[name]) key = @[letters[name], @0];
            if (!key) fail(@"Unknown key name");
            post_key(pid, (CGKeyCode)[key[0] unsignedShortValue], (CGEventFlags)[key[1] unsignedLongLongValue]);
            emit(@{@"key": name, @"method": @"CGEventPost(kCGSessionEventTap)"});
        } else if ([command isEqualToString:@"sources"] && argc == 3) {
            NSMutableArray *list = [NSMutableArray array];
            for (NSDictionary *entry in sources([NSString stringWithUTF8String:argv[2]])) [list addObject:entry[@"info"]];
            emit(@{@"sources": list});
        } else if ([command isEqualToString:@"current"] && argc == 2) {
            emit(current());
        } else if ([command isEqualToString:@"select"] && argc == 3) {
            NSString *identifier = [NSString stringWithUTF8String:argv[2]];
            NSDictionary *previous = current();
            NSArray *matches = sources(identifier);
            TISInputSourceRef target = NULL;
            for (NSDictionary *entry in matches)
                if ([entry[@"info"][@"id"] isEqualToString:identifier]) target = (__bridge TISInputSourceRef)entry[@"ref"];
            if (!target) fail([NSString stringWithFormat:@"Input source %@ is not installed", identifier]);
            // An input mode (for example Korean 2-Set) is enabled through its
            // input method's bundle; enable every source of that bundle that can be.
            NSString *bundle = (__bridge NSString *)TISGetInputSourceProperty(target, kTISPropertyBundleID);
            NSMutableArray *enabled = [NSMutableArray array];
            NSArray *related = bundle ? CFBridgingRelease(TISCreateInputSourceList(
                                           (__bridge CFDictionaryRef)@{(__bridge NSString *)kTISPropertyBundleID: bundle}, true))
                                      : @[];
            for (id source in related) {
                CFBooleanRef capable = TISGetInputSourceProperty((__bridge TISInputSourceRef)source,
                                                                 kTISPropertyInputSourceIsEnableCapable);
                if (capable && CFBooleanGetValue(capable)) {
                    OSStatus status = TISEnableInputSource((__bridge TISInputSourceRef)source);
                    [enabled addObject:@{@"id": source_info((__bridge TISInputSourceRef)source)[@"id"], @"status": @(status)}];
                }
            }
            OSStatus status = TISEnableInputSource(target);
            if (status != noErr) fail([NSString stringWithFormat:@"TISEnableInputSource failed: %d", (int)status]);
            status = TISSelectInputSource(target);
            if (status != noErr) fail([NSString stringWithFormat:@"TISSelectInputSource failed: %d", (int)status]);
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
            while (![current()[@"id"] isEqualToString:identifier]) {
                if ([deadline timeIntervalSinceNow] < 0)
                    fail([NSString stringWithFormat:@"%@ was not selected; current %@", identifier, current()[@"id"]]);
                [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
            }
            emit(@{@"previous": previous, @"selected": current(), @"enabled": enabled});
        } else {
            fail(@"usage: activate PID | key PID NAME | sources PREFIX | current | select ID");
        }
    }
    return 0;
}
