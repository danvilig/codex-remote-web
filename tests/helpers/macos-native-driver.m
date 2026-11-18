// Test-only loader for the exact installed, ad-hoc signed application. This
// dylib is built outside the .app and never distributed. No evaluation/debug
// endpoint, command-line switch or test confirmation bypass ships in the app.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <unistd.h>

static NSInteger confirmationResponse = NSAlertFirstButtonReturn;
static NSDictionary *lastConfirmation;
static NSFileHandle *testOutput;
static NSModalResponse testAlert(id self, SEL selector) {
    NSAlert *alert = self;
    lastConfirmation = @{ @"message": alert.messageText, @"detail": alert.informativeText,
        @"buttons": [alert.buttons valueForKey:@"title"] };
    return confirmationResponse;
}
static WKWebView *findWebView(NSView *view) {
    if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
    for (NSView *child in view.subviews) { WKWebView *result = findWebView(child); if (result) return result; }
    return nil;
}
static void reply(NSDictionary *request, id value, NSError *error) {
    NSDictionary *result = error ? @{ @"id": request[@"id"], @"error": error.localizedDescription } : @{ @"id": request[@"id"], @"value": value ?: NSNull.null };
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:nil];
    if (!json) json = [NSJSONSerialization dataWithJSONObject:@{ @"id": request[@"id"], @"error": @"Non-JSON native result" } options:0 error:nil];
    @synchronized (testOutput) {
        [testOutput writeData:json];
        [testOutput writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    }
}
static void command(NSDictionary *request) {
    WKWebView *webView = nil;
    for (NSWindow *window in NSApp.windows) { webView = findWebView(window.contentView); if (webView) break; }
    NSString *action = request[@"action"];
    if ([action isEqual:@"evaluate"]) {
        if (!webView) { reply(request, nil, [NSError errorWithDomain:@"test" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Native WebKit window unavailable"}]); return; }
        [webView callAsyncJavaScript:request[@"script"] arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) { reply(request, value, error); }];
    } else if ([action isEqual:@"menus"]) {
        NSStatusItem *item = [(NSObject *)NSApp.delegate valueForKey:@"statusItem"];
        NSMutableArray *titles = [NSMutableArray array];
        for (NSMenuItem *entry in item.menu.itemArray) if (!entry.separatorItem) [titles addObject:entry.title];
        NSMutableDictionary *commands = [NSMutableDictionary dictionary];
        for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
            [top.submenu update];
            commands[top.title] = top.submenu ? [top.submenu.itemArray filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"separatorItem == NO"]] : @[];
            commands[top.title] = [commands[top.title] valueForKey:@"title"];
        }
        reply(request, @{ @"tray": titles, @"app": [NSApp.mainMenu.itemArray valueForKey:@"title"], @"commands": commands }, nil);
    } else if ([action isEqual:@"window"]) {
        if ([request[@"mode"] isEqual:@"close"]) [webView.window performClose:nil];
        if ([request[@"mode"] isEqual:@"minimize"]) [webView.window performMiniaturize:nil];
        if ([request[@"mode"] isEqual:@"reopen"]) {
            [NSWorkspace.sharedWorkspace openApplicationAtURL:NSBundle.mainBundle.bundleURL configuration:NSWorkspaceOpenConfiguration.configuration completionHandler:^(NSRunningApplication *app, NSError *error) {
                reply(request, @(app.processIdentifier == getpid()), error);
            }];
            return;
        }
        reply(request, @{ @"visible": @(webView.window.visible != NO), @"minimized": @(webView.window.miniaturized != NO) }, nil);
    } else if ([action isEqual:@"runningApps"]) {
        NSArray *foreground = [NSRunningApplication runningApplicationsWithBundleIdentifier:NSBundle.mainBundle.bundleIdentifier];
        NSArray *background = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"io.github.danvilig.codex-remote-web.background"];
        reply(request, @{ @"pid": @(getpid()), @"foreground": [foreground valueForKey:@"processIdentifier"], @"backgroundPolicies": [background valueForKey:@"activationPolicy"] }, nil);
    } else if ([action isEqual:@"confirmation"]) {
        if (request[@"response"]) confirmationResponse = [request[@"response"] boolValue] ? NSAlertSecondButtonReturn : NSAlertFirstButtonReturn;
        reply(request, lastConfirmation ?: NSNull.null, nil);
    } else if ([action isEqual:@"quit"]) {
        // Invoke the real tray menu action rather than terminating the PID.
        NSStatusItem *item = [(NSObject *)NSApp.delegate valueForKey:@"statusItem"];
        NSMenuItem *quit = item.menu.itemArray.lastObject;
        reply(request, @YES, nil);
        [NSApp sendAction:quit.action to:quit.target from:quit];
    } else if ([action isEqual:@"snapshot"]) {
        [webView takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) {
            if (error) { reply(request, nil, error); return; }
            NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            NSError *writeError = nil; [png writeToFile:request[@"path"] options:NSDataWritingAtomic error:&writeError];
            reply(request, @YES, writeError);
        }];
    } else if ([action isEqual:@"geometry"]) {
        NSRect frame = [webView.window convertRectToScreen:[webView convertRect:webView.bounds toView:nil]];
        NSRect screen = webView.window.screen.frame;
        reply(request, @{ @"left": @(NSMinX(frame)), @"top": @(NSMaxY(screen)-NSMaxY(frame)), @"screenWidth": @(NSWidth(screen)) }, nil);
    } else if ([action isEqual:@"security"]) {
        reply(request, @{ @"persistent": @(webView.configuration.websiteDataStore.persistent), @"url": webView.URL.absoluteString ?: @"", @"inspectable": @(webView.inspectable) }, nil);
    } else { reply(request, nil, [NSError errorWithDomain:@"test" code:2 userInfo:@{NSLocalizedDescriptionKey:@"Unknown test command"}]); }
}
__attribute__((constructor)) static void loadNativeTestDriver(void) {
    @autoreleasepool {
        if (![NSBundle.mainBundle.bundleIdentifier isEqual:@"io.github.danvilig.codex-remote-web"] || [NSProcessInfo.processInfo.arguments containsObject:@"--background-agent"]) return;
        const char *path = getenv("CRW_NATIVE_TEST_SOCKET");
        struct sockaddr_un address = { .sun_family = AF_UNIX };
        if (!path || strlcpy(address.sun_path, path, sizeof(address.sun_path)) >= sizeof(address.sun_path)) return;
        int connection = socket(AF_UNIX, SOCK_STREAM, 0);
        if (connection < 0) return;
        if (connect(connection, (struct sockaddr *)&address, SUN_LEN(&address))) { close(connection); return; }
        testOutput = [[NSFileHandle alloc] initWithFileDescriptor:connection closeOnDealloc:YES];
        Method modal = class_getInstanceMethod(NSAlert.class, @selector(runModal));
        method_setImplementation(modal, (IMP)testAlert);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            @autoreleasepool {
                FILE *input = fdopen(dup(connection), "r"); char *line = NULL; size_t capacity = 0;
                while (getline(&line, &capacity, input) > 0) {
                    NSData *data = [NSData dataWithBytes:line length:strlen(line)];
                    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                    if (request) dispatch_async(dispatch_get_main_queue(), ^{ command(request); });
                }
                free(line); fclose(input);
            }
        });
    }
}
