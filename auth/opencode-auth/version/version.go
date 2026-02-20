// Package version provides semver parsing, comparison, and update checking
// for the opencode-auth CLI client.
package version

import (
	"fmt"
	"strconv"
	"strings"
)

// Semver holds a parsed semantic version.
type Semver struct {
	Major int
	Minor int
	Patch int
}

// String returns the semver as "major.minor.patch".
func (s Semver) String() string {
	return fmt.Sprintf("%d.%d.%d", s.Major, s.Minor, s.Patch)
}

// Parse parses a version string like "1.2.3" or "v1.2.3" into a Semver.
// Returns an error if the string is not a valid semver.
func Parse(v string) (Semver, error) {
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return Semver{}, fmt.Errorf("invalid semver: %q (expected major.minor.patch)", v)
	}

	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return Semver{}, fmt.Errorf("invalid major version %q: %w", parts[0], err)
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return Semver{}, fmt.Errorf("invalid minor version %q: %w", parts[1], err)
	}

	// Patch may have pre-release suffix (e.g., "3-beta"); strip it
	patchStr := parts[2]
	if idx := strings.IndexAny(patchStr, "-+"); idx >= 0 {
		patchStr = patchStr[:idx]
	}
	patch, err := strconv.Atoi(patchStr)
	if err != nil {
		return Semver{}, fmt.Errorf("invalid patch version %q: %w", parts[2], err)
	}

	return Semver{Major: major, Minor: minor, Patch: patch}, nil
}

// Compare compares two version strings.
// Returns -1 if a < b, 0 if a == b, 1 if a > b.
// Returns an error if either string is not a valid semver.
func Compare(a, b string) (int, error) {
	va, err := Parse(a)
	if err != nil {
		return 0, fmt.Errorf("parsing version a: %w", err)
	}
	vb, err := Parse(b)
	if err != nil {
		return 0, fmt.Errorf("parsing version b: %w", err)
	}

	if va.Major != vb.Major {
		if va.Major < vb.Major {
			return -1, nil
		}
		return 1, nil
	}
	if va.Minor != vb.Minor {
		if va.Minor < vb.Minor {
			return -1, nil
		}
		return 1, nil
	}
	if va.Patch != vb.Patch {
		if va.Patch < vb.Patch {
			return -1, nil
		}
		return 1, nil
	}
	return 0, nil
}

// IsDev returns true if the version string is "dev" (development build).
func IsDev(v string) bool {
	return v == "dev" || v == ""
}
