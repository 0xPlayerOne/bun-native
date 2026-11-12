// Independent AppKit drag source for the native drag and drop qualification.
// It owns a small window, receives a real CoreGraphics mouse-down there, starts
// an NSDraggingSession from that event and moves the real pointer with posted
// CoreGraphics drag events, so GPUI's own NSDraggingDestination code receives
// the drag from the WindowServer. Nothing calls into the host.
//
// Compile with: xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit
//   -framework CoreGraphics macos-drag-source.m -o macos-drag-source
//
// Commands, one per stdin line; each prints one JSON line (or {"error":...}):
//   find {"title","width","height","pid"}  locate the onscreen window of a
//                       direct child of pid whose content is width x height
//   offer files JSON    offer file URLs for these absolute paths
//   offer text JSON     offer one plain string
//   enter X Y           mouse-down on the source, begin the session, move to
//                       the window-relative point X,Y of the found window and
//                       wait until the session itself has tracked it there
//   move X Y            drag to X,Y, with the same wait
//   drop                release the button; reports the session's operation
//   leave               cancel with Escape, then release over the source
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <libproc.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <unistd.h>

static const CGFloat SourceLeft = 16;
static const CGFloat SourceTop = 160;
static const CGFloat SourceSize = 48;
static const int64_t Wait = 3 * (int64_t)NSEC_PER_SEC;

static NSArray *payload;
static dispatch_semaphore_t began;
static dispatch_semaphore_t ended;
static NSDragOperation endedOperation;
static NSInteger legacyFilenames;

// What the session itself tracked, in Quartz coordinates. The main thread
// writes these from the session's callbacks; the command thread reads them
// under the same lock and never waits on the main thread during a drag.
static NSObject *sessionLock;
static CGFloat primaryHeight;
static NSInteger sessionMoves;
static CGPoint sessionPoint;

// Only the command thread touches these.
static BOOL targetFound;
static CGPoint targetOrigin;
static BOOL dragging;
static CGPoint current;

static void fail(NSString *reason) {
    @throw [NSException exceptionWithName:@"Failed" reason:reason userInfo:nil];
}

static CGPoint source_center(void) {
    return CGPointMake(SourceLeft + SourceSize / 2, SourceTop + SourceSize / 2);
}

@interface SourceWindow : NSWindow
@end

@implementation SourceWindow
- (BOOL)canBecomeKeyWindow {
    return YES;
}
@end

@interface SourceView : NSView <NSDraggingSource>
@end

@implementation SourceView
- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    (void)event;
    return YES;
}

- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    [[NSColor systemOrangeColor] setFill];
    NSRectFill(self.bounds);
}

- (void)mouseDown:(NSEvent *)event {
    NSArray *writers = payload;
    if (writers.count == 0) return;
    NSImage *image = [NSImage imageWithSize:NSMakeSize(16, 16) flipped:NO
                             drawingHandler:^BOOL(NSRect rect) {
        [[NSColor systemBlueColor] setFill];
        NSRectFill(rect);
        return YES;
    }];
    NSPoint at = [self convertPoint:event.locationInWindow fromView:nil];
    NSMutableArray<NSDraggingItem *> *items = [NSMutableArray arrayWithCapacity:writers.count];
    for (id<NSPasteboardWriting> writer in writers) {
        NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:writer];
        [item setDraggingFrame:NSMakeRect(at.x - 8, at.y - 8, 16, 16) contents:image];
        [items addObject:item];
    }
    NSDraggingSession *session = [self beginDraggingSessionWithItems:items event:event source:self];
    session.animatesToStartingPositionsOnCancelOrFail = NO;
    session.draggingFormation = NSDraggingFormationNone;
    // GPUI reads the legacy filenames list; record what the pasteboard offers.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    id names = [session.draggingPasteboard propertyListForType:NSFilenamesPboardType];
#pragma clang diagnostic pop
    legacyFilenames = [names isKindOfClass:NSArray.class] ? (NSInteger)[names count] : -1;
    dispatch_semaphore_signal(began);
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    (void)session;
    return context == NSDraggingContextOutsideApplication ? NSDragOperationCopy : NSDragOperationNone;
}

- (void)draggingSession:(NSDraggingSession *)session movedToPoint:(NSPoint)point {
    (void)session;
    @synchronized(sessionLock) {
        sessionMoves++;
        sessionPoint = CGPointMake(point.x, primaryHeight - point.y);
    }
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)point
              operation:(NSDragOperation)operation {
    (void)session;
    (void)point;
    endedOperation = operation;
    dispatch_semaphore_signal(ended);
}
@end

static void post_mouse(CGEventType type, CGPoint point) {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, kCGMouseButtonLeft);
    if (!event) fail(@"Cannot allocate a CoreGraphics mouse event");
    CGEventSetFlags(event, 0);
    if (type == kCGEventLeftMouseDown || type == kCGEventLeftMouseUp)
        CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
    CGEventPost(kCGSessionEventTap, event);
    CFRelease(event);
}

static void post_key(CGKeyCode code) {
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down == 1);
        if (!event) fail(@"Cannot allocate a CoreGraphics keyboard event");
        CGEventSetFlags(event, 0);
        CGEventPost(kCGSessionEventTap, event);
        CFRelease(event);
    }
}

static void pause_ms(unsigned milliseconds) {
    usleep(milliseconds * 1000);
}

static NSString *operation_name(NSDragOperation operation) {
    if (operation == NSDragOperationNone) return @"none";
    if (operation == NSDragOperationCopy) return @"copy";
    return [NSString stringWithFormat:@"%lu", (unsigned long)operation];
}

static id parse_json(NSString *text) {
    // Wrapped, so a bare JSON string needs no fragment option.
    NSString *wrapped = [NSString stringWithFormat:@"[%@]", text];
    NSArray *value = [NSJSONSerialization JSONObjectWithData:[wrapped dataUsingEncoding:NSUTF8StringEncoding]
                                                     options:0 error:NULL];
    if (![value isKindOfClass:NSArray.class] || value.count != 1) fail(@"Invalid JSON argument");
    return value[0];
}

static BOOL number(id value) {
    return [value isKindOfClass:NSNumber.class]
        && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
        && isfinite([value doubleValue]);
}

static pid_t parent_of(pid_t pid) {
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) return -1;
    return (pid_t)info.pbi_ppid;
}

static NSDictionary *find(NSDictionary *request) {
    if (![request isKindOfClass:NSDictionary.class] || !number(request[@"width"])
        || !number(request[@"height"]) || !number(request[@"pid"]))
        fail(@"find needs width, height and pid");
    double width = [request[@"width"] doubleValue], height = [request[@"height"] doubleValue];
    pid_t owner = [request[@"pid"] intValue];
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 3;
    for (;;) {
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
        if (!windows) fail(@"The current session has no accessible WindowServer");
        NSMutableArray *matches = [NSMutableArray array];
        for (NSDictionary *candidate in windows) {
            pid_t pid = [candidate[(__bridge NSString *)kCGWindowOwnerPID] intValue];
            if ([candidate[(__bridge NSString *)kCGWindowLayer] intValue] != 0 || parent_of(pid) != owner)
                continue;
            CGRect bounds = CGRectZero;
            if (!CGRectMakeWithDictionaryRepresentation(
                    (__bridge CFDictionaryRef)candidate[(__bridge NSString *)kCGWindowBounds], &bounds))
                continue;
            // Content is centered horizontally with the title bar on top.
            double side = (bounds.size.width - width) / 2;
            double top = bounds.size.height - height - side;
            if (side < 0 || side > 16 || top < 0 || top > 96) continue;
            [matches addObject:@{@"id": candidate[(__bridge NSString *)kCGWindowNumber],
                @"origin": @[@(bounds.origin.x + side), @(bounds.origin.y + top)]}];
        }
        if (matches.count > 1) fail(@"Several owned windows match the requested content size");
        if (matches.count == 1) {
            NSArray *origin = matches[0][@"origin"];
            targetOrigin = CGPointMake([origin[0] doubleValue], [origin[1] doubleValue]);
            targetFound = YES;
            return @{@"found": @YES, @"window": matches[0][@"id"], @"origin": origin};
        }
        if (NSProcessInfo.processInfo.systemUptime > deadline) return @{@"found": @NO};
        pause_ms(25);
    }
}

static CGPoint target_point(NSString *rest) {
    if (!targetFound) fail(@"No target window was found");
    NSArray *parts = [rest componentsSeparatedByString:@" "];
    if (parts.count != 2) fail(@"Expected X Y");
    double x = [parts[0] doubleValue], y = [parts[1] doubleValue];
    if (!isfinite(x) || !isfinite(y) || x < 0 || y < 0 || x > 4096 || y > 4096)
        fail(@"Window-relative point out of bounds");
    return CGPointMake(targetOrigin.x + x, targetOrigin.y + y);
}

static NSInteger session_moves(CGPoint *point) {
    @synchronized(sessionLock) {
        if (point) *point = sessionPoint;
        return sessionMoves;
    }
}

/// Waits until the session has tracked a move past `after` that ends within
/// two points of `point`, reposting that same position every 100 ms. A
/// session whose tracking starts after the posted motion (a 65-item session
/// takes longer to begin) otherwise never sees the pointer arrive, and the
/// destination is never entered. Returns the number of reposts.
static NSInteger track_to(CGPoint point, NSInteger after) {
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + Wait / (double)NSEC_PER_SEC;
    for (NSInteger reposts = 0;; reposts++) {
        for (int poll = 0; poll < 4; poll++) {
            CGPoint at;
            if (session_moves(&at) > after && fabs(at.x - point.x) <= 2 && fabs(at.y - point.y) <= 2)
                return reposts;
            pause_ms(25);
        }
        if (NSProcessInfo.processInfo.systemUptime > deadline) {
            CGPoint at;
            NSInteger moves = session_moves(&at);
            fail([NSString stringWithFormat:
                @"The dragging session did not track the pointer to %.0f,%.0f (%ld moves, last %.0f,%.0f)",
                point.x, point.y, (long)moves, at.x, at.y]);
        }
        post_mouse(kCGEventLeftMouseDragged, point);
    }
}

/// One jump, then a still update, so the destination sees one position only.
/// Returns how often the session needed the position reposted.
static NSInteger drag_to(CGPoint point) {
    CGPoint was;
    NSInteger before = session_moves(&was);
    // A session already tracked at this position need not see a new move.
    if (before > 0 && fabs(was.x - point.x) <= 2 && fabs(was.y - point.y) <= 2) before--;
    post_mouse(kCGEventLeftMouseDragged, point);
    pause_ms(40);
    post_mouse(kCGEventLeftMouseDragged, point);
    pause_ms(80);
    current = point;
    return track_to(point, before);
}

static NSDictionary *wait_ended(int64_t timeout) {
    if (dispatch_semaphore_wait(ended, dispatch_time(DISPATCH_TIME_NOW, timeout)) != 0) return nil;
    dragging = NO;
    return @{@"ended": @YES, @"operation": operation_name(endedOperation)};
}

static NSDictionary *command(NSString *line) {
    NSRange space = [line rangeOfString:@" "];
    NSString *verb = space.location == NSNotFound ? line : [line substringToIndex:space.location];
    NSString *rest = space.location == NSNotFound ? @"" : [line substringFromIndex:space.location + 1];
    if ([verb isEqualToString:@"find"]) return find(parse_json(rest));
    if ([verb isEqualToString:@"offer"]) {
        NSRange kind = [rest rangeOfString:@" "];
        if (kind.location == NSNotFound) fail(@"offer TYPE JSON");
        NSString *type = [rest substringToIndex:kind.location];
        id value = parse_json([rest substringFromIndex:kind.location + 1]);
        NSMutableArray *writers = [NSMutableArray array];
        if ([type isEqualToString:@"files"] && [value isKindOfClass:NSArray.class]) {
            for (id path in value) {
                if (![path isKindOfClass:NSString.class] || ![path isAbsolutePath])
                    fail(@"Offered files must be absolute paths");
                [writers addObject:[NSURL fileURLWithPath:path isDirectory:NO]];
            }
        } else if ([type isEqualToString:@"text"] && [value isKindOfClass:NSString.class]) {
            [writers addObject:value];
        } else fail(@"offer files [paths] or offer text \"string\"");
        if (writers.count == 0 || writers.count > 256) fail(@"Offer 1-256 items");
        dispatch_sync(dispatch_get_main_queue(), ^{ payload = writers; });
        return @{@"offered": @(writers.count)};
    }
    if ([verb isEqualToString:@"enter"]) {
        CGPoint point = target_point(rest);
        if (dragging) fail(@"A drag is already active");
        if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))
            fail(@"An external pointer button is held");
        dispatch_sync(dispatch_get_main_queue(), ^{
            [NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateAllWindows];
        });
        CGPoint start = source_center();
        post_mouse(kCGEventMouseMoved, start);
        pause_ms(60);
        post_mouse(kCGEventLeftMouseDown, start);
        if (dispatch_semaphore_wait(began, dispatch_time(DISPATCH_TIME_NOW, Wait)) != 0) {
            post_mouse(kCGEventLeftMouseUp, start);
            fail(@"AppKit did not deliver the source mouse-down or begin a dragging session");
        }
        dragging = YES;
        // Leave the source by a few points so AppKit tracks a drag.
        for (int step = 1; step <= 3; step++) {
            post_mouse(kCGEventLeftMouseDragged, CGPointMake(start.x + 4 * step, start.y));
            pause_ms(20);
        }
        NSInteger reposts = drag_to(point);
        return @{@"entered": @YES, @"legacyFilenames": @(legacyFilenames),
            @"screenPoint": @[@(point.x), @(point.y)], @"sessionMoves": @(session_moves(NULL)),
            @"reposts": @(reposts)};
    }
    if ([verb isEqualToString:@"move"]) {
        CGPoint point = target_point(rest);
        if (!dragging) fail(@"No drag is active");
        NSInteger reposts = drag_to(point);
        return @{@"moved": @YES, @"reposts": @(reposts)};
    }
    if ([verb isEqualToString:@"drop"]) {
        if (!dragging) fail(@"No drag is active");
        post_mouse(kCGEventLeftMouseUp, current);
        NSDictionary *result = wait_ended(Wait);
        if (!result) fail(@"The dragging session did not end after the release");
        return result;
    }
    if ([verb isEqualToString:@"leave"]) {
        if (!dragging) fail(@"No drag is active");
        NSString *method = @"escape";
        // The main thread may be tracking the session, so nothing here waits
        // on it. Escape reaches the session only while this app is frontmost.
        post_key(53); // kVK_Escape
        NSDictionary *result = wait_ended(NSEC_PER_SEC * 3 / 2);
        CGPoint start = source_center();
        if (!result) {
            // The session did not see Escape: return to the source, which is
            // not a destination, and release there. The target sees a leave.
            method = @"returned to the source after an unanswered Escape";
            drag_to(start);
            post_mouse(kCGEventLeftMouseUp, start);
            result = wait_ended(Wait);
            if (!result) fail(@"The dragging session did not end after returning to the source");
        } else {
            // Release the posted button over the source window that owns it.
            post_mouse(kCGEventLeftMouseDragged, start);
            pause_ms(40);
            post_mouse(kCGEventLeftMouseUp, start);
            pause_ms(40);
        }
        NSMutableDictionary *reply = [result mutableCopy];
        reply[@"cancel"] = method;
        return reply;
    }
    fail(@"Unknown command");
    return nil;
}

static void commands(void) {
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) > 0) {
        @autoreleasepool {
            if (line[length - 1] == '\n') length--;
            NSString *text = [[NSString alloc] initWithBytes:line length:(NSUInteger)length
                                                    encoding:NSUTF8StringEncoding];
            NSDictionary *reply;
            @try {
                if (!text || length > 1 << 20) fail(@"Command line is not bounded UTF-8");
                reply = command(text);
            } @catch (NSException *error) {
                reply = @{@"error": error.reason ?: error.name};
            }
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL];
            if (!encoded) encoded = [@"{\"error\":\"unencodable reply\"}" dataUsingEncoding:NSUTF8StringEncoding];
            fwrite(encoded.bytes, 1, encoded.length, stdout);
            fputc('\n', stdout);
            fflush(stdout);
        }
    }
    free(line);
    // A failed fixture closes stdin while the OS drag is still active. Since
    // the source posted the global mouse-down, it must release that button
    // before exiting or the next independent drag sees an external hold.
    // The nonzero exit for the incomplete drag is preserved.
    BOOL abandonedDrag = dragging;
    if (abandonedDrag) {
        post_mouse(kCGEventLeftMouseUp, current);
        fputs("Drag source ended during an active drag; released the posted button\n", stderr);
    }
    exit(abandonedDrag ? 1 : 0);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        began = dispatch_semaphore_create(0);
        sessionLock = [NSObject new];
        ended = dispatch_semaphore_create(0);
        if (!CGPreflightPostEventAccess()) {
            fputs("{\"error\":\"CoreGraphics event posting permission is unavailable\"}\n", stdout);
            return 2;
        }
        NSScreen *primary = NSScreen.screens.firstObject;
        if (!primary) return 2;
        primaryHeight = primary.frame.size.height;
        // AppKit's origin is the primary screen's bottom-left; Quartz's is top-left.
        NSRect frame = NSMakeRect(SourceLeft, primary.frame.size.height - SourceTop - SourceSize,
            SourceSize, SourceSize);
        SourceWindow *window = [[SourceWindow alloc] initWithContentRect:frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.level = NSFloatingWindowLevel;
        window.contentView = [[SourceView alloc] initWithFrame:NSMakeRect(0, 0, SourceSize, SourceSize)];
        [window orderFrontRegardless];
        [NSThread detachNewThreadWithBlock:^{ commands(); }];
        [NSApp run];
    }
    return 0;
}
