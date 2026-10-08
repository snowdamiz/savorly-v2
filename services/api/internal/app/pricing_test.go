package app

import (
	"testing"

	"savorly/api/internal/ai"
)

// Conservative planning costs including OpenRouter's credit fee. Keep the existing
// assistant allowance as headroom with GPT-6 Luna; sources are in docs/PRICING.md.
var unitCost = map[string]float64{
	"assistant": 0.025,                          // planning allowance; actual turns settle to provider usage
	"voice":     0.05,                           // GPT-Live, per connected minute
	"image":     ai.GenerationEstimate("image"), // reserved and never settled, so count the reservation
	"video":     ai.GenerationEstimate("video"),
	"narration": 0.012, // a ~300-character step at $0.04 per 1K characters
}

// A member who uses every allowance costs at most their plan's SpendCap, and that stays
// under 65% of what the cheaper billing interval nets after fees. The rest pays for fixed
// costs, free use, and a store link-out fee should Apple win one in court.
func TestPlansStayCashPositive(t *testing.T) {
	for _, p := range plans {
		allowances := float64(p.Assistant)*unitCost["assistant"] + float64(p.VoiceMinutes)*unitCost["voice"] +
			float64(p.Images)*unitCost["image"] + float64(p.Videos)*unitCost["video"] + float64(p.Narration)*unitCost["narration"]
		if allowances > p.SpendCap {
			t.Errorf("%s: allowances cost $%.2f, over the $%.2f ceiling, so members would hit the ceiling first", p.ID, allowances, p.SpendCap)
		}
		if p.ID == "free" {
			if p.SpendCap > 0.50 {
				t.Errorf("free: a free member may cost up to $%.2f a month", p.SpendCap)
			}
			continue
		}
		net := min(p.netMonthly("monthly"), p.netMonthly("yearly"))
		if p.SpendCap > 0.65*net {
			t.Errorf("%s: worst-case AI cost $%.2f is over 65%% of its $%.2f monthly net", p.ID, p.SpendCap, net)
		}
		if p.YearlyUSD >= 12*p.MonthlyUSD {
			t.Errorf("%s: yearly billing should cost less than twelve months", p.ID)
		}
	}
	// Reservations that never settle must cover the provider's list price.
	if ai.GenerationEstimate("image") < 0.02 || ai.GenerationEstimate("video") < 1.005 {
		t.Error("an image or video reservation is below what the provider charges")
	}
}
