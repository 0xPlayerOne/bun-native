// A real foreign-process AppKit hit target must be resolved before OS input.
// The controller is not normally an NSApplication. This non-posting control
// separates the window owner and the controller into distinct processes.
#define main bun_native_controller_main
#include "../../scripts/quality/native-platform-macos.m"
#undef main

#include <spawn.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int run_owner(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSScreen *screen = NSScreen.screens.firstObject;
        if (!screen) return 3;
        NSRect frame = NSMakeRect(NSMidX(screen.visibleFrame) - 64,
            NSMidY(screen.visibleFrame) - 48, 128, 96);
        NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        window.backgroundColor = NSColor.whiteColor;
        window.opaque = YES;
        window.level = NSFloatingWindowLevel;
        [window orderFrontRegardless];
        [window displayIfNeeded];
        printf("%ld %.2f %.2f\n", (long)window.windowNumber,
            NSMidX(window.frame), NSMidY(window.frame));
        fflush(stdout);
        NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 8;
        while (NSProcessInfo.processInfo.systemUptime < deadline)
            [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        [window orderOut:nil];
        [window close];
        return 0;
    }
}

static void wait_for_visible_foreign_window(pid_t pid, uint32_t number, CGPoint point) {
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 2;
    do {
        NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID));
        if (!windows || windows.count > 4096) fail(@"Invalid WindowServer witness list");
        for (NSDictionary *candidate in windows) {
            if ([candidate[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != number
                || [candidate[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid)
                continue;
            CGRect bounds = pointer_window_bounds(candidate);
            if ([candidate[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0
                || !CGRectContainsPoint(bounds, point))
                fail(@"Foreign owned window has no valid visible pointer witness");
            return;
        }
        [NSThread sleepForTimeInterval:0.01];
    } while (NSProcessInfo.processInfo.systemUptime < deadline);
    fail(@"Timed out waiting for the foreign owned WindowServer witness");
}

int main(int argc, const char *argv[]) {
    if (argc == 2 && strcmp(argv[1], "--owner") == 0) return run_owner();
    if (argc != 1) return 2;
    @autoreleasepool {
        pid_t child = -1;
        int output = -1;
        @try {
            int channel[2] = {-1, -1};
            if (pipe(channel) != 0) fail(@"Cannot create bounded owned-process witness pipe");
            posix_spawn_file_actions_t actions;
            posix_spawn_file_actions_init(&actions);
            posix_spawn_file_actions_adddup2(&actions, channel[1], STDOUT_FILENO);
            posix_spawn_file_actions_addclose(&actions, channel[0]);
            posix_spawn_file_actions_addclose(&actions, channel[1]);
            char ownerArg[] = "--owner";
            char *arguments[] = {(char *)argv[0], ownerArg, NULL};
            int status = posix_spawn(&child, argv[0], &actions, NULL, arguments, environ);
            posix_spawn_file_actions_destroy(&actions);
            close(channel[1]);
            output = channel[0];
            if (status != 0 || child <= 0) fail(@"Cannot launch owned AppKit window process");

            fd_set ready;
            FD_ZERO(&ready);
            FD_SET(output, &ready);
            struct timeval timeout = {.tv_sec = 3, .tv_usec = 0};
            if (select(output + 1, &ready, NULL, NULL, &timeout) != 1)
                fail(@"Foreign AppKit window did not provide a bounded witness");
            char line[160] = {0};
            ssize_t bytes = read(output, line, sizeof(line) - 1);
            long number = 0;
            double x = 0, y = 0;
            if (bytes <= 0 || sscanf(line, "%ld %lf %lf", &number, &x, &y) != 3
                || number <= 0 || number > UINT32_MAX || !isfinite(x) || !isfinite(y))
                fail(@"Invalid foreign AppKit window witness");
            NSPoint appkitPoint = NSMakePoint(x, y);
            CGRect primary = CGDisplayBounds(CGMainDisplayID());
            CGPoint quartzPoint = CGPointMake(x, primary.size.height - y);
            wait_for_visible_foreign_window(child, (uint32_t)number, quartzPoint);
            // This was zero in the broken helper: the plain command-line
            // controller has no initialized AppKit application connection.
            NSInteger before = [NSWindow windowNumberAtPoint:appkitPoint
                belowWindowWithWindowNumber:0];
            NSDictionary *state = @{@"host": @{@"pid": @(child)},
                @"window": @{@"id": @(number)}};
            pid_t foregroundBefore = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
            require_pointer_target(state, quartzPoint);
            if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != foregroundBefore)
                fail(@"The controller's AppKit initialization changed the foreground application");
            NSInteger after = [NSWindow windowNumberAtPoint:appkitPoint
                belowWindowWithWindowNumber:0];
            if (after != number) fail(@"Initialized AppKit did not select the foreign owned window");

            BOOL rejected = NO;
            NSDictionary *wrongOwner = @{@"host": @{@"pid": @(getpid())},
                @"window": @{@"id": @(number)}};
            @try { require_pointer_target(wrongOwner, quartzPoint); }
            @catch (NSException *error) {
                if (![error.name isEqualToString:@"Unsupported"]) @throw error;
                rejected = YES;
            }
            if (!rejected) fail(@"A foreign owner was incorrectly authorized");
            NSDictionary *result = @{@"status": @"passed", @"crossProcessTargetAccepted": @YES,
                @"foreignOwnerRejected": @YES, @"foregroundUnchanged": @YES,
                @"rawHitBeforeAppKit": @(before), @"inputPosted": @NO,
                @"scope": @"Real cross-process AppKit/WindowServer hit testing; no OS input delivery"};
            NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
            if (!json) fail(@"Cannot encode bounded cross-process hit evidence");
            fwrite(json.bytes, 1, json.length, stdout);
            fputc('\n', stdout);
            return 0;
        } @catch (NSException *error) {
            fprintf(stderr, "%s\n", error.reason.UTF8String);
            return 1;
        } @finally {
            if (output >= 0) close(output);
            if (child > 0) {
                kill(child, SIGTERM);
                int state = 0;
                waitpid(child, &state, 0);
            }
        }
    }
}
