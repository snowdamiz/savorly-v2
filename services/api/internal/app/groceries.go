package app

import (
	"context"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// Grocery quantities are text, so people can write their own. Recipes add "<amount> <unit>":
// formatQuantity keeps that short, and parseQuantity reads it (and most hand-written amounts)
// back, so adding a recipe again tops up a line instead of repeating it.

var unitAliases = map[string]string{
	"cups": "cup", "c": "cup",
	"tablespoon": "tbsp", "tablespoons": "tbsp", "tbsps": "tbsp", "tbs": "tbsp", "tbl": "tbsp",
	"teaspoon": "tsp", "teaspoons": "tsp", "tsps": "tsp",
	"gram": "g", "grams": "g", "gr": "g", "kilogram": "kg", "kilograms": "kg", "kgs": "kg",
	"milliliter": "ml", "milliliters": "ml", "millilitre": "ml", "millilitres": "ml",
	"liter": "l", "liters": "l", "litre": "l", "litres": "l",
	"ounce": "oz", "ounces": "oz", "pound": "lb", "pounds": "lb", "lbs": "lb",
	"cloves": "clove", "slices": "slice", "pinches": "pinch", "handfuls": "handful", "sprigs": "sprig",
	"cans": "can", "pieces": "piece", "pcs": "piece", "bunches": "bunch", "balls": "ball",
}

// normalizeUnit compares units: case, plurals and abbreviations aside, "T" and "t" stay apart.
func normalizeUnit(unit string) string {
	switch unit = strings.TrimSpace(unit); unit {
	case "T":
		return "tbsp"
	case "t":
		return "tsp"
	}
	unit = strings.ToLower(strings.TrimSuffix(unit, "."))
	if u, ok := unitAliases[unit]; ok {
		return u
	}
	return unit
}

func normalizeName(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(name), " "))
}

var fractions = []struct {
	value float64
	glyph string
}{{1. / 4, "¼"}, {1. / 3, "⅓"}, {1. / 2, "½"}, {2. / 3, "⅔"}, {3. / 4, "¾"}}

// formatAmount writes at most two decimals, never an exponent; cups and spoons read in common
// fractions when the amount is close to one.
func formatAmount(x float64, unit string) string {
	switch normalizeUnit(unit) {
	case "cup", "tbsp", "tsp":
		whole, part := math.Modf(x)
		for _, f := range fractions {
			if math.Abs(part-f.value) < 0.01 {
				if whole == 0 {
					return f.glyph
				}
				return strconv.FormatFloat(whole, 'f', 0, 64) + f.glyph
			}
		}
	}
	s := strings.TrimRight(strings.TrimRight(strconv.FormatFloat(x, 'f', 2, 64), "0"), ".")
	if s == "0" && x > 0 {
		return "0.01"
	}
	return s
}

// formatQuantity is "<amount> <unit>"; an amount of zero ("salt to taste") leaves the unit alone.
func formatQuantity(amount float64, unit string) string {
	unit = strings.TrimSpace(unit)
	if amount <= 0 {
		return unit
	}
	return strings.TrimSpace(formatAmount(amount, unit) + " " + unit)
}

// A whole and a fraction ("1 1/2"), a fraction ("1/2"), or a number and/or a fraction glyph.
var quantityPattern = regexp.MustCompile(`^(?:(\d+)\s+(\d+)\s*/\s*(\d+)|(\d+)\s*/\s*(\d+)|(\d+(?:[.,]\d+)?)?\s*([¼½¾⅓⅔⅛])?)\s*(.*)$`)
var glyphs = map[string]float64{"¼": 1. / 4, "½": 1. / 2, "¾": 3. / 4, "⅓": 1. / 3, "⅔": 2. / 3, "⅛": 1. / 8}

// parseQuantity reads "1½ cup", "1 1/2 cups", "0,5 kg" or "2"; ok is false without a leading
// amount ("a pinch") or for a range ("2-3 cloves"). unit is what follows the amount.
func parseQuantity(s string) (amount float64, unit string, ok bool) {
	s = strings.TrimSpace(s)
	m := quantityPattern.FindStringSubmatch(s)
	if m == nil || strings.HasPrefix(m[8], "-") || strings.HasPrefix(m[8], "–") {
		return 0, s, false
	}
	number := func(v string) float64 { f, _ := strconv.ParseFloat(strings.Replace(v, ",", ".", 1), 64); return f }
	switch {
	case m[1] != "" || m[4] != "":
		whole, n, d := number(m[1]), number(m[2]+m[4]), number(m[3]+m[5])
		if d == 0 {
			return 0, s, false
		}
		amount = whole + n/d
	case m[6] != "" || m[7] != "":
		amount = number(m[6]) + glyphs[m[7]]
	default:
		return 0, s, false
	}
	return amount, strings.TrimSpace(m[8]), true
}

// groceryLine is something to put on the list: an amount of zero means none was given.
type groceryLine struct {
	Name, Unit, Category string
	Amount               float64
}

// groceryKey groups lines that can merge: same name and unit, and both with an amount or both without.
func groceryKey(name, unit string, counted bool) string {
	return normalizeName(name) + "\x00" + normalizeUnit(unit) + "\x00" + strconv.FormatBool(counted)
}

// addGroceries puts lines on the member's list in one transaction: their household's while
// they are in one (household.go). A line merges into an unchecked one with the same name and
// unit, summing the amounts when both have one; anything else becomes a new line. It reports
// new lines (added) and lines folded into others (merged).
func (a *App) addGroceries(ctx context.Context, owner string, lines []groceryLine) (added, merged int, err error) {
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)
	// One list changes at a time, so two quick adds can't both miss the other's lines. The
	// member's own lock comes first: joining or leaving a household takes it too.
	if err = lockList(ctx, tx, owner); err != nil {
		return 0, 0, err
	}
	household, _, err := householdOf(ctx, tx, owner)
	if err != nil {
		return 0, 0, err
	}
	if household != "" {
		if err = lockList(ctx, tx, householdKey(household)); err != nil {
			return 0, 0, err
		}
	}
	rows, err := tx.Query(ctx, `SELECT id,name,quantity FROM groceries g WHERE NOT checked AND `+groceryScope(1)+` ORDER BY created_at`, owner)
	if err != nil {
		return 0, 0, err
	}
	type entry struct {
		id, name, quantity, unit, category string
		amount                             float64
		counted, fresh, changed            bool
	}
	byKey := map[string]*entry{}
	for rows.Next() {
		var x entry
		if err = rows.Scan(&x.id, &x.name, &x.quantity); err != nil {
			rows.Close()
			return 0, 0, err
		}
		x.amount, x.unit, x.counted = parseQuantity(x.quantity)
		if k := groceryKey(x.name, x.unit, x.counted); byKey[k] == nil {
			byKey[k] = &x
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, 0, err
	}
	var order []*entry
	for _, l := range lines {
		counted := l.Amount > 0
		k := groceryKey(l.Name, l.Unit, counted)
		if x := byKey[k]; x != nil {
			merged++
			if counted {
				x.amount += l.Amount
				x.quantity, x.changed = formatQuantity(x.amount, x.unit), true
			}
			continue
		}
		category := strings.TrimSpace(l.Category)
		if category == "" {
			category = "Other"
		}
		x := &entry{id: uuid.NewString(), name: strings.TrimSpace(l.Name), unit: strings.TrimSpace(l.Unit), category: category, amount: l.Amount, counted: counted, fresh: true}
		x.quantity = formatQuantity(x.amount, x.unit)
		byKey[k] = x
		order = append(order, x)
	}
	var changedIDs, changedQuantities, ids, names, quantities, categories []string
	for _, x := range byKey {
		if x.changed && !x.fresh {
			changedIDs, changedQuantities = append(changedIDs, x.id), append(changedQuantities, x.quantity)
		}
	}
	for _, x := range order {
		ids, names, quantities, categories = append(ids, x.id), append(names, x.name), append(quantities, x.quantity), append(categories, x.category)
	}
	// One statement, whatever the number of lines.
	_, err = tx.Exec(ctx, `WITH changed AS (UPDATE groceries g SET quantity=c.quantity FROM unnest($2::text[],$3::text[]) AS c(id,quantity) WHERE g.id=c.id AND `+groceryScope(1)+`)
 INSERT INTO groceries(id,user_id,household_id,name,quantity,category) SELECT id,$1,NULLIF($8,''),name,quantity,category FROM unnest($4::text[],$5::text[],$6::text[],$7::text[]) AS items(id,name,quantity,category)`,
		owner, changedIDs, changedQuantities, ids, names, quantities, categories, household)
	if err != nil {
		return 0, 0, err
	}
	return len(order), merged, tx.Commit(ctx)
}
