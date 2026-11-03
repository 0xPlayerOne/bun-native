// Actual AppKit/WindowServer controls using only task-owned temporary windows.
// No pointer/keyboard event is posted and no application/security setting changes.
#define main bun_native_controller_main
#include "../../scripts/quality/native-platform-macos.m"
#undef main

static void wait_for_owned_hit(NSInteger expected, NSPoint point) {
    if (expected <= 0) fail(@"Owned AppKit fixture has no positive window number");
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 2;
    while ([NSWindow windowNumberAtPoint:point belowWindowWithWindowNumber:0] != expected) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            fail(@"The owned AppKit control did not acquire its expected mouse-down target");
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
            beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
}

int main(void) {
    @autoreleasepool {
        NSWindow *base = nil;
        NSWindow *overlay = nil;
        @try {
            [NSApplication sharedApplication];
            [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
            NSScreen *screen = NSScreen.screens.firstObject;
            if (!screen) unavailable(@"No GUI display for the owned hit-test control");
            NSRect visible = screen.visibleFrame;
            if (visible.size.width < 160 || visible.size.height < 120)
                unavailable(@"The GUI display cannot contain the bounded control");
            NSRect frame = NSMakeRect(NSMidX(visible) - 64, NSMidY(visible) - 48, 128, 96);
            base = [[NSWindow alloc] initWithContentRect:frame
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            base.releasedWhenClosed = NO;
            base.opaque = YES;
            base.backgroundColor = NSColor.whiteColor;
            base.level = NSFloatingWindowLevel;
            [base orderFrontRegardless];
            [base displayIfNeeded];
            NSPoint appkitPoint = NSMakePoint(NSMidX(base.frame), NSMidY(base.frame));
            wait_for_owned_hit(base.windowNumber, appkitPoint);
            CGRect primary = CGDisplayBounds(CGMainDisplayID());
            CGPoint quartzPoint = CGPointMake(appkitPoint.x, primary.size.height - appkitPoint.y);
            NSDictionary *state = @{@"host": @{@"pid": @(getpid())},
                @"window": @{@"id": @(base.windowNumber)}};

            overlay = [[NSWindow alloc] initWithContentRect:frame
                styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
            overlay.releasedWhenClosed = NO;
            overlay.opaque = YES;
            overlay.backgroundColor = NSColor.blackColor;
            overlay.level = NSFloatingWindowLevel + 1;
            overlay.ignoresMouseEvents = YES;
            [overlay orderFrontRegardless];
            [overlay displayIfNeeded];
            wait_for_owned_hit(base.windowNumber, appkitPoint);

            NSTimeInterval visibleDeadline = NSProcessInfo.processInfo.systemUptime + 2;
            for (;;) {
                NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
                    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
                if (!windows || windows.count > 4096) fail(@"Invalid bounded owned-window observation");
                NSUInteger baseIndex = NSNotFound, overlayIndex = NSNotFound;
                for (NSUInteger i = 0; i < windows.count; i++) {
                    NSDictionary *row = windows[i];
                    if ([row[(__bridge NSString *)kCGWindowOwnerPID] intValue] != getpid()) continue;
                    NSInteger identifier = [row[(__bridge NSString *)kCGWindowNumber] integerValue];
                    if (identifier == base.windowNumber) baseIndex = i;
                    if (identifier == overlay.windowNumber) {
                        overlayIndex = i;
                        CGRect bounds = CGRectZero;
                        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)
                            row[(__bridge NSString *)kCGWindowBounds], &bounds)
                            || !CGRectContainsPoint(bounds, quartzPoint)
                            || [row[(__bridge NSString *)kCGWindowAlpha] doubleValue] != 1)
                            fail(@"The owned click-through rectangle witness is invalid");
                    }
                }
                if (baseIndex != NSNotFound && overlayIndex != NSNotFound && overlayIndex < baseIndex) break;
                if (NSProcessInfo.processInfo.systemUptime >= visibleDeadline)
                    fail([NSString stringWithFormat:@"Owned overlay visibility failed: base=%ld overlay=%ld baseIndex=%lu overlayIndex=%lu",
                        (long)base.windowNumber, (long)overlay.windowNumber,
                        (unsigned long)baseIndex, (unsigned long)overlayIndex]);
                [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                    beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            }
            // The former rectangle-only guard rejects here, despite the OS
            // independently selecting the underlying exact owned window.
            @try { require_pointer_target(state, quartzPoint); }
            @catch (NSException *error) {
                fail([@"Guard rejected a verified owned click-through witness: " stringByAppendingString:error.reason]);
            }

            overlay.ignoresMouseEvents = NO;
            wait_for_owned_hit(overlay.windowNumber, appkitPoint);
            BOOL rejected = NO;
            @try { require_pointer_target(state, quartzPoint); }
            @catch (NSException *error) {
                if (![error.name isEqualToString:@"Unsupported"]) @throw error;
                rejected = YES;
            }
            if (!rejected) fail(@"An input-taking same-process overlay was incorrectly authorized");

            [overlay orderOut:nil];
            wait_for_owned_hit(base.windowNumber, appkitPoint);
            require_pointer_target(state, quartzPoint);
            NSDictionary *result = @{@"status": @"passed", @"inputPosted": @NO,
                @"clickThroughAccepted": @YES, @"inputTakingOverlayRejected": @YES,
                @"uncoveredTargetAccepted": @YES, @"ownedWindowCount": @2,
                @"scope": @"Actual AppKit mouse-down hit testing and Quartz identity/geometry; not GPUI input delivery"};
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
            if (!encoded) fail(@"Cannot encode bounded hit-test control evidence");
            fwrite(encoded.bytes, 1, encoded.length, stdout);
            fputc('\n', stdout);
            return 0;
        } @catch (NSException *error) {
            fprintf(stderr, "%s\n", error.reason.UTF8String);
            return 1;
        } @finally {
            [overlay orderOut:nil];
            [overlay close];
            [base orderOut:nil];
            [base close];
        }
    }
}
