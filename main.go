package main

import (
	"embed"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	dolmen := NewApp()

	app := application.New(application.Options{
		Name:        "Dolmen",
		Description: "A desktop SQL client for Oracle, Postgres, MySQL and SQLite.",
		Services: []application.Service{
			application.NewService(dolmen),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	dolmen.app = app

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Dolmen",
		Width:            1440,
		Height:           900,
		MinWidth:         900,
		MinHeight:        560,
		BackgroundColour: application.NewRGB(24, 24, 27),
		URL:              "/",
		Mac: application.MacWindow{
			// Transparent, full-size title bar without a toolbar: window_darwin.go
			// positions the traffic lights to match the 52pt web top bar.
			TitleBar: application.MacTitleBarHidden,
		},
		// On Windows the web top bar is the title bar: the window has no frame
		// (it keeps its shadow, rounded corners and resize borders), and the
		// top bar's minimise / maximise / close buttons are declared as native
		// caption buttons, so Windows handles them like its own (Snap Layouts
		// on the maximise button). That routing needs composition hosting.
		Frameless: runtime.GOOS == "windows",
		Windows: application.WindowsWindow{
			WebView2CompositionHosting: true,
		},
	})
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { styleWindow() })

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
