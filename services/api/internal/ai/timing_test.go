package ai

import (
	"math"
	"testing"
)

func TestCheckTimingKeepsOnlyWhatWasAsked(t *testing.T) {
	r := TimingRecipe{Title: "Stew", Minutes: 90, Steps: []TimingStep{{Step: 1, Text: "Chop.", Estimate: true}, {Step: 2, Text: "Simmer 1 hour."}, {Step: 3, Text: "Brown the meat.", Estimate: true}}}
	got := CheckTiming(r, []TimingEstimate{
		{Step: 1, Active: 10},
		{Step: 1, Active: 99},                      // a second answer for the same step
		{Step: 2, Wait: 60},                        // not asked about
		{Step: 3, Active: 8, Oven: 20, Burners: 5}, // an oven no oven has, too many burners
		{Step: 4, Active: 3},                       // no such step
		{Step: 3, Active: math.NaN()},
	})
	if len(got) != 2 || got[0] != (TimingEstimate{Step: 1, Active: 10}) || got[1] != (TimingEstimate{Step: 3, Active: 8, Burners: 2}) {
		t.Fatalf("checked %+v", got)
	}
	if got := CheckTiming(r, []TimingEstimate{{Step: 1, Active: -1}, {Step: 3, Active: 1000, Wait: 1000}}); len(got) != 0 {
		t.Fatalf("out of bounds kept: %+v", got)
	}
	if r.Estimate() <= 0 || r.Estimate() > 0.005 {
		t.Fatalf("estimate %v", r.Estimate())
	}
}
