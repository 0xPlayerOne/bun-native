// Independent Accessibility oracle for macOS OS context menus (#239).
// It never links GPUI. It finds the pop-up `AXMenu` a process is tracking by
// an item title, as VoiceOver sees it.
//   trusted                          whether this process may use Accessibility
//   find <pid> <title>               the open menu's entries (waits for it)
//   press <pid> <title>...           AXPress the entry reached by these titles
//   cancel <pid> <title>             AXCancel the open menu, as Escape does
//   absent <pid> <title>             succeed once no such menu is open (waits)
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

static BOOL has_role(AXUIElementRef element, CFStringRef role) {
    return [text(element, kAXRoleAttribute) isEqualToString:(__bridge NSString *)role];
}

// One menu entry and, through its AXMenu child, a submenu's entries.
static NSDictionary *describe(AXUIElementRef element, int depth) {
    NSMutableArray *items = [NSMutableArray array];
    if (depth < 6)
        for (id child in children(element)) {
            AXUIElementRef menu = (__bridge AXUIElementRef)child;
            if (!has_role(menu, kAXMenuRole)) continue;
            for (id entry in children(menu))
                [items addObject:describe((__bridge AXUIElementRef)entry, depth + 1)];
        }
    return @{
        @"title" : text(element, kAXTitleAttribute),
        @"enabled" : number(element, kAXEnabledAttribute),
        @"mark" : text(element, kAXMenuItemMarkCharAttribute),
        @"key" : text(element, kAXMenuItemCmdCharAttribute),
        @"modifiers" : number(element, kAXMenuItemCmdModifiersAttribute),
        @"items" : items,
    };
}

// The entry titled `title` directly in `menu`, or NULL. Not retained.
static id entry(AXUIElementRef menu, NSString *title) {
    for (id child in children(menu))
        if ([text((__bridge AXUIElementRef)child, kAXTitleAttribute) isEqualToString:title])
            return child;
    return nil;
}

// A pop-up AXMenu of the process with a top-level entry titled `title`.
static id search(AXUIElementRef element, NSString *title, int depth) {
    if (depth > 4) return nil;
    for (id child in children(element)) {
        AXUIElementRef node = (__bridge AXUIElementRef)child;
        if (has_role(node, kAXMenuBarRole)) continue;
        if (has_role(node, kAXMenuRole) && entry(node, title)) return child;
        id nested = search(node, title, depth + 1);
        if (nested) return nested;
    }
    return nil;
}

// The AXMenu above the application's focused element: a tracking menu
// focuses its highlighted item.
static id focused_menu(AXUIElementRef application, NSString *title) {
    id element = attribute(application, kAXFocusedUIElementAttribute);
    for (int depth = 0; element && depth < 6; depth++) {
        AXUIElementRef node = (__bridge AXUIElementRef)element;
        if (has_role(node, kAXMenuRole) && entry(node, title)) return element;
        element = attribute(node, kAXParentAttribute);
    }
    return nil;
}

// The AXMenu above `element`, if it has a top-level entry titled `title`.
static id menu_above(id element, NSString *title) {
    for (int depth = 0; element && depth < 6; depth++) {
        AXUIElementRef node = (__bridge AXUIElementRef)element;
        if (has_role(node, kAXMenuRole) && entry(node, title)) return element;
        element = attribute(node, kAXParentAttribute);
    }
    return nil;
}

// The pop-up menu windows of `pid` on screen, as CoreGraphics lists them
// (top-left origin, the same space as the Accessibility API).
static NSArray<NSValue *> *menu_windows(pid_t pid) {
    NSMutableArray *frames = [NSMutableArray array];
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    if (!list) return frames;
    for (NSDictionary *window in (__bridge NSArray *)list) {
        if ([window[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
        if ([window[(__bridge NSString *)kCGWindowLayer] intValue] != kCGPopUpMenuWindowLevel) continue;
        CGRect frame;
        if (!CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)window[(__bridge NSString *)kCGWindowBounds], &frame))
            continue;
        [frames addObject:[NSValue valueWithRect:NSRectFromCGRect(frame)]];
    }
    CFRelease(list);
    return frames;
}

// The menu under a point of each pop-up menu window, by hit-testing the
// Accessibility tree there: a tracking menu need not be a child of its
// application element.
static id hit_menu(pid_t pid, NSString *title) {
    AXUIElementRef system = AXUIElementCreateSystemWide();
    id found = nil;
    for (NSValue *value in menu_windows(pid)) {
        NSRect frame = value.rectValue;
        for (CGFloat offset = 8; offset < frame.size.height && !found; offset += 16) {
            AXUIElementRef hit = NULL;
            if (AXUIElementCopyElementAtPosition(system, (float)NSMidX(frame),
                                                 (float)(frame.origin.y + offset), &hit) == kAXErrorSuccess &&
                hit)
                found = menu_above(CFBridgingRelease(hit), title);
        }
        if (found) break;
    }
    CFRelease(system);
    return found;
}

static id find_menu(pid_t pid, NSString *title) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"No accessibility element for the process");
    AXUIElementSetMessagingTimeout(application, 2.0);
    id menu = search(application, title, 0);
    if (!menu) menu = focused_menu(application, title);
    CFRelease(application);
    if (!menu) menu = hit_menu(pid, title);
    return menu;
}

// Diagnostics: the process's accessibility tree as role:title, three deep.
static void tree(AXUIElementRef element, int depth, NSMutableArray *into) {
    if (depth > 3) return;
    for (id child in children(element)) {
        AXUIElementRef node = (__bridge AXUIElementRef)child;
        [into addObject:[NSString stringWithFormat:@"%d:%@:%@", depth, text(node, kAXRoleAttribute),
                                                   text(node, kAXTitleAttribute)]];
        tree(node, depth + 1, into);
    }
}

static NSString *describe_process(pid_t pid) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) return @"no application element";
    AXUIElementSetMessagingTimeout(application, 2.0);
    NSMutableArray *lines = [NSMutableArray array];
    tree(application, 0, lines);
    id focused = attribute(application, kAXFocusedUIElementAttribute);
    [lines addObject:[NSString stringWithFormat:@"menu windows:%lu", (unsigned long)menu_windows(pid).count]];
    if (focused)
        [lines addObject:[NSString stringWithFormat:@"focused:%@:%@",
                                                    text((__bridge AXUIElementRef)focused, kAXRoleAttribute),
                                                    text((__bridge AXUIElementRef)focused, kAXTitleAttribute)]];
    CFRelease(application);
    return [lines componentsJoinedByString:@" | "];
}

static id wait_for_menu(pid_t pid, NSString *title) {
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
    id menu;
    while (!(menu = find_menu(pid, title))) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            fail([NSString stringWithFormat:@"No open menu has an entry %@; tree: %@", title,
                                            describe_process(pid)]);
        [NSThread sleepForTimeInterval:0.025];
    }
    return menu;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        NSString *usage = @"Usage: trusted | find|cancel|absent <pid> <title> | press <pid> <title>...";
        if (argc < 4) fail(usage);
        if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
        const char *command = argv[1];
        pid_t pid = parse_pid(argv[2]);
        NSString *title = utf8(argv[3]);
        if (strcmp(command, "absent") == 0 && argc == 4) {
            NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
            while (find_menu(pid, title)) {
                if (NSProcessInfo.processInfo.systemUptime >= deadline)
                    fail([NSString stringWithFormat:@"A menu with %@ is still open", title]);
                [NSThread sleepForTimeInterval:0.025];
            }
            emit(@{@"absent" : title});
            return 0;
        }
        id menu = wait_for_menu(pid, title);
        if (strcmp(command, "find") == 0 && argc == 4) {
            NSMutableArray *items = [NSMutableArray array];
            for (id child in children((__bridge AXUIElementRef)menu))
                [items addObject:describe((__bridge AXUIElementRef)child, 0)];
            emit(@{@"items" : items});
            return 0;
        }
        if (strcmp(command, "cancel") == 0 && argc == 4) {
            AXError error = AXUIElementPerformAction((__bridge AXUIElementRef)menu, kAXCancelAction);
            if (error != kAXErrorSuccess)
                fail([NSString stringWithFormat:@"AXCancel failed (AXError %d)", (int)error]);
            emit(@{@"cancelled" : title});
            return 0;
        }
        if (strcmp(command, "press") == 0) {
            id element = entry((__bridge AXUIElementRef)menu, title);
            for (int index = 4; index < argc && element; index++) {
                NSString *next = utf8(argv[index]);
                id found = nil;
                for (id child in children((__bridge AXUIElementRef)element))
                    if (has_role((__bridge AXUIElementRef)child, kAXMenuRole) &&
                        (found = entry((__bridge AXUIElementRef)child, next)))
                        break;
                element = found;
            }
            if (!element) fail(@"No menu entry at that path");
            AXError error = AXUIElementPerformAction((__bridge AXUIElementRef)element, kAXPressAction);
            if (error != kAXErrorSuccess)
                fail([NSString stringWithFormat:@"AXPress failed (AXError %d)", (int)error]);
            emit(@{@"pressed" : @(argc - 3)});
            return 0;
        }
        fail(usage);
    }
}
