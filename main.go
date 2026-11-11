package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Dolmen",
		Width:     1440,
		Height:    900,
		MinWidth:  900,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 24, G: 24, B: 27, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnDomReady:       func(context.Context) { styleWindow() },
		Bind:             []interface{}{app},
		Mac: &mac.Options{
			// Transparent, full-size title bar without a toolbar: window_darwin.go
			// positions the traffic lights to match the 52pt web top bar.
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				FullSizeContent:            true,
			},
			About: &mac.AboutInfo{Title: "Dolmen", Message: "A desktop SQL client for Oracle, Postgres, MySQL and SQLite."},
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
