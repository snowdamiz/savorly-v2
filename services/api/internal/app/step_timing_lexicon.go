package app

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// timingLexicon is what the step timing reader (step_timing.go) looks for in a step's words, one
// kind of phrase a line:
//
//	kind | phrases
//
// preheat: heating the oven before it's needed. oven: putting food in the oven, beyond the oven's
// names the equipment lexicon knows ("roast", "запекайте"). out: taking it out, so the step heats
// nothing ("remove from the oven"). wait: time that needs no attention (baking, simmering,
// resting, chilling, rising, a lid on). busy: attention all along ("stirring constantly"), which
// makes a waiting step hands-on. hob: a burner (boiling, frying, "over medium heat"), besides the
// pots and pans the equipment lexicon names. side: a time for each side, so twice it. night:
// overnight, eight hours.
//
// Phrases are in the app's nine languages and folded like ingredient names (no accents, so
// "réfrigérer" is "refrigerer", and "й" is "и"). A phrase ending in * matches words that start
// with it, for verbs' many endings ("обжар*": обжарьте, обжарить). As in the equipment lexicon, a
// phrase that is another word elsewhere carries the language it is read in ("fr:sauter"), and
// recipes that don't say their language read the English ones. Phrases in Chinese and Japanese
// are found inside a run of their script. Change timingVersion with the lexicon, so recipes are
// read again.
const timingLexicon = `
preheat|preheat*; pre-heat*; heat the oven; prechauff*; vorheiz*; vorgeheizt*; den ofen vorheizen; den backofen vorheizen; precalent*; precalient*; preriscald*; pre aquec*; preaquec*; pre-aquec*; разогре* духовк*; разогре* духов* шкаф; нагре* духовк*; 预热; 預熱; 予熱; オーブンを温め
oven|roast; roasting; rotir; rotissez; rotissage; gratinieren; gratinar; gratinare; gratinate; arrostire; arrostite; arrosto; assar; asse; запек*; запеч*; выпек*; 烤
out|out of the oven; from the oven; remove from oven; take out of the oven; sortir du four; sortez du four; sortie du four; hors du four; aus dem ofen; aus dem backofen; sacar del horno; saca del horno; retirar del horno; retira del horno; fuera del horno; sfornare; sfornate; sforna; togliere dal forno; fuori dal forno; retirar do forno; retire do forno; tirar do forno; tire do forno; из духовки; 出炉; 从烤箱取出; オーブンから取り出
wait|bake; simmer*; braise*; boil; en:rest; en:resting; let stand; let it stand; let sit; leave to; let cool; cool for; cool completely; chill*; refrigerat*; fridge; marinate*; en:rise; let rise; prove; proof; soak*; steep*; let set; until set; freeze; covered; cover and; with the lid on; lid on; slow cook*; pressure cook*; poach*; steam; steaming; infuse; ferment*; thaw*; cuire; cuisez; faites cuire; cuisson; mijot*; bouillir; fremir; frem*; repos*; refroidir; laissez refroidir; tiedir; refrigerer; au frais; au refrigerateur; au frigo; mariner; laissez mariner; fr:lever; laisser lever; laissez lever; pousser; laisser pousser; tremper; faire tremper; infuser; congeler; couvrir; couvrez; a couvert; braiser; pocher; a la vapeur; decongeler; backen; garen; kochen*; kocht; kocheln*; simmern; schmor*; ruhen; abkuhl*; auskuhl*; kuhl*; kalt stellen; kuhlschrank; marinier*; gehen lassen; quellen; einweichen; ziehen lassen; einfrier*; zugedeckt; abgedeckt; deckel; dampf*; dunst*; pochier*; auftau*; hornear; hornea; hornee; cocer; cueza; cuece; hervir; hierva; hierve; enfriar; enfrie; refrigerar; nevera; marinar; marine; levar; leudar; fermentar; remojar; remojo; infusionar; congelar; congele; tapar; tape; tapado; tapada; tapa; guisar; estofar; brasear; al vapor; escalfar; descongelar; cuocere; cuocete; cuoci; cottura; infornare; infornate; inforna; bollire; bollore; sobbollire; lessare; lessate; riposare; riposo; riposate; raffreddare; fate raffreddare; intiepidire; frigorifero; frigo; marinare; lievit*; ammollo; a bagno; in infusione; congelare; coperchio; coperto; coperta; stufare; brasare; al vapore; scongelare; assar; asse; cozer; coza; ferver; ferva; descansar; descanse; repousar; esfriar; arrefecer; geladeira; frigorifico; marinar; crescer; levedar; de molho; tampa; tampar; tampe; tampado; ensopar; guisar; no vapor; escalfar; descongelar; вари*; свари*; отвари*; туши*; потуши*; томи*; кипят*; дайте постоять; постоять; настоя*; оставьте; остуд*; охлад*; холодильник*; маринов*; замарин*; подняться; расстой*; замоч*; замороз*; под крышкой; крышк*; на пару; размороз*; 烤; 炖; 焖; 煮; 蒸; 静置; 醒; 冷藏; 冰箱; 腌; 发酵; 浸泡; 冷却; 放凉; 晾凉; 冷冻; 盖上盖; 加盖; 解冻; 煲; 卤; 煮込; 煮る; 煮て; 茹で; ゆで; 蒸し; 蒸す; 蒸らす; 寝かせ; 寝かす; 休ませ; 冷ます; 冷まし; 冷やす; 冷やし; 冷蔵; 漬け; 発酵; 浸す; 浸け; 冷凍; 蓋をし; ふたをし; 解凍; 炊く; 炊い
busy|stirring constantly; stir constantly; stirring continuously; stir continuously; whisking constantly; whisk constantly; stirring often; stir often; stirring frequently; stir frequently; keep stirring; without stopping; watch closely; sans cesser; sans arret; constamment; remuer constamment; standig; unter standigem; ununterbrochen; unter ruhren; sin parar; sin dejar de; constantemente; senza smettere; continuamente; di continuo; costantemente; sem parar; mexendo sempre; sempre mexendo; постоянно; не переставая; непрерывно; все время помешивая; 不停; 不断; 持续翻炒; 一直搅拌; 絶えず; 混ぜ続け; かき混ぜ続け
hob|boil; boiling; simmer*; fry; frying; fried; deep-fry*; deep fry*; stir-fry*; stir fry*; saute*; sear*; en:brown; poach*; blanch*; bring to a boil; bring to the boil; over medium heat; over low heat; over high heat; medium heat; low heat; high heat; medium-high heat; medium-low heat; on the stove; stovetop; stove top; on the hob; heat the oil; reduce the heat; steam; steaming; bouillir; ebullition; mijot*; fremir; frire; poeler; poelez; faire revenir; faites revenir; fr:revenir; faire sauter; faites sauter; fr:sauter; blanchir; pocher; feu doux; feu moyen; feu vif; a feu; sur le feu; kochen*; aufkoch*; kocheln*; simmern; anbrat*; de:brat*; frittier*; dunst*; blanchier*; pochier*; bei mittlerer hitze; bei schwacher hitze; bei starker hitze; bei hoher hitze; bei niedriger hitze; herd; zum kochen bringen; sieden; hervir; hierva; hervor; ebullicion; a fuego; fuego; sofreir; sofria; freir; fria; frie; saltear; saltee; blanquear; escalfar; bollire; bollore; ebollizione; sobbollire; soffrigg*; soffritto; frigg*; rosol*; it:saltare; it:saltate; lessare; lessate; sbollent*; a fuoco; fuoco; fiamma; ferver; ferva; fervura; levar ao fogo; leve ao fogo; fogo; refog*; fritar; frite; escaldar; branquear; em fogo; вари*; свари*; отвари*; кипят*; вскипят*; кипени*; жарь*; жарит*; жарен*; обжар*; поджар*; пассер*; огне; огонь; на плите; плиту; бланшир*; 煮; 炒; 煎; 炸; 焯; 烧开; 煮沸; 沸腾; 大火; 中火; 小火; 文火; 煸; 爆香; 茹で; ゆで; 煮る; 煮て; 煮込; 煮立; 沸騰; 炒め; 揚げ; 弱火; 強火; とろ火; 火にかけ
side|per side; each side; on each side; on both sides; de chaque cote; par face; de chaque face; pro seite; je seite; von jeder seite; von beiden seiten; por lado; por cada lado; de cada lado; por ambos lados; per lato; per parte; su ogni lato; da ogni lato; per ogni lato; dos dois lados; с каждои стороны; с обеих сторон; 每面; 两面; 每边; 片面; 両面
night|overnight; une nuit; toute la nuit; pendant la nuit; uber nacht; toda la noche; durante la noche; una noche; tutta la notte; una notte; per una notte; durante a noite; de um dia para o outro; a noite toda; uma noite; на ночь; всю ночь; 过夜; 一夜; 一晚; 一晩
`

// The kinds of phrase timingLexicon has.
const (
	timingPreheat = "preheat"
	timingOven    = "oven"
	timingOut     = "out"
	timingWait    = "wait"
	timingBusy    = "busy"
	timingHob     = "hob"
	timingSide    = "side"
	timingNight   = "night"
)

// timingPhrase is one phrase as the reader matches it: words for spaced scripts, each a prefix
// when it ended in *, or a run of Chinese or Japanese.
type timingPhrase struct {
	kind     string
	words    []string
	prefix   []bool
	cjk      string
	language string // "" for any
}

var (
	timingPhrases []timingPhrase
	// timingLexiconProblems lists what the lexicon got wrong at load, which a test reports.
	timingLexiconProblems []string
)

func init() { loadTimingLexicon(timingLexicon) }

func loadTimingLexicon(text string) {
	kinds := map[string]bool{timingPreheat: true, timingOven: true, timingOut: true, timingWait: true, timingBusy: true, timingHob: true, timingSide: true, timingNight: true}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		kind, phrases, ok := strings.Cut(line, "|")
		if kind = strings.TrimSpace(kind); !ok || !kinds[kind] {
			timingLexiconProblems = append(timingLexiconProblems, fmt.Sprintf("bad line %q", line))
			continue
		}
		for _, phrase := range strings.Split(phrases, ";") {
			if phrase = strings.TrimSpace(phrase); phrase == "" {
				continue
			}
			p := timingPhrase{kind: kind}
			if language, rest, tagged := strings.Cut(phrase, ":"); tagged && recipeLanguages[language] {
				p.language, phrase = language, rest
			}
			if r, _ := utf8.DecodeRuneInString(phrase); cjk(r) {
				p.cjk = foldFood(phrase)
			}
			for _, word := range strings.Fields(phrase) {
				if p.cjk != "" {
					break
				}
				// "pre-heat*" is "pre" and the prefix "heat".
				words := foodWords(foldFood(strings.TrimSuffix(word, "*")))
				for i, w := range words {
					p.words = append(p.words, w)
					p.prefix = append(p.prefix, i == len(words)-1 && strings.HasSuffix(word, "*"))
				}
			}
			if p.cjk == "" && len(p.words) == 0 {
				timingLexiconProblems = append(timingLexiconProblems, fmt.Sprintf("phrase %q of %q folds to nothing", phrase, kind))
				continue
			}
			timingPhrases = append(timingPhrases, p)
		}
	}
}

// Words that name numbers, by language, folded. "a", "half" and "a few" stand for a number only
// before a unit ("an hour", "half an hour", "a few minutes").
var timingNumbers = map[string]map[string]float64{
	"en": {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "ninety": 90},
	"fr": {"un": 1, "une": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6, "sept": 7, "huit": 8, "neuf": 9, "dix": 10, "douze": 12, "quinze": 15, "vingt": 20, "trente": 30, "quarante": 40, "cinquante": 50, "soixante": 60},
	"de": {"ein": 1, "eine": 1, "einen": 1, "einer": 1, "zwei": 2, "drei": 3, "vier": 4, "funf": 5, "sechs": 6, "sieben": 7, "acht": 8, "neun": 9, "zehn": 10, "zwolf": 12, "funfzehn": 15, "zwanzig": 20, "dreissig": 30, "vierzig": 40, "funfzig": 50, "sechzig": 60, "anderthalb": 1.5, "eineinhalb": 1.5},
	"es": {"un": 1, "una": 1, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "doce": 12, "quince": 15, "veinte": 20, "treinta": 30, "cuarenta": 40, "cincuenta": 50, "sesenta": 60},
	"it": {"un": 1, "uno": 1, "una": 1, "due": 2, "tre": 3, "quattro": 4, "cinque": 5, "sei": 6, "sette": 7, "otto": 8, "nove": 9, "dieci": 10, "dodici": 12, "quindici": 15, "venti": 20, "trenta": 30, "quaranta": 40, "cinquanta": 50, "sessanta": 60},
	"pt": {"um": 1, "uma": 1, "dois": 2, "duas": 2, "tres": 3, "quatro": 4, "cinco": 5, "seis": 6, "sete": 7, "oito": 8, "nove": 9, "dez": 10, "doze": 12, "quinze": 15, "vinte": 20, "trinta": 30, "quarenta": 40, "cinquenta": 50, "sessenta": 60},
	"ru": {"один": 1, "одну": 1, "одна": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "двенадцать": 12, "пятнадцать": 15, "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50, "шестьдесят": 60, "полтора": 1.5, "полторы": 1.5},
}

// Articles that are one of a unit ("an hour"), halves ("half an hour", "et demie"), and the words
// for a few, by language.
var (
	timingArticles = map[string][]string{"en": {"a", "an"}, "fr": {"un", "une"}, "de": {"ein", "eine", "einen", "einer"}, "es": {"un", "una"}, "it": {"un", "una", "uno"}, "pt": {"um", "uma"}}
	timingHalves   = map[string][]string{"en": {"half"}, "fr": {"demi", "demie"}, "de": {"halb", "halbe", "halben"}, "es": {"media", "medio"}, "it": {"mezza", "mezz", "mezzo"}, "pt": {"meia", "meio"}}
	timingFew      = map[string][]string{"en": {"few", "couple"}, "fr": {"quelques"}, "de": {"einige", "paar"}, "es": {"unos", "unas", "algunos", "algunas"}, "it": {"qualche", "pochi", "alcuni"}, "pt": {"alguns", "algumas", "poucos"}, "ru": {"несколько", "пару"}}
	// The words between two numbers that make a range ("20 to 25").
	timingRanges = map[string][]string{"en": {"to", "or"}, "fr": {"a", "ou"}, "de": {"bis", "oder"}, "es": {"a", "o"}, "it": {"a", "o"}, "pt": {"a", "ou"}, "ru": {"до", "или"}}
	// The word before a half after a unit ("an hour and a half").
	timingAnd = map[string][]string{"en": {"and"}, "fr": {"et"}, "de": {"und"}, "es": {"y"}, "it": {"e"}, "pt": {"e"}}
)

// Units of time as words, folded, in seconds: every language's, since a unit only counts after a
// number. Some are whole amounts on their own ("полчаса", "mezzora").
var (
	timingUnits = map[string]float64{
		"hour": 3600, "hours": 3600, "hr": 3600, "hrs": 3600, "h": 3600, "heure": 3600, "heures": 3600, "stunde": 3600, "stunden": 3600, "std": 3600,
		"hora": 3600, "horas": 3600, "ora": 3600, "ore": 3600, "час": 3600, "часа": 3600, "часов": 3600, "ч": 3600,
		"minute": 60, "minutes": 60, "min": 60, "mins": 60, "mn": 60, "minuten": 60, "minuto": 60, "minutos": 60, "minuti": 60,
		"минута": 60, "минуту": 60, "минуты": 60, "минут": 60, "мин": 60, "минутку": 60,
		"second": 1, "seconds": 1, "sec": 1, "secs": 1, "seconde": 1, "secondes": 1, "sekunde": 1, "sekunden": 1, "sek": 1,
		"segundo": 1, "segundos": 1, "seg": 1, "secondo": 1, "secondi": 1, "секунда": 1, "секунду": 1, "секунды": 1, "секунд": 1, "сек": 1,
	}
	timingWholeUnits = map[string]float64{"полчаса": 1800, "mezzora": 1800, "часик": 3600}
	// Russian names an hour or a minute without a number ("варите час").
	timingBareUnits = map[string]bool{"час": true, "минуту": true, "минутку": true}
	// Units in Chinese and Japanese, longest first, after a number written either way.
	timingCJKUnits = []struct {
		unit    string
		seconds float64
	}{{"个小时", 3600}, {"個小時", 3600}, {"小时", 3600}, {"小時", 3600}, {"钟头", 3600}, {"鐘頭", 3600}, {"時間", 3600}, {"分钟", 60}, {"分鐘", 60}, {"分間", 60}, {"分", 60}, {"秒钟", 1}, {"秒鐘", 1}, {"秒", 1}}
	timingCJKNumerals = map[rune]float64{'一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100, '半': 0.5, '几': 3, '幾': 3, '数': 3, '數': 3}
)

// Words for degrees of heat, folded, and the units that may follow them.
var (
	timingDegrees    = map[string]bool{"degree": true, "degrees": true, "deg": true, "degre": true, "degres": true, "grad": true, "grado": true, "grados": true, "gradi": true, "grau": true, "graus": true, "градус": true, "градуса": true, "градусов": true, "градусах": true, "градусами": true}
	timingCelsius    = map[string]bool{"c": true, "celsius": true, "цельсия": true}
	timingFahrenheit = map[string]bool{"f": true, "fahrenheit": true, "фаренгеита": true}
	// UK gas marks in °C.
	timingGasMarks = map[int]int{1: 140, 2: 150, 3: 160, 4: 180, 5: 190, 6: 200, 7: 220, 8: 230, 9: 240}
)
