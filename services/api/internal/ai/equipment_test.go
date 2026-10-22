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

func TestCheckEquipmentSizes(t *testing.T) {
	r := EquipmentRecipe{Steps: []EquipmentStep{{Step: 1}}, Keys: []string{"pot", "frying pan", "baking dish", "whisk", "wok", "cake pan"}}
	got := CheckEquipment(r, []EquipmentGuess{
		{Key: "pot", Steps: []int{1}, Size: &EquipmentSize{Liters: 4.8}},
		{Key: "frying pan", Steps: []int{1}, Size: &EquipmentSize{Liters: 3}},                 // measured the wrong way
		{Key: "baking dish", Steps: []int{1}, Size: &EquipmentSize{Cm: 33.2, LengthCm: 22.9}}, // long side first
		{Key: "whisk", Steps: []int{1}, Size: &EquipmentSize{Cm: 25}},                         // no size to have
		{Key: "wok", Steps: []int{1}, Size: &EquipmentSize{Cm: 300}},                          // no kitchen has one
		{Key: "cake pan", Steps: []int{1}},
	})
	want := []*EquipmentSize{{Liters: 5}, nil, {Cm: 23, LengthCm: 33}, nil, nil, nil}
	for i, w := range want {
		if g := got[i].Size; (g == nil) != (w == nil) || (g != nil && *g != *w) {
			t.Errorf("%s: %+v, want %+v", got[i].Key, g, w)
		}
	}
}
