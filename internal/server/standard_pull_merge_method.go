package server

import golfv1 "github.com/mjtechguy/golf-git/gen/golf/v1"

func standardPullMergeMethod(value string) (string, error) {
	switch value {
	case "", "merge":
		return "merge", nil
	case "squash":
		return "squash", nil
	}
	return "", invalid("Choose merge or squash; other integration methods are unavailable.")
}
func standardPullMergeStoredMethod(value string) string {
	// Empty records occur only in historical source fixtures; migration65 persists
	// every retained record as merge, without changing its original fingerprint.
	if value == "" {
		return "merge"
	}
	return value
}
func standardPullMergeAllowed(method string, config *golfv1.RepositoryMergeConfiguration) bool {
	normalized, err := standardPullMergeMethod(method)
	if err != nil || config == nil {
		return false
	}
	if normalized == "squash" {
		return config.AllowSquashMerge
	}
	return config.AllowMergeCommits
}
func standardPullMergeParents(method, head string, parents []string) bool {
	normalized, err := standardPullMergeMethod(method)
	if err != nil || !objectID.MatchString(head) {
		return false
	}
	if normalized == "merge" {
		if len(parents) != 2 || parents[1] != head {
			return false
		}
	} else if len(parents) != 1 {
		return false
	}
	// Squash has no H parent: this proves the acknowledged native PR's C and
	// observed first parent, not an atomic expected-base or content equivalence.
	return objectID.MatchString(parents[0]) && len(parents[0]) == len(head)
}
