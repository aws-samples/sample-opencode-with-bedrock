package version

import "testing"

func TestParse(t *testing.T) {
	tests := []struct {
		input   string
		want    Semver
		wantErr bool
	}{
		{"1.2.3", Semver{1, 2, 3}, false},
		{"v1.2.3", Semver{1, 2, 3}, false},
		{"0.0.1", Semver{0, 0, 1}, false},
		{"10.20.30", Semver{10, 20, 30}, false},
		{"1.2.3-beta", Semver{1, 2, 3}, false},
		{"1.2.3+build123", Semver{1, 2, 3}, false},
		{"invalid", Semver{}, true},
		{"1.2", Semver{}, true},
		{"1.2.abc", Semver{}, true},
		{"", Semver{}, true},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := Parse(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("Parse(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("Parse(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestCompare(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "2.0.0", -1},
		{"2.0.0", "1.0.0", 1},
		{"1.1.0", "1.0.0", 1},
		{"1.0.0", "1.1.0", -1},
		{"1.0.1", "1.0.0", 1},
		{"1.0.0", "1.0.1", -1},
		{"v1.2.3", "1.2.3", 0},
		{"10.0.0", "9.9.9", 1},
	}

	for _, tt := range tests {
		t.Run(tt.a+"_vs_"+tt.b, func(t *testing.T) {
			got, err := Compare(tt.a, tt.b)
			if err != nil {
				t.Errorf("Compare(%q, %q) error: %v", tt.a, tt.b, err)
				return
			}
			if got != tt.want {
				t.Errorf("Compare(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

func TestIsDev(t *testing.T) {
	if !IsDev("dev") {
		t.Error("IsDev(\"dev\") should be true")
	}
	if !IsDev("") {
		t.Error("IsDev(\"\") should be true")
	}
	if IsDev("1.0.0") {
		t.Error("IsDev(\"1.0.0\") should be false")
	}
}

func TestSemverString(t *testing.T) {
	s := Semver{1, 2, 3}
	if s.String() != "1.2.3" {
		t.Errorf("Semver.String() = %q, want %q", s.String(), "1.2.3")
	}
}
