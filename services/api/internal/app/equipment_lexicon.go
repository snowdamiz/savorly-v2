package app

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// equipmentLexicon is the equipment lexicon, one piece of equipment a line:
//
//	key | aliases
//
// Keys are English, as equipmentDetected answers them; the app names each one in the reader's
// language (src/components/Equipment.tsx). Aliases are in the app's nine languages as methods
// write them, nouns and the few verbs that can only mean the tool ("bake", "sift", "ausrollen"),
// and are folded like ingredient names (no accents, English-style plurals folded), so "Poêle" and
// "poele" are one alias; Russian cases are spelled out. An alias that is another word in another
// language carries the language it is read in ("fr:four", four in English), and is read only in
// recipes written in it; recipes that don't say their language read the English ones. The key "-"
// lists phrases that begin with an alias but name no equipment ("oven-safe", "pot roast"), which
// the longest match then swallows, as "Dutch oven" is never an oven. A bare English "pan" names
// nothing, since it may be any of the pans; one the method says more about does ("a dry pan" is a
// frying pan, "a pan of water" a saucepan, "pan-fry"). Verbs that also mean mixing by hand
// ("blend") or other things ("drain", "toast") name nothing either: the model's guess
// (equipment_guess.go) reads what a method takes for granted. Change equipmentVersion with the
// lexicon, so recipes are read again.
const equipmentLexicon = `
# Pots and pans
pot|stockpot; stock pot; soup pot; pasta pot; cooking pot; clay pot; faitout; fait-tout; grande casserole; fr:marmite; Topf; Töpfe; Kochtopf; Suppentopf; olla; olla grande; cazuela; pentola; pentole; pentolone; pt:panela; pt:panela grande; caldeirão; кастрюля; кастрюлю; кастрюле; кастрюли; кастрюлей; кастрюлька; кастрюльку; кастрюльке; 汤锅; 煮锅; 深锅; 鍋; 深鍋; 土鍋; 両手鍋; 寸胴鍋
saucepan|sauce pan; en:saucier; milk pan; pan of water; pan of boiling water; pan of salted water; pan of boiling salted water; pan of salted boiling water; pan of simmering water; pan of hot water; fr:casserole; petite casserole; Stieltopf; Kasserolle; Milchtopf; cazo; cacerola; casseruola; casseruole; pentolino; caçarola; leiteira; ковш; ковше; ковшик; ковшике; ковшом; 奶锅; 小锅; 小鍋; 片手鍋; ミルクパン
frying pan|fry pan; frypan; skillet; sauté pan; nonstick pan; non-stick pan; cast-iron pan; omelette pan; omelet pan; crepe pan; dry pan; pan fry; pan sear; poêle; poêle à frire; poêlez; sauteuse; Pfanne; Pfannen; Bratpfanne; sartén; sartenes; padella; padelle; tegame; saltapasta; frigideira; сковорода; сковороду; сковороде; сковороды; сковородой; сковородка; сковородку; сковородке; сковородки; сковородкой; сотейник; сотейнике; сотейника; сотейником; 平底锅; 煎锅; 不粘锅; フライパン
griddle|griddle pan; grill pan; plancha; poêle grill; Grillpfanne; comal; chapa; piastra; bistecchiera; bifeteira; сковорода гриль; сковороду гриль; сковороде гриль; 铁板; 鉄板; ホットプレート
wok|Wokpfanne; вок; воке; 炒锅; 中華鍋
dutch oven|french oven; casserole pot; cast-iron pot; en:braiser; cocotte; cocotte en fonte; Bräter; Schmortopf; olla de hierro; olla de hierro fundido; casseruola di ghisa; pentola di ghisa; pentola in ghisa; panela de ferro; panela de ferro fundido; казан; казане; казана; казаном; утятница; утятнице; утятницу; гусятница; гусятнице; чугунная кастрюля; чугунной кастрюле; чугунную кастрюлю; 铸铁锅; 珐琅锅; ダッチオーブン; 鋳物ホーロー鍋
roasting pan|roasting tin; roasting tray; roasting dish; plat à rôtir; lèchefrite; Bratreine; fuente para asar; bandeja para asar; rostiera; teglia da arrosto
sheet pan|baking sheet; baking tray; cookie sheet; oven tray; sheet tray; jelly roll pan; plaque de cuisson; plaque du four; plaque à pâtisserie; plaque à four; plaque allant au four; Backblech; Backbleche; Blech; Bleche; Fettpfanne; bandeja de horno; bandeja para horno; bandeja del horno; bandeja para hornear; bandeja de hornear; charola para hornear; placa de horno; lata de horno; leccarda; placca; placca da forno; tabuleiro; tabuleiro de forno; bandeja de forno; противень; противне; противня; противнем; лист для выпечки; листе для выпечки; 烤盘; 天板
baking dish|casserole dish; ovenproof dish; oven-proof dish; oven dish; gratin dish; lasagna dish; lasagne dish; lasagna pan; baking pan; plat à gratin; plat allant au four; plat à four; moule à gratin; plat à lasagnes; Auflaufform; Ofenform; Gratinform; ofenfeste Form; Lasagneform; fuente de horno; fuente para horno; fuente refractaria; refractario; asadera; pirofila; pirofile; teglia; teglie; assadeira; refratário; forma refratária; travessa refratária; форма для запекания; форму для запекания; форме для запекания; формы для запекания; жаропрочная форма; жаропрочную форму; жаропрочной форме; 焗盘; 烤碗; 耐熱皿; グラタン皿
loaf pan|loaf tin; bread pan; bread tin; moule à cake; moule à pain; Kastenform; Kastenformen; Brotbackform; molde de pan; molde para pan; molde rectangular; molde de plumcake; molde de budín; stampo da plumcake; stampo per plumcake; stampo da plum cake; stampo per pane; stampo da pane; forma de pão; forma para pão; forma de bolo inglês; форма для хлеба; форму для хлеба; форме для хлеба; форма для кекса; форму для кекса; форме для кекса; 吐司模; 吐司盒; 磅蛋糕模; パウンド型; 食パン型
cake pan|cake tin; springform; springform pan; springform tin; bundt pan; bundt tin; tube pan; sandwich tin; cake mould; cake mold; moule à gâteau; moule à manqué; moule à charnière; moule rond; moule à savarin; moule à kouglof; Springformen; Backform; Kuchenform; Tortenform; Gugelhupfform; molde para bizcocho; molde de bizcocho; molde desmontable; molde redondo; molde para tarta; molde de tarta; stampo per torte; stampo per torta; stampo da torta; stampo a cerniera; stampo apribile; stampo per ciambella; stampo da ciambella; tortiera; forma de bolo; pt:forma redonda; forma de aro removível; forma com furo; forma de furo; форма для выпечки; форму для выпечки; форме для выпечки; разъемная форма; разъемную форму; разъемной форме; форма для торта; форму для торта; форме для торта; 蛋糕模; 活底模; 戚风模; ケーキ型; シフォン型; スポンジ型
pie dish|pie plate; pie pan; pie tin; tart pan; tart tin; tart ring; quiche dish; flan dish; moule à tarte; moule à quiche; moule à tartelette; cercle à tarte; Tarteform; Quicheform; Pieform; Tarteletteform; molde para pay; molde para quiche; molde de tartaleta; tartera; stampo per crostata; stampo da crostata; tortiera per crostata; stampo per quiche; forma de torta; forma de quiche; forma de fundo removível; форма для пирога; форму для пирога; форме для пирога; форма для тарта; форму для тарта; форме для тарта; 派盘; 塔模; タルト型; パイ皿
muffin pan|muffin tin; muffin tray; cupcake pan; cupcake tin; cupcake tray; moule à muffins; moule à cupcakes; Muffinform; Muffinformen; Muffinblech; molde para muffins; molde de muffins; molde para magdalenas; molde para cupcakes; bandeja para muffins; stampo per muffin; stampo da muffin; teglia per muffin; forma de muffin; forma para muffin; forma de cupcake; форма для маффинов; форму для маффинов; форме для маффинов; формочки для маффинов; формочки для кексов; формочках для кексов; формочки для капкейков; 玛芬模; 麦芬模; 马芬模; マフィン型

# Appliances
oven|bake; broil; broiler; toaster oven; convection oven; fr:four; grille du four; enfourner; enfournez; Ofen; Backofen; Backrohr; backen; Umluft; Oberhitze; Unterhitze; Ober- und Unterhitze; horno; hornear; hornea; hornee; forno; infornare; infornate; inforna; духовка; духовку; духовке; духовки; духовкой; духовой шкаф; духовом шкафу; духового шкафа; 烤箱; 焗炉; オーブン; オーブンレンジ; オーブントースター
grill|barbecue; barbeque; bbq; grill grate; gril; Grillrost; grillen; parrilla; barbacoa; griglia; grelha; churrasqueira; гриль; гриле; гриля; мангал; мангале; мангала; 烤架; 烧烤架; グリル; 魚焼きグリル
slow cooker|crockpot; crock pot; crock-pot; mijoteuse; Slowcooker; Schongarer; olla de cocción lenta; olla lenta; pentola a cottura lenta; panela de cozimento lento; panela elétrica; мультиварка; мультиварку; мультиварке; мультиварки; мультиваркой; медленноварка; 慢炖锅; 电炖锅; スロークッカー
pressure cooker|instant pot; instantpot; multicooker; multi-cooker; pressure cook; autocuiseur; cocotte-minute; Schnellkochtopf; Dampfkochtopf; olla a presión; olla exprés; olla express; olla rápida; olla programable; pentola a pressione; panela de pressão; panela elétrica de pressão; panela de pressão elétrica; скороварка; скороварку; скороварке; скороварки; 高压锅; 压力锅; 圧力鍋; 電気圧力鍋
air fryer|airfryer; air fry; air-fry; friteuse à air; friteuse sans huile; Heißluftfritteuse; Heißluftfriteuse; freidora de aire; freidora sin aceite; friggitrice ad aria; fritadeira elétrica; fritadeira sem óleo; аэрогриль; аэрогриле; аэрогриля; аэрофритюрница; аэрофритюрнице; 空气炸锅; エアフライヤー; ノンフライヤー
deep fryer|deep-fat fryer; fryer; friteuse; Fritteuse; freidora; friggitrice; fritadeira; фритюрница; фритюрнице; фритюрницу; 油炸锅; フライヤー
microwave|microwave oven; micro-ondes; four à micro-ondes; Mikrowelle; microondas; horno de microondas; horno microondas; microonde; forno a microonde; micro-ondas; forno de micro-ondas; forno micro-ondas; микроволновка; микроволновку; микроволновке; микроволновки; микроволновая печь; микроволновую печь; микроволновой печи; свч; 微波炉; 電子レンジ; レンジ
rice cooker|cuiseur à riz; cuiseur de riz; Reiskocher; arrocera; olla arrocera; cuociriso; panela de arroz; panela elétrica de arroz; рисоварка; рисоварке; рисоварку; 电饭煲; 电饭锅; 炊飯器
steamer|steamer basket; bamboo steamer; steaming basket; cuit-vapeur; panier vapeur; panier à vapeur; couscoussier; Dampfgarer; Dampfeinsatz; Dämpfeinsatz; Dampfkorb; vaporera; cesta de vapor; vaporiera; cestello per il vapore; cestello a vapore; panela a vapor; panela de vapor; cesto de cozimento a vapor; пароварка; пароварке; пароварку; пароварки; 蒸锅; 蒸笼; 蒸し器; せいろ; 蒸籠

# Blending and mixing
blender|high-speed blender; countertop blender; liquidizer; Vitamix; mixeur; Standmixer; de:mixer; Hochleistungsmixer; licuadora; batidora de vaso; frullatore; liquidificador; блендер; блендере; блендером; блендера; стационарный блендер; стационарном блендере; 搅拌机; 料理机; 破壁机; ミキサー
immersion blender|stick blender; hand blender; handheld blender; mixeur plongeant; mixeur à main; Stabmixer; Pürierstab; Puerierstab; Zauberstab; batidora de mano; batidora de brazo; batidora de inmersión; minipimer; frullatore a immersione; frullatore ad immersione; mixer a immersione; pt:mixer; mixer de mão; mixer de imersão; погружной блендер; погружным блендером; погружного блендера; погружном блендере; 手持搅拌棒; 料理棒; 手持料理棒; ハンドブレンダー; スティックミキサー; ブレンダー
food processor|mini chopper; food chopper; robot culinaire; robot ménager; robot mixeur; hachoir; mini-hachoir; Zerkleinerer; Multizerkleinerer; Foodprocessor; Universalzerkleinerer; Blitzhacker; procesador de alimentos; procesador de comida; procesadora; picadora; robot de cocina; robot da cucina; tritatutto; processador; processador de alimentos; multiprocessador; кухонный комбайн; кухонном комбайне; кухонного комбайна; кухонным комбайном; комбайн; комбайне; комбайна; комбайном; измельчитель; измельчителе; измельчителем; чоппер; чоппере; 食物处理器; 食品加工机; フードプロセッサー; フープロ
stand mixer|KitchenAid; Kitchen Aid; dough hook; paddle attachment; whisk attachment; flat beater; robot pâtissier; batteur sur socle; robot pétrisseur; Küchenmaschine; Knetmaschine; Teigknetmaschine; batidora amasadora; amasadora; batidora planetaria; batidora de pie; planetaria; impastatrice; impastatrice planetaria; batedeira planetária; планетарный миксер; планетарном миксере; планетарного миксера; планетарным миксером; тестомес; тестомесе; 厨师机; スタンドミキサー
hand mixer|electric mixer; electric beaters; electric whisk; hand-held mixer; handheld mixer; en:mixer; batteur électrique; batteur; fouet électrique; Handmixer; Handrührgerät; Rührgerät; batidora de varillas; batidora eléctrica; sbattitore; sbattitore elettrico; fruste elettriche; frusta elettrica; batedeira; batedeira elétrica; batedeira de mão; миксер; миксером; миксера; миксере; 电动打蛋器; 打蛋机; ハンドミキサー
whisk|balloon whisk; fouet; Schneebesen; batidor; batidor de globo; batidor de varillas; varillas; batidor manual; frusta; fruste; frustino; batedor; batedor de arame; batedor manual; венчик; венчиком; венчика; 打蛋器; 手动打蛋器; 蛋抽; 泡立て器; ホイッパー

# Tools
grater|box grater; microplane; zester; en:grate; fr:râpe; râpe à fromage; râpez; zesteur; Reibe; Küchenreibe; Reibeisen; Raspel; Muskatreibe; rallador; rallar; ralle; grattugia; grattugiare; grattugiate; ralador; ralar; терка; терку; терке; теркой; терки; натереть; натрите; 擦丝器; 刨丝器; 擦子; 礤床; おろし金; おろし器; グレーター; チーズおろし
mandoline|mandolin; mandoline slicer; Gemüsehobel; Hobel; mandolina; affettaverdure; fatiador; мандолина; мандолине; овощерезка; овощерезке; слайсер; 切片器; 刨片器; スライサー
rolling pin|roll out; rouleau à pâtisserie; rouleau à pâte; Nudelholz; Teigrolle; Wellholz; ausrollen; rodillo; rodillo de cocina; uslero; palote; mattarello; matterello; rolo de massa; rolo de macarrão; скалка; скалкой; скалку; раскатать; раскатайте; 擀面杖; めん棒; 麺棒
sieve|fine-mesh sieve; strainer; sifter; sift; tamis; passoire fine; tamiser; tamisez; Sieb; Haarsieb; Mehlsieb; tamiz; tamizar; tamice; colador; colador fino; cernidor; setaccio; setacciare; setacciate; colino; peneira; peneirar; coador; сито; сита; сите; ситом; ситечко; ситечке; ситечком; просеять; просейте; 筛子; 筛网; 过筛; 滤网; ふるい; こし器; 茶こし
colander|passoire; Nudelsieb; Durchschlag; Seiher; Abtropfsieb; escurridor; escurridera; scolapasta; colapasta; escorredor; дуршлаг; дуршлаге; дуршлага; дуршлагом; 沥水篮; 漏盆; ザル; ざるに; ざるで
thermometer|meat thermometer; candy thermometer; probe thermometer; instant-read thermometer; thermomètre; Küchenthermometer; Bratenthermometer; termómetro; termômetro; термометр; термометром; термометра; градусник; 温度计; 探针温度计; 温度計
kitchen scale|digital scale; food scale; balance de cuisine; fr:balance; Küchenwaage; Waage; báscula; báscula de cocina; balanza; bilancia; bilancia da cucina; balança; balança de cozinha; весы; весах; кухонные весы; кухонных весах; 厨房秤; 电子秤; キッチンスケール; スケール; はかり
mortar and pestle|pestle and mortar; mortar; pestle; mortier; mortier et pilon; Mörser; Stößel; mortero; molcajete; almirez; mortaio; pestello; pilão; almofariz; ступка; ступке; ступку; ступкой; пестик; 研钵; 擂钵; 捣臼; すり鉢; すりこぎ

# Phrases that start with an alias and name no equipment
-|pot roast; pot pie; pot sticker; pot holder; hot pot; pot de; fr:pot; oven safe; oven proof; oven mitt; oven glove; microwave safe; microwave proof; no-bake; petit four; carta forno; carta da forno; papel de horno; papel para horno; オーブンシート; オーブンペーパー; オレンジ; アレンジ; チャレンジ; 鍋料理; 鍋物
`

// ignoredEquipment is the key of phrases that name no equipment.
const ignoredEquipment = "-"

var (
	equipmentKeys       []string                         // in lexicon order
	equipmentAliases    = map[string]string{}            // cleaned alias → key, read in any language
	equipmentInLanguage = map[string]map[string]string{} // language → cleaned alias → key, read only in it
	equipmentLongest    int                              // the most words in an alias
	equipmentCJKLongest int                              // the most runes in an alias written without spaces
)

// equipmentLexiconProblems lists what the lexicon got wrong at load (an alias of two keys, one that
// cleans to nothing), which a test reports; the first entry wins.
var equipmentLexiconProblems []string

func init() { loadEquipmentLexicon(equipmentLexicon) }

func loadEquipmentLexicon(text string) {
	problem := func(format string, args ...any) {
		equipmentLexiconProblems = append(equipmentLexiconProblems, fmt.Sprintf(format, args...))
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, aliases, ok := strings.Cut(line, "|")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			problem("bad line %q", line)
			continue
		}
		if key != ignoredEquipment {
			if slices.Contains(equipmentKeys, key) {
				problem("key %q twice", key)
				continue
			}
			equipmentKeys = append(equipmentKeys, key)
			aliases = key + ";" + aliases
		}
		for _, alias := range strings.Split(aliases, ";") {
			if alias = strings.TrimSpace(alias); alias == "" {
				continue
			}
			table := equipmentAliases
			if language, rest, tagged := strings.Cut(alias, ":"); tagged && recipeLanguages[language] {
				if equipmentInLanguage[language] == nil {
					equipmentInLanguage[language] = map[string]string{}
				}
				table, alias = equipmentInLanguage[language], rest
			}
			phrase := equipmentPhrase(alias)
			if phrase == "" {
				problem("alias %q of %q cleans to nothing", alias, key)
				continue
			}
			if other, ok := table[phrase]; ok && other != key {
				problem("alias %q (%q) is both %q and %q", alias, phrase, other, key)
				continue
			}
			table[phrase] = key
			if r, _ := utf8.DecodeRuneInString(phrase); cjk(r) {
				equipmentCJKLongest = max(equipmentCJKLongest, utf8.RuneCountInString(phrase))
			} else {
				equipmentLongest = max(equipmentLongest, len(strings.Fields(phrase)))
			}
		}
	}
}
