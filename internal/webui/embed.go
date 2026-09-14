package webui

import "embed"

//go:embed index.html
var HTML string

//go:embed player.js player.css player-danmaku.js library-sort.js rankings.js library-tools.css history.js app.js windows.js context-menu.js
var PlayerAssets embed.FS
