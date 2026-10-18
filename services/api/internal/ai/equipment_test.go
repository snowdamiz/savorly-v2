package ai

import (
	"fmt"
	"slices"
	"testing"
)

func TestCheckEquipmentKeepsWhatTheRequestOffers(t *testing.T) {
	r := EquipmentRecipe{
		Title: "Pesto linguine",
		Steps: []EquipmentStep{{Step: 1, Text: "Blend the basil."}, {Step: 2, Text: "Cook the linguine in salted boiling water."}, {Step: 3, Text: "Toss."}},
		Keys:  []string{"pot", "blender", "colander"},
	}
	got := CheckEquipment(r, []EquipmentGuess{
		{Key: "blender", Steps: []int{1}},
		{Key: "pot", Steps: []int{3, 2, 2, 9, 0}}, // out of order, repeated, and steps it hasn't
		{Key: "blender", Steps: []int{2}},         // a second answer for one piece
		{Key: "sous vide circulator", Steps: []int{2}},
		{Key: "colander", Steps: []int{7}}, // no step of this recipe
	})
	want := []EquipmentGuess{{Key: "blender", Steps: []int{1}}, {Key: "pot", Steps: []int{2, 3}}}
	if len(got) != len(want) {
		t.Fatalf("checked %+v", got)
	}
	for i := range want {
		if got[i].Key != want[i].Key || !slices.Equal(got[i].Steps, want[i].Steps) {
			t.Fatalf("checked %+v, want %+v", got, want)
		}
	}
	if r.Estimate() <= 0 || r.Estimate() > 0.005 {
		t.Fatalf("estimate %v", r.Estimate())
	}
	// No more than a recipe's own list holds.
	many := EquipmentRecipe{Steps: []EquipmentStep{{Step: 1}}}
	var answer []EquipmentGuess
	for i := range 30 {
		key := fmt.Sprint("tool ", i)
		many.Keys = append(many.Keys, key)
		answer = append(answer, EquipmentGuess{Key: key, Steps: []int{1}})
	}
	if got := CheckEquipment(many, answer); len(got) != 20 {
		t.Fatalf("kept %d", len(got))
	}
}
