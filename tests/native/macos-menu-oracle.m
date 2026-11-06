// Independent Accessibility oracle for the macOS application menu bar (#239).
// It never links GPUI. `trusted` reports whether this process may use the
// Accessibility API. `dump <pid>` reads that process's menu bar as AppKit
// exposes it to assistive clients. `press <pid> <title>...` walks the menu
// bar by exact titles and performs AXPress on the last item, as VoiceOver
// would; it opens no menu and moves no pointer.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

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

static id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value)
        return nil;
    return CFBridgingRelease(value);
}

static NSArray *children(AXUIElementRef element) {
    id value = attribute(element, kAXChildrenAttribute);
    return [value isKindOfClass:[NSArray class]] ? value : @[];
}

static NSString *text(AXUIElementRef element, CFStringRef name) {
    id value = attribute(element, name);
    return [value isKindOfClass:[NSString class]] ? value : @"";
}

static id number(AXUIElementRef element, CFStringRef name) {
    id value = attribute(element, name);
    return [value isKindOfClass:[NSNumber class]] ? value : [NSNull null];
}

static AXUIElementRef menu_bar(pid_t pid) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"No accessibility element for the process");
    AXUIElementSetMessagingTimeout(application, 2.0);
    CFTypeRef bar = NULL;
    AXError error = AXUIElementCopyAttributeValue(application, kAXMenuBarAttribute, &bar);
    CFRelease(application);
    if (error != kAXErrorSuccess || !bar)
        fail([NSString stringWithFormat:@"The process exposes no menu bar (AXError %d)", (int)error]);
    return (AXUIElementRef)bar;
}

// One menu bar item or menu item and, through its AXMenu child, its items.
static NSDictionary *describe(AXUIElementRef element, int depth) {
    NSMutableArray *items = [NSMutableArray array];
    if (depth < 6) {
        for (id child in children(element)) {
            AXUIElementRef menu = (__bridge AXUIElementRef)child;
            if (![text(menu, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXMenuRole])
                continue;
            for (id entry in children(menu))
                [items addObject:describe((__bridge AXUIElementRef)entry, depth + 1)];
        }
    }
    return @{
        @"role" : text(element, kAXRoleAttribute),
        @"title" : text(element, kAXTitleAttribute),
        @"enabled" : number(element, kAXEnabledAttribute),
        @"mark" : text(element, kAXMenuItemMarkCharAttribute),
        @"key" : text(element, kAXMenuItemCmdCharAttribute),
        @"virtualKey" : number(element, kAXMenuItemCmdVirtualKeyAttribute),
        @"modifiers" : number(element, kAXMenuItemCmdModifiersAttribute),
        @"items" : items,
    };
}

// Returns a retained element: the caller releases it.
static AXUIElementRef find(AXUIElementRef element, NSString *title) {
    for (id child in children(element)) {
        AXUIElementRef candidate = (__bridge AXUIElementRef)child;
        if ([text(candidate, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXMenuRole]) {
            AXUIElementRef nested = find(candidate, title);
            if (nested) return nested;
        } else if ([text(candidate, kAXTitleAttribute) isEqualToString:title]) {
            return (AXUIElementRef)CFRetain(candidate);
        }
    }
    return NULL;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        if (argc < 3) fail(@"Usage: trusted | dump <pid> | press <pid> <title>...");
        if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
        pid_t pid = parse_pid(argv[2]);
        AXUIElementRef bar = menu_bar(pid);
        if (strcmp(argv[1], "dump") == 0 && argc == 3) {
            NSMutableArray *menus = [NSMutableArray array];
            for (id child in children(bar)) [menus addObject:describe((__bridge AXUIElementRef)child, 0)];
            CFRelease(bar);
            emit(menus);
            return 0;
        }
        if (strcmp(argv[1], "press") == 0 && argc >= 4) {
            AXUIElementRef element = (AXUIElementRef)CFRetain(bar);
            CFRelease(bar);
            for (int index = 3; index < argc; index++) {
                NSString *title = [NSString stringWithUTF8String:argv[index]];
                if (!title) fail(@"Menu titles must be UTF-8");
                AXUIElementRef next = find(element, title);
                CFRelease(element);
                if (!next) fail([NSString stringWithFormat:@"No menu entry titled %@", title]);
                element = next;
            }
            AXError error = AXUIElementPerformAction(element, kAXPressAction);
            CFRelease(element);
            if (error != kAXErrorSuccess)
                fail([NSString stringWithFormat:@"AXPress failed (AXError %d)", (int)error]);
            emit(@{@"pressed" : @(argc - 3)});
            return 0;
        }
        fail(@"Usage: trusted | dump <pid> | press <pid> <title>...");
    }
}
