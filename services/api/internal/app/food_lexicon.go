package app

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// foodLexicon is the ingredient lexicon, one entry a line:
//
//	key | what it is a kind of | what it is made from | its own groups | aliases
//
// Keys are English. Kinds and contents are other keys, groups are foodGroups, and aliases are in
// the app's nine languages, as cooks write them; they are folded and cleaned like ingredient names
// (no accents, no state words, English-style plurals folded), so "Crème fraîche" and "creme
// fraiche" are one alias. A line starting with ! lists words for groups themselves, as members
// write their allergies: "!milk | dairy; lactose".
//
// Longer aliases win ("peanut butter" is never butter, "noix de muscade" is nutmeg, not a nut),
// so a compound that would otherwise read wrong needs its own alias. Change foodVersion with the
// lexicon, so recipes are indexed again.
const foodLexicon = `
# Milk and dairy
milk|||milk|milk; skim milk; semi-skimmed milk; lait; lait entier; milch; vollmilch; leche; leche entera; latte; latte intero; leite; leite integral; молоко; молока; 牛奶; 鲜奶; 牛乳; ミルク
butter|||milk|butter; beurre; mantequilla; burro; manteiga; сливочное масло; масло сливочное; 黄油; バター
ghee|butter||milk|ghee; clarified butter; beurre clarifie; butterschmalz; ги; 酥油; ギー
cream|||milk|cream; heavy cream; double cream; single cream; whipping cream; light cream; creme; creme fraiche; creme liquide; creme fleurette; sahne; schlagsahne; nata; crema; crema de leche; nata para montar; panna; panna da cucina; panna fresca; creme de leite; сливки; сливок; 奶油; 淡奶油; 鲜奶油; 生クリーム; クリーム
sour cream|cream||milk|sour cream; creme aigre; saure sahne; sauerrahm; schmand; crema agria; panna acida; creme azedo; сметана; сметаны; 酸奶油; サワークリーム
yogurt|||milk|yogurt; yoghurt; greek yogurt; yaourt; joghurt; jogurt; yogur; iogurte; йогурт; 酸奶; ヨーグルト
buttermilk|||milk|buttermilk; babeurre; lait ribot; buttermilch; suero de leche; latticello; leitelho; пахта; 酪乳; バターミルク
condensed milk|||milk|condensed milk; sweetened condensed milk; evaporated milk; lait concentre; kondensmilch; leche condensada; leche evaporada; latte condensato; leite condensado; сгущенка; сгущенное молоко; 炼乳; 練乳
ice cream|||milk|ice cream; glace; eiscreme; speiseeis; helado; gelato; sorvete; мороженое; 冰淇淋; アイスクリーム
plant cream||||plant cream; creme vegetale; crema vegetal; panna vegetale; creme vegetal; pflanzensahne; hafersahne; растительные сливки; 植物奶油
margarine||||margarine; margarina; margarin; маргарин; 人造黄油; マーガリン
rice milk||rice||rice milk; lait de riz; reismilch; leche de arroz; latte di riso; leite de arroz; рисовое молоко; 米浆; ライスミルク
whey|||milk|whey; whey protein; lactoserum; molke; siero di latte; soro de leite; сыворотка
cheese|||milk|cheese; grated cheese; fromage; kase; queso; formaggio; queijo; сыр; сыра; 奶酪; 芝士; 干酪; チーズ
parmesan|cheese|||parmesan; parmigiano; parmigiano reggiano; grana padano; parmesano; parmesao; пармезан; 帕玛森; パルメザン; パルミジャーノ
mozzarella|cheese|||mozzarella; burrata; моцарелла; 马苏里拉; モッツァレラ
cheddar|cheese|||cheddar; чеддер; 切达; チェダー
ricotta|cheese|||ricotta; рикотта; 乳清干酪; リコッタ
feta|cheese|||feta; фета; 菲达; フェタ
goat cheese|cheese|||goat cheese; chevre; fromage de chevre; ziegenkase; queso de cabra; formaggio di capra; queijo de cabra; козий сыр; 山羊奶酪; シェーブル
cream cheese|cheese|||cream cheese; philadelphia; fromage a la creme; frischkase; queso crema; formaggio spalmabile; queijo creme; requeijao; сливочный сыр; 奶油奶酪; クリームチーズ
mascarpone|cheese|||mascarpone; маскарпоне; 马斯卡彭; マスカルポーネ
pecorino|cheese|||pecorino; pecorino romano; пекорино
gruyere|cheese|||gruyere; emmental; emmentaler; comte; swiss cheese; raclette; грюйер
halloumi|cheese|||halloumi; халуми; ハルーミ
paneer|cheese|||paneer; панир
cottage cheese|cheese|||cottage cheese; quark; fromage blanc; huttenkase; requeson; fiocchi di latte; queijo cottage; творог; 茅屋奶酪; カッテージチーズ
blue cheese|cheese|||blue cheese; gorgonzola; roquefort; stilton; горгонзола
brie|cheese|||brie; camembert; бри; камамбер

# Eggs
egg|||egg|egg; oeuf; ei; eier; huevo; uovo; uova; ovo; яйцо; яйца; яиц; 鸡蛋; 蛋; 卵; 玉子; たまご; 鶏卵
egg yolk|egg|||egg yolk; yolk; jaune d oeuf; eigelb; dotter; yema; tuorlo; tuorli; gema; желток; желтки; 蛋黄; 卵黄
egg white|egg|||egg white; blanc d oeuf; eiweiss; eiklar; clara; clara de huevo; albume; albumi; clara de ovo; яичный белок; 蛋清; 卵白
mayonnaise||egg||mayonnaise; mayo; aioli; mayonesa; maionese; майонез; 蛋黄酱; 美乃滋; マヨネーズ
meringue||egg||meringue; baiser; merengue; meringa; meringhe; suspiro; безе; 蛋白霜; メレンゲ

# Fish
fish|||fish|fish; fish fillet; poisson; fisch; fischfilet; pescado; pez; pesce; peixe; рыба; рыбы; рыбное филе; 鱼; 鱼肉; 魚
salmon|fish|||salmon; saumon; lachs; salmon; salmone; salmao; лосось; семга; 三文鱼; 鲑鱼; 鮭; サーモン; しゃけ
tuna|fish|||tuna; thon; thunfisch; atun; tonno; atum; тунец; 金枪鱼; 吞拿鱼; ツナ; マグロ
cod|fish|||cod; cabillaud; morue; kabeljau; dorsch; bacalao; merluzzo; baccala; bacalhau; треска; 鳕鱼; タラ; 鱈
anchovy|fish|||anchovy; anchovy paste; anchois; sardelle; sardellen; anchoa; boqueron; acciuga; acciughe; alici; anchova; anchovas; анчоус; анчоусы; 凤尾鱼; 鳀鱼; アンチョビ
sardine|fish|||sardine; sardina; sardinha; сардина; сардины; 沙丁鱼; イワシ
trout|fish|||trout; truite; forelle; trucha; trota; truta; форель; 鳟鱼; マス
mackerel|fish|||mackerel; maquereau; makrele; caballa; sgombro; cavala; скумбрия; 鲭鱼; サバ; 鯖
white fish|fish|||white fish; whitefish; haddock; halibut; tilapia; sea bass; pollock; hake; snapper; swordfish; catfish; carp; monkfish; mahi mahi; grouper; perch; pike; bream; sea bream; turbot; flounder; plaice; sole; mullet; eel; roe; caviar; lotte; sandre; brochet; anguille; barsch; hecht; aal; seezunge; lenguado; anguila; rana pescatrice; anguilla; sogliola; linguado; enguia; щука; окунь; угорь; икра; 鳗鱼; 鱼子; ウナギ; 鰻; イクラ; タラコ; 明太子; merlu; colin; loup de mer; dorade; seelachs; zander; heilbutt; merluza; lubina; dorada; branzino; orata; spigola; robalo; dourada; судак; минтай; палтус; сибас; 鲈鱼; 罗非鱼; 鯛; スズキ
herring|fish|||herring; hareng; hering; arenque; aringa; сельдь; селедка; 鲱鱼; ニシン
fish sauce|||fish|fish sauce; nam pla; nuoc mam; sauce de poisson; fischsauce; salsa de pescado; salsa di pesce; molho de peixe; рыбный соус; 鱼露; ナンプラー
worcestershire sauce||anchovy||worcestershire; worcestershire sauce; sauce worcestershire; worcestersauce; worcestershiresauce; salsa worcestershire; salsa inglesa; molho ingles; вустерширский соус; 伍斯特酱
bonito flakes|fish|||bonito flakes; katsuobushi; 鰹節; かつお節; 木鱼花
dashi||fish||dashi; だし; 出汁; ほんだし
fish stock|stock|fish||fish stock; fish broth; fumet; fond de poisson; fischfond; fischbruhe; caldo de pescado; fumetto; brodo di pesce; caldo de peixe; рыбный бульон; 鱼汤

# Crustaceans
shrimp|||shellfish|shrimp; prawn; king prawn; tiger prawn; crevette; garnele; garnelen; shrimps; gamba; camaron; langostino; gambero; gamberi; gamberetti; mazzancolle; camarao; camaroes; креветка; креветки; 虾; 虾仁; 大虾; 虾肉; エビ; 海老; えび; むきえび
crab|||shellfish|crab; crabs; крабы; crab meat; crabe; krabbe; cangrejo; jaiba; granchio; caranguejo; siri; краб; крабовое мясо; 蟹; 螃蟹; 蟹肉; カニ; かに
lobster|||shellfish|lobster; homard; langouste; hummer; languste; langosta; bogavante; aragosta; astice; lagosta; лобстер; омар; 龙虾; ロブスター; 伊勢海老
crayfish|||shellfish|crayfish; crawfish; langoustine; ecrevisse; flusskrebs; cigala; cangrejo de rio; scampi; gamberi di fiume; lagostim; раки; 小龙虾; ザリガニ
shrimp paste||shrimp||shrimp paste; belacan; kapi; pate de crevette; garnelenpaste; pasta de camaron; 虾酱; 虾膏; えびペースト
curry paste||shrimp paste||curry paste; red curry paste; green curry paste; thai curry paste; pate de curry; currypaste; pasta de curry; pasta di curry; pasta de caril; паста карри; 咖喱酱; カレーペースト

# Molluscs
clam|||mollusc|clam; palourde; coque; venusmuschel; almeja; vongola; vongole; ameijoa; vongole; 蛤蜊; 花蛤; アサリ; あさり; ハマグリ
mussel|||mollusc|mussel; moule; miesmuschel; muschel; muscheln; mejillon; cozza; cozze; mitili; mexilhao; мидии; мидия; 贻贝; 青口; ムール貝
oyster|||mollusc|oyster; huitre; auster; austern; ostra; ostrica; ostriche; устрица; устрицы; 牡蛎; 生蚝; 牡蠣; カキ
scallop|||mollusc|scallop; saint jacques; coquille saint jacques; noix de saint jacques; jakobsmuschel; vieira; capesante; capasanta; гребешок; гребешки; 扇贝; ホタテ; 帆立
squid|||mollusc|squid; calamari; calamar; calmar; encornet; tintenfisch; kalmar; calamaro; lula; кальмар; кальмары; 鱿鱼; イカ; いか
octopus|||mollusc|octopus; poulpe; pieuvre; oktopus; krake; pulpo; polpo; polvo; осьминог; 章鱼; タコ; 蛸
snail|||mollusc|snail; escargot; schnecke; schnecken; caracol; lumaca; lumache; улитка; 蜗牛; エスカルゴ
oyster sauce|||mollusc|oyster sauce; sauce d huitre; austernsauce; salsa de ostras; salsa di ostriche; molho de ostra; устричный соус; 蚝油; オイスターソース

# Tree nuts
nut|||treenut|nut; mixed nuts; nusse; frutos secos; frutta secca; орехи; орех; 坚果; ナッツ
almond|||treenut|almond; almendra; amande; mandel; mandeln; mandorla; mandorle; amendoa; миндаль; 杏仁; 扁桃仁; アーモンド
walnut|||treenut|walnut; noix; noix de grenoble; walnuss; walnusse; nuez; nueces; noce; noci; noz; nozes; грецкий орех; грецкие орехи; 核桃; 胡桃; クルミ; くるみ
cashew|||treenut|cashew; cashew nut; noix de cajou; cajou; cashewkerne; anacardo; anacardi; castanha de caju; caju; кешью; 腰果; カシューナッツ
pecan|||treenut|pecan; noix de pecan; pekannuss; pekannusse; nuez pecana; noce pecan; noz pecan; пекан; 碧根果; 山核桃; ピーカン
hazelnut|||treenut|hazelnut; noisette; haselnuss; haselnusse; avellana; nocciola; nocciole; avela; фундук; лесной орех; 榛子; ヘーゼルナッツ
pistachio|||treenut|pistachio; pistache; pistazie; pistazien; pistacho; pistacchio; pistacchi; фисташки; фисташка; 开心果; ピスタチオ
macadamia|||treenut|macadamia; macadamia nut; макадамия; 夏威夷果; マカダミア
brazil nut|||treenut|brazil nut; noix du bresil; paranuss; paranusse; nuez de brasil; noce del brasile; castanha do brasil; бразильский орех; 巴西坚果; ブラジルナッツ
pine nut|||treenut|pine nut; pignon; pignon de pin; pinienkerne; pinon; pinones; pinolo; pinoli; pinhao; кедровые орехи; 松子; 松の実
chestnut|||treenut|chestnut; marron; chataigne; kastanie; kastanien; maroni; castana; castagna; castagne; castanha; каштан; каштаны; 栗子; 栗; くり
water chestnut||||water chestnut; chataigne d eau; wasserkastanie; castana de agua; castagna d acqua; 荸荠; 马蹄; クワイ
almond milk||almond||almond milk; lait d amande; mandelmilch; leche de almendra; latte di mandorla; leite de amendoa; миндальное молоко; 杏仁奶; アーモンドミルク
almond flour||almond||almond flour; almond meal; poudre d amande; mandelmehl; harina de almendra; farina di mandorle; farinha de amendoa; миндальная мука; 杏仁粉; アーモンドプードル
marzipan||almond||marzipan; massepain; pate d amande; mazapan; marzapane; macapao; марципан; 杏仁糖; マジパン
nutella||hazelnut; milk||nutella; hazelnut spread; pate a tartiner; nuss nougat creme; crema de avellana; crema di nocciole; creme de avela; нутелла; ヌテラ
praline||hazelnut||praline; pralinato; пралине
pesto||basil; pine nut; parmesan||pesto; pesto genovese; песто; 青酱; ジェノベーゼ
nutmeg||||nutmeg; muscade; noix de muscade; muskatnuss; muskat; nuez moscada; noce moscata; noz moscada; мускатный орех; 肉豆蔻; ナツメグ

# Peanuts
peanut|||peanut|peanut; groundnut; arachide; cacahuete; cacahouete; cacahuate; erdnuss; erdnusse; mani; arachidi; amendoim; арахис; 花生; 落花生; ピーナッツ
peanut butter||peanut||peanut butter; beurre de cacahuete; beurre d arachide; erdnussbutter; erdnusscreme; crema de cacahuete; mantequilla de mani; burro di arachidi; manteiga de amendoim; арахисовая паста; 花生酱; ピーナッツバター
peanut oil||peanut||peanut oil; groundnut oil; huile d arachide; erdnussol; aceite de cacahuete; olio di arachidi; oleo de amendoim; арахисовое масло; 花生油; ピーナッツオイル
satay sauce||peanut||satay; satay sauce; peanut sauce; sauce satay; erdnusssauce; salsa satay; сатай; 沙爹; サテ

# Wheat, gluten and grains
wheat|||gluten|wheat; ble; weizen; trigo; frumento; grano; пшеница; 小麦
flour||wheat||flour; all purpose flour; plain flour; bread flour; cake flour; pastry flour; self raising flour; self rising flour; wheat flour; wholemeal flour; farine; farine de ble; mehl; weizenmehl; harina; harina de trigo; farina; farina di grano; farinha; farinha de trigo; мука; муки; пшеничная мука; 面粉; 中筋面粉; 低筋面粉; 高筋面粉; 小麦粉; 薄力粉; 強力粉
rye|||gluten|rye; rye flour; seigle; farine de seigle; roggen; roggenmehl; centeno; segale; centeio; рожь; ржаная мука; 黑麦; ライ麦
barley|||gluten|barley; pearl barley; orge; gerste; graupen; cebada; orzo perlato; cevada; ячмень; перловка; 大麦
spelt|||gluten|spelt; farro; epeautre; dinkel; dinkelmehl; espelta; spelta; полба; スペルト
oats|||gluten|oat; oatmeal; rolled oat; porridge oat; flocon d avoine; avoine; haferflocken; hafer; avena; copos de avena; fiocchi d avena; aveia; овсянка; овсяные хлопья; овес; 燕麦; 麦片; オートミール; オーツ
oat milk||oats||oat milk; lait d avoine; hafermilch; leche de avena; latte d avena; leite de aveia; овсяное молоко; 燕麦奶; オーツミルク
malt|||gluten|malt; malt extract; malz; malta; malto; солод; 麦芽
bread||flour||bread; loaf; baguette; sourdough; ciabatta; brioche; toast; bun; pain; pain de mie; brot; brotchen; toastbrot; pan; pan de molde; pane; pao; pao de forma; хлеб; хлеба; батон; 面包; 吐司; パン; 食パン
pita||flour||pita; pitta; naan; flatbread; lavash; pain pita; fladenbrot; pan de pita; pane pita; pao sirio; лаваш; лепешка; 皮塔饼; 馕; ナン
tortilla||flour||tortilla; flour tortilla; wrap; тортилья; 墨西哥薄饼; トルティーヤ
corn tortilla||corn||corn tortilla; tortilla de maiz; maistortilla; tortilla di mais
breadcrumbs||flour||breadcrumb; bread crumb; panko; chapelure; paniermehl; semmelbrosel; pan rallado; pangrattato; pan grattato; farinha de rosca; pao ralado; панировочные сухари; сухари; 面包糠; 面包屑; パン粉
pasta||flour||pasta; spaghetti; penne; fusilli; rigatoni; linguine; fettuccine; tagliatelle; pappardelle; macaroni; lasagna; lasagne; lasagna sheet; farfalle; orecchiette; orzo; conchiglie; bucatini; pate; nudeln; teigwaren; spatzle; fideo; massa; macarrao; макароны; паста; спагетти; 意大利面; 意面; パスタ; スパゲッティ; マカロニ
egg pasta||flour; egg||egg pasta; fresh egg pasta; pate aux oeufs; pasta al huevo; pasta all uovo; massa de ovos
noodle||flour||noodle; ramen; udon; lo mein; nouille; fideos chinos; лапша; 面条; 面; 拉面; 乌冬; 挂面; うどん; ラーメン; 麺; そうめん; 中華麺
egg noodle||flour; egg||egg noodle; eiernudeln; nouilles aux oeufs; 鸡蛋面; 蛋面
rice noodle||rice||rice noodle; rice vermicelli; vermicelle de riz; reisnudeln; fideos de arroz; spaghetti di riso; macarrao de arroz; рисовая лапша; 米粉; 河粉; 米线; ビーフン; フォー
soba||buckwheat; flour||soba; soba noodle; 荞麦面; そば; 蕎麦
couscous||flour||couscous; cuscus; cuscuz marroquino; кускус; 古斯米; クスクス
semolina||wheat||semolina; semoule; griess; semola; semola di grano duro; манка; манная крупа; セモリナ
bulgur||wheat||bulgur; bulghur; boulgour; burghul; булгур; 布格麦; ブルグル
pastry||flour; butter||pastry; puff pastry; shortcrust pastry; pie crust; pie dough; phyllo; filo; pate feuilletee; pate brisee; pate sablee; blatterteig; murbeteig; hojaldre; masa quebrada; pasta sfoglia; pasta frolla; massa folhada; слоеное тесто; тесто; 酥皮; 千层酥; パイシート
dumpling wrapper||flour||dumpling wrapper; wonton wrapper; gyoza wrapper; 饺子皮; 馄饨皮; 餃子の皮
gnocchi||flour; potato||gnocchi; ньокки; ニョッキ
ravioli||flour; egg||ravioli; tortellini; tortelloni; agnolotti; равиоли; ラビオリ
seitan||wheat||seitan; gluten de ble; weizengluten; сейтан; 面筋
beer||barley|alcohol|beer; lager; ale; stout; biere; bier; cerveza; birra; cerveja; пиво; 啤酒; ビール
buckwheat||||buckwheat; buckwheat flour; sarrasin; ble noir; farine de sarrasin; buchweizen; buchweizenmehl; trigo sarraceno; harina de trigo sarraceno; alforfon; grano saraceno; farina di grano saraceno; trigo sarraceno; гречка; гречневая крупа; гречневая мука; 荞麦; そば粉

# Soy
soy|||soy|soy; soya; soybean; soja; sojabohne; sojabohnen; soia; соя; 大豆; 黄豆
soy sauce||soy; wheat||soy sauce; shoyu; light soy sauce; dark soy sauce; sauce soja; sauce de soja; sojasauce; sojasosse; salsa de soja; salsa di soia; molho de soja; molho shoyu; соевый соус; 酱油; 生抽; 老抽; 醤油; しょうゆ; 醬油
tamari||soy||tamari; タマリ
teriyaki sauce||soy sauce||teriyaki; teriyaki sauce; sauce teriyaki; teriyakisauce; salsa teriyaki; molho teriyaki; соус терияки; 照烧汁; テリヤキ
hoisin sauce||soy; wheat||hoisin; hoisin sauce; sauce hoisin; hoisinsauce; salsa hoisin; соус хойсин; 海鲜酱; 海鮮醤
miso||soy||miso; miso paste; pate de miso; misopaste; pasta de miso; pasta di miso; pasta de misso; мисо; 味噌; みそ
tofu||soy||tofu; bean curd; тофу; 豆腐
edamame||soy||edamame; эдамаме; 毛豆; 枝豆
tempeh||soy||tempeh; темпе; 天贝; テンペ
soy milk||soy||soy milk; soya milk; lait de soja; sojamilch; leche de soja; latte di soia; leite de soja; соевое молоко; 豆浆; 豆乳

# Sesame, celery, mustard, lupin
sesame|||sesame|sesame; sesame seed; sesame; sesam; sesamo; ajonjoli; gergelim; кунжут; 芝麻; 白芝麻; 黑芝麻; ごま; 胡麻; ゴマ
sesame oil||sesame||sesame oil; huile de sesame; sesamol; aceite de sesamo; olio di sesamo; oleo de gergelim; кунжутное масло; 芝麻油; 香油; ごま油; 胡麻油
tahini||sesame||tahini; tahina; tahin; тахини; 芝麻酱; タヒニ; 練りごま
hummus||chickpea; tahini||hummus; houmous; humus; хумус; 鹰嘴豆泥; フムス
celery|||celery|celery; celery stalk; celeriac; celeri; celeri rave; sellerie; staudensellerie; knollensellerie; apio; sedano; sedano rapa; aipo; сельдерей; 芹菜; 西芹; セロリ
celery salt||celery; salt||celery salt; sel de celeri; selleriesalz; sal de apio
mustard|||mustard|mustard; dijon; dijon mustard; wholegrain mustard; mustard seed; mustard powder; moutarde; moutarde de dijon; senf; mostaza; senape; mostarda; горчица; 芥末; 黄芥末; マスタード; からし; 辛子
lupin|||lupin|lupin; lupine; lupin flour; lupini; lupinen; lupinenmehl; altramuz; altramuces; lupino; tremoco; tremocos; люпин; 羽扇豆; ルピナス

# Meat
meat|||meat|meat; viande; fleisch; carne; мясо; мяса; 肉; 肉類
beef|||meat|beef; steak; ground beef; minced beef; beef mince; mince; brisket; sirloin; ribeye; tenderloin; chuck; beef chuck; flank steak; skirt steak; short rib; boeuf; steak hache; bavette; rind; rindfleisch; rinderhack; rinderhackfleisch; carne de res; res; ternera; manzo; macinato di manzo; carne bovina; carne de vaca; patinho; говядина; говядины; говяжий фарш; 牛肉; 牛肉末; 牛ひき肉; 牛肉 ステーキ; ステーキ
minced meat|||meat; pork|minced meat; ground meat; carne picada; carne molida; carne macinata; carne moida; carne trita; viande hachee; hackfleisch; hack; gemischtes hack; фарш; 肉末; 绞肉; ひき肉; 挽肉; 合いびき肉
veal|||meat|veal; veau; escalope de veau; kalb; kalbfleisch; vitello; vitela; телятина; 小牛肉; 仔牛
lamb|||meat|lamb; mutton; lamb chop; lamb shoulder; leg of lamb; agneau; gigot; mouton; lamm; lammfleisch; hammel; cordero; carnero; agnello; montone; cordeiro; borrego; carneiro; баранина; ягнятина; 羊肉; 羔羊肉; ラム; マトン
venison|||meat|venison; cerf; chevreuil; reh; hirsch; venado; cervo; veado; оленина; 鹿肉
rabbit|||meat|rabbit; lapin; kaninchen; conejo; coniglio; coelho; кролик; 兔肉; ウサギ
beef stock|stock|beef||beef stock; beef broth; bone broth; meat stock; fleischbruhe; fond de viande; fond de veau; fond de boeuf; bouillon de boeuf; rinderbruhe; rinderfond; kalbsfond; caldo de carne; caldo de res; brodo di carne; brodo di manzo; говяжий бульон; мясной бульон; 牛肉汤; ビーフブイヨン
gelatin|||gelatin|gelatin; gelatine; gelatin sheet; leaf gelatin; feuille de gelatine; blattgelatine; gelatina; colla di pesce; желатин; 明胶; 吉利丁; ゼラチン
marshmallow||gelatin||marshmallow; guimauve; malvavisco; маршмеллоу; 棉花糖; マシュマロ

# Pork
pork|||pork|pork; pork belly; pork shoulder; pork loin; pork chop; pork tenderloin; pulled pork; porc; echine de porc; poitrine de porc; filet mignon de porc; schweinefleisch; schwein; schweinebauch; schweinefilet; cerdo; carne de cerdo; lomo de cerdo; puerco; panceta; maiale; carne di maiale; lonza; porco; carne de porco; lombo de porco; свинина; свинины; свиная грудинка; 猪肉; 五花肉; 豚肉; 豚バラ; ポーク
bacon||pork||bacon; streaky bacon; lardon; speck; fruhstucksspeck; tocino; beicon; tocineta; toucinho; бекон; 培根; ベーコン
pancetta|bacon|pork||pancetta; guanciale; панчетта
ham||pork||ham; prosciutto; jambon; jambon cru; jambon de bayonne; schinken; jamon; jamon serrano; prosciutto crudo; prosciutto cotto; presunto; fiambre; ветчина; хамон; прошутто; 火腿; ハム; 生ハム
sausage||pork||sausage; chorizo; salami; pepperoni; bratwurst; kielbasa; hot dog; frankfurter; saucisse; saucisson; wurst; wurstchen; salchicha; salchichon; longaniza; salsiccia; salame; salsicce; linguica; salsicha; chourico; колбаса; сосиски; колбаски; 香肠; 腊肠; ソーセージ; サラミ; ウインナー
chicken sausage||chicken||chicken sausage; turkey sausage; saucisse de volaille; geflugelwurst; salchicha de pollo; salsiccia di pollo
lard||pork||lard; saindoux; schmalz; schweineschmalz; manteca de cerdo; strutto; banha; сало; смалец; 猪油; ラード

# Poultry
chicken|||poultry|chicken; chicken breast; chicken thigh; chicken drumstick; chicken wing; chicken leg; whole chicken; rotisserie chicken; chicken fillet; poulet; blanc de poulet; cuisse de poulet; filet de poulet; aile de poulet; hahnchen; hahnchenbrust; hahnchenbrustfilet; hahnchenschenkel; huhnchen; huhn; huhnerbrust; pollo; pechuga de pollo; muslo de pollo; alita de pollo; petto di pollo; coscia di pollo; sovracosce di pollo; frango; peito de frango; coxa de frango; sobrecoxa; galinha; курица; курицы; куриное филе; куриная грудка; куриные бедра; куриные крылья; цыпленок; 鸡; 鸡肉; 鸡胸肉; 鸡腿; 鸡翅; 鸡腿肉; 鶏肉; 鶏; 鶏むね肉; 鶏もも肉; 鶏胸肉; 手羽先; 手羽元; チキン; とり肉; 鳥肉
turkey|||poultry|turkey; ground turkey; turkey breast; dinde; dindon; pute; putenbrust; truthahn; pavo; tacchino; peru; индейка; 火鸡; 七面鳥; ターキー
duck|||poultry|duck; duck breast; canard; magret; magret de canard; ente; entenbrust; pato; anatra; anitra; утка; утиная грудка; 鸭; 鸭肉; 鴨; カモ; 合鴨
chicken stock|stock|chicken||chicken stock; chicken broth; chicken bouillon; bouillon de poulet; fond de volaille; bouillon de volaille; huhnerbruhe; huhnerfond; geflugelbruhe; geflugelfond; caldo de pollo; brodo di pollo; caldo de galinha; caldo de frango; куриный бульон; 鸡汤; 鸡高汤; 鸡精; 鶏ガラスープ; 鶏ガラ; チキンブイヨン; チキンスープ

# Alcohol
wine|||alcohol; sulphite|wine; red wine; white wine; rose wine; vin; vin blanc; vin rouge; wein; weisswein; rotwein; vino; vino blanco; vino tinto; vino bianco; vino rosso; vinho; vinho branco; vinho tinto; вино; белое вино; красное вино; 葡萄酒; 红酒; 白葡萄酒; ワイン; 白ワイン; 赤ワイン
champagne|||alcohol; sulphite|champagne; prosecco; cava; sparkling wine; cremant; sekt; spumante; espumante; шампанское; 香槟; シャンパン
fortified wine|||alcohol; sulphite|sherry; jerez; xeres; marsala; port; porto; madeira; vermouth; vermut; херес; марсала; портвейн; вермут; 雪利酒; シェリー
rum|||alcohol|rum; rhum; ron; ром; 朗姆酒; ラム酒
vodka|||alcohol|vodka; wodka; водка; 伏特加; ウォッカ
brandy|||alcohol|brandy; cognac; armagnac; calvados; weinbrand; conac; conhaque; коньяк; бренди; 白兰地; ブランデー
whisky|||alcohol|whisky; whiskey; bourbon; scotch; виски; 威士忌; ウイスキー
liqueur|||alcohol|liqueur; amaretto; kirsch; grand marnier; cointreau; triple sec; kahlua; baileys; limoncello; likor; licor; liquore; ликер; 利口酒; リキュール
spirit|||alcohol|gin; tequila; mezcal; sake; soju; cachaca; schnapps; grappa; ouzo; raki; джин; текила; 白酒; 清酒; 日本酒; 酒
mirin|||alcohol|mirin; みりん; 味醂; 味淋
rice wine|||alcohol|shaoxing; shaoxing wine; chinese cooking wine; rice wine; cooking wine; vin de riz; reiswein; vino de arroz; vino di riso; vinho de arroz; рисовое вино; 料酒; 绍兴酒; 黄酒; 米酒; 紹興酒
cider|||alcohol|hard cider; cider; cidre; apfelwein; sidra; sidro; сидр; 苹果酒; シードル
apple juice||||apple juice; apple cider; jus de pomme; apfelsaft; zumo de manzana; jugo de manzana; succo di mela; suco de maca; яблочный сок; 苹果汁; りんごジュース

# Honey and sweeteners
honey|||honey|honey; miel; honig; miele; mel; мед; меда; 蜂蜜; はちみつ; ハチミツ
sugar||||sugar; rock sugar; 冰糖; white sugar; granulated sugar; caster sugar; superfine sugar; powdered sugar; icing sugar; confectioners sugar; sucre; sucre en poudre; sucre glace; zucker; puderzucker; azucar; azucar glas; azucar blanco; zucchero; zucchero a velo; acucar; acucar refinado; сахар; сахара; сахарная пудра; 糖; 白糖; 砂糖; 糖粉; グラニュー糖; 粉糖
brown sugar||||brown sugar; dark brown sugar; light brown sugar; demerara; muscovado; cassonade; sucre roux; sucre brun; brauner zucker; rohrzucker; azucar moreno; azucar morena; panela; zucchero di canna; acucar mascavo; коричневый сахар; тростниковый сахар; 红糖; 黑糖; きび砂糖; 黒砂糖; 三温糖
maple syrup||||maple syrup; sirop d erable; ahornsirup; sirope de arce; sciroppo d acero; xarope de bordo; кленовый сироп; 枫糖浆; メープルシロップ

# Stock
stock||||stock; broth; bouillon; stock cube; bouillon cube; fond; bruhe; caldo; brodo; бульон; 高汤; 汤; ブイヨン; スープ
vegetable stock|stock|celery||vegetable stock; vegetable broth; veggie stock; bouillon de legume; gemusebruhe; gemusefond; caldo de verdura; brodo vegetale; caldo de legume; овощной бульон; 蔬菜高汤; 野菜ブイヨン; ベジブロス

# Vegetables
onion||||onion; yellow onion; white onion; brown onion; oignon; zwiebel; zwiebeln; cebolla; cipolla; cipolle; cebola; лук; лука; репчатый лук; луковица; 洋葱; 玉ねぎ; たまねぎ; 玉葱
red onion|onion|||red onion; oignon rouge; rote zwiebel; cebolla morada; cebolla roja; cipolla rossa; cebola roxa; красный лук; 红洋葱; 紫洋葱; 赤玉ねぎ
shallot||||shallot; echalote; schalotte; chalota; scalogno; echalota; лук шалот; шалот; 红葱头; エシャロット
green onion||||green onion; scallion; spring onion; oignon vert; ciboule; frühlingszwiebel; fruhlingszwiebel; lauchzwiebel; cebolleta; cebollin; cipollotto; cebolinha; зеленый лук; 葱; 小葱; 青葱; 香葱; ねぎ; 長ねぎ; 青ねぎ; 万能ねぎ; ネギ
leek||||leek; poireau; lauch; porree; puerro; porro; alho poro; alho frances; лук порей; порей; 韭葱; ポロネギ; リーキ
chive||||chive; ciboulette; schnittlauch; cebollino; erba cipollina; шнитт лук; 细香葱; 韭菜; チャイブ; ニラ
garlic||||garlic; garlic clove; ail; gousse d ail; knoblauch; knoblauchzehe; ajo; diente de ajo; aglio; spicchio d aglio; alho; dente de alho; чеснок; чеснока; 大蒜; 蒜; 蒜末; 蒜瓣; にんにく; ニンニク
ginger||||ginger; gingembre; ingwer; jengibre; zenzero; gengibre; имбирь; 姜; 生姜; 老姜; しょうが; ショウガ
tomato||||tomato; plum tomato; roma tomato; beefsteak tomato; tomate; tomaten; pomodoro; pomodori; помидор; помидоры; помидора; помидоров; томат; томаты; 番茄; 西红柿; トマト
cherry tomato|tomato|||cherry tomato; grape tomato; tomate cerise; kirschtomate; cocktailtomate; tomate cherry; pomodorino; pomodorini; pomodoro ciliegino; tomate cereja; помидоры черри; черри; 圣女果; 小番茄; ミニトマト; プチトマト
tomato paste||||tomato paste; tomato puree; concentre de tomate; tomatenmark; concentrado de tomate; pasta de tomate; concentrato di pomodoro; doppio concentrato; extrato de tomate; томатная паста; 番茄膏; トマトペースト
tomato sauce||||tomato sauce; passata; marinara; marinara sauce; sauce tomate; coulis de tomate; tomatensauce; passierte tomate; salsa de tomate; tomate frito; salsa di pomodoro; passata di pomodoro; sugo; molho de tomate; томатный соус; 番茄酱; トマトソース
ketchup||||ketchup; catsup; кетчуп; ケチャップ
potato||||potato; pomme de terre; kartoffel; kartoffeln; patata; papa; patate; batata; картофель; картофеля; картошка; картофелина; 土豆; 马铃薯; じゃがいも; ジャガイモ; 馬鈴薯
sweet potato||||sweet potato; yam; patate douce; susskartoffel; boniato; camote; batata doce; patata dolce; patata americana; батат; 红薯; 地瓜; さつまいも; サツマイモ
carrot||||carrot; carotte; karotte; karotten; mohre; mohren; mohrrube; zanahoria; carota; carote; cenoura; морковь; моркови; морковка; 胡萝卜; にんじん; 人参; ニンジン
bell pepper||||bell pepper; red pepper; green pepper; yellow pepper; orange pepper; sweet pepper; capsicum; poivron; poivron rouge; paprikaschote; rote paprika; gelbe paprika; grune paprika; pimiento; pimiento rojo; morron; peperone; peperoni; pimentao; болгарский перец; сладкий перец; 甜椒; 彩椒; 青椒; ピーマン; パプリカ
chili||||chili; chilli; chile; chili pepper; jalapeno; serrano pepper; habanero; red chili; green chili; bird eye chili; thai chili; piment; piment rouge; piment oiseau; chilischote; peperoncino; guindilla; aji; pimenta malagueta; перец чили; острый перец; 辣椒; 小米辣; 唐辛子; とうがらし; 鷹の爪
chili flakes||||chili flakes; red pepper flake; crushed red pepper; flocon de piment; chiliflocken; hojuelas de chile; peperoncino in fiocchi; pimenta calabresa; хлопья чили; 辣椒碎; 一味唐辛子
chili powder||||chili powder; cayenne; cayenne pepper; piment de cayenne; cayennepfeffer; chilipulver; chile en polvo; cayena; peperoncino in polvere; pimenta caiena; кайенский перец; 辣椒粉; チリパウダー
zucchini||||zucchini; courgette; calabacin; calabacita; zucchina; zucchine; abobrinha; кабачок; кабачки; цукини; 西葫芦; ズッキーニ
eggplant||||eggplant; aubergine; berenjena; melanzana; melanzane; berinjela; баклажан; баклажаны; 茄子; なす; ナス
cucumber||||cucumber; concombre; gurke; salatgurke; pepino; cetriolo; cetrioli; огурец; огурцы; 黄瓜; きゅうり
spinach||||spinach; baby spinach; epinard; spinat; espinaca; espinacas; spinaci; espinafre; шпинат; 菠菜; ほうれん草
kale||||kale; chou kale; grunkohl; col rizada; cavolo nero; couve; кейл; 羽衣甘蓝; ケール
lettuce||||lettuce; romaine; romaine lettuce; iceberg; iceberg lettuce; salad leaf; mixed greens; laitue; kopfsalat; blattsalat; lechuga; lattuga; alface; латук; салат латук; 生菜; レタス
cabbage||||cabbage; red cabbage; savoy cabbage; napa cabbage; chou; chou rouge; kohl; weisskohl; rotkohl; col; repollo; cavolo; cavolo cappuccio; verza; repolho; капуста; капусты; 卷心菜; 白菜; 包菜; キャベツ
broccoli||||broccoli; brocoli; brokkoli; brocolis; брокколи; 西兰花; ブロッコリー
cauliflower||||cauliflower; chou fleur; blumenkohl; coliflor; cavolfiore; couve flor; цветная капуста; 花菜; 菜花; カリフラワー
mushroom||||mushroom; button mushroom; cremini; portobello; shiitake; oyster mushroom; chanterelle; porcini; champignon; pleurote; cepe; pilz; pilze; austernpilz; steinpilz; champinon; champinones; seta; setas; hongo; hongos; fungo; funghi; funghi porcini; cogumelo; cogumelos; грибы; гриб; шампиньоны; вешенки; 蘑菇; 香菇; 平菇; きのこ; しいたけ; マッシュルーム; 椎茸; しめじ; エリンギ
pea||||pea; green pea; petit pois; erbse; erbsen; guisante; guisantes; arveja; arvejas; pisello; piselli; ervilha; горох; горошек; зеленый горошек; 豌豆; 青豆; グリーンピース
green bean||||green bean; string bean; haricot vert; grune bohne; grune bohnen; judia verde; judias verdes; ejote; fagiolini; vagem; стручковая фасоль; 四季豆; 豆角; いんげん
corn||||corn; sweetcorn; sweet corn; corn kernel; corn on the cob; mais; maiskolben; maiz; elote; choclo; milho; кукуруза; 玉米; とうもろこし; コーン
avocado||||avocado; avocat; aguacate; palta; abacate; авокадо; 牛油果; 鳄梨; アボカド
asparagus||||asparagus; asperge; spargel; esparrago; esparragos; asparagi; aspargo; спаржа; 芦笋; アスパラガス
beet||||beet; beetroot; betterave; rote bete; rote beete; remolacha; betabel; barbabietola; beterraba; свекла; 甜菜根; ビーツ
radish||||radish; daikon; radis; radieschen; rettich; rabanito; rabano; ravanello; rabanete; редис; редиска; редька; 萝卜; 白萝卜; 大根; ラディッシュ
pumpkin||||pumpkin; squash; butternut squash; butternut; potiron; citrouille; courge; courge butternut; kurbis; calabaza; zucca; abobora; тыква; 南瓜; かぼちゃ
olive||||olive; kalamata; olive noire; olive verte; olive; aceituna; oliva; olive nere; azeitona; маслины; оливки; 橄榄; オリーブ
fennel||||fennel; fenouil; fenchel; hinojo; finocchio; funcho; фенхель; 茴香; フェンネル

# Fruit
lemon||||lemon; lemon juice; lemon zest; citron; jus de citron; zeste de citron; zitrone; zitronen; zitronensaft; zitronenschale; limon; zumo de limon; jugo de limon; limone; succo di limone; scorza di limone; limao; suco de limao; лимон; лимона; лимонный сок; 柠檬; 柠檬汁; レモン; レモン汁
lime||||lime; lime juice; lime zest; citron vert; jus de citron vert; limette; limettensaft; lima; zumo de lima; succo di lime; лайм; 青柠; ライム
orange||||orange; orange juice; orange zest; jus d orange; zeste d orange; orangensaft; naranja; zumo de naranja; jugo de naranja; arancia; succo d arancia; laranja; suco de laranja; апельсин; апельсиновый сок; 橙子; 橙; 橙汁; オレンジ
apple||||apple; pomme; apfel; manzana; mela; mele; maca; яблоко; яблоки; 苹果; りんご; リンゴ
banana||||banana; banane; platano; банан; бананы; 香蕉; バナナ
berry||||berry; mixed berry; baie; fruits rouges; beeren; frutos rojos; frutos del bosque; frutti di bosco; frutas vermelhas; ягоды; 浆果; ベリー
strawberry|berry|||strawberry; fraise; erdbeere; erdbeeren; fresa; frutilla; fragola; fragole; morango; клубника; 草莓; いちご; イチゴ
blueberry|berry|||blueberry; myrtille; heidelbeere; heidelbeeren; blaubeere; blaubeeren; arandano; arandanos; mirtillo; mirtilli; mirtilo; голубика; черника; 蓝莓; ブルーベリー
raspberry|berry|||raspberry; framboise; himbeere; himbeeren; frambuesa; lampone; lamponi; framboesa; малина; 树莓; 覆盆子; ラズベリー
mango||||mango; mangue; manga; манго; 芒果; マンゴー
pineapple||||pineapple; ananas; pina; abacaxi; ананас; 菠萝; 凤梨; パイナップル
grape||||grape; raisin blanc; traube; trauben; weintraube; weintrauben; uva; uvas; виноград; 葡萄; ぶどう
raisin||||raisin; sultana; rosine; rosinen; uva pasa; pasas; uvetta; uva passa; passas; изюм; 葡萄干; レーズン
coconut||||coconut; shredded coconut; desiccated coconut; noix de coco; coco; kokosnuss; kokos; kokosraspeln; cocco; кокос; кокосовая стружка; 椰子; 椰丝; ココナッツ
coconut milk||coconut||coconut milk; coconut cream; lait de coco; creme de coco; kokosmilch; kokoscreme; leche de coco; crema de coco; latte di cocco; leite de coco; кокосовое молоко; 椰奶; 椰浆; ココナッツミルク
coconut flour||coconut||coconut flour; farine de coco; kokosmehl; harina de coco; farina di cocco; farinha de coco

# Grains, legumes and seeds
rice||||rice; white rice; basmati; basmati rice; jasmine rice; arborio; arborio rice; risotto rice; sushi rice; brown rice; long grain rice; riz; riz basmati; reis; basmatireis; arroz; arroz blanco; riso; riso arborio; рис; риса; 米; 大米; 米饭; 白米; 糯米; ご飯; ごはん
rice flour||rice||rice flour; farine de riz; reismehl; harina de arroz; farina di riso; farinha de arroz; рисовая мука; 粘米粉; 糯米粉; 上新粉; 白玉粉
quinoa||||quinoa; киноа; 藜麦; キヌア
lentil||||lentil; red lentil; green lentil; lentille; linse; linsen; lenteja; lentejas; lenticchia; lenticchie; lentilha; lentilhas; чечевица; 小扁豆; レンズ豆
chickpea||||chickpea; garbanzo; garbanzo bean; pois chiche; kichererbse; kichererbsen; ceci; grao de bico; нут; 鹰嘴豆; ひよこ豆
chickpea flour||chickpea||chickpea flour; gram flour; besan; farine de pois chiche; kichererbsenmehl; harina de garbanzo; farina di ceci; farinha de grao de bico; нутовая мука
bean||||bean; black bean; kidney bean; white bean; cannellini; cannellini bean; pinto bean; borlotti; navy bean; haricot; haricot rouge; haricot blanc; bohne; bohnen; kidneybohnen; frijol; frijoles; alubia; alubias; judia; fagioli; fagiolo; feijao; фасоль; 豆; 豆子; 黑豆; 红豆; いんげん豆
cornstarch||||cornstarch; corn starch; cornflour; maizena; fecule de mais; maisstarke; speisestarke; maismehl; maicena; almidon de maiz; harina de maiz; amido di mais; farina di mais; amido de milho; farinha de milho; кукурузный крахмал; кукурузная мука; крахмал; 玉米淀粉; 淀粉; 生粉; コーンスターチ; 片栗粉
cassava flour||||cassava flour; tapioca; tapioca flour; farinha de mandioca; polvilho; harina de yuca; тапиока; 木薯粉; タピオカ
chia||||chia; chia seed; graine de chia; chiasamen; semilla de chia; semi di chia; semente de chia; чиа; 奇亚籽; チアシード

# Pantry
olive oil||||olive oil; extra virgin olive oil; huile d olive; olivenol; aceite de oliva; olio d oliva; olio extravergine; olio extravergine di oliva; azeite; azeite de oliva; оливковое масло; 橄榄油; オリーブオイル
vegetable oil||||oil; vegetable oil; neutral oil; canola oil; rapeseed oil; sunflower oil; cooking oil; corn oil; grapeseed oil; huile; huile vegetale; huile de tournesol; huile de colza; ol; pflanzenol; sonnenblumenol; rapsol; aceite; aceite vegetal; aceite de girasol; olio; olio di semi; olio di girasole; oleo; oleo vegetal; oleo de girassol; растительное масло; масло растительное; подсолнечное масло; 油; 植物油; 食用油; 菜籽油; サラダ油
coconut oil||coconut||coconut oil; huile de coco; kokosol; aceite de coco; olio di cocco; oleo de coco; кокосовое масло; 椰子油; ココナッツオイル
salt||||salt; sea salt; kosher salt; flaky salt; table salt; sel; sel de mer; fleur de sel; gros sel; salz; meersalz; sal; sal marina; sal gruesa; sale; sale grosso; sale fino; соль; соли; 盐; 食盐; 塩; 食塩
pepper||||pepper; black pepper; white pepper; peppercorn; poivre; poivre noir; pfeffer; schwarzer pfeffer; pimienta; pimienta negra; pepe; pepe nero; pimenta do reino; pimenta preta; перец; перца; черный перец; черный молотый перец; 胡椒; 黑胡椒; 胡椒粉; こしょう; ブラックペッパー
water||||water; eau; wasser; agua; acqua; вода; воды; 水
ice||||ice; ice cube; glacon; eiswurfel; hielo; ghiaccio; gelo; лед; 冰; 冰块; 氷
baking powder||||baking powder; levure chimique; backpulver; polvo de hornear; levadura quimica; polvere lievitante; lievito per dolci; fermento em po; разрыхлитель; 泡打粉; ベーキングパウダー
baking soda||||baking soda; bicarbonate of soda; bicarbonate de soude; natron; bicarbonato; bicarbonato de sodio; bicarbonato di sodio; bicarbonato de sodio; сода; пищевая сода; 小苏打; 重曹
yeast||||yeast; instant yeast; active yeast; levure; levure boulangere; hefe; trockenhefe; levadura; lievito; lievito di birra; fermento biologico; дрожжи; 酵母; 酵母粉; イースト; ドライイースト
vinegar||||vinegar; white vinegar; rice vinegar; apple cider vinegar; cider vinegar; vinaigre; vinaigre de cidre; essig; apfelessig; vinagre; vinagre de manzana; aceto; aceto di mele; уксус; 醋; 米醋; 酢; 米酢
wine vinegar|vinegar||sulphite|wine vinegar; red wine vinegar; white wine vinegar; sherry vinegar; vinaigre de vin; weinessig; rotweinessig; vinagre de vino; aceto di vino; vinagre de vinho; винный уксус; 葡萄酒醋; ワインビネガー
balsamic vinegar|vinegar||sulphite|balsamic; balsamic vinegar; vinaigre balsamique; balsamico; balsamessig; aceto balsamico; vinagre balsamico; бальзамический уксус; 香醋; バルサミコ酢
cocoa||||cocoa; cocoa powder; cacao; cacao en poudre; kakao; kakaopulver; cacao en polvo; cacao amaro; cacau; какао; 可可粉; ココア
chocolate||||chocolate; dark chocolate; chocolate chip; semisweet chocolate; bittersweet chocolate; chocolat; chocolat noir; pepite de chocolat; schokolade; zartbitterschokolade; chocolate negro; cioccolato; cioccolato fondente; шоколад; 巧克力; チョコレート
milk chocolate|chocolate|milk||milk chocolate; white chocolate; chocolat au lait; chocolat blanc; vollmilchschokolade; weisse schokolade; chocolate con leche; chocolate blanco; cioccolato al latte; cioccolato bianco; chocolate ao leite; chocolate branco; молочный шоколад; белый шоколад; 牛奶巧克力; 白巧克力; ミルクチョコレート; ホワイトチョコレート
vanilla||||vanilla; vanilla extract; vanilla bean; vanilla pod; vanille; extrait de vanille; gousse de vanille; vanilleextrakt; vanilleschote; vainilla; extracto de vainilla; vaniglia; estratto di vaniglia; baunilha; ваниль; 香草; 香草精; バニラ
cocoa butter||||cocoa butter; beurre de cacao; kakaobutter; manteca de cacao; burro di cacao; manteiga de cacau; какао масло

# Herbs and spices
cumin||||cumin; kreuzkummel; comino; cumino; cominho; кумин; зира; 孜然; クミン
paprika||||paprika; smoked paprika; sweet paprika; paprikapulver; pimenton; pimenton de la vera; paprica; паприка; 红椒粉
cinnamon||||cinnamon; cinnamon stick; cannelle; zimt; zimtstange; canela; cannella; корица; 肉桂; 桂皮; シナモン
cardamom||||cardamom; cardamome; kardamom; cardamomo; кардамон; 豆蔻; 小豆蔻; カルダモン
clove||||clove; girofle; clou de girofle; nelke; gewurznelke; gewurznelken; clavo de olor; chiodo di garofano; chiodi di garofano; cravo; cravinho; гвоздика; 丁香; クローブ
star anise||||star anise; anis etoile; badiane; sternanis; anis estrellado; anice stellato; anis estrelado; бадьян; 八角; 八角茴香; スターアニス
turmeric||||turmeric; curcuma; kurkuma; acafrao da terra; куркума; 姜黄; ターメリック
curry powder||||curry powder; curry; poudre de curry; currypulver; curry en polvo; caril; карри; 咖喱粉; 咖喱; カレー粉
garam masala||||garam masala; гарам масала; ガラムマサラ
cilantro||||cilantro; coriander; coriander leaf; coriandre; koriander; culantro; coriandolo; coentro; кинза; кориандр; 香菜; 芫荽; パクチー; コリアンダー
parsley||||parsley; flat leaf parsley; persil; petersilie; perejil; prezzemolo; salsinha; петрушка; петрушки; 欧芹; 香芹; パセリ
basil||||basil; basilic; basilikum; albahaca; basilico; manjericao; базилик; 罗勒; 九层塔; バジル
oregano||||oregano; origan; oregano; орегано; душица; 牛至; オレガノ
thyme||||thyme; thym; thymian; tomillo; timo; tomilho; тимьян; чабрец; 百里香; タイム
rosemary||||rosemary; romarin; rosmarin; romero; rosmarino; alecrim; розмарин; 迷迭香; ローズマリー
dill||||dill; aneth; eneldo; aneto; endro; укроп; укропа; 莳萝; ディル
mint||||mint; menthe; minze; hierbabuena; menta; hortela; мята; 薄荷; ミント
bay leaf||||bay leaf; bay leave; laurier; feuille de laurier; lorbeerblatt; lorbeerblatter; laurel; hoja de laurel; alloro; foglia di alloro; louro; folha de louro; лавровый лист; 香叶; 月桂叶; ローリエ; ベイリーフ
sage||||sage; sauge; salbei; salvia; salvia; шалфей; 鼠尾草; セージ

# Words members write for their allergies and diets
!milk|dairy; dairy product; milk product; lactose; casein; lait; produit laitier; lactose; milch; milchprodukt; milchprodukte; laktose; leche; lacteo; lacteos; lactosa; latte; latticini; lattosio; leite; laticinio; laticinios; lacticinios; молоко; молочные продукты; молочка; лактоза; 牛奶; 乳制品; 奶制品; 乳糖; 奶; 牛乳; 乳製品; 乳
!egg|egg; oeuf; ei; eier; huevo; uovo; uova; ovo; яйцо; яйца; 鸡蛋; 蛋; 卵; たまご
!fish|fish; poisson; fisch; pescado; pesce; peixe; рыба; 鱼; 魚
!shellfish|shellfish; crustacean; crustace; krebstier; krebstiere; schalentier; schalentiere; crustaceo; crustaceos; crostacei; ракообразные; 甲壳类; 甲殻類
!shellfish; mollusc|seafood; fruits de mer; meeresfruchte; mariscos; marisco; frutti di mare; frutos do mar; морепродукты; 海鲜; 海産物; シーフード; 魚介
!mollusc|mollusc; mollusk; mollusque; weichtier; weichtiere; molusco; moluscos; mollusco; molluschi; моллюски; 软体动物; 軟体動物
!treenut; peanut|nut; nusse; nueces; frutos secos; noci; nozes; орехи; 坚果; ナッツ; 木の実
!treenut|tree nut; fruit a coque; schalenfrucht; schalenfruchte; fruto de cascara; frutta a guscio; fruto de casca rija; древесные орехи; 树坚果
!peanut|peanut; arachide; cacahuete; erdnuss; erdnusse; mani; arachidi; amendoim; арахис; 花生; 落花生; ピーナッツ
!gluten|gluten; wheat; coeliac; celiac; coeliaque; zoliakie; celiaco; celiaquia; glutine; frumento; ble; weizen; trigo; глютен; клейковина; пшеница; 麸质; 谷蛋白; 小麦; グルテン
!soy|soy; soya; soja; sojabohne; soia; соя; 大豆; 黄豆
!sesame|sesame; sesam; sesamo; ajonjoli; gergelim; кунжут; 芝麻; ごま; 胡麻
!celery|celery; celeri; sellerie; apio; sedano; aipo; сельдерей; 芹菜; セロリ
!mustard|mustard; moutarde; senf; mostaza; senape; mostarda; горчица; 芥末; マスタード
!lupin|lupin; lupine; lupinen; altramuz; lupini; tremoco; люпин; 羽扇豆; ルピナス
!sulphite|sulphite; sulfite; sulfit; sulfite; sulfito; sulfitos; solfito; solfiti; сульфиты; 亚硫酸盐; 亜硫酸塩
!alcohol|alcohol; alcoholic; alcool; alcoolise; alkohol; alkoholisch; alcoholico; alcol; alcolico; alcoolico; алкоголь; спиртное; 酒精; 酒; アルコール
!pork|pork; porc; schwein; schweinefleisch; cerdo; maiale; porco; свинина; 猪肉; 豚肉
!meat|meat; red meat; viande; viande rouge; fleisch; carne; carne roja; carne rossa; carne vermelha; мясо; 肉; 红肉; 肉類
!poultry|poultry; volaille; geflugel; ave; aves de corral; pollame; aves; птица; 家禽
!gelatin|gelatin; gelatine; gelatina; желатин; 明胶; ゼラチン
!honey|honey; miel; honig; miele; mel; мед; 蜂蜜; はちみつ
`

// foodLexiconProblems lists what the lexicon got wrong at load (an alias of two keys, a kind
// that isn't a key, a group that isn't one), which a test reports; the first entry wins.
var foodLexiconProblems []string

func init() { loadFoodLexicon(foodLexicon) }

func loadFoodLexicon(text string) {
	list := func(s string) []string {
		var out []string
		for _, v := range strings.Split(s, ";") {
			if v = strings.TrimSpace(v); v != "" {
				out = append(out, v)
			}
		}
		return out
	}
	problem := func(format string, args ...any) {
		foodLexiconProblems = append(foodLexiconProblems, fmt.Sprintf(format, args...))
	}
	// Aliases are cleaned like names; words that would cancel an alias aren't in any.
	clean := func(alias string) string { return strings.Join(cleanFoodName(alias).words, " ") }
	var order []*foodEntry
	var avoidLines [][2]string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "|")
		if strings.HasPrefix(line, "!") {
			if len(parts) != 2 {
				problem("bad line %q", line)
				continue
			}
			avoidLines = append(avoidLines, [2]string{strings.TrimPrefix(parts[0], "!"), parts[1]})
			continue
		}
		if len(parts) != 5 {
			problem("bad line %q", line)
			continue
		}
		e := &foodEntry{key: strings.TrimSpace(parts[0]), parents: list(parts[1]), contains: list(parts[2]), groups: list(parts[3])}
		if foodEntries[e.key] != nil {
			problem("key %q twice", e.key)
			continue
		}
		foodEntries[e.key] = e
		order = append(order, e)
		for _, alias := range append([]string{e.key}, list(parts[4])...) {
			a := clean(alias)
			if a == "" {
				problem("alias %q of %q cleans to nothing", alias, e.key)
				continue
			}
			if other, ok := foodAliases[a]; ok && other != e.key {
				problem("alias %q (%q) is both %q and %q", alias, a, other, e.key)
				continue
			}
			foodAliases[a] = e.key
			if r, _ := utf8.DecodeRuneInString(a); cjk(r) {
				cjkLongest = max(cjkLongest, utf8.RuneCountInString(a))
			} else {
				foodLongest = max(foodLongest, len(strings.Fields(a)))
			}
		}
	}
	valid := map[string]bool{}
	for _, g := range foodGroups {
		valid[g] = true
	}
	for _, e := range order {
		for _, g := range e.groups {
			if !valid[g] {
				problem("%q has unknown group %q", e.key, g)
			}
		}
		for _, k := range append(slices.Clone(e.parents), e.contains...) {
			if foodEntries[k] == nil {
				problem("%q refers to unknown key %q", e.key, k)
			}
		}
	}
	// Groups, covers and avoid terms flow down from kinds and contents; a cycle stops at itself.
	var resolve func(e *foodEntry, seen map[string]bool)
	resolve = func(e *foodEntry, seen map[string]bool) {
		if e.covers != nil || seen[e.key] {
			return
		}
		seen[e.key] = true
		groups := map[string]bool{}
		for _, g := range e.groups {
			groups[g] = true
		}
		covers, avoid := []string{e.key}, []string{e.key}
		for _, k := range e.parents {
			if p := foodEntries[k]; p != nil {
				resolve(p, seen)
				covers = append(covers, p.covers...)
				avoid = append(avoid, p.avoid...)
				for _, g := range p.groups {
					groups[g] = true
				}
			}
		}
		for _, k := range e.contains {
			if c := foodEntries[k]; c != nil {
				resolve(c, seen)
				avoid = append(avoid, c.avoid...)
				for _, g := range c.groups {
					groups[g] = true
				}
			}
		}
		e.groups = nil
		for _, g := range foodGroups {
			if groups[g] {
				e.groups = append(e.groups, g)
			}
		}
		slices.Sort(covers)
		slices.Sort(avoid)
		e.covers, e.avoid = slices.Compact(covers), slices.Compact(avoid)
	}
	for _, e := range order {
		resolve(e, map[string]bool{})
	}
	for _, line := range avoidLines {
		groups := list(line[0])
		for _, g := range groups {
			if !valid[g] {
				problem("allergy words for unknown group %q", g)
			}
		}
		for _, alias := range list(line[1]) {
			a := clean(alias)
			if a == "" {
				problem("allergy word %q cleans to nothing", alias)
				continue
			}
			if other, ok := avoidAliases[a]; ok && !slices.Equal(other, groups) {
				problem("allergy word %q is both %v and %v", alias, other, groups)
				continue
			}
			avoidAliases[a] = groups
		}
	}
}
