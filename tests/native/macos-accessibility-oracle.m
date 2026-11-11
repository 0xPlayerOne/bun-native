// Independent Accessibility client for the macOS accessibility fixture (#241).
// It never links GPUI. `trusted` reports whether this process may use the
// Accessibility API. `dump <pid> <title>` prints the accessible subtree of that
// process's window, in pre-order, as VoiceOver reads it through AppKit.
// `act <pid> <title> <role> <name> <action> [args]` performs one request on the
// first element with that AX role whose title, description or string value is
// <name>: `press` (AXPress), `focus` (AXFocused), `text S` (AXValue string),
// `number N` (AXValue number), `select LOCATION LENGTH` (AXSelectedTextRange,
// UTF-16) or `increment` (AXIncrement). `focused <pid>` prints the element that
// process reports as its AXFocusedUIElement, the attribute VoiceOver follows,
// with the application's AXFocusedWindow title and whether it is active.
// It moves no pointer and sends no keys.
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

static NSString *utf8(const char *value) {
    NSString *result = [NSString stringWithUTF8String:value];
    if (!result) fail(@"Arguments must be UTF-8");
    return result;
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

static id scalar(AXUIElementRef element, CFStringRef name) {
    id value = attribute(element, name);
    if ([value isKindOfClass:[NSString class]] || [value isKindOfClass:[NSNumber class]]) return value;
    return [NSNull null];
}

static BOOL settable(AXUIElementRef element, CFStringRef name) {
    Boolean result = false;
    return AXUIElementIsAttributeSettable(element, name, &result) == kAXErrorSuccess && result;
}

static id selected_range(AXUIElementRef element) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute, &value) != kAXErrorSuccess ||
        !value)
        return [NSNull null];
    CFRange range = {0, 0};
    BOOL ok = CFGetTypeID(value) == AXValueGetTypeID() &&
              AXValueGetValue((AXValueRef)value, (AXValueType)kAXValueCFRangeType, &range);
    CFRelease(value);
    return ok ? @[ @(range.location), @(range.length) ] : [NSNull null];
}

static NSArray *actions(AXUIElementRef element) {
    CFArrayRef names = NULL;
    if (AXUIElementCopyActionNames(element, &names) != kAXErrorSuccess || !names) return @[];
    return CFBridgingRelease(names);
}

static AXUIElementRef window_titled(pid_t pid, NSString *title) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"No accessibility element for the process");
    AXUIElementSetMessagingTimeout(application, 2.0);
    AXUIElementRef found = NULL;
    for (id candidate in (NSArray *)(attribute(application, kAXWindowsAttribute) ?: @[])) {
        AXUIElementRef window = (__bridge AXUIElementRef)candidate;
        if ([text(window, kAXTitleAttribute) isEqualToString:title]) {
            found = (AXUIElementRef)CFRetain(window);
            break;
        }
    }
    CFRelease(application);
    if (!found) fail([NSString stringWithFormat:@"No accessible window titled %@", title]);
    return found;
}

static void walk(AXUIElementRef element, int depth, NSMutableArray *entries, NSMutableArray *elements) {
    if (depth > 32 || entries.count > 512) fail(@"The accessible tree exceeds the bounded fixture size");
    if (depth > 0) {
        [entries addObject:@{
            @"role" : text(element, kAXRoleAttribute),
            @"subrole" : text(element, kAXSubroleAttribute),
            @"title" : text(element, kAXTitleAttribute),
            @"description" : text(element, kAXDescriptionAttribute),
            @"value" : scalar(element, kAXValueAttribute),
            @"minimum" : scalar(element, kAXMinValueAttribute),
            @"maximum" : scalar(element, kAXMaxValueAttribute),
            @"enabled" : scalar(element, kAXEnabledAttribute),
            @"focused" : scalar(element, kAXFocusedAttribute),
            @"valueSettable" : @(settable(element, kAXValueAttribute)),
            @"selection" : selected_range(element),
            @"actions" : actions(element),
            @"depth" : @(depth),
        }];
        [elements addObject:(__bridge id)element];
    }
    for (id child in children(element)) walk((__bridge AXUIElementRef)child, depth + 1, entries, elements);
}

static BOOL named(NSDictionary *entry, NSString *name) {
    return [entry[@"title"] isEqual:name] || [entry[@"description"] isEqual:name] ||
           [entry[@"value"] isEqual:name];
}

static void check(AXError error, NSString *what) {
    if (error != kAXErrorSuccess) fail([NSString stringWithFormat:@"%@ failed (AXError %d)", what, (int)error]);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        NSString *usage = @"Usage: trusted | focused <pid> | dump <pid> <title> | act <pid> <title> <role> <name> <action> [args]";
        if (argc == 3 && strcmp(argv[1], "focused") == 0) {
            if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
            pid_t pid = parse_pid(argv[2]);
            AXUIElementRef application = AXUIElementCreateApplication(pid);
            if (!application) fail(@"No accessibility element for the process");
            AXUIElementSetMessagingTimeout(application, 2.0);
            id window = attribute(application, kAXFocusedWindowAttribute);
            id element = attribute(application, kAXFocusedUIElementAttribute);
            NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            NSMutableDictionary *report = [NSMutableDictionary dictionary];
            report[@"active"] = @(running.active);
            report[@"window"] = window ? text((__bridge AXUIElementRef)window, kAXTitleAttribute) : [NSNull null];
            if (element) {
                AXUIElementRef focused = (__bridge AXUIElementRef)element;
                report[@"element"] = @{
                    @"role" : text(focused, kAXRoleAttribute),
                    @"title" : text(focused, kAXTitleAttribute),
                    @"description" : text(focused, kAXDescriptionAttribute),
                    @"value" : scalar(focused, kAXValueAttribute),
                };
            } else {
                report[@"element"] = [NSNull null];
            }
            CFRelease(application);
            emit(report);
            return 0;
        }
        if (argc < 4) fail(usage);
        if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
        AXUIElementRef window = window_titled(parse_pid(argv[2]), utf8(argv[3]));
        NSMutableArray *entries = [NSMutableArray array];
        NSMutableArray *elements = [NSMutableArray array];
        walk(window, 0, entries, elements);
        if (strcmp(argv[1], "dump") == 0 && argc == 4) {
            emit(entries);
            CFRelease(window);
            return 0;
        }
        if (strcmp(argv[1], "act") != 0 || argc < 7) fail(usage);
        NSString *role = utf8(argv[4]);
        NSString *name = utf8(argv[5]);
        NSString *action = utf8(argv[6]);
        AXUIElementRef target = NULL;
        for (NSUInteger index = 0; index < entries.count; index++) {
            if ([entries[index][@"role"] isEqualToString:role] && named(entries[index], name)) {
                target = (__bridge AXUIElementRef)elements[index];
                break;
            }
        }
        if (!target) fail([NSString stringWithFormat:@"No %@ named %@", role, name]);
        if ([action isEqualToString:@"press"] && argc == 7) {
            check(AXUIElementPerformAction(target, kAXPressAction), @"AXPress");
        } else if ([action isEqualToString:@"increment"] && argc == 7) {
            check(AXUIElementPerformAction(target, kAXIncrementAction), @"AXIncrement");
        } else if ([action isEqualToString:@"focus"] && argc == 7) {
            check(AXUIElementSetAttributeValue(target, kAXFocusedAttribute, kCFBooleanTrue), @"AXFocused");
        } else if ([action isEqualToString:@"text"] && argc == 8) {
            check(AXUIElementSetAttributeValue(target, kAXValueAttribute, (__bridge CFStringRef)utf8(argv[7])),
                  @"AXValue text");
        } else if ([action isEqualToString:@"number"] && argc == 8) {
            NSNumber *number = @(strtod(argv[7], NULL));
            check(AXUIElementSetAttributeValue(target, kAXValueAttribute, (__bridge CFNumberRef)number),
                  @"AXValue number");
        } else if ([action isEqualToString:@"select"] && argc == 9) {
            CFRange range = {strtol(argv[7], NULL, 10), strtol(argv[8], NULL, 10)};
            AXValueRef value = AXValueCreate((AXValueType)kAXValueCFRangeType, &range);
            AXError error = AXUIElementSetAttributeValue(target, kAXSelectedTextRangeAttribute, value);
            CFRelease(value);
            check(error, @"AXSelectedTextRange");
        } else {
            fail(usage);
        }
        CFRelease(window);
        emit(@{@"role" : role, @"name" : name, @"action" : action, @"done" : @YES});
        return 0;
    }
}
