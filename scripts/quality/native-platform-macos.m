// Thin SDK-typed test helper. It addresses only the launched app's direct child
// after checking libproc creation identity, image path and Quartz window owner.
// Compile with: xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit
//   -framework CoreGraphics -framework ApplicationServices native-platform-macos.m -o native-platform-macos
// API contracts: developer.apple.com/documentation/coregraphics/quartz-window-services
// and the target SDK's libproc.h / sys/proc_info.h. No handwritten ABI layouts.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <libproc.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

static void fail(NSString *reason) {
    @throw [NSException exceptionWithName:@"Failed" reason:reason userInfo:nil];
}

static void unavailable(NSString *reason) {
    @throw [NSException exceptionWithName:@"Unsupported" reason:reason userInfo:nil];
}

static BOOL number(id value) {
    return [value isKindOfClass:NSNumber.class]
        && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
        && isfinite([value doubleValue]);
}

static pid_t process_id(id value) {
    if (!number(value) || [value doubleValue] < 1 || [value doubleValue] > INT_MAX
        || floor([value doubleValue]) != [value doubleValue]) fail(@"Invalid owned process ID");
    return [value intValue];
}

static NSDictionary *process(pid_t pid) {
    struct proc_bsdinfo info = {0};
    char image[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)
        || info.pbi_pid != (uint32_t)pid || info.pbi_uid != getuid()
        || proc_pidpath(pid, image, sizeof(image)) <= 0) return nil;
    NSString *path = [[NSFileManager defaultManager]
        stringWithFileSystemRepresentation:image length:strlen(image)];
    if (!path) fail(@"Owned process path is not representable");
    return @{@"pid": @(pid), @"parent": @(info.pbi_ppid), @"image": path,
        @"created": [NSString stringWithFormat:@"%llu:%llu",
            (unsigned long long)info.pbi_start_tvsec,
            (unsigned long long)info.pbi_start_tvusec]};
}

static NSDictionary *snapshot(NSDictionary *request) {
    pid_t root = process_id(request[@"app_pid"]);
    NSString *hostPath = request[@"host"];
    NSString *title = request[@"title"];
    if (![hostPath isKindOfClass:NSString.class] || !hostPath.isAbsolutePath
        || ![title isKindOfClass:NSString.class] || !title.length || title.length > 256)
        fail(@"An absolute host executable and bounded title are required");
    hostPath = hostPath.stringByResolvingSymlinksInPath;
    NSDictionary *app = process(root);
    if (!app) fail(@"Owned application process identity is unavailable");
    pid_t children[256] = {0};
    int count = proc_listchildpids(root, children, sizeof(children));
    if (count < 0 || count >= 256) fail(@"Owned child enumeration failed or exceeded its bound");
    NSDictionary *host = nil;
    for (int i = 0; i < count; i++) {
        if (children[i] <= 0) continue;
        NSDictionary *candidate = process(children[i]);
        if ([candidate[@"parent"] intValue] == root
            && [[candidate[@"image"] stringByResolvingSymlinksInPath] isEqualToString:hostPath]) {
            if (host) fail(@"Multiple native children match the expected executable");
            host = candidate;
        }
    }
    if (!host) return @{@"status": @"not-ready", @"reason": @"No matching native child yet"};
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID));
    if (!windows) unavailable(@"The current user session has no accessible WindowServer");
    NSDictionary *window = nil;
    for (NSDictionary *candidate in windows) {
        if ([candidate[(__bridge NSString *)kCGWindowOwnerPID] intValue] != [host[@"pid"] intValue]
            || [candidate[(__bridge NSString *)kCGWindowLayer] intValue] != 0
            || [candidate[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0) continue;
        NSString *name = candidate[(__bridge NSString *)kCGWindowName];
        if (name.length && ![name isEqualToString:title]) continue;
        CGRect bounds = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)
                candidate[(__bridge NSString *)kCGWindowBounds], &bounds)
            || !isfinite(bounds.origin.x) || !isfinite(bounds.origin.y)
            || !isfinite(bounds.size.width) || !isfinite(bounds.size.height)
            || bounds.size.width <= 0 || bounds.size.width > 32768
            || bounds.size.height <= 0 || bounds.size.height > 32768)
            fail(@"Owned Quartz window bounds are invalid");
        if (window) fail(@"Multiple visible native windows match the owned fixture");
        // AppKit's own content rectangle for a standard titled window of this
        // frame on this OS: an independent check of the GPUI viewport.
        NSRect content = [NSWindow contentRectForFrameRect:NSMakeRect(0, 0, bounds.size.width, bounds.size.height)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable];
        window = @{@"id": candidate[(__bridge NSString *)kCGWindowNumber],
            @"title": name ?: NSNull.null, @"titleVerified": @(name.length > 0),
            @"visible": @YES, @"frame": @[@(bounds.origin.x), @(bounds.origin.y),
                @(bounds.size.width), @(bounds.size.height)],
            @"titledContentSize": @[@(content.size.width), @(content.size.height)]};
    }
    if (!window) return @{@"status": @"not-ready", @"reason": @"No owned onscreen native window yet"};
    if (![process(root) isEqualToDictionary:app]
        || ![process([host[@"pid"] intValue]) isEqualToDictionary:host])
        fail(@"Owned process identity changed during window enumeration");
    return @{@"status": @"ready", @"method": @"libproc + creation identity + Quartz onscreen window enumeration",
        @"application": app, @"host": host, @"window": window,
        @"postEventAccess": @(CGPreflightPostEventAccess()),
        @"frontmostPID": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)};
}

static void verify(NSDictionary *expected, NSDictionary *actual) {
    if (![actual[@"status"] isEqualToString:@"ready"])
        fail(@"Owned native window is no longer ready before input");
    if (![actual[@"application"] isEqual:expected[@"application"]])
        fail(@"Owned application process identity changed before input");
    if (![actual[@"host"] isEqual:expected[@"host"]])
        fail(@"Owned native process identity changed before input");
    if (![actual[@"window"] isEqual:expected[@"window"]]) {
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:actual[@"window"] options:0 error:NULL];
        NSString *details = encoded ? [[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding] : nil;
        fail([@"Owned native window metadata/geometry changed before input; current window: "
            stringByAppendingString:details ?: @"unavailable"]);
    }
}

static void foreground(NSDictionary *request, NSDictionary *state) {
    if (![state[@"postEventAccess"] boolValue])
        unavailable(@"CoreGraphics event posting permission is unavailable; no permission was requested");
    pid_t pid = [state[@"host"][@"pid"] intValue];
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    [app activateWithOptions:NSApplicationActivateAllWindows];
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 1;
    while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            unavailable(@"The owned native application cannot become foreground");
        [NSThread sleepForTimeInterval:0.01];
    }
    verify(state, snapshot(request));
    CGEventFlags held = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    if (held & (kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate
                | kCGEventFlagMaskCommand | kCGEventFlagMaskAlphaShift))
        unavailable([NSString
            stringWithFormat:@"An external modifier is active; no input was injected (flags 0x%llx)",
                             (unsigned long long)held]);
    if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))
        unavailable(@"An external pointer button is held; no input was injected");
}

static void require_foreground(pid_t pid) {
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)
        fail(@"Native foreground changed before input");
}

// AppKit's documented mouse-down hit test, unlike rectangle intersection,
// excludes click-through windows and pixels transparent to mouse events.
// https://developer.apple.com/documentation/appkit/nswindow/windownumber(at:belowwindowwithwindownumber:)
static NSPoint appkit_pointer_point(CGPoint point, CGRect primaryDisplay) {
    if (!isfinite(point.x) || !isfinite(point.y)
        || !isfinite(primaryDisplay.size.width) || !isfinite(primaryDisplay.size.height)
        || primaryDisplay.origin.x != 0 || primaryDisplay.origin.y != 0
        || primaryDisplay.size.width <= 0 || primaryDisplay.size.height <= 0
        || primaryDisplay.size.width > 32768 || primaryDisplay.size.height > 32768)
        fail(@"Invalid primary-display coordinate conversion");
    // Both systems use global logical coordinates. Quartz's primary origin is
    // top-left; AppKit's is bottom-left. Negative secondary-screen points remain valid.
    return NSMakePoint(point.x, primaryDisplay.size.height - point.y);
}

static CGRect pointer_window_bounds(NSDictionary *candidate) {
    if (![candidate isKindOfClass:NSDictionary.class]) fail(@"Invalid WindowServer target record");
    id identifier = candidate[(__bridge NSString *)kCGWindowNumber];
    id owner = candidate[(__bridge NSString *)kCGWindowOwnerPID];
    id layer = candidate[(__bridge NSString *)kCGWindowLayer];
    if (!number(identifier) || [identifier doubleValue] < 1
        || [identifier doubleValue] > UINT32_MAX || floor([identifier doubleValue]) != [identifier doubleValue]
        || !number(owner) || [owner doubleValue] < 1 || [owner doubleValue] > INT_MAX
        || floor([owner doubleValue]) != [owner doubleValue]
        || !number(layer) || [layer doubleValue] < INT_MIN || [layer doubleValue] > INT_MAX
        || floor([layer doubleValue]) != [layer doubleValue])
        fail(@"WindowServer target identity metadata is invalid");
    id alpha = candidate[(__bridge NSString *)kCGWindowAlpha];
    if (!number(alpha) || [alpha doubleValue] < 0 || [alpha doubleValue] > 1)
        fail(@"WindowServer opacity is invalid");
    id value = candidate[(__bridge NSString *)kCGWindowBounds];
    CGRect bounds = CGRectZero;
    if (![value isKindOfClass:NSDictionary.class]
        || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value, &bounds)
        || !isfinite(bounds.origin.x) || !isfinite(bounds.origin.y)
        || !isfinite(bounds.size.width) || !isfinite(bounds.size.height)
        || bounds.size.width < 0 || bounds.size.height < 0
        || bounds.size.width > 32768 || bounds.size.height > 32768)
        fail(@"WindowServer target bounds are invalid");
    return bounds;
}

static NSString *pointer_rejection(NSDictionary *state, NSDictionary *candidate,
    CGRect bounds, CGPoint point) {
    // Only numeric hit-target metadata is retained, never other titles or contents.
    NSDictionary *details = @{@"expectedWindow": state[@"window"][@"id"],
        @"expectedPID": state[@"host"][@"pid"], @"screenPoint": @[@(point.x), @(point.y)],
        @"hitWindow": candidate[(__bridge NSString *)kCGWindowNumber],
        @"hitPID": candidate[(__bridge NSString *)kCGWindowOwnerPID],
        @"layer": candidate[(__bridge NSString *)kCGWindowLayer],
        @"alpha": candidate[(__bridge NSString *)kCGWindowAlpha],
        @"frame": @[@(bounds.origin.x), @(bounds.origin.y), @(bounds.size.width), @(bounds.size.height)]};
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:details options:0 error:NULL];
    if (!encoded || encoded.length > 1024) fail(@"WindowServer target diagnostics exceed their bound");
    return [@"AppKit mouse-down target is not the owned window; no input was posted; target details: "
        stringByAppendingString:[[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding]];
}

static void verify_pointer_target(NSDictionary *state, NSArray *windows, CGPoint point,
    NSInteger hitWindow) {
    if (![windows isKindOfClass:NSArray.class] || windows.count > 4096
        || !isfinite(point.x) || !isfinite(point.y)) fail(@"Invalid bounded WindowServer target list");
    if (hitWindow <= 0 || (uint64_t)hitWindow > UINT32_MAX)
        unavailable(@"AppKit did not resolve a mouse-down target; no input was posted");
    NSDictionary *target = nil;
    CGRect targetBounds = CGRectZero;
    for (NSDictionary *candidate in windows) {
        CGRect bounds = pointer_window_bounds(candidate);
        if ([candidate[(__bridge NSString *)kCGWindowNumber] unsignedLongLongValue] != (uint64_t)hitWindow)
            continue;
        if (target) fail(@"Duplicate WindowServer hit-target metadata");
        target = candidate;
        targetBounds = bounds;
    }
    if (!target) unavailable(@"AppKit's hit target is absent from current onscreen metadata; no input was posted");
    if ([target[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0
        || !CGRectContainsPoint(targetBounds, point))
        fail(@"AppKit hit target contradicts its current WindowServer geometry");
    if (![target[(__bridge NSString *)kCGWindowNumber] isEqual:state[@"window"][@"id"]]
        || ![target[(__bridge NSString *)kCGWindowOwnerPID] isEqual:state[@"host"][@"pid"]])
        unavailable(pointer_rejection(state, target, targetBounds, point));
}

static void require_pointer_target(NSDictionary *state, CGPoint point) {
    // The controller is not an AppKit application. Without initialization,
    // NSWindow's cross-process mouse-down query returns zero even for an
    // independently visible, input-taking window. No activation is requested.
    [NSApplication sharedApplication];
    NSPoint appkitPoint = appkit_pointer_point(point, CGDisplayBounds(CGMainDisplayID()));
    NSInteger hitWindow = [NSWindow windowNumberAtPoint:appkitPoint belowWindowWithWindowNumber:0];
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    if (!windows) unavailable(@"The current GUI session cannot resolve the pointer target");
    verify_pointer_target(state, windows, point, hitWindow);
}

static void post_modifier(CGKeyCode code, CGEventFlags flags, bool down) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
    if (!event) fail(@"Cannot allocate a bounded CoreGraphics modifier event");
    CGEventSetType(event, kCGEventFlagsChanged);
    CGEventSetFlags(event, flags);
    CGEventPost(kCGSessionEventTap, event);
    CFRelease(event);
}

static void key_with(pid_t pid, CGKeyCode code, CGEventFlags flags, UniChar character) {
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        fail(@"Cannot allocate bounded CoreGraphics keyboard events");
    }
    // The public session stream performs ordinary WindowServer/AppKit routing.
    // Check the owned foreground before each down/up pair, not just the text run.
    @try { require_foreground(pid); }
    @catch (NSException *error) {
        CFRelease(up);
        CFRelease(down);
        @throw error;
    }
    // Flags on a key event alone leave the session's modifier state held after
    // the key-up, so press and release each modifier key around the chord, as
    // a physical keyboard does (kVK_Control, kVK_Option, kVK_Shift, kVK_Command).
    static const struct { CGEventFlags mask; CGKeyCode code; } modifiers[] = {
        {kCGEventFlagMaskControl, 59}, {kCGEventFlagMaskAlternate, 58},
        {kCGEventFlagMaskShift, 56}, {kCGEventFlagMaskCommand, 55}};
    const int count = (int)(sizeof modifiers / sizeof modifiers[0]);
    CGEventFlags held = 0;
    for (int i = 0; i < count; i++) {
        if (!(flags & modifiers[i].mask)) continue;
        held |= modifiers[i].mask;
        post_modifier(modifiers[i].code, held, true);
    }
    for (int i = 0; i < 2; i++) {
        CGEventRef event = i == 0 ? down : up;
        CGEventSetFlags(event, flags);
        if (character) CGEventKeyboardSetUnicodeString(event, 1, &character);
        CGEventPost(kCGSessionEventTap, event);
    }
    for (int i = count - 1; i >= 0; i--) {
        if (!(flags & modifiers[i].mask)) continue;
        held &= ~modifiers[i].mask;
        post_modifier(modifiers[i].code, held, false);
    }
    CFRelease(up);
    CFRelease(down);
}

static void key(pid_t pid, CGKeyCode code, UniChar character) {
    key_with(pid, code, 0, character);
}

// Named keys use ANSI virtual key codes (HIToolbox Events.h); the active
// keyboard layout supplies the characters, as for a physical key press.
static CGKeyCode named_key(NSString *name) {
    // GPUI names a printable key from its virtual key code through the active
    // layout (gpui_macos events.rs parse_keystroke), so every letter has its own
    // ANSI code rather than a Unicode string on key code 0.
    NSDictionary *codes = @{@"Return": @36, @"Escape": @53, @"BackSpace": @51, @"Delete": @117,
        @"Tab": @48, @"space": @49, @"Left": @123, @"Right": @124, @"Down": @125, @"Up": @126,
        @"Home": @115, @"End": @119,
        @"a": @0, @"s": @1, @"d": @2, @"f": @3, @"h": @4, @"g": @5, @"z": @6, @"x": @7,
        @"c": @8, @"v": @9, @"b": @11, @"q": @12, @"w": @13, @"e": @14, @"r": @15, @"y": @16,
        @"t": @17, @"o": @31, @"u": @32, @"i": @34, @"p": @35, @"l": @37, @"j": @38, @"k": @40,
        @"n": @45, @"m": @46};
    NSNumber *code = [name isKindOfClass:NSString.class] ? codes[name] : nil;
    if (!code) fail(@"Unknown bounded key name");
    return (CGKeyCode)code.unsignedShortValue;
}

static CGEventFlags modifier_flags(id modifiers) {
    if (!modifiers) return 0;
    if (![modifiers isKindOfClass:NSArray.class] || [modifiers count] > 4) fail(@"Invalid bounded key modifiers");
    NSDictionary *masks = @{@"control": @(kCGEventFlagMaskControl), @"shift": @(kCGEventFlagMaskShift),
        @"option": @(kCGEventFlagMaskAlternate), @"command": @(kCGEventFlagMaskCommand)};
    CGEventFlags flags = 0;
    for (id modifier in modifiers) {
        NSNumber *mask = [modifier isKindOfClass:NSString.class] ? masks[modifier] : nil;
        if (!mask || (flags & mask.unsignedLongLongValue)) fail(@"Unknown or repeated key modifier");
        flags |= mask.unsignedLongLongValue;
    }
    return flags;
}

static void pause_ms(id value) {
    if (!value) return;
    if (!number(value) || [value doubleValue] < 0 || [value doubleValue] > 100) fail(@"Invalid bounded input delay");
    [NSThread sleepForTimeInterval:[value doubleValue] / 1000];
}

static NSArray *pointer_events(CGPoint point) {
    // CGEventCreateMouseEvent accepts global Quartz coordinates. Session posting
    // leaves native target selection to WindowServer after an exact target check.
    CGEventType types[] = {kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp};
    NSMutableArray *events = [NSMutableArray arrayWithCapacity:3];
    for (int i = 0; i < 3; i++) {
        CGEventRef event = CGEventCreateMouseEvent(NULL, types[i], point, kCGMouseButtonLeft);
        if (!event) fail(@"Cannot allocate bounded CoreGraphics pointer events");
        id owned = CFBridgingRelease(event);
        CGEventSetFlags(event, 0);
        CGEventSetIntegerValueField(event, kCGMouseEventClickState, i ? 1 : 0);
        if (CGEventGetType(event) != types[i] || !CGPointEqualToPoint(CGEventGetLocation(event), point)
            || CGEventGetFlags(event) != 0
            || CGEventGetIntegerValueField(event, kCGMouseEventClickState) != (i ? 1 : 0))
            fail(@"CoreGraphics pointer construction did not retain its exact type and global position");
        [events addObject:owned];
    }
    return events;
}

// The same viewport-in-frame bound the click uses: GPUI's measured viewport
// sits centered horizontally and at the bottom of the observed Quartz frame.
static CGPoint content_point(NSDictionary *request, NSDictionary *state) {
    NSArray *viewport = request[@"viewport"];
    if (![viewport isKindOfClass:NSArray.class] || viewport.count != 2
        || !number(viewport[0]) || !number(viewport[1])
        || !number(request[@"x"]) || !number(request[@"y"])) fail(@"Invalid bounded pointer geometry");
    double width = [viewport[0] doubleValue], height = [viewport[1] doubleValue];
    double x = [request[@"x"] doubleValue], y = [request[@"y"] doubleValue];
    NSArray *frame = state[@"window"][@"frame"];
    double side = ([frame[2] doubleValue] - width) / 2;
    double top = [frame[3] doubleValue] - height - side;
    if (width <= 0 || height <= 0 || x < 0 || x >= width || y < 0 || y >= height
        || side < 0 || side > 16 || top < 0 || top > 96)
        fail(@"GPUI viewport cannot be bounded within the owned Quartz frame");
    return CGPointMake([frame[0] doubleValue] + side + x, [frame[1] doubleValue] + top + y);
}

// The one accessibility window of the owned host whose position and size are
// the observed Quartz frame. Both use global top-left logical coordinates.
static AXUIElementRef owned_ax_window(pid_t pid, NSDictionary *state) {
    if (!AXIsProcessTrusted())
        unavailable(@"Accessibility control is not granted to this process; no permission was requested");
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"Cannot address the owned native application");
    id ownedApplication = CFBridgingRelease(application);
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)ownedApplication, kAXWindowsAttribute, &value)
            != kAXErrorSuccess || !value)
        unavailable(@"The owned native application exposes no accessible windows");
    NSArray *windows = CFBridgingRelease(value);
    if (![windows isKindOfClass:NSArray.class] || windows.count > 64) fail(@"Invalid bounded accessibility window list");
    NSArray *frame = state[@"window"][@"frame"];
    AXUIElementRef match = NULL;
    for (id candidate in windows) {
        CFTypeRef position = NULL, size = NULL;
        CGPoint origin = CGPointZero;
        CGSize extent = CGSizeZero;
        AXError positionError = AXUIElementCopyAttributeValue((__bridge AXUIElementRef)candidate, kAXPositionAttribute, &position);
        AXError sizeError = AXUIElementCopyAttributeValue((__bridge AXUIElementRef)candidate, kAXSizeAttribute, &size);
        id ownedPosition = position ? CFBridgingRelease(position) : nil;
        id ownedSize = size ? CFBridgingRelease(size) : nil;
        if (positionError != kAXErrorSuccess || sizeError != kAXErrorSuccess || !ownedPosition || !ownedSize
            || !AXValueGetValue((__bridge AXValueRef)ownedPosition, kAXValueTypeCGPoint, &origin)
            || !AXValueGetValue((__bridge AXValueRef)ownedSize, kAXValueTypeCGSize, &extent)) continue;
        if (fabs(origin.x - [frame[0] doubleValue]) >= 1 || fabs(origin.y - [frame[1] doubleValue]) >= 1
            || fabs(extent.width - [frame[2] doubleValue]) >= 1 || fabs(extent.height - [frame[3] doubleValue]) >= 1)
            continue;
        if (match) fail(@"Multiple accessible windows match the owned Quartz frame");
        match = (__bridge AXUIElementRef)candidate;
    }
    if (!match) unavailable(@"No accessible window matches the owned Quartz frame");
    return (AXUIElementRef)CFRetain(match);
}

// A listen-only tap on the owned process sees the wheel events WindowServer
// actually routes to it, independent of what GPUI does with them.
static CGEventRef record_delivered_wheel(CGEventTapProxy proxy, CGEventType type, CGEventRef event,
                                         void *refcon) {
    (void)proxy;
    if (type == kCGEventScrollWheel)
        [(__bridge NSMutableArray *)refcon
            addObject:@(CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1))];
    return event;
}

static NSDictionary *input(NSDictionary *request, NSDictionary *state) {
    NSDictionary *expected = request[@"expected"];
    if (![expected isKindOfClass:NSDictionary.class]) fail(@"A previously observed identity is required");
    verify(expected, state);
    foreground(request, state);
    pid_t pid = [state[@"host"][@"pid"] intValue];
    NSString *action = request[@"action"];
    NSUInteger events = 0;
    NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:state];
    if ([action isEqualToString:@"activate"]) {
        events = 0;
    } else if ([action isEqualToString:@"tab"]) {
        key(pid, 48, 0);
        events = 2;
    } else if ([action isEqualToString:@"text"]) {
        NSString *text = request[@"text"];
        if (![text isKindOfClass:NSString.class] || !text.length || text.length > 64
            || [text rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location != NSNotFound)
            fail(@"OS text injection accepts only a bounded hexadecimal run nonce");
        for (NSUInteger i = 0; i < text.length; i++) key(pid, 0, [text characterAtIndex:i]);
        events = text.length * 2;
    } else if ([action isEqualToString:@"key"]) {
        CGKeyCode code = named_key(request[@"key"]);
        CGEventFlags flags = modifier_flags(request[@"modifiers"]);
        key_with(pid, code, flags, 0);
        events = 2 + 2 * (NSUInteger)__builtin_popcountll(flags);
    } else if ([action isEqualToString:@"keys"]) {
        // A bounded sequence of named key chords, each checked for the owned
        // foreground immediately before it is posted.
        NSArray *sequence = request[@"keys"];
        if (![sequence isKindOfClass:NSArray.class] || !sequence.count || sequence.count > 64)
            fail(@"A bounded key sequence is required");
        for (NSUInteger i = 0; i < sequence.count; i++) {
            NSDictionary *chord = sequence[i];
            if (![chord isKindOfClass:NSDictionary.class]) fail(@"Invalid bounded key chord");
            CGKeyCode code = named_key(chord[@"key"]);
            CGEventFlags flags = modifier_flags(chord[@"modifiers"]);
            if (i) pause_ms(request[@"delayMs"]);
            key_with(pid, code, flags, 0);
            events += 2 + 2 * (NSUInteger)__builtin_popcountll(flags);
        }
    } else if ([action isEqualToString:@"drag"]) {
        // One left-button drag: press at the first viewport point, dragged
        // moves through the rest, an optional hold, then release at the last.
        // Every point must hit the owned window before its event is posted.
        NSArray *path = request[@"points"];
        id hold = request[@"holdMs"];
        if (![path isKindOfClass:NSArray.class] || path.count < 2 || path.count > 32
            || (hold && (!number(hold) || [hold doubleValue] < 0 || [hold doubleValue] > 2000)))
            fail(@"Invalid bounded drag request");
        NSMutableArray *points = [NSMutableArray arrayWithCapacity:path.count];
        for (id entry in path) {
            if (![entry isKindOfClass:NSArray.class] || [entry count] != 2) fail(@"Invalid bounded drag point");
            NSMutableDictionary *at = [request mutableCopy];
            at[@"x"] = entry[0];
            at[@"y"] = entry[1];
            [points addObject:[NSValue valueWithPoint:NSPointFromCGPoint(content_point(at, state))]];
        }
        // Move, press at the first point, drag through the rest, release at the last.
        NSUInteger last = points.count - 1;
        for (NSUInteger i = 0; i <= last + 2; i++) {
            NSUInteger index = i < 2 ? 0 : MIN(i - 1, last);
            CGPoint point = NSPointToCGPoint([points[index] pointValue]);
            CGEventType type = i == 0 ? kCGEventMouseMoved
                : i == 1 ? kCGEventLeftMouseDown
                : i <= last + 1 ? kCGEventLeftMouseDragged : kCGEventLeftMouseUp;
            if (type == kCGEventLeftMouseUp && hold) {
                // The caller observes that nothing is reported while the
                // button is still held, then the release.
                fprintf(stderr, "held\n");
                fflush(stderr);
                [NSThread sleepForTimeInterval:[hold doubleValue] / 1000];
            }
            CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, kCGMouseButtonLeft);
            if (!event) fail(@"Cannot allocate a bounded CoreGraphics drag event");
            id owned = CFBridgingRelease(event);
            CGEventSetFlags(event, 0);
            CGEventSetIntegerValueField(event, kCGMouseEventClickState, i == 0 ? 0 : 1);
            require_foreground(pid);
            require_pointer_target(state, point);
            CGEventPost(kCGSessionEventTap, (__bridge CGEventRef)owned);
            events += 1;
            if (type == kCGEventLeftMouseDragged) [NSThread sleepForTimeInterval:0.03];
        }
        result[@"viewportPoints"] = path;
        result[@"windowServerTargetVerified"] = @YES;
    } else if ([action isEqualToString:@"type"]) {
        NSString *text = request[@"text"];
        NSCharacterSet *printable = [NSCharacterSet characterSetWithRange:NSMakeRange(0x20, 0x5f)];
        if (![text isKindOfClass:NSString.class] || !text.length || text.length > 256
            || [text rangeOfCharacterFromSet:printable.invertedSet].location != NSNotFound)
            fail(@"OS typing accepts only bounded printable ASCII text");
        for (NSUInteger i = 0; i < text.length; i++) {
            if (i) pause_ms(request[@"delayMs"]);
            key(pid, 0, [text characterAtIndex:i]);
        }
        events = text.length * 2;
    } else if ([action isEqualToString:@"scroll"]) {
        CGPoint point = content_point(request, state);
        id lines = request[@"lines"], repeat = request[@"repeat"];
        if (!number(lines) || [lines intValue] == 0 || abs([lines intValue]) > 3
            || [lines doubleValue] != [lines intValue]
            || !number(repeat) || [repeat doubleValue] < 1 || [repeat doubleValue] > 64
            || floor([repeat doubleValue]) != [repeat doubleValue]) fail(@"Invalid bounded wheel request");
        CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
        if (!move) fail(@"Cannot allocate a bounded CoreGraphics pointer move");
        id owned = CFBridgingRelease(move);
        require_foreground(pid);
        require_pointer_target(state, point);
        NSMutableArray *delivered = [NSMutableArray array];
        CFMachPortRef tap = CGEventTapCreateForPid(pid, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
            CGEventMaskBit(kCGEventScrollWheel), record_delivered_wheel, (__bridge void *)delivered);
        CFRunLoopSourceRef tapSource = tap ? CFMachPortCreateRunLoopSource(NULL, tap, 0) : NULL;
        if (tapSource) CFRunLoopAddSource(CFRunLoopGetCurrent(), tapSource, kCFRunLoopDefaultMode);
        CGEventPost(kCGSessionEventTap, (__bridge CGEventRef)owned);
        for (int i = 0; i < [repeat intValue]; i++) {
            if (i) pause_ms(request[@"delayMs"]);
            // Line units, one wheel axis: positive scrolls up, negative down.
            CGEventRef wheel = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, [lines intValue]);
            if (!wheel) fail(@"Cannot allocate a bounded CoreGraphics wheel event");
            id ownedWheel = CFBridgingRelease(wheel);
            CGEventSetLocation(wheel, point);
            require_foreground(pid);
            require_pointer_target(state, point);
            CGEventPost(kCGSessionEventTap, (__bridge CGEventRef)ownedWheel);
        }
        events = 1 + [repeat unsignedIntegerValue];
        if (tapSource) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.3, false);
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), tapSource, kCFRunLoopDefaultMode);
            CFRelease(tapSource);
        }
        if (tap) {
            CFMachPortInvalidate(tap);
            CFRelease(tap);
        }
        result[@"deliveredWheelDeltas"] = tap ? (id)delivered : (id)[NSNull null];
        result[@"screenPoint"] = @[@(point.x), @(point.y)];
        result[@"windowServerTargetVerified"] = @YES;
    } else if ([action isEqualToString:@"resize"] || [action isEqualToString:@"close"]) {
        AXUIElementRef window = owned_ax_window(pid, state);
        id ownedWindow = CFBridgingRelease(window);
        if ([action isEqualToString:@"close"]) {
            CFTypeRef button = NULL;
            if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)ownedWindow, kAXCloseButtonAttribute, &button)
                    != kAXErrorSuccess || !button)
                unavailable(@"The owned window exposes no accessible close button");
            id ownedButton = CFBridgingRelease(button);
            require_foreground(pid);
            if (AXUIElementPerformAction((__bridge AXUIElementRef)ownedButton, kAXPressAction) != kAXErrorSuccess)
                fail(@"The owned window's close button refused the press");
            result[@"injection"] = @{@"method": @"Accessibility AXPress on the owned window's standard close button",
                @"postedEvents": @0, @"delivery": @"Requires independent native close evidence"};
            return result;
        }
        NSArray *viewport = request[@"viewport"];
        id width = request[@"width"], height = request[@"height"];
        if (![viewport isKindOfClass:NSArray.class] || viewport.count != 2 || !number(viewport[0])
            || !number(viewport[1]) || !number(width) || !number(height)
            || [width doubleValue] < 200 || [width doubleValue] > 4096
            || [height doubleValue] < 200 || [height doubleValue] > 4096) fail(@"Invalid bounded resize request");
        NSArray *frame = state[@"window"][@"frame"];
        // Keep the observed frame-to-content insets: the request names the GPUI viewport.
        CGSize size = CGSizeMake([width doubleValue] + [frame[2] doubleValue] - [viewport[0] doubleValue],
            [height doubleValue] + [frame[3] doubleValue] - [viewport[1] doubleValue]);
        AXValueRef value = AXValueCreate(kAXValueTypeCGSize, &size);
        if (!value) fail(@"Cannot allocate a bounded accessibility size");
        id ownedValue = CFBridgingRelease(value);
        require_foreground(pid);
        if (AXUIElementSetAttributeValue((__bridge AXUIElementRef)ownedWindow, kAXSizeAttribute,
                (__bridge CFTypeRef)ownedValue) != kAXErrorSuccess)
            fail(@"The owned window refused the accessibility resize");
        NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 2;
        NSDictionary *resized = nil;
        while (NSProcessInfo.processInfo.systemUptime < deadline) {
            NSDictionary *current = snapshot(request);
            NSArray *now = current[@"window"][@"frame"];
            if ([current[@"status"] isEqualToString:@"ready"]
                && fabs([now[2] doubleValue] - size.width) < 1 && fabs([now[3] doubleValue] - size.height) < 1) {
                resized = current;
                break;
            }
            [NSThread sleepForTimeInterval:0.02];
        }
        if (!resized) fail(@"The owned Quartz window did not reach the requested size");
        if (![resized[@"application"] isEqual:state[@"application"]] || ![resized[@"host"] isEqual:state[@"host"]]
            || ![resized[@"window"][@"id"] isEqual:state[@"window"][@"id"]])
            fail(@"Owned identity changed during the resize");
        NSMutableDictionary *after = [resized mutableCopy];
        after[@"injection"] = @{@"method": @"Accessibility kAXSizeAttribute on the owned window",
            @"postedEvents": @0, @"delivery": @"Requires independent native layout evidence"};
        return after;
    } else if ([action isEqualToString:@"click"]) {
        CGPoint point = content_point(request, state);
        id window = state[@"window"][@"id"];
        if (!number(window) || [window doubleValue] < 1 || [window doubleValue] > UINT32_MAX
            || floor([window doubleValue]) != [window doubleValue]) fail(@"Invalid owned Quartz window number");
        NSArray *mouse = pointer_events(point);
        for (id event in mouse) {
            require_foreground(pid);
            require_pointer_target(state, point);
            // Initialization of the controller's AppKit connection must not
            // change the native process selected for actual OS input.
            require_foreground(pid);
            CGEventPost(kCGSessionEventTap, (__bridge CGEventRef)event);
        }
        events = 3;
        result[@"windowNumber"] = window;
        result[@"screenPoint"] = @[@(point.x), @(point.y)];
        result[@"windowServerTargetVerified"] = @YES;
        result[@"contentGeometry"] = @"Global Quartz point from the observed frame and measured GPUI viewport; exact mouse-down hit window checked by AppKit and independently matched to Quartz owner/bounds before each event; delivery still requires native target evidence";
    } else fail(@"Unknown bounded input action");
    verify(state, snapshot(request));
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)
        fail(@"Native foreground changed during input");
    result[@"injection"] = @{@"method": @"CoreGraphics CGEventPost(kCGSessionEventTap)", @"postedEvents": @(events),
        @"delivery": @"Requires independent native/Bun event and paint evidence"};
    return result;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSDictionary *result;
        int code = 0;
        @try {
            if (argc != 2 || strlen(argv[1]) > 16384) fail(@"One bounded JSON request is required");
            NSData *data = [[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
            if (![request isKindOfClass:NSDictionary.class]) fail(@"Invalid JSON request");
            if ([request[@"action"] isEqualToString:@"identity"]) {
                NSDictionary *app = process(process_id(request[@"app_pid"]));
                if (!app) fail(@"Owned application process identity is unavailable");
                result = @{@"status": @"ready", @"application": app};
            } else {
                result = snapshot(request);
                if (![request[@"action"] isEqualToString:@"observe"]) result = input(request, result);
            }
        } @catch (NSException *error) {
            BOOL unsupported = [error.name isEqualToString:@"Unsupported"];
            result = @{@"status": unsupported ? @"unsupported" : @"failed", @"error": error.reason ?: error.name};
            code = unsupported ? 2 : 1;
        }
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
        if (!encoded || encoded.length > 16384) return 1;
        fwrite(encoded.bytes, 1, encoded.length, stdout);
        fputc('\n', stdout);
        return code;
    }
}
