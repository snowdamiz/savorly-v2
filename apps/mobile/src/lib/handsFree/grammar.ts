import type { Language } from '../i18n/core';

// What hands-free cooking understands, in each of the app's languages. A command is a whole
// short utterance ("next step", "stop", "start the timer"), never a phrase inside a longer one,
// so talk in the kitchen ("I'll do the next step after this") doesn't move the screen. Matching
// forgives what recognizers vary on: case, accents, punctuation, apostrophes, spacing, and
// polite words at either end ("next step, please"). An utterance that starts with the wake word
// ("Chef, how long do I boil it?") is a question for the sous-chef instead.

export type HandsFreeCommand =
  | 'next'
  | 'previous'
  | 'repeat'
  | 'startTimer'
  | 'pauseTimer'
  | 'resumeTimer'
  | 'stopReading'
  | 'ingredients'
  | 'stepIngredients'
  | 'done';

export type Heard =
  | { kind: 'command'; command: HandsFreeCommand }
  /** The wake word and what followed it, as the recognizer wrote it. */
  | { kind: 'question'; question: string }
  /** The wake word alone: the next thing said is the question. */
  | { kind: 'wake' }
  /** Anything else: kitchen conversation, which hands-free ignores. */
  | { kind: 'other' };

// Each language's phrases for each command, separated by "|": the first is the one the app shows
// as an example. `wake` lists forms of the wake word as said at the start of a question, and
// `fillers` the polite or filler words that may come before or after a command.
type Grammar = Record<HandsFreeCommand | 'wake' | 'fillers', string>;

const grammars: Record<Language, Grammar> = {
  en: {
    next: "next step | next | next one | go to the next step | go to next step | go next | continue | go on | move on | forward | go forward | what's next | step forward",
    previous:
      'previous step | previous | back | go back | step back | last step | go to the previous step | the previous step | one step back | back one step | go back a step',
    repeat:
      "repeat | repeat that | repeat the step | repeat this step | say that again | say it again | again | read the step | read this step | read step | read it | read it again | read it out | read it aloud | what's this step | what does this step say | come again | pardon",
    startTimer:
      'start the timer | start timer | timer start | set the timer | start the clock | timer on | begin the timer | start a timer | timer',
    pauseTimer:
      'pause the timer | pause timer | stop the timer | stop timer | hold the timer | timer off | pause',
    resumeTimer:
      'resume the timer | resume timer | resume | continue the timer | unpause the timer | unpause | restart the timer',
    stopReading:
      "stop reading | stop | be quiet | quiet | shush | silence | enough | stop talking | that's enough | cancel | never mind | nevermind",
    ingredients:
      'ingredients | the ingredients | read the ingredients | list the ingredients | what are the ingredients | what do i need | ingredient list | read me the ingredients | all the ingredients | all ingredients',
    stepIngredients:
      "ingredients for this step | this step's ingredients | what do i need for this step | ingredients for the step | step ingredients | what goes in this step | which ingredients for this step | ingredients in this step",
    done: "done | i'm done | finished | i'm finished | finish | finish cooking | all done | we're done | that's it | done cooking",
    wake: 'chef | hey chef | ok chef | okay chef | sous chef | hey sous chef',
    fillers:
      'please | ok | okay | hey | um | uh | so | now | and | alright | all right | thanks | thank you',
  },
  de: {
    next: 'nächster Schritt | weiter | nächster | nächste | nächstes | der nächste Schritt | zum nächsten Schritt | vorwärts | weitermachen | geh weiter | gehe weiter | nächster Punkt',
    previous:
      'zurück | vorheriger Schritt | voriger Schritt | letzter Schritt | einen Schritt zurück | zum vorherigen Schritt | geh zurück | gehe zurück | Schritt zurück',
    repeat:
      'wiederholen | wiederhole | nochmal | noch mal | noch einmal | wiederhole das | wiederhole den Schritt | Schritt vorlesen | lies den Schritt vor | lies vor | vorlesen | was steht da | lies das nochmal | wie bitte',
    startTimer:
      'Timer starten | starte den Timer | Timer start | starte Timer | den Timer starten | stell den Timer | stelle den Timer | Timer an | Timer',
    pauseTimer:
      'Timer anhalten | Timer pausieren | pausiere den Timer | halte den Timer an | Timer stoppen | stopp den Timer | stoppe den Timer | Timer stopp | Timer aus | Pause',
    resumeTimer:
      'Timer fortsetzen | setze den Timer fort | Timer weiter | Timer weiterlaufen lassen | fortsetzen | weiterlaufen',
    stopReading:
      'stopp | stop | halt | Ruhe | sei still | still | aufhören | hör auf | genug | nicht vorlesen | Vorlesen beenden | abbrechen',
    ingredients:
      'Zutaten | die Zutaten | Zutaten vorlesen | lies die Zutaten vor | was brauche ich | welche Zutaten | Zutatenliste | alle Zutaten',
    stepIngredients:
      'Zutaten für diesen Schritt | Zutaten für den Schritt | was brauche ich für diesen Schritt | welche Zutaten für diesen Schritt | Zutaten in diesem Schritt',
    done: "fertig | ich bin fertig | erledigt | geschafft | Kochen beenden | fertig gekocht | das war's | alles fertig",
    wake: 'Chef | hey Chef | okay Chef | Küchenchef | hey Küchenchef',
    fillers: 'bitte | okay | ok | hey | äh | ähm | also | jetzt | und | danke | mal',
  },
  es: {
    next: 'siguiente paso | siguiente | el siguiente paso | paso siguiente | próximo paso | el próximo paso | continuar | continúa | adelante | sigue | seguir | pasa al siguiente | ir al siguiente paso | avanza | avanzar',
    previous:
      'paso anterior | anterior | el paso anterior | atrás | volver | vuelve | regresa | regresar | volver atrás | ir al paso anterior | retrocede | retroceder',
    repeat:
      'repite | repetir | repítelo | otra vez | de nuevo | repite el paso | lee el paso | léelo | leer el paso | lee este paso | qué dice el paso | cómo | repite eso',
    startTimer:
      'inicia el temporizador | iniciar el temporizador | iniciar temporizador | empieza el temporizador | empezar temporizador | pon el temporizador | activa el temporizador | arranca el temporizador | inicia el cronómetro | temporizador',
    pauseTimer:
      'pausa el temporizador | pausar el temporizador | pausar temporizador | detén el temporizador | detener el temporizador | para el temporizador | parar el temporizador | pausa',
    resumeTimer:
      'reanuda el temporizador | reanudar el temporizador | reanudar temporizador | continúa el temporizador | continuar el temporizador | sigue el temporizador | reanudar | reanuda',
    stopReading:
      'deja de leer | para | parar | detente | basta | silencio | cállate | para de leer | stop | suficiente | cancela | cancelar',
    ingredients:
      'ingredientes | los ingredientes | lee los ingredientes | leer ingredientes | qué necesito | cuáles son los ingredientes | lista de ingredientes | todos los ingredientes',
    stepIngredients:
      'ingredientes de este paso | los ingredientes de este paso | ingredientes para este paso | qué necesito para este paso | ingredientes del paso',
    done: 'listo | lista | terminado | terminé | he terminado | ya terminé | ya está | hecho | acabé | terminar | terminar de cocinar | fin',
    wake: 'chef | oye chef | hey chef | hola chef | oiga chef',
    fillers: 'por favor | vale | ok | oye | eh | ahora | y | bueno | gracias | venga',
  },
  fr: {
    next: "étape suivante | suivant | l'étape suivante | la suite | suite | continue | continuer | on continue | après | passe à l'étape suivante | passer à l'étape suivante | prochaine étape | la prochaine étape | ensuite | et après",
    previous:
      "étape précédente | précédent | l'étape précédente | retour | reviens | revenir | revenir en arrière | en arrière | retour en arrière | reviens en arrière | retourne à l'étape précédente",
    repeat:
      "répète | répéter | répète l'étape | répète ça | encore | encore une fois | relis | relis l'étape | lis l'étape | lire l'étape | lis-moi l'étape | pardon | quoi | tu peux répéter | redis | redis-le",
    startTimer:
      'lance le minuteur | lancer le minuteur | démarre le minuteur | démarrer le minuteur | mets le minuteur | active le minuteur | lance le chrono | démarre le chrono | lance la minuterie | démarre la minuterie | minuteur | minuterie',
    pauseTimer:
      'mets le minuteur en pause | pause le minuteur | pause minuteur | arrête le minuteur | arrêter le minuteur | stoppe le minuteur | arrête la minuterie | mets en pause | mettre en pause | pause',
    resumeTimer:
      'reprends le minuteur | reprendre le minuteur | relance le minuteur | relancer le minuteur | continue le minuteur | reprends la minuterie | reprends | reprendre',
    stopReading:
      'arrête de lire | stop | arrête | arrêter | tais-toi | silence | chut | ça suffit | assez | annule | annuler | arrête la lecture',
    ingredients:
      "ingrédients | les ingrédients | lis les ingrédients | lire les ingrédients | liste des ingrédients | qu'est-ce qu'il faut | de quoi j'ai besoin | quels ingrédients | tous les ingrédients",
    stepIngredients:
      "ingrédients de cette étape | les ingrédients de cette étape | ingrédients pour cette étape | de quoi j'ai besoin pour cette étape | qu'est-ce qu'il faut pour cette étape",
    done: "terminé | fini | j'ai fini | j'ai terminé | c'est fini | c'est terminé | c'est prêt | terminer | finir | fin",
    wake: 'chef | hé chef | hey chef | dis chef | ok chef',
    fillers:
      "s'il te plaît | s'il vous plaît | stp | svp | ok | d'accord | euh | bon | alors | et | maintenant | merci | vas-y",
  },
  it: {
    next: 'passo successivo | avanti | prossimo | prossimo passo | il prossimo passo | il passo successivo | successivo | continua | continuare | vai avanti | andiamo avanti | dopo | passaggio successivo | prossimo passaggio',
    previous:
      'passo precedente | indietro | precedente | il passo precedente | torna indietro | tornare indietro | torna | passaggio precedente | vai indietro',
    repeat:
      'ripeti | ripetere | ripeti il passo | ripetilo | di nuovo | ancora | ancora una volta | rileggi | leggi il passo | leggi questo passo | leggilo | come | cosa | puoi ripetere',
    startTimer:
      'avvia il timer | avviare il timer | avvia timer | fai partire il timer | inizia il timer | metti il timer | accendi il timer | imposta il timer | start timer | timer',
    pauseTimer:
      'metti in pausa il timer | pausa il timer | ferma il timer | fermare il timer | blocca il timer | stop timer | metti in pausa | pausa',
    resumeTimer:
      'riprendi il timer | riprendere il timer | continua il timer | fai ripartire il timer | riparti | riprendi',
    stopReading:
      'smetti di leggere | basta | stop | fermati | ferma | silenzio | zitto | zitta | annulla | smettila | basta così',
    ingredients:
      'ingredienti | gli ingredienti | leggi gli ingredienti | elenco degli ingredienti | lista degli ingredienti | cosa mi serve | che ingredienti servono | quali ingredienti | tutti gli ingredienti',
    stepIngredients:
      'ingredienti di questo passo | gli ingredienti di questo passo | ingredienti per questo passo | cosa mi serve per questo passo | ingredienti del passo | ingredienti di questo passaggio',
    done: 'fatto | finito | ho finito | ho fatto | è pronto | pronto | fine | abbiamo finito | finito di cucinare',
    wake: 'chef | ehi chef | ok chef | senti chef',
    fillers: 'per favore | ok | okay | ehi | allora | e | adesso | ora | grazie | dai',
  },
  pt: {
    next: 'próximo passo | próximo | o próximo passo | próxima etapa | seguinte | passo seguinte | avançar | avança | continuar | continua | segue | seguir | adiante | pra frente | para frente',
    previous:
      'passo anterior | anterior | o passo anterior | etapa anterior | voltar | volta | volte | para trás | pra trás | voltar um passo | retroceder',
    repeat:
      'repete | repetir | repita | de novo | outra vez | mais uma vez | lê o passo | leia o passo | ler o passo | lê de novo | leia de novo | repete o passo | como | o quê',
    startTimer:
      'iniciar o temporizador | inicia o temporizador | iniciar temporizador | começar o temporizador | liga o temporizador | iniciar o timer | inicia o timer | inicie o timer | iniciar timer | começar o timer | começa o timer | liga o timer | ligar o timer | iniciar o cronômetro | inicia o cronômetro | começa o cronômetro | temporizador | timer',
    pauseTimer:
      'pausar o temporizador | pausa o temporizador | parar o temporizador | para o temporizador | pare o temporizador | pausar o timer | pausa o timer | pause o timer | parar o timer | para o timer | pare o timer | desliga o timer | pausar | pausa',
    resumeTimer:
      'retomar o temporizador | retoma o temporizador | continuar o temporizador | continua o temporizador | retomar o timer | retoma o timer | continuar o timer | continua o timer | retomar | retoma | despausar',
    stopReading:
      'para de ler | para | pare | parar | chega | silêncio | pare de ler | stop | cancelar | cancela | basta',
    ingredients:
      'ingredientes | os ingredientes | lê os ingredientes | leia os ingredientes | ler os ingredientes | lista de ingredientes | o que eu preciso | do que eu preciso | quais são os ingredientes | todos os ingredientes',
    stepIngredients:
      'ingredientes deste passo | ingredientes desse passo | ingredientes para este passo | o que eu preciso para este passo | do que eu preciso nesse passo | ingredientes do passo',
    done: 'pronto | terminei | acabei | terminado | feito | finalizar | terminar | acabou | fim | tá pronto | está pronto',
    wake: 'chef | chefe | ei chef | oi chef | ô chef',
    fillers: 'por favor | ok | tá | beleza | agora | e | então | obrigado | obrigada | aí',
  },
  ru: {
    next: 'следующий шаг | дальше | далее | следующий | следующий этап | вперёд | продолжай | продолжить | давай дальше | к следующему шагу | перейди к следующему шагу | следующее | следующая',
    previous:
      'предыдущий шаг | назад | предыдущий | шаг назад | вернись | вернуться | вернись назад | к предыдущему шагу | обратно | предыдущее',
    repeat:
      'повтори | повторить | ещё раз | повтори шаг | прочитай шаг | прочитай | прочти | прочитай ещё раз | что там | что | как',
    startTimer:
      'запусти таймер | запустить таймер | включи таймер | включить таймер | старт таймер | поставь таймер | начни таймер | засеки время | таймер',
    pauseTimer:
      'останови таймер | остановить таймер | поставь на паузу | таймер на паузу | пауза таймер | приостанови таймер | выключи таймер | стоп таймер | пауза',
    resumeTimer:
      'продолжи таймер | продолжить таймер | возобнови таймер | возобновить | сними с паузы | сними паузу | таймер дальше',
    stopReading:
      'перестань читать | стоп | хватит | замолчи | тихо | тише | не читай | остановись | отмена | достаточно | молчи',
    ingredients:
      'ингредиенты | прочитай ингредиенты | список ингредиентов | что нужно | что мне нужно | какие ингредиенты | все ингредиенты | какие продукты',
    stepIngredients:
      'ингредиенты для этого шага | ингредиенты этого шага | что нужно для этого шага | какие ингредиенты для этого шага | ингредиенты на этом шаге | что нужно на этом шаге',
    done: 'готово | я закончил | я закончила | закончил | закончила | закончили | закончить | конец | всё готово | финиш',
    wake: 'шеф | эй шеф | шеф-повар | слушай шеф',
    fillers: 'пожалуйста | ок | окей | так | ну | давай | теперь | а | и | спасибо',
  },
  ja: {
    next: '次へ | 次 | 次の手順 | 次のステップ | 次の工程 | 次に進んで | 次へ進んで | 次に進む | 進んで | 進む | つぎ | つぎへ | 次行って | 次お願い',
    previous:
      '前へ | 前 | 前の手順 | 前のステップ | 前の工程 | 戻って | 戻る | もどって | 一つ前 | ひとつ前 | 前に戻って | 前に戻る | 戻して',
    repeat:
      'もう一回 | もう一度 | もういっかい | もういちど | 繰り返して | くりかえして | 読んで | よんで | 手順を読んで | この手順を読んで | もう一回読んで | もう一度読んで | 何て言った | なんて言った',
    startTimer:
      'タイマー開始 | タイマースタート | タイマーをスタート | タイマーを開始 | タイマーをかけて | タイマーかけて | タイマーをセット | タイマーを始めて | タイマー始めて | タイマーをつけて | タイマーつけて | タイマー',
    pauseTimer:
      'タイマー停止 | タイマーを停止 | タイマーを止めて | タイマー止めて | タイマー一時停止 | タイマーを一時停止 | タイマーストップ | 一時停止',
    resumeTimer: 'タイマー再開 | タイマーを再開 | タイマーを続けて | タイマー続けて | 再開',
    stopReading:
      '読むのをやめて | ストップ | 止めて | とめて | やめて | 静かに | しずかに | 黙って | だまって | 停止 | もういい | キャンセル',
    ingredients:
      '材料 | 材料を読んで | 材料は | 材料を教えて | 材料一覧 | 材料リスト | 何が必要 | なにが必要 | 全部の材料 | 材料は何',
    stepIngredients:
      'この手順の材料 | この手順で使う材料 | このステップの材料 | この工程の材料 | 今の手順の材料 | この手順の材料は | この手順に必要なもの | この手順で何が必要',
    done: '完成 | 終わり | おわり | 終わった | おわった | できた | できました | 完了 | 終了 | 料理終わり | 完成した',
    wake: 'シェフ | しぇふ | シェフさん | ねえシェフ | ねぇシェフ | ねえ、シェフ | chef',
    fillers:
      'ください | 下さい | お願いします | おねがいします | お願い | おねがい | ねえ | ね | えっと | ええと | じゃあ | あの | はい | よ',
  },
  zh: {
    next: '下一步 | 下一个 | 下一个步骤 | 下个步骤 | 下一步骤 | 继续 | 往下 | 接着 | 然后呢 | 前进 | 下一条',
    previous:
      '上一步 | 上一个 | 上一个步骤 | 上个步骤 | 上一步骤 | 返回 | 后退 | 回去 | 退回 | 回到上一步 | 往回',
    repeat:
      '重复 | 再说一遍 | 再说一次 | 再读一遍 | 再念一遍 | 重读 | 读一下 | 念一下 | 读这一步 | 这一步是什么 | 什么 | 再来一遍 | 重复一遍 | 朗读',
    startTimer:
      '开始计时 | 启动计时器 | 开始计时器 | 打开计时器 | 开启计时器 | 计时开始 | 开始定时 | 启动定时器 | 设置计时器 | 开始倒计时 | 计时器 | 计时 | 定时',
    pauseTimer:
      '暂停计时 | 暂停计时器 | 暂停定时器 | 停止计时 | 停止计时器 | 关闭计时器 | 计时暂停 | 暂停',
    resumeTimer: '继续计时 | 恢复计时 | 继续计时器 | 恢复计时器 | 计时继续 | 取消暂停 | 恢复',
    stopReading:
      '别读了 | 停 | 停止 | 停下 | 不要读了 | 安静 | 闭嘴 | 够了 | 停止朗读 | 别说了 | 取消',
    ingredients:
      '食材 | 材料 | 配料 | 用料 | 读一下食材 | 读食材 | 食材有哪些 | 需要什么 | 需要哪些材料 | 所有食材 | 食材清单 | 材料清单',
    stepIngredients:
      '这一步的食材 | 这一步需要什么 | 这一步用什么 | 这步的食材 | 这一步的材料 | 这一步用哪些食材 | 这步需要什么 | 这一步要什么',
    done: '完成 | 做完了 | 完成了 | 结束 | 结束烹饪 | 做好了 | 搞定 | 搞定了 | 完毕 | 完事',
    wake: '厨师 | 大厨 | 主厨 | 厨师长 | 大厨师 | 嘿厨师 | 嘿大厨 | 嘿主厨 | chef',
    fillers: '请 | 麻烦 | 一下 | 吧 | 啊 | 呀 | 嗯 | 好的 | 那么 | 谢谢 | 了',
  },
};

/** Languages written without spaces between words, which recognizers space unpredictably. */
const unspaced = new Set<Language>(['ja', 'zh']);
/** Languages whose accents recognizers drop or add: matching ignores them. */
const accented = new Set<Language>(['de', 'en', 'es', 'fr', 'it', 'pt']);

/**
 * The form two utterances are compared in: lowercase, full-width letters and digits folded
 * (NFKC), punctuation and symbols gone, accents dropped where recognizers vary on them, "ё" read
 * as "е", single spaces, and no spaces at all in Japanese and Chinese.
 */
export function normalize(text: string, language: Language) {
  let out = text.normalize('NFKC').toLowerCase();
  if (accented.has(language)) out = out.normalize('NFD').replace(/\p{M}/gu, '');
  if (language === 'ru') out = out.replace(/ё/g, 'е');
  out = out
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return unspaced.has(language) ? out.replace(/ /g, '') : out;
}

const commandNames: HandsFreeCommand[] = [
  'next',
  'previous',
  'repeat',
  'startTimer',
  'pauseTimer',
  'resumeTimer',
  'stopReading',
  'ingredients',
  'stepIngredients',
  'done',
];
const list = (phrases: string) =>
  phrases
    .split('|')
    .map((phrase) => phrase.trim())
    .filter(Boolean);

/** Each command's phrases in `language`, the example first. */
export function phrases(language: Language) {
  const grammar = grammars[language];
  return Object.fromEntries(
    commandNames.map((command) => [command, list(grammar[command])]),
  ) as Record<HandsFreeCommand, string[]>;
}

type Compiled = {
  commands: Map<string, HandsFreeCommand>;
  wake: string[];
  fillers: string[];
};
const compiled = new Map<Language, Compiled>();

function compile(language: Language): Compiled {
  const known = compiled.get(language);
  if (known) return known;
  const grammar = grammars[language];
  const commands = new Map<string, HandsFreeCommand>();
  for (const [command, said] of Object.entries(phrases(language)) as [HandsFreeCommand, string[]][])
    for (const phrase of said)
      // "what's next" is also heard as "whats next".
      for (const form of [phrase, phrase.replace(/['’]/g, '')]) {
        const key = normalize(form, language);
        if (key && !commands.has(key)) commands.set(key, command);
      }
  const byLength = (a: string, b: string) => b.length - a.length;
  const forms = (items: string) =>
    [...new Set(list(items).map((item) => normalize(item, language)))].sort(byLength);
  const result = { commands, wake: forms(grammar.wake), fillers: forms(grammar.fillers) };
  compiled.set(language, result);
  return result;
}

// Drops polite and filler words from both ends, as often as they come ("okay, next step please").
function withoutFillers(text: string, language: Language, fillers: string[]) {
  const spaced = !unspaced.has(language);
  let out = text;
  for (let changed = true; changed && out;) {
    changed = false;
    for (const filler of fillers) {
      if (out === filler) break;
      if (out.startsWith(spaced ? filler + ' ' : filler)) {
        out = out.slice(filler.length).trim();
        changed = true;
      } else if (out.endsWith(spaced ? ' ' + filler : filler)) {
        out = out.slice(0, out.length - filler.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** The question after a leading wake word, as the recognizer wrote it; null without one. */
function afterWake(utterance: string, language: Language, wake: string[]): string | null {
  const full = normalize(utterance, language);
  for (const form of wake) {
    if (!full.startsWith(form)) continue;
    const rest = full.slice(form.length);
    // "Chefs" or "Chefkoch" aren't the wake word.
    if (!unspaced.has(language) && rest && !rest.startsWith(' ')) continue;
    // Where the wake word ends in what was said, so the question keeps its own punctuation.
    for (let end = 1; end <= utterance.length; end++)
      if (normalize(utterance.slice(0, end), language) === form)
        return utterance
          .slice(end)
          .replace(/^[\s\p{P}\p{S}]+/u, '')
          .trim();
    return rest.trim();
  }
  return null;
}

/** What an utterance means to hands-free cooking in `language`. */
export function hear(utterance: string, language: Language): Heard {
  const grammar = compile(language);
  const command = (text: string) => {
    const said = normalize(text, language);
    return (
      grammar.commands.get(said) ??
      grammar.commands.get(withoutFillers(said, language, grammar.fillers))
    );
  };
  const question = afterWake(utterance, language, grammar.wake);
  if (question === null) {
    const found = command(utterance);
    return found ? { kind: 'command', command: found } : { kind: 'other' };
  }
  // "Chef, next step" is still a command, and free.
  const found = command(question);
  if (found) return { kind: 'command', command: found };
  return normalize(question, language).length >= 2
    ? { kind: 'question', question }
    : { kind: 'wake' };
}

/** The phrase the app shows for each command in `language`. */
export function examples(language: Language): Record<HandsFreeCommand, string> {
  return Object.fromEntries(
    Object.entries(phrases(language)).map(([command, said]) => [command, said[0]]),
  ) as Record<HandsFreeCommand, string>;
}

/** The wake word as the app shows it, capitalized as it starts the question ("Chef, …"). */
export function wakeWord(language: Language) {
  const word = list(grammars[language].wake)[0];
  return word.charAt(0).toLocaleUpperCase(language) + word.slice(1);
}

/**
 * Phrases a recognizer can favour (iOS and Android take hints): the first few of each command and
 * the wake word.
 */
export function hints(language: Language) {
  return [
    ...Object.values(phrases(language)).flatMap((said) => said.slice(0, 3)),
    ...list(grammars[language].wake),
  ];
}
