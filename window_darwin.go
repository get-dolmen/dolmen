//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// The web top bar is 52pt tall on macOS. AppKit puts the traffic lights in
// the top-left corner of a 28pt title bar, so we place them ourselves (the
// approach Electron uses for trafficLightPosition): grow the title bar
// container to the bar's height, then centre the buttons vertically with a
// comfortable left inset. AppKit lays the title bar out again on resize,
// focus and full-screen changes, so the placement is re-applied then.
static const CGFloat kDolmenBarHeight = 52;
static const CGFloat kDolmenInsetX = 20;

static void dolmenPlaceButtons(NSWindow *window) {
	NSButton *close = [window standardWindowButton:NSWindowCloseButton];
	NSButton *minimize = [window standardWindowButton:NSWindowMiniaturizeButton];
	NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
	if (!close || !minimize || !zoom || (window.styleMask & NSWindowStyleMaskFullScreen)) {
		return;
	}
	NSView *container = close.superview.superview; // NSTitlebarContainerView
	if (container) {
		NSRect containerFrame = container.frame;
		containerFrame.size.height = kDolmenBarHeight;
		containerFrame.origin.y = NSHeight(window.frame) - kDolmenBarHeight;
		container.frame = containerFrame;
	}
	CGFloat gap = NSMinX(minimize.frame) - NSMinX(close.frame);
	if (gap <= 0 || gap > 40) {
		gap = 20;
	}
	CGFloat parentHeight = NSHeight(close.superview.frame);
	NSArray<NSButton *> *buttons = @[ close, minimize, zoom ];
	for (NSUInteger index = 0; index < buttons.count; index++) {
		NSButton *button = buttons[index];
		[button setFrameOrigin:NSMakePoint(kDolmenInsetX + index * gap, (parentHeight - NSHeight(button.frame)) / 2)];
	}
}

static void dolmenStyleWindows(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		static BOOL observing = NO;
		for (NSWindow *window in [NSApp windows]) {
			if (![window isKindOfClass:[NSWindow class]] || [window standardWindowButton:NSWindowCloseButton] == nil) {
				continue;
			}
			dolmenPlaceButtons(window);
			if (observing) {
				continue;
			}
			NSNotificationCenter *notificationCenter = [NSNotificationCenter defaultCenter];
			NSArray *names = @[
				NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification,
				NSWindowDidExitFullScreenNotification, NSWindowDidBecomeKeyNotification,
				NSWindowDidResignKeyNotification, NSWindowDidChangeBackingPropertiesNotification,
			];
			for (NSNotificationName name in names) {
				[notificationCenter addObserverForName:name object:window queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *notification) {
					dolmenPlaceButtons((NSWindow *)notification.object);
				}];
			}
		}
		observing = YES;
	});
}
*/
import "C"

func styleWindow() { C.dolmenStyleWindows() }
