// SDK controls only: inspect real Quartz event objects and target validation.
// This executable never calls foreground(), input(), key() or CGEventPost.
#define main bun_native_controller_main
#include "../../scripts/quality/native-platform-macos.m"
#undef main

static NSDictionary *window_record(pid_t pid, uint32_t number, CGRect bounds, double alpha) {
    return @{(__bridge NSString *)kCGWindowOwnerPID: @(pid),
        (__bridge NSString *)kCGWindowNumber: @(number),
        (__bridge NSString *)kCGWindowBounds: CFBridgingRelease(CGRectCreateDictionaryRepresentation(bounds)),
        (__bridge NSString *)kCGWindowAlpha: @(alpha)};
}

int main(void) {
    @autoreleasepool {
        @try {
            NSArray<NSArray<NSNumber *> *> *points = @[@[@336.0, @348.0], @[@0.25, @0.5], @[@(-100.25), @381.0]];
            NSUInteger checked = 0;
            for (NSArray<NSNumber *> *coordinates in points) {
                CGPoint point = CGPointMake(coordinates[0].doubleValue, coordinates[1].doubleValue);
                NSArray *events = pointer_events(point);
                if (events.count != 3) fail(@"Pointer sequence is incomplete");
                CGEventType types[] = {kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp};
                for (NSUInteger i = 0; i < events.count; i++) {
                    CGEventRef event = (__bridge CGEventRef)events[i];
                    if (CGEventGetType(event) != types[i]
                        || !CGPointEqualToPoint(CGEventGetLocation(event), point)
                        || CGEventGetFlags(event) != 0
                        || CGEventGetIntegerValueField(event, kCGMouseEventClickState) != (i ? 1 : 0))
                        fail(@"Global Quartz event type, point or click state was lost");
                    checked++;
                }
            }
            NSDictionary *identity = @{@"status": @"ready", @"application": @{@"pid": @1},
                @"host": @{@"pid": @2}, @"window": @{@"id": @123, @"frame": @[@232, @176, @560, @409]}};
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
            CGRect bounds = CGRectMake(232, 176, 560, 409);
            NSDictionary *owned = window_record(2, 123, bounds, 1);
            NSDictionary *foreign = window_record(9, 456, bounds, 1);
            NSDictionary *sameProcessOverlay = window_record(2, 124, bounds, 1);
            NSDictionary *transparent = window_record(9, 456, bounds, 0);
            NSDictionary *outside = window_record(9, 456, CGRectMake(0, 0, 10, 10), 1);
            NSArray *lists = @[@[owned, foreign], @[foreign, owned], @[sameProcessOverlay, owned],
                @[transparent, owned], @[outside, owned], @[foreign], @[], @[outside]];
            NSArray<NSNumber *> *shouldReject = @[@NO, @YES, @YES, @NO, @NO, @YES, @YES, @YES];
            for (NSUInteger i = 0; i < lists.count; i++) {
                BOOL rejected = NO;
                @try { verify_pointer_target(identity, lists[i], CGPointMake(336, 348)); }
                @catch (NSException *error) {
                    if (![error.name isEqualToString:@"Unsupported"]) @throw error;
                    rejected = YES;
                }
                if (rejected != shouldReject[i].boolValue)
                    fail(@"Unobscured exact-window target control produced the wrong result");
            }
            NSDictionary *result = @{@"status": @"passed", @"globalEventsChecked": @(checked),
                @"inputPosted": @NO, @"identityGuardsChecked": @(fields.count),
                @"windowTargetControlsChecked": @(lists.count),
                @"scope": @"Actual Quartz construction and pure target-guard controls only; WindowServer delivery is separately required"};
            NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
            if (!encoded) fail(@"Cannot encode SDK event evidence");
            fwrite(encoded.bytes, 1, encoded.length, stdout);
            fputc('\n', stdout);
            return 0;
        } @catch (NSException *error) {
            fprintf(stderr, "%s\n", error.reason.UTF8String);
            return 1;
        }
    }
}
