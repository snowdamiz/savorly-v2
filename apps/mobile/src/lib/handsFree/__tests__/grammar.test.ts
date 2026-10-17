/// <reference types="jest" />
import { languages, type Language } from '../../i18n/core';
import {
  examples,
  hear,
  hints,
  normalize,
  phrases,
  wakeWord,
  type HandsFreeCommand,
} from '../grammar';

const codes = languages.map((l) => l.code) as Language[];
const commandOf = (utterance: string, language: Language) => {
  const heard = hear(utterance, language);
  return heard.kind === 'command' ? heard.command : heard.kind;
};

describe.each(codes)('%s', (language) => {
  const table = phrases(language);

  test('every phrase means its own command, and no phrase means two', () => {
    const seen = new Map<string, HandsFreeCommand>();
    for (const [command, list] of Object.entries(table) as [HandsFreeCommand, string[]][]) {
      expect(list.length).toBeGreaterThan(0);
      for (const phrase of list) {
        const key = normalize(phrase, language);
        expect(seen.get(key) ?? command).toBe(command);
        seen.set(key, command);
        expect(commandOf(phrase, language)).toBe(command);
      }
    }
  });

  test('recognizer variations still match: case, punctuation and spacing', () => {
    for (const [command, list] of Object.entries(table) as [HandsFreeCommand, string[]][]) {
      const phrase = list[0];
      expect(commandOf(phrase.toUpperCase(), language)).toBe(command);
      expect(commandOf(`${phrase}.`, language)).toBe(command);
      expect(commandOf(`  ${phrase}!  `, language)).toBe(command);
    }
  });

  test('a command inside a longer sentence is just conversation', () => {
    for (const list of Object.values(table)) {
      const phrase = list[0];
      const sentence =
        language === 'ja'
          ? `昨日は${phrase}について友達と長く話していました`
          : language === 'zh'
            ? `昨天我朋友跟我聊了很久${phrase}的事`
            : `yesterday my friend told me about ${phrase} for a very long time`;
      expect(commandOf(sentence, language)).toBe('other');
    }
  });

  test('the wake word starts a question, alone it waits for one, and before a command it is the command', () => {
    const wake = wakeWord(language);
    const heard = hear(`${wake}, how long?`, language);
    expect(heard).toEqual({ kind: 'question', question: 'how long?' });
    expect(hear(wake, language)).toEqual({ kind: 'wake' });
    expect(hear(`${wake}!`, language)).toEqual({ kind: 'wake' });
    expect(commandOf(`${wake}, ${examples(language).next}`, language)).toBe('next');
  });

  test('hints and examples come from the grammar', () => {
    expect(hints(language)).toContain(examples(language).next);
    expect(hints(language).map((hint) => hint.toLowerCase())).toContain(
      wakeWord(language).toLowerCase(),
    );
    expect(Object.keys(examples(language)).sort()).toEqual(Object.keys(table).sort());
  });
});

test('what recognizers write for English commands', () => {
  expect(commandOf('Next step.', 'en')).toBe('next');
  expect(commandOf("What's next?", 'en')).toBe('next');
  expect(commandOf('whats next', 'en')).toBe('next');
  expect(commandOf('Okay, next step please', 'en')).toBe('next');
  expect(commandOf('go back', 'en')).toBe('previous');
  expect(commandOf('Start the timer.', 'en')).toBe('startTimer');
  expect(commandOf('pause the timer', 'en')).toBe('pauseTimer');
  expect(commandOf('Resume the timer', 'en')).toBe('resumeTimer');
  expect(commandOf('stop reading', 'en')).toBe('stopReading');
  expect(commandOf('Read the ingredients', 'en')).toBe('ingredients');
  expect(commandOf('What do I need for this step?', 'en')).toBe('stepIngredients');
  expect(commandOf("I'm done", 'en')).toBe('done');
  expect(commandOf('im done', 'en')).toBe('done');
  for (const talk of [
    "I'll do the next step after this",
    'can you pass the salt',
    'stop it you two',
    'the timer on the oven is broken',
    'Chefs always salt the water',
  ])
    expect(commandOf(talk, 'en')).toBe('other');
});

test('questions keep what was said after the wake word', () => {
  const cases: [Language, string, string][] = [
    ['en', 'Chef, how long do I boil it?', 'how long do I boil it?'],
    ['en', 'hey chef how long do I boil it', 'how long do I boil it'],
    ['en', 'Sous-chef, can I use butter instead?', 'can I use butter instead?'],
    ['de', 'Chef, wie lange muss das kochen?', 'wie lange muss das kochen?'],
    ['de', 'Küchenchef, wie heiß soll die Pfanne sein?', 'wie heiß soll die Pfanne sein?'],
    ['es', 'Chef, ¿cuánto tiempo lo hiervo?', 'cuánto tiempo lo hiervo?'],
    ['fr', 'Chef, combien de temps je fais cuire ?', 'combien de temps je fais cuire ?'],
    ['fr', 'Hé chef, je peux remplacer le beurre ?', 'je peux remplacer le beurre ?'],
    ['it', 'Chef, quanto tempo devo cuocerla?', 'quanto tempo devo cuocerla?'],
    ['pt', 'Chef, quanto tempo eu cozinho?', 'quanto tempo eu cozinho?'],
    ['pt', 'Chefe, posso usar manteiga?', 'posso usar manteiga?'],
    ['ru', 'Шеф, сколько варить макароны?', 'сколько варить макароны?'],
    ['ru', 'эй шеф сколько варить', 'сколько варить'],
    ['ja', 'シェフ、パスタは何分茹でればいい？', 'パスタは何分茹でればいい？'],
    ['ja', 'シェフさん 何分茹でる', '何分茹でる'],
    ['zh', '厨师，这个要煮多久？', '这个要煮多久？'],
    ['zh', '大厨这个要煮多久', '这个要煮多久'],
    ['zh', '主厨，可以用黄油代替吗', '可以用黄油代替吗'],
  ];
  for (const [language, utterance, question] of cases)
    expect(hear(utterance, language)).toEqual({ kind: 'question', question });
});

test('what recognizers write in the other languages', () => {
  const cases: [Language, string, HandsFreeCommand | 'other'][] = [
    ['de', 'Nächster Schritt', 'next'],
    ['de', 'weiter bitte', 'next'],
    ['de', 'Timer starten', 'startTimer'],
    ['de', 'Timer weiter', 'resumeTimer'],
    ['de', 'Zutaten für diesen Schritt', 'stepIngredients'],
    ['de', 'Ich bin gleich fertig mit dem Schritt', 'other'],
    ['es', 'Siguiente paso, por favor', 'next'],
    ['es', 'Pausa el temporizador', 'pauseTimer'],
    ['es', '¿Qué necesito?', 'ingredients'],
    ['es', 'Pásame la sal', 'other'],
    ['fr', 'Étape suivante !', 'next'],
    ['fr', 'etape suivante', 'next'],
    ['fr', 'Lance le minuteur', 'startTimer'],
    ['fr', "J'ai fini", 'done'],
    ['fr', 'Tu peux me passer le sel ?', 'other'],
    ['it', 'Passo successivo', 'next'],
    ['it', 'Riprendi il timer', 'resumeTimer'],
    ['it', 'Ho finito', 'done'],
    ['pt', 'Próximo passo', 'next'],
    ['pt', 'proximo passo', 'next'],
    ['pt', 'Pausar o timer', 'pauseTimer'],
    ['pt', 'Pronto', 'done'],
    ['ru', 'Следующий шаг', 'next'],
    ['ru', 'Ещё раз', 'repeat'],
    ['ru', 'еще раз', 'repeat'],
    ['ru', 'Запусти таймер', 'startTimer'],
    ['ru', 'Ингредиенты для этого шага', 'stepIngredients'],
    ['ru', 'Передай мне соль', 'other'],
    ['ja', '次へ。', 'next'],
    ['ja', '次 へ', 'next'],
    ['ja', '次へ進んでください', 'next'],
    ['ja', 'タイマーを止めて', 'pauseTimer'],
    ['ja', 'この手順の材料は？', 'stepIngredients'],
    ['ja', '塩を取ってくれる？', 'other'],
    ['zh', '下一步。', 'next'],
    ['zh', '下 一步', 'next'],
    ['zh', '请下一步', 'next'],
    ['zh', '暂停一下', 'pauseTimer'],
    ['zh', '继续计时', 'resumeTimer'],
    ['zh', '这一步需要什么？', 'stepIngredients'],
    ['zh', '把盐递给我', 'other'],
  ];
  for (const [language, utterance, expected] of cases)
    expect([language, utterance, commandOf(utterance, language)]).toEqual([
      language,
      utterance,
      expected,
    ]);
});
