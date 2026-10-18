import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { ArrowRight, Camera, Images, Mic, Square, Trash2 } from './icons';
import { pickAudioFile } from '../lib/audioFile';
import {
  keepRecording,
  readCard,
  recordings as listRecordings,
  writeAgain,
  writtenDown,
  type Recording,
} from '../lib/family';
import { api } from '../lib/api';
import { type LocalMedia, pickPhoto, preparePhoto, uploadMedia } from '../lib/photos';
import type { AIJob } from '../lib/types';
import { color, font, s } from '../lib/theme';
import { Button, Field, IconButton } from './ui';
import { SheetError } from './SheetAction';

// "Record a family recipe" (docs/FAMILY-RECIPES.md): a relative talks a dish through, while they
// cook or from memory, and Savorly writes it down as a private recipe whose steps play what they
// said; or a photo of a handwritten card becomes a recipe with the card as its cover. It lives in
// the Add a recipe sheet (RecipeStart), which shows its title and its way back.

/** Mono AAC at 64 kb/s (WebM in browsers that record it): half an hour stays well under 25 MB. */
const RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
  web: { mimeType: 'audio/webm', bitsPerSecond: 64000 },
};
const LONGEST = 30 * 60_000;
const SHORTEST = 3000;

export type FamilyMode = 'voice' | 'card';
type Stage = 'idle' | 'recording' | 'recorded' | 'uploading' | 'writing';

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

export function FamilyRecipe({
  mode,
  onMode,
  onDone,
}: {
  mode: FamilyMode;
  onMode: (mode: FamilyMode) => void;
  /** The recipe it was written down as, ready to open. */
  onDone: (recipeId: string) => void;
}) {
  const { t: tr, number } = useI18n();
  const recorder = useAudioRecorder(RECORDING);
  const recording = useAudioRecorderState(recorder, 250);
  const [speaker, setSpeaker] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [take, setTake] = useState<{ media: LocalMedia; durationMs: number } | null>(null);
  // Where a failure leaves the sheet: back at the start, or, for a recording that didn't upload,
  // ready to send it again.
  const fallback = useRef<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  // Recordings kept on an earlier visit but not written down (AI was off, it failed, or its
  // recipe was deleted), and the one this visit kept when writing it down didn't start.
  const [waiting, setWaiting] = useState<Recording[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  // Each attempt is numbered; leaving the sheet, or starting another, leaves the old one behind.
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const refresh = useCallback(
    () =>
      listRecordings().then(
        (list) => setWaiting(list.filter((r) => !r.recipe && !inFlight(r.job?.status))),
        () => {},
      ),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Waits for the job to write the recipe down, then hands it over.
  const follow = async (job: AIJob, n: number) => {
    setStage('writing');
    const id = await writtenDown(job, () => attempt.current === n);
    if (id) onDone(id);
  };
  const run = async (work: (n: number) => Promise<void>) => {
    const n = ++attempt.current;
    setError('');
    fallback.current = 'idle';
    try {
      await work(n);
    } catch (e) {
      if (attempt.current !== n || (e as Error).name === 'AbortError') return;
      setError((e as Error).message);
      setStage(fallback.current);
      void refresh();
    }
  };

  const start = () =>
    void run(async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted)
        throw new Error('Savorly needs the microphone to record. You can allow it in Settings.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      // Half an hour is as much as one recording holds: the recorder stops itself there.
      recorder.record({ forDuration: LONGEST / 1000 });
      setTake(null);
      setStage('recording');
    });
  const stop = () =>
    void run(async () => {
      const status = recorder.getStatus();
      const durationMs = Math.min(status.durationMillis || recording.durationMillis, LONGEST);
      if (status.isRecording) await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      const uri = recorder.uri;
      if (!uri || durationMs < SHORTEST) {
        setStage('idle');
        throw new Error('Record at least a few seconds.');
      }
      setTake({ media: { uri }, durationMs });
      setStage('recorded');
    });
  const chooseFile = () =>
    void run(async () => {
      const media = await pickAudioFile();
      if (!media) return;
      setTake({ media, durationMs: 0 });
      setStage('recorded');
    });
  const writeDown = () =>
    void run(async (n) => {
      if (!take) return;
      fallback.current = 'recorded';
      setStage('uploading');
      setProgress(0);
      const url = await uploadMedia(take.media, 'audio', { onProgress: setProgress });
      if (attempt.current !== n) return;
      const kept = await keepRecording(url, speaker, Math.round(take.durationMs));
      if (attempt.current !== n) return;
      // Kept: from here on, it's written down again from the list rather than sent again.
      fallback.current = 'idle';
      setTake(null);
      if (!kept.job) {
        // Kept for later; it waits in the list below.
        setStage('idle');
        await refresh();
        throw new Error(kept.error || 'Your recording is saved. Write it down again later.');
      }
      await follow(kept.job, n);
    });
  const again = (r: Recording) =>
    void run(async (n) => {
      await follow(await writeAgain(r.id), n);
    });
  const remove = (r: Recording) =>
    void run(async () => {
      await api(`/recordings/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      setRemoving(null);
      await refresh();
    });
  const card = (from: 'camera' | 'library') =>
    void run(async (n) => {
      const picked = await pickPhoto(from);
      if (!picked || attempt.current !== n) return;
      setStage('uploading');
      setProgress(0);
      const photo = await preparePhoto(picked, { max: 2048 });
      const url = await uploadMedia(photo.uri, 'image', { onProgress: setProgress });
      if (attempt.current !== n) return;
      await follow(await readCard(url), n);
    });

  const busy = stage === 'uploading' || stage === 'writing';
  if (busy)
    return (
      <>
        <View
          accessibilityLiveRegion="polite"
          style={[s.card, s.row, { gap: 14, alignItems: 'flex-start' }]}
        >
          <ActivityIndicator color={color.ink} style={{ marginTop: 2 }} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.h3}>
              {stage === 'uploading'
                ? tr('Uploading… {{v0}}', {
                    v0: number(progress, { style: 'percent', maximumFractionDigits: 0 }),
                  })
                : mode === 'card'
                  ? tr('Reading the card…')
                  : tr('Writing it down…')}
            </Text>
            <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
              {tr(
                'This can take a minute. You can close this: the recipe will be in My recipes when it’s ready.',
              )}
            </Text>
          </View>
        </View>
        <SheetError message={error} />
      </>
    );

  if (mode === 'card')
    return (
      <>
        <Text style={[s.muted, { marginTop: -8 }]}>
          {tr(
            'Photograph a handwritten recipe. Savorly writes it down, and keeps the card as its cover.',
          )}
        </Text>
        {Platform.OS !== 'web' && (
          <Button title={tr('Take a photo')} icon={Camera} large onPress={() => card('camera')} />
        )}
        <Button
          title={tr('Choose a photo')}
          icon={Images}
          variant={Platform.OS === 'web' ? 'primary' : 'secondary'}
          large
          onPress={() => card('library')}
        />
        <SheetError message={error} />
      </>
    );

  return (
    <>
      <Text style={[s.muted, { marginTop: -8 }]}>
        {tr(
          'Let them tell it in their own words, while they cook or from memory. Savorly writes it down, and cooking mode plays their voice with each step.',
        )}
      </Text>
      <Field
        label={tr('Who’s speaking?')}
        placeholder={tr('Grandma, Uncle Joe…')}
        value={speaker}
        onChangeText={setSpeaker}
        maxLength={60}
        autoCapitalize="words"
      />
      {stage === 'recording' ? (
        <Button
          title={tr('Stop · {{v0}}', { v0: clock(recording.durationMillis) })}
          label={tr('Stop recording')}
          icon={Square}
          large
          onPress={stop}
        />
      ) : stage === 'recorded' && take ? (
        <>
          <View style={[s.between, { gap: 12 }]}>
            <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>
              {take.durationMs
                ? tr('Recorded · {{v0}}', { v0: clock(take.durationMs) })
                : take.media.fileName || tr('Your recording')}
            </Text>
            <Button
              title={tr('Start over')}
              variant="ghost"
              small
              onPress={() => {
                setTake(null);
                setStage('idle');
              }}
            />
          </View>
          <Button
            title={tr('Write it down')}
            icon={ArrowRight}
            large
            disabled={!speaker.trim()}
            onPress={writeDown}
          />
        </>
      ) : (
        <Button title={tr('Start recording')} icon={Mic} large onPress={start} />
      )}
      <SheetError message={error} />
      {stage === 'idle' && (
        <View style={[s.row, { flexWrap: 'wrap', marginHorizontal: -12 }]}>
          <Button title={tr('Choose an audio file')} variant="ghost" small onPress={chooseFile} />
          <Button
            title={tr('Use a handwritten card')}
            variant="ghost"
            small
            onPress={() => onMode('card')}
          />
        </View>
      )}
      {stage === 'idle' && waiting.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={s.label}>{tr('Not written down yet')}</Text>
          {waiting.map((r) => (
            <View key={r.id} style={[s.between, { gap: 8 }]}>
              <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>
                {`${r.speaker} · ${clock(r.durationMs)}`}
              </Text>
              {removing === r.id ? (
                <>
                  <Button
                    title={tr('Keep')}
                    variant="ghost"
                    small
                    onPress={() => setRemoving(null)}
                  />
                  <Button title={tr('Delete for good')} small onPress={() => remove(r)} />
                </>
              ) : (
                <>
                  <Button
                    title={tr('Write it down')}
                    variant="ghost"
                    small
                    onPress={() => again(r)}
                  />
                  <IconButton
                    icon={Trash2}
                    size={38}
                    label={tr('Delete the recording of {{v0}}', { v0: r.speaker })}
                    onPress={() => setRemoving(r.id)}
                  />
                </>
              )}
            </View>
          ))}
        </View>
      )}
      <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
        {tr(
          'Family recipes stay private until you share them. Cooking mode only ever plays what was really said.',
        )}
      </Text>
    </>
  );
}

const inFlight = (status?: AIJob['status']) =>
  status === 'queued' || status === 'running' || status === 'processing';
