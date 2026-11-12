// Independent Accessibility client for the macOS accessibility fixture (#241).
// It never links GPUI. `trusted` reports whether this process may use the
// Accessibility API. `dump <pid> <title>` prints the accessible subtree of that
// process's window, in pre-order, as VoiceOver reads it through AppKit: each
// element's role, names, value and range, enabled and focused states, whether
// AXFocused and AXValue report settable, orientation, modal state, selection
// and, for a text field, every character's AXBoundsForRange frame. AppKit
// reports both settable on every AccessKit element (hosted run 43110442504
// dumped a button with a settable AXValue and a disabled field with a settable
// AXFocused), so neither is a focusable or editable state.
// `act <pid> <title> <role> <name> <action> [args]` performs one request on the
// first element with that AX role whose title, description or string value is
// <name>: `press` (AXPress), `focus` (AXFocused), `request-focus` (AXFocused,
// printing the AXError rather than failing on it), `text S` (AXValue string),
// `number N` (AXValue number), `select LOCATION LENGTH` (AXSelectedTextRange,
// UTF-16), `increment` (AXIncrement) or `hit` (prints the element the process
// reports at the centre of the target's frame). `focused <pid>` prints the element that
// process reports as its AXFocusedUIElement, the attribute VoiceOver follows,
// with the application's AXFocusedWindow title and whether it is active.
// `watch <pid> <seconds>` registers an AXObserver on that process's
// application element for AXAnnouncementRequested, the notification AccessKit
// posts for a live region (accesskit_macos 0.26.3 src/event.rs) and VoiceOver
// speaks, prints {"ready":true} once registered and then one line per
// announcement with its AXAnnouncementKey text and AXPriorityKey level, until
// stdin closes or the bound elapses.
// It moves no pointer and sends no keys.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <signal.h>
#include <unistd.h>

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

// Each UTF-16 unit's screen frame in a text field, from AXBoundsForRange (the
// query VoiceOver uses to highlight characters); null when any is unavailable.
static id extents(AXUIElementRef element) {
    if (![text(element, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXTextFieldRole]) return [NSNull null];
    id value = attribute(element, kAXValueAttribute);
    if (![value isKindOfClass:[NSString class]] || [value length] > 64) return [NSNull null];
    NSMutableArray *boxes = [NSMutableArray array];
    for (NSUInteger index = 0; index < [value length]; index++) {
        CFRange range = {(CFIndex)index, 1};
        AXValueRef parameter = AXValueCreate((AXValueType)kAXValueCFRangeType, &range);
        if (!parameter) return [NSNull null];
        CFTypeRef bounds = NULL;
        AXError error = AXUIElementCopyParameterizedAttributeValue(
            element, kAXBoundsForRangeParameterizedAttribute, parameter, &bounds);
        CFRelease(parameter);
        CGRect rect = CGRectNull;
        BOOL ok = error == kAXErrorSuccess && bounds && CFGetTypeID(bounds) == AXValueGetTypeID() &&
                  AXValueGetValue((AXValueRef)bounds, kAXValueTypeCGRect, &rect);
        if (bounds) CFRelease(bounds);
        if (!ok) return [NSNull null];
        [boxes addObject:@[ @(rect.origin.x), @(rect.origin.y), @(rect.size.width), @(rect.size.height) ]];
    }
    return boxes;
}

// How many elements AXSelectedChildren names; null when the attribute is absent.
static id selected_children(AXUIElementRef element) {
    id value = attribute(element, kAXSelectedChildrenAttribute);
    return [value isKindOfClass:[NSArray class]] ? @([value count]) : [NSNull null];
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
            // Recorded only: AppKit reports it settable on every AccessKit node.
            @"focusSettable" : @(settable(element, kAXFocusedAttribute)),
            @"orientation" : scalar(element, kAXOrientationAttribute),
            @"modal" : scalar(element, kAXModalAttribute),
            @"extents" : extents(element),
            @"selection" : selected_range(element),
            // A list row's AXSelected, AXIndex and a list's AXSelectedChildren
            // (accessibility_lists_v1); null where the element has none.
            @"selected" : scalar(element, kAXSelectedAttribute),
            @"index" : scalar(element, kAXIndexAttribute),
            @"selectedChildren" : selected_children(element),
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

static volatile sig_atomic_t input_closed = 0;

// One AXAnnouncementRequested notification. The element is not queried: the
// announcing process may be busy, and the text and priority are in the info.
static void announced(AXObserverRef observer, AXUIElementRef element, CFStringRef notification,
                      CFDictionaryRef info, void *context) {
    (void)observer;
    (void)element;
    (void)context;
    NSDictionary *details = (__bridge NSDictionary *)info;
    id announcement = details[@"AXAnnouncementKey"];
    id priority = details[@"AXPriorityKey"];
    emit(@{
        @"notification" : (__bridge NSString *)notification,
        @"announcement" : [announcement isKindOfClass:[NSString class]] ? announcement : [NSNull null],
        @"priority" : [priority isKindOfClass:[NSNumber class]] ? priority : [NSNull null],
    });
}

static void watch(pid_t pid, double seconds) {
    if (!(seconds > 0 && seconds <= 600)) fail(@"The watch bound must be between 0 and 600 seconds");
    AXObserverRef observer = NULL;
    check(AXObserverCreateWithInfoCallback(pid, announced, &observer), @"AXObserverCreateWithInfoCallback");
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"No accessibility element for the process");
    // Registered on the application element, the observer receives the
    // notification from every element of the process, including the NSWindow
    // AccessKit posts it on.
    check(AXObserverAddNotification(observer, application, CFSTR("AXAnnouncementRequested"), NULL),
          @"AXObserverAddNotification(AXAnnouncementRequested)");
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), kCFRunLoopDefaultMode);
    [NSThread detachNewThreadWithBlock:^{
      char buffer[64];
      while (read(STDIN_FILENO, buffer, sizeof buffer) > 0) {
      }
      input_closed = 1;
    }];
    emit(@{@"ready" : @YES});
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!input_closed && [until timeIntervalSinceNow] > 0)
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), kCFRunLoopDefaultMode);
    AXObserverRemoveNotification(observer, application, CFSTR("AXAnnouncementRequested"));
    CFRelease(application);
    CFRelease(observer);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        NSString *usage = @"Usage: trusted | focused <pid> | watch <pid> <seconds> | dump <pid> <title> | act <pid> <title> <role> <name> <action> [args]";
        if (argc == 4 && strcmp(argv[1], "watch") == 0) {
            if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
            char *end = NULL;
            double seconds = strtod(argv[3], &end);
            if (!end || *end) fail(@"Invalid watch bound");
            watch(parse_pid(argv[2]), seconds);
            return 0;
        }
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
        if ([action isEqualToString:@"hit"] && argc == 7) {
            // The element the application reports at the centre of the target's
            // frame, the query VoiceOver's mouse and touch exploration use.
            CGPoint origin = CGPointZero;
            CGSize size = CGSizeZero;
            id position = attribute(target, kAXPositionAttribute);
            id extent = attribute(target, kAXSizeAttribute);
            if (!position || !extent || !AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, &origin) ||
                !AXValueGetValue((__bridge AXValueRef)extent, kAXValueTypeCGSize, &size))
                fail(@"The target has no frame");
            AXUIElementRef application = AXUIElementCreateApplication(parse_pid(argv[2]));
            if (!application) fail(@"No accessibility element for the process");
            AXUIElementSetMessagingTimeout(application, 2.0);
            float x = (float)(origin.x + size.width / 2), y = (float)(origin.y + size.height / 2);
            AXUIElementRef hit = NULL;
            AXError error = AXUIElementCopyElementAtPosition(application, x, y, &hit);
            CFRelease(application);
            check(error, @"AXUIElementCopyElementAtPosition");
            emit(@{
                @"x" : @(x),
                @"y" : @(y),
                @"role" : text(hit, kAXRoleAttribute),
                @"value" : scalar(hit, kAXValueAttribute),
            });
            CFRelease(hit);
            CFRelease(window);
            return 0;
        }
        if ([action isEqualToString:@"press"] && argc == 7) {
            check(AXUIElementPerformAction(target, kAXPressAction), @"AXPress");
        } else if ([action isEqualToString:@"increment"] && argc == 7) {
            check(AXUIElementPerformAction(target, kAXIncrementAction), @"AXIncrement");
        } else if ([action isEqualToString:@"focus"] && argc == 7) {
            check(AXUIElementSetAttributeValue(target, kAXFocusedAttribute, kCFBooleanTrue), @"AXFocused");
        } else if ([action isEqualToString:@"request-focus"] && argc == 7) {
            // The same request, reporting AppKit's answer instead of failing on
            // it: the caller judges the effect from the host's own focus events.
            AXError error = AXUIElementSetAttributeValue(target, kAXFocusedAttribute, kCFBooleanTrue);
            CFRelease(window);
            emit(@{@"role" : role, @"name" : name, @"action" : action, @"error" : @((int)error)});
            return 0;
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
