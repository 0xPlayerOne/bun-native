// Thin SDK-typed test helper. It addresses only the launched app's direct child
// after checking libproc creation identity, image path and Quartz window owner.
// Compile with: xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit
//   -framework CoreGraphics native-platform-macos.m -o native-platform-macos
// API contracts: developer.apple.com/documentation/coregraphics/quartz-window-services
// and the target SDK's libproc.h / sys/proc_info.h. No handwritten ABI layouts.
#import <AppKit/AppKit.h>
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
        window = @{@"id": candidate[(__bridge NSString *)kCGWindowNumber],
            @"title": name ?: NSNull.null, @"titleVerified": @(name.length > 0),
            @"visible": @YES, @"frame": @[@(bounds.origin.x), @(bounds.origin.y),
                @(bounds.size.width), @(bounds.size.height)]};
    }
    if (!window) return @{@"status": @"not-ready", @"reason": @"No owned onscreen native window yet"};
    if (![process(root) isEqualToDictionary:app]
        || ![process([host[@"pid"] intValue]) isEqualToDictionary:host])
        fail(@"Owned process identity changed during window enumeration");
    return @{@"status": @"ready", @"method": @"libproc + creation identity + Quartz onscreen window enumeration",
        @"application": app, @"host": host, @"window": window,
        @"postEventAccess": @(CGPreflightPostEventAccess())};
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
        unavailable(@"An external modifier is active; no input was injected");
    if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))
        unavailable(@"An external pointer button is held; no input was injected");
}

static void require_foreground(pid_t pid) {
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid)
        fail(@"Native foreground changed before input");
}

// Quartz returns onscreen windows front-to-back. Reject even a same-process
// overlay: the measured button must belong to this exact unobscured window.
static void verify_pointer_target(NSDictionary *state, NSArray *windows, CGPoint point) {
    if (![windows isKindOfClass:NSArray.class] || windows.count > 4096
        || !isfinite(point.x) || !isfinite(point.y)) fail(@"Invalid bounded WindowServer target list");
    for (NSDictionary *candidate in windows) {
        id alpha = candidate[(__bridge NSString *)kCGWindowAlpha];
        if (!number(alpha)) fail(@"WindowServer opacity is unavailable");
        if ([alpha doubleValue] <= 0) continue;
        id value = candidate[(__bridge NSString *)kCGWindowBounds];
        CGRect bounds = CGRectZero;
        if (![value isKindOfClass:NSDictionary.class]
            || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value, &bounds)
            || !isfinite(bounds.origin.x) || !isfinite(bounds.origin.y)
            || !isfinite(bounds.size.width) || !isfinite(bounds.size.height)
            || bounds.size.width < 0 || bounds.size.height < 0
            || bounds.size.width > 32768 || bounds.size.height > 32768)
            fail(@"WindowServer target bounds are invalid");
        if (!CGRectContainsPoint(bounds, point)) continue;
        if (![candidate[(__bridge NSString *)kCGWindowNumber] isEqual:state[@"window"][@"id"]]
            || ![candidate[(__bridge NSString *)kCGWindowOwnerPID] isEqual:state[@"host"][@"pid"]])
            unavailable(@"The owned pointer target is obscured by another window; no input was posted");
        return;
    }
    unavailable(@"The owned pointer target is absent from the onscreen window list");
}

static void require_pointer_target(NSDictionary *state, CGPoint point) {
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    if (!windows) unavailable(@"The current GUI session cannot resolve the pointer target");
    verify_pointer_target(state, windows, point);
}

static void key(pid_t pid, CGKeyCode code, UniChar character) {
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
    for (int i = 0; i < 2; i++) {
        CGEventRef event = i == 0 ? down : up;
        CGEventSetFlags(event, 0);
        if (character) CGEventKeyboardSetUnicodeString(event, 1, &character);
        CGEventPost(kCGSessionEventTap, event);
    }
    CFRelease(up);
    CFRelease(down);
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

static NSDictionary *input(NSDictionary *request, NSDictionary *state) {
    NSDictionary *expected = request[@"expected"];
    if (![expected isKindOfClass:NSDictionary.class]) fail(@"A previously observed identity is required");
    verify(expected, state);
    foreground(request, state);
    pid_t pid = [state[@"host"][@"pid"] intValue];
    NSString *action = request[@"action"];
    NSUInteger events = 0;
    NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:state];
    if ([action isEqualToString:@"tab"]) {
        key(pid, 48, 0);
        events = 2;
    } else if ([action isEqualToString:@"text"]) {
        NSString *text = request[@"text"];
        if (![text isKindOfClass:NSString.class] || !text.length || text.length > 64
            || [text rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location != NSNotFound)
            fail(@"OS text injection accepts only a bounded hexadecimal run nonce");
        for (NSUInteger i = 0; i < text.length; i++) key(pid, 0, [text characterAtIndex:i]);
        events = text.length * 2;
    } else if ([action isEqualToString:@"click"]) {
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
        id window = state[@"window"][@"id"];
        if (!number(window) || [window doubleValue] < 1 || [window doubleValue] > UINT32_MAX
            || floor([window doubleValue]) != [window doubleValue]) fail(@"Invalid owned Quartz window number");
        CGPoint point = CGPointMake([frame[0] doubleValue] + side + x,
            [frame[1] doubleValue] + top + y);
        NSArray *mouse = pointer_events(point);
        require_foreground(pid);
        require_pointer_target(state, point);
        for (id event in mouse) CGEventPost(kCGSessionEventTap, (__bridge CGEventRef)event);
        events = 3;
        result[@"windowNumber"] = window;
        result[@"screenPoint"] = @[@(point.x), @(point.y)];
        result[@"windowServerTargetVerified"] = @YES;
        result[@"contentGeometry"] = @"Global Quartz point from the observed frame and measured GPUI viewport; exact unobscured window checked in the front-to-back WindowServer list; delivery still requires native target evidence";
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
