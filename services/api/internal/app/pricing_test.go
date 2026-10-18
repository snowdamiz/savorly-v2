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
	"clip":      ai.GenerationEstimate("clip"),  // a step clip, reserved and never settled like a photo
	"narration": 0.012,                          // a ~300-character step at $0.04 per 1K characters
}

// A hands-free cooking question: about 1,500 tokens in (instructions, the recipe, the step and the
// question) and 150 out, reasoning included, at GPT-6 Luna's fast tier plus OpenRouter's 5.5% fee,
// rounded up. Each one settles to the provider's reported cost.
const cookQuestionCost = 0.0005

// A member who uses every allowance costs at most their plan's SpendCap, and that stays
// under 65% of what the cheaper billing interval nets after fees. The rest pays for fixed
// costs, free use, and a store link-out fee should Apple win one in court.
func TestPlansStayCashPositive(t *testing.T) {
	for _, p := range plans {
		allowances := float64(p.Assistant)*unitCost["assistant"] + float64(p.VoiceMinutes)*unitCost["voice"] +
			float64(p.Images)*unitCost["image"] + float64(p.Videos)*unitCost["clip"] + float64(p.Narration)*unitCost["narration"] +
			float64(p.CookQuestions)*cookQuestionCost
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
	// A step clip is four seconds of Seedance 2.0 Mini Eco at $0.036 a second.
	if ai.GenerationEstimate("image") < 0.02 || ai.GenerationEstimate("clip") < 4*0.036 || ai.GenerationEstimate("video") < 4*0.036 {
		t.Error("an image or clip reservation is below what the provider charges")
	}
}

// Cooking questions are cheap enough to include by the hundred: the planning cost covers a
// typical question at list price, and a typical question's reservation, which counts every byte
// as a token, stays around a tenth of a cent.
func TestCookQuestionsCostWhatThePlansAssume(t *testing.T) {
	fast := func(in, out float64) float64 { return (in*0.20 + out*1.0) / 1e6 * 1.055 }
	if typical := fast(1500, 150); typical > cookQuestionCost {
		t.Errorf("a typical question costs $%.5f, over the $%.4f the plans assume", typical, cookQuestionCost)
	}
	r := &sceneRecipe{title: "Spaghetti al pomodoro", author: "Robin", servings: 4, minutes: 30}
	for range 10 {
		r.ingredients = append(r.ingredients, Ingredient{Name: "San Marzano tomatoes", Amount: 400, Unit: "g"})
	}
	for range 8 {
		r.steps = append(r.steps, Step{Title: "Simmer", Text: "Simmer the sauce gently for twenty minutes, stirring now and then so it doesn't catch.", Seconds: 1200})
	}
	q := ai.CookQuestion{Recipe: r.text(), Step: cookStep(r, 3), Question: "how do I know when the sauce is thick enough", Language: "English"}
	if reserved := q.Estimate(); reserved < cookQuestionCost || reserved > 0.0015 {
		t.Errorf("a typical question reserves $%.5f", reserved)
	}
	// Even the longest question reserves well under a cent.
	if most := (float64(ai.CookQuestionMaxPromptBytes)*0.20 + ai.CookAnswerTokens) / 1e6 * 1.055; most > 0.01 {
		t.Errorf("the longest question reserves $%.4f", most)
	}
}
