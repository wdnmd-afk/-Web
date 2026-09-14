package app

import (
	"net/http"

	"juku/internal/webui"
)

var uiHTML = webui.HTML

func playbackAssets() http.Handler {
	return http.StripPrefix("/assets/", http.FileServer(http.FS(webui.PlayerAssets)))
}
