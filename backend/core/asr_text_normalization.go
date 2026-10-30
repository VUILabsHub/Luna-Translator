package core

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	asrNumberBeforeLetter = regexp.MustCompile(`[0-9零〇一二两三四五六七八九十百千万亿点]+[A-Za-z]`)
	asrDecimalDigits      = regexp.MustCompile(`^[0-9]+$`)
	asrSmallInteger       = regexp.MustCompile(`^(?:[1-9]千)?(?:0?[1-9]百)?(?:0?[1-9]?十)?(?:0?[1-9])?$`)
	asrChineseDigits      = strings.NewReplacer(
		"零", "0", "〇", "0", "一", "1", "二", "2", "两", "2",
		"三", "3", "四", "4", "五", "5", "六", "6", "七", "7", "八", "8", "九", "9",
	)
)

// NormalizeASRAlphanumericNumbers processes a complete provider snapshot, never
// a delta against an earlier normalized result. This keeps tail revisions safe.
// Only adjacent ASCII letters trigger conversion; ordinary Chinese is untouched.
func NormalizeASRAlphanumericNumbers(text string) string {
	return asrNumberBeforeLetter.ReplaceAllStringFunc(text, func(match string) string {
		number, letter := match[:len(match)-1], match[len(match)-1:]
		// Do not guess mixed Arabic/Chinese numbers or unsupported large units.
		if strings.ContainsAny(number, "0123456789万亿") {
			return match
		}
		parts := strings.Split(asrChineseDigits.Replace(number), "点")
		if len(parts) > 2 {
			return match
		}
		integer := normalizeASRSmallInteger(parts[0])
		if integer == "" {
			return match
		}
		if len(parts) == 2 {
			if !asrDecimalDigits.MatchString(parts[1]) {
				return match
			}
			integer += "." + parts[1]
		}
		return integer + letter
	})
}

func normalizeASRSmallInteger(number string) string {
	if asrDecimalDigits.MatchString(number) {
		return number // Keep identifier leading zeros, e.g. 零零七A -> 007A.
	}
	if number == "" || !asrSmallInteger.MatchString(number) {
		return ""
	}
	total, digit, lastUnit := 0, 0, 1
	zeroGap := false
	for _, r := range number {
		if r >= '0' && r <= '9' {
			if r == '0' {
				zeroGap = true
			}
			digit = int(r - '0')
			continue
		}
		unit := 10
		if r == '百' {
			unit = 100
		}
		if r == '千' {
			unit = 1000
		}
		if digit == 0 {
			digit = 1
		} // 十 / 十三
		total += digit * unit
		digit, lastUnit, zeroGap = 0, unit, false
	}
	// 一百二 may mean 120 rather than 102; leave ambiguous colloquial forms.
	if digit != 0 && lastUnit > 10 && !zeroGap {
		return ""
	}
	return strconv.Itoa(total + digit)
}
