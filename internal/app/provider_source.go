package app

import (
	"net/http"
	"strings"
)

const sourceHongguo = "hongguo"

func canonicalProviderSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case sourceHongguo, "hongguoduanju.com", "www.hongguoduanju.com":
		return sourceHongguo
	default:
		return ""
	}
}

func splitProviderDramaID(identifier string) (source, sourceID string, ok bool) {
	identifier = strings.TrimSpace(identifier)
	source, sourceID, prefixed := strings.Cut(identifier, ":")
	if prefixed {
		if canonicalProviderSource(source) != sourceHongguo {
			return "", "", false
		}
	} else {
		sourceID = identifier
	}
	sourceID = strings.TrimSpace(strings.TrimPrefix(sourceID, "hg-series-v1:"))
	if !hongguoNumericID.MatchString(sourceID) {
		return "", "", false
	}
	return sourceHongguo, sourceID, true
}

func normalizeHongguoDrama(drama Drama) (Drama, bool) {
	if drama.Source != "" && canonicalProviderSource(drama.Source) != sourceHongguo {
		return Drama{}, false
	}
	_, sourceID, valid := splitProviderDramaID(drama.ID)
	if !valid {
		return Drama{}, false
	}
	drama.Source = sourceHongguo
	drama.SourceID = sourceID
	drama.ID = providerDramaID(sourceHongguo, sourceID)
	return drama, true
}

func onlyHongguoDramas(dramas []Drama) []Drama {
	filtered := make([]Drama, 0, len(dramas))
	seen := make(map[string]bool, len(dramas))
	for _, drama := range dramas {
		if normalized, valid := normalizeHongguoDrama(drama); valid && !seen[normalized.ID] {
			seen[normalized.ID] = true
			filtered = append(filtered, normalized)
		}
	}
	return filtered
}

func isHongguoTask(task Task) bool {
	if task.Chapter.Source != "" && canonicalProviderSource(task.Chapter.Source) != sourceHongguo {
		return false
	}
	_, _, valid := splitProviderDramaID(task.DramaID)
	return valid
}

func readHongguoIDsRequest(writer http.ResponseWriter, request *http.Request) ([]string, bool) {
	identifiers, valid := readIDsRequest(writer, request)
	if !valid {
		return nil, false
	}
	for index, identifier := range identifiers {
		_, sourceID, supported := splitProviderDramaID(identifier)
		if !supported {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "此版本仅支持红果剧集 ID"})
			return nil, false
		}
		identifiers[index] = providerDramaID(sourceHongguo, sourceID)
	}
	return identifiers, true
}
