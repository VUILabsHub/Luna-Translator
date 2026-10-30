package core

import "testing"

func TestNormalizeASRAlphanumericNumbers(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"三D和五G，二B，三d", "3D和5G，2B，3d"},
		{"十二GB，一百零二Hz，二千零二十四K", "12GB，102Hz，2024K"},
		{"零零七A，二〇二五GPU，两D", "007A，2025GPU，2D"},
		{"三点五GHz，零点零五m", "3.5GHz，0.05m"},
		{"三个人，二十年，三维，第三章", "三个人，二十年，三维，第三章"},
		{"3D，2025GPU，3.5GHz，三 D", "3D，2025GPU，3.5GHz，三 D"},
		{"三", "三"}, {"三D", "3D"}, {"三点", "三点"},
		{"三点五", "三点五"}, {"三点五G", "3.5G"},
		{"一百二G，一万三D，十十G，三3D", "一百二G，一万三D，十十G，三3D"},
		{"", ""}, {"  三D\n五G  ", "  3D\n5G  "},
	} {
		t.Run(tc.input, func(t *testing.T) {
			got := NormalizeASRAlphanumericNumbers(tc.input)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			if again := NormalizeASRAlphanumericNumbers(got); again != got {
				t.Fatalf("not idempotent: %q -> %q", got, again)
			}
		})
	}
}
