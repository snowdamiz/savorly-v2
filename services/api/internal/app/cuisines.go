package app

import (
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// The app's cuisine shelves (apps/mobile/src/lib/cuisines.ts); keep the two lists in step.
var cuisines = []string{
	"Italian", "French", "Russian", "Japanese", "Mexican", "Indian", "Chinese", "Korean", "Thai", "Greek",
	"Spanish", "Vietnamese", "Turkish", "Moroccan", "Ethiopian", "Jamaican", "Brazilian", "Peruvian",
	"Indonesian", "Filipino", "American", "Ukrainian", "Georgian", "Polish", "German", "British",
	"Portuguese", "Lebanese", "Iranian", "Nigerian", "Malaysian", "Argentinian",
	"Mediterranean", "Asian", "Middle Eastern", "Caribbean", "Other",
}

var cuisineSpelling = func() map[string]string {
	m := make(map[string]string, len(cuisines))
	for _, c := range cuisines {
		m[strings.ToLower(c)] = c
	}
	return m
}()

// normalizeCuisine stores a listed cuisine in the app's spelling, so "italian" from the
// sous-chef or an API client lands on the Italian shelf; anything else is tidied to title case.
func normalizeCuisine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if c, ok := cuisineSpelling[strings.ToLower(s)]; ok {
		return c
	}
	return cases.Title(language.Und).String(s)
}
