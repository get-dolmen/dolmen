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

static void dolmenPlaceButtons(NSWindow *w) {
	NSButton *close = [w standardWindowButton:NSWindowCloseButton];
	NSButton *mini = [w standardWindowButton:NSWindowMiniaturizeButton];
	NSButton *zoom = [w standardWindowButton:NSWindowZoomButton];
	if (!close || !mini || !zoom || (w.styleMask & NSWindowStyleMaskFullScreen)) {
		return;
	}
	NSView *container = close.superview.superview; // NSTitlebarContainerView
	if (container) {
		NSRect cf = container.frame;
		cf.size.height = kDolmenBarHeight;
		cf.origin.y = NSHeight(w.frame) - kDolmenBarHeight;
		container.frame = cf;
	}
	CGFloat gap = NSMinX(mini.frame) - NSMinX(close.frame);
	if (gap <= 0 || gap > 40) {
		gap = 20;
	}
	CGFloat parentH = NSHeight(close.superview.frame);
	NSArray<NSButton *> *buttons = @[ close, mini, zoom ];
	for (NSUInteger i = 0; i < buttons.count; i++) {
		NSButton *b = buttons[i];
		[b setFrameOrigin:NSMakePoint(kDolmenInsetX + i * gap, (parentH - NSHeight(b.frame)) / 2)];
	}
}

static void dolmenStyleWindows(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		static BOOL observing = NO;
		for (NSWindow *w in [NSApp windows]) {
			if (![w isKindOfClass:[NSWindow class]] || [w standardWindowButton:NSWindowCloseButton] == nil) {
				continue;
			}
			dolmenPlaceButtons(w);
			if (observing) {
				continue;
			}
			NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
			NSArray *names = @[
				NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification,
				NSWindowDidExitFullScreenNotification, NSWindowDidBecomeKeyNotification,
				NSWindowDidResignKeyNotification, NSWindowDidChangeBackingPropertiesNotification,
			];
			for (NSNotificationName name in names) {
				[nc addObserverForName:name object:w queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *n) {
					dolmenPlaceButtons((NSWindow *)n.object);
				}];
			}
		}
		observing = YES;
	});
}
*/
import "C"

func styleWindow() { C.dolmenStyleWindows() }
