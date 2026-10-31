// SDK regression only: creates and inspects event objects, never posts input.
// Include the helper so the exact event-construction implementation is tested.
#define main bun_native_controller_main
#include "../../scripts/quality/native-platform-macos.m"
#undef main

int main(void) {
    @autoreleasepool {
        @try {
            NSArray<NSArray<NSNumber *> *> *points = @[@[@104.0, @237.0], @[@0.25, @0.5], @[@0.0, @381.0]];
            NSUInteger checked = 0;
            for (NSArray<NSNumber *> *coordinates in points) {
                NSPoint point = NSMakePoint(coordinates[0].doubleValue, coordinates[1].doubleValue);
                NSArray<NSEvent *> *events = pointer_events(123, point);
                if (events.count != 3) fail(@"Pointer sequence is incomplete");
                for (NSEvent *event in events) {
                    NSEvent *roundTrip = [NSEvent eventWithCGEvent:event.CGEvent];
                    if (roundTrip.windowNumber != 123 || !NSEqualPoints(roundTrip.locationInWindow, point))
                        fail(@"Owned window association or local coordinates were lost");
                    checked++;
                }
            }
            CGEventRef raw = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown,
                CGPointMake(100, 200), kCGMouseButtonLeft);
            if (!raw) fail(@"Cannot construct the unassociated control event");
            NSInteger controlWindow = [NSEvent eventWithCGEvent:raw].windowNumber;
            CFRelease(raw);
            NSDictionary *identity = @{@"status": @"ready", @"application": @{@"pid": @1},
                @"host": @{@"pid": @2}, @"window": @{@"id": @123, @"frame": @[@0, @0, @560, @408]}};
            verify(identity, identity);
            NSArray<NSString *> *fields = @[@"status", @"application", @"host", @"window"];
            NSArray<NSString *> *reasons = @[@"no longer ready", @"application process identity",
                @"native process identity", @"window metadata/geometry"];
            for (NSUInteger i = 0; i < fields.count; i++) {
                NSMutableDictionary *changed = [identity mutableCopy];
                if (i == 0) changed[fields[i]] = @"not-ready";
                else changed[fields[i]] = @{@"changed": @YES};
                BOOL rejected = NO;
                @try { verify(identity, changed); }
                @catch (NSException *error) {
                    rejected = [error.name isEqualToString:@"Failed"]
                        && [error.reason containsString:reasons[i]];
                    if (i == 3) rejected = rejected && [error.reason containsString:@"current window:"];
                }
                if (!rejected) fail(@"Changed owned identity was not precisely rejected");
            }
            NSDictionary *result = @{@"status": @"passed", @"associatedEventsChecked": @(checked),
                @"rawControlWindowNumber": @(controlWindow), @"inputPosted": @NO,
                @"identityGuardsChecked": @(fields.count),
                @"scope": @"Actual AppKit/CoreGraphics conversion only; native delivery is separately required"};
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
            if (!encoded) fail(@"Cannot encode SDK association evidence");
            fwrite(encoded.bytes, 1, encoded.length, stdout);
            fputc('\n', stdout);
            return 0;
        } @catch (NSException *error) {
            fprintf(stderr, "%s\n", error.reason.UTF8String);
            return 1;
        }
    }
}
