// Independent Accessibility oracle for macOS OS file dialogs: NSOpenPanel and
// NSSavePanel sheets. It never links GPUI. It finds a sheet attached to one of
// a process's windows by a static text equal to the dialog title (the host
// shows the title as the panel's message), as VoiceOver sees it.
//   trusted                          whether this process may use Accessibility
//   find <pid> <title>               the sheet's texts, buttons and text field values
//   invoke <pid> <title> <button>    AXPress the button with that title
//   key <pid> <title> escape|return  bring the process forward and type the key
//   absent <pid> <title>             succeed once no such sheet exists (waits)
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static const NSTimeInterval kWait = 5.0;
// HIToolbox virtual key codes (kVK_Escape, kVK_Return).
static const CGKeyCode kEscape = 53;
static const CGKeyCode kReturn = 36;

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

static NSArray *elements(AXUIElementRef element, CFStringRef name) {
    id value = attribute(element, name);
    return [value isKindOfClass:[NSArray class]] ? value : @[];
}

static NSString *text(AXUIElementRef element, CFStringRef name) {
    id value = attribute(element, name);
    return [value isKindOfClass:[NSString class]] ? value : @"";
}

static BOOL has_role(AXUIElementRef element, CFStringRef role) {
    return [text(element, kAXRoleAttribute) isEqualToString:(__bridge NSString *)role];
}

// Static texts and buttons below `element`, in tree order.
static void collect(AXUIElementRef element, NSMutableArray *texts, NSMutableArray *buttons,
                    NSMutableArray *buttonElements, NSMutableArray *fields, int depth) {
    if (depth > 24) return;
    for (id child in elements(element, kAXChildrenAttribute)) {
        AXUIElementRef node = (__bridge AXUIElementRef)child;
        if (has_role(node, kAXStaticTextRole)) {
            [texts addObject:text(node, kAXValueAttribute)];
        } else if (has_role(node, kAXButtonRole)) {
            [buttons addObject:text(node, kAXTitleAttribute)];
            [buttonElements addObject:child];
        } else if (has_role(node, kAXTextFieldRole)) {
            [fields addObject:text(node, kAXValueAttribute)];
        }
        collect(node, texts, buttons, buttonElements, fields, depth + 1);
    }
}

typedef struct {
    NSArray *texts;
    NSArray *buttons;
    NSArray *buttonElements;
    NSArray *fields;
} Sheet;

// The first sheet of any window of `pid` that shows `title` as a static text.
static BOOL find_sheet(pid_t pid, NSString *title, Sheet *found) {
    AXUIElementRef application = AXUIElementCreateApplication(pid);
    if (!application) fail(@"No accessibility element for the process");
    AXUIElementSetMessagingTimeout(application, 2.0);
    BOOL matched = NO;
    for (id window in elements(application, kAXWindowsAttribute)) {
        for (id child in elements((__bridge AXUIElementRef)window, kAXChildrenAttribute)) {
            AXUIElementRef sheet = (__bridge AXUIElementRef)child;
            if (!has_role(sheet, kAXSheetRole)) continue;
            NSMutableArray *texts = [NSMutableArray array];
            NSMutableArray *buttons = [NSMutableArray array];
            NSMutableArray *buttonElements = [NSMutableArray array];
            NSMutableArray *fields = [NSMutableArray array];
            collect(sheet, texts, buttons, buttonElements, fields, 0);
            if ([texts containsObject:title]) {
                found->texts = texts;
                found->buttons = buttons;
                found->buttonElements = buttonElements;
                found->fields = fields;
                matched = YES;
                break;
            }
        }
        if (matched) break;
    }
    CFRelease(application);
    return matched;
}

static Sheet wait_for_sheet(pid_t pid, NSString *title) {
    Sheet sheet = {0};
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
    while (!find_sheet(pid, title, &sheet)) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            fail([NSString stringWithFormat:@"No sheet shows %@", title]);
        [NSThread sleepForTimeInterval:0.025];
    }
    return sheet;
}

static void foreground(pid_t pid) {
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!app) fail(@"The process is not a running application");
    [app activateWithOptions:NSApplicationActivateAllWindows];
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
    while (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline)
            fail(@"The process cannot become the foreground application");
        [NSThread sleepForTimeInterval:0.01];
    }
}

static void type_key(CGKeyCode code) {
    for (int down = 1; down >= 0; down--) {
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down == 1);
        if (!event) fail(@"Cannot allocate a keyboard event");
        CGEventSetFlags(event, 0);
        CGEventPost(kCGSessionEventTap, event);
        CFRelease(event);
        [NSThread sleepForTimeInterval:0.02];
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "trusted") == 0) {
            emit(@{@"trusted" : AXIsProcessTrusted() ? @YES : @NO});
            return 0;
        }
        if (argc < 4) fail(@"Usage: trusted | find|absent <pid> <title> | invoke <pid> <title> <button> | key <pid> <title> escape|return");
        if (!AXIsProcessTrusted()) fail(@"This process is not trusted for Accessibility");
        const char *command = argv[1];
        pid_t pid = parse_pid(argv[2]);
        NSString *title = utf8(argv[3]);
        if (strcmp(command, "find") == 0 && argc == 4) {
            Sheet sheet = wait_for_sheet(pid, title);
            emit(@{@"texts" : sheet.texts, @"buttons" : sheet.buttons, @"fields" : sheet.fields});
            return 0;
        }
        if (strcmp(command, "absent") == 0 && argc == 4) {
            Sheet sheet = {0};
            NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + kWait;
            while (find_sheet(pid, title, &sheet)) {
                if (NSProcessInfo.processInfo.systemUptime >= deadline)
                    fail([NSString stringWithFormat:@"A sheet still shows %@", title]);
                [NSThread sleepForTimeInterval:0.025];
            }
            emit(@{@"absent" : title});
            return 0;
        }
        if (strcmp(command, "invoke") == 0 && argc == 5) {
            Sheet sheet = wait_for_sheet(pid, title);
            NSUInteger index = [sheet.buttons indexOfObject:utf8(argv[4])];
            if (index == NSNotFound)
                fail([NSString stringWithFormat:@"The sheet has no button %s", argv[4]]);
            AXError error = AXUIElementPerformAction(
                (__bridge AXUIElementRef)sheet.buttonElements[index], kAXPressAction);
            if (error != kAXErrorSuccess)
                fail([NSString stringWithFormat:@"AXPress failed (AXError %d)", (int)error]);
            emit(@{@"pressed" : sheet.buttons[index]});
            return 0;
        }
        if (strcmp(command, "key") == 0 && argc == 5) {
            CGKeyCode code;
            if (strcmp(argv[4], "escape") == 0) code = kEscape;
            else if (strcmp(argv[4], "return") == 0) code = kReturn;
            else fail(@"The key is escape or return");
            wait_for_sheet(pid, title);
            foreground(pid);
            type_key(code);
            emit(@{@"key" : utf8(argv[4]), @"method" : @"CGEventPost(kCGSessionEventTap)"});
            return 0;
        }
        fail(@"Usage: trusted | find|absent <pid> <title> | invoke <pid> <title> <button> | key <pid> <title> escape|return");
    }
}
