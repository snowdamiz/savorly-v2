import { useI18n } from '../lib/i18n';
import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, View } from 'react-native';
import { Camera, Check, Images, Sparkles, Trash2 } from './icons';
import { useApp } from '../lib/store';
import { Crop, Photo, pickPhoto, preparePhoto, touchUpPhoto, uploadMedia } from '../lib/photos';
import { haptic } from '../lib/haptics';
import { color, font, radius, s } from '../lib/theme';
import { Avatar, Button, Dialog, Press, Segmented, animate, motionReduced } from './ui';
import { chunk } from '../lib/chunk';

// The crop loads the first time a photo needs framing, so pages with a profile photo on them
// (My kitchen, a recipe's "I cooked this") don't carry it.
const PhotoCrop = lazy(chunk(() => import('./PhotoCrop').then((m) => ({ default: m.PhotoCrop }))));

/** A profile photo that opens the photo sheet: the place to change it from anywhere. */
export function PhotoButton({
  name,
  uri,
  size,
  onPress,
}: {
  name: string;
  uri?: string;
  size: number;
  onPress: () => void;
}) {
  const { t: tr } = useI18n();
  const badge = Math.max(28, Math.round(size * 0.32));
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={uri ? tr('Change your photo') : tr('Add a photo')}
      onPress={onPress}
      scale={0.95}
      style={{ width: size, height: size }}
    >
      <Avatar name={name} uri={uri} size={size} />
      <View
        style={{
          position: 'absolute',
          right: -2,
          bottom: -2,
          width: badge,
          height: badge,
          borderRadius: badge / 2,
          backgroundColor: color.ink,
          borderWidth: 3,
          borderColor: color.white,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Camera size={Math.round(badge * 0.48)} color={color.white} strokeWidth={2.2} />
      </View>
    </Press>
  );
}

/**
 * Take a photo, choose one, or touch up the one you have with AI, then keep it. `onSave` decides
 * what keeping means: saving the profile straight away, or filling in a form saved later.
 */
export function ProfilePhoto({
  visible,
  onClose,
  name,
  value,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  name: string;
  value: string;
  onSave: (url: string) => Promise<void> | void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [photo, setPhoto] = useState(value);
  // A local copy shows straight away while the photo uploads.
  const [local, setLocal] = useState('');
  // The photo a touch-up started from, so the two can be compared.
  const [before, setBefore] = useState('');
  const [showBefore, setShowBefore] = useState(false);
  const [busy, setBusy] = useState<'photo' | 'touch' | 'save' | null>(null);
  // How much of a new photo has gone up, once it's on its way.
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  // A new photo, being framed before it's used.
  const [framing, setFraming] = useState<Photo | null>(null);
  // Mounted from the first photo on, so the crop can close with its own animation.
  const [cropping, setCropping] = useState(false);
  // Each opening starts from the photo in use.
  const [opened, setOpened] = useState(visible);
  if (opened !== visible) {
    setOpened(visible);
    if (visible) {
      setPhoto(value);
      setLocal('');
      setFraming(null);
      setBefore('');
      setShowBefore(false);
      setBusy(null);
      setProgress(null);
      setError('');
    }
  }
  // Uploads and touch-ups that finish after the sheet closes change nothing; an upload stops.
  const live = useRef(visible);
  const upload = useRef<AbortController | null>(null);
  useEffect(() => {
    live.current = visible;
    return () => {
      live.current = false;
      upload.current?.abort();
    };
  }, [visible]);
  const choose = async (from: 'camera' | 'library') => {
    setError('');
    try {
      const picked = await pickPhoto(from, true);
      if (!picked || !live.current) return;
      setBusy('photo');
      // An upright copy, small enough to move around smoothly; the crop is cut from it.
      const upright = await preparePhoto(picked, { max: 2048 });
      if (live.current) {
        setCropping(true);
        setFraming(upright);
      }
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(null);
    }
  };
  const crop = async (area: Crop) => {
    if (!framing) return;
    setFraming(null);
    setBusy('photo');
    try {
      const ready = await preparePhoto(framing.uri, { max: 1024, crop: area });
      if (!live.current) return;
      setLocal(ready.uri);
      setBefore('');
      setShowBefore(false);
      const controller = new AbortController();
      upload.current = controller;
      const url = await uploadMedia({ uri: ready.uri, fileName: 'profile.jpg' }, 'image', {
        signal: controller.signal,
        onProgress: (sent) => live.current && setProgress(sent),
      });
      if (live.current) setPhoto(url);
    } catch (e) {
      if (live.current) {
        setLocal('');
        setError((e as Error).message);
      }
    } finally {
      upload.current = null;
      if (live.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  };
  const touchUp = async () => {
    if (!photo || !app.requireUser()) return;
    haptic.tap();
    setError('');
    setBusy('touch');
    try {
      const url = await touchUpPhoto(photo, 'avatar', () => live.current);
      if (!url || !live.current) return;
      haptic.soft();
      setBefore(photo);
      setShowBefore(false);
      setLocal('');
      setPhoto(url);
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(null);
    }
  };
  const save = async (url: string) => {
    setError('');
    setBusy('save');
    try {
      await onSave(url);
      onClose();
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setBusy(null);
    }
  };
  const shown = showBefore && before ? before : local || photo;
  const chosen = showBefore && before ? before : photo;
  const canTouchUp = !!app.capabilities?.imageAI && !!photo && !before;
  return (
    <Dialog visible={visible} onClose={onClose} title={tr('Profile photo')}>
      <View style={{ alignItems: 'center', gap: 14, paddingTop: 4 }}>
        <View style={{ width: 168, height: 168, marginBottom: before ? 20 : 0 }}>
          <Avatar name={name} uri={shown} size={168} />
          {(busy === 'photo' || busy === 'touch') && (
            <Working touch={busy === 'touch'} radius={84} progress={progress} />
          )}
          {!!before && (
            // Straddles the photo's lower edge, so the comparison sits on what it compares.
            <View style={styles.compare}>
              <Segmented
                floating
                value={showBefore ? 'before' : 'after'}
                onChange={(v) => setShowBefore(v === 'before')}
                options={[
                  { value: 'before', label: tr('Before') },
                  { value: 'after', label: tr('Touched up') },
                ]}
              />
            </View>
          )}
        </View>
        {busy === 'touch' && (
          <Text accessibilityLiveRegion="polite" style={[s.small, { textAlign: 'center' }]}>
            {tr('Touching up your photo… This takes about half a minute.')}
          </Text>
        )}
      </View>
      <View style={[s.row, { gap: 10 }]}>
        <Source
          icon={Camera}
          title={tr('Take a photo')}
          disabled={!!busy}
          onPress={() => void choose('camera')}
        />
        <Source
          icon={Images}
          title={tr('Choose a photo')}
          disabled={!!busy}
          onPress={() => void choose('library')}
        />
      </View>
      {canTouchUp && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr('Touch up with AI')}
          disabled={!!busy}
          onPress={() => void touchUp()}
          scale={0.98}
          style={[s.row, styles.touch]}
        >
          <View style={styles.spark}>
            <Sparkles size={18} color={color.ink} strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[s.h3, { color: color.white, fontSize: 15 }]}>
              {tr('Touch up with AI')}
            </Text>
            <Text style={[s.small, { color: color.onInk, fontFamily: font.medium }]}>
              {tr('Better light, color and focus. Still you.')}
            </Text>
          </View>
        </Press>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
          {tr(error)}
        </Text>
      )}
      {chosen !== value && !!chosen && (
        <Button
          title={tr('Use this photo')}
          icon={Check}
          large
          busy={busy === 'save'}
          disabled={!!busy && busy !== 'save'}
          onPress={() => void save(chosen)}
        />
      )}
      {!!value && (
        <Button
          title={tr('Remove photo')}
          icon={Trash2}
          variant="ghost"
          disabled={!!busy}
          onPress={() => void save('')}
        />
      )}
      {cropping && (
        <Suspense fallback={null}>
          <PhotoCrop
            photo={framing}
            onCancel={() => setFraming(null)}
            onDone={(area) => void crop(area)}
          />
        </Suspense>
      )}
    </Dialog>
  );
}
function Source({
  icon: Icon,
  title,
  disabled,
  onPress,
}: {
  icon: typeof Camera;
  title: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      scale={0.96}
      style={[s.card, { flex: 1, alignItems: 'center', gap: 10, paddingVertical: 18 }]}
    >
      <View style={styles.source}>
        <Icon size={20} color={color.ink} strokeWidth={2} />
      </View>
      <Text numberOfLines={1} style={[s.h3, { fontSize: 14 }]}>
        {title}
      </Text>
    </Press>
  );
}
// A veil over the photo while it uploads, with how far it's got; a touch-up also gets a slow
// sweep of light.
export function Working({
  touch,
  radius: corner,
  progress = null,
}: {
  touch: boolean;
  radius: number;
  /** The share of an upload sent so far, when one is under way. */
  progress?: number | null;
}) {
  const { t: tr, number } = useI18n();
  const sweep = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (!touch || motionReduced()) return;
    const loop = Animated.loop(Animated.sequence([animate(sweep, 1, 1400), animate(sweep, 0, 0)]));
    loop.start();
    return () => loop.stop();
  }, [touch, sweep]);
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: corner,
          overflow: 'hidden',
          backgroundColor: 'rgba(13,13,13,0.38)',
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      {touch && (
        <Animated.View
          style={{
            position: 'absolute',
            top: -40,
            bottom: -40,
            width: 70,
            backgroundColor: 'rgba(255,255,255,0.22)',
            transform: [
              { translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-150, 150] }) },
              { rotate: '18deg' },
            ],
          }}
        />
      )}
      {touch ? (
        <Sparkles size={34} color={color.white} strokeWidth={1.8} />
      ) : (
        <ActivityIndicator color={color.white} />
      )}
      {!touch && progress !== null && (
        <Text
          accessibilityRole="progressbar"
          accessibilityLabel={tr('Upload progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          style={styles.percent}
        >
          {number(progress, { style: 'percent', maximumFractionDigits: 0 })}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  touch: {
    gap: 14,
    padding: 14,
    paddingRight: 18,
    borderRadius: radius.lg,
    backgroundColor: color.ink,
  },
  spark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compare: {
    position: 'absolute',
    left: -80,
    right: -80,
    bottom: -20,
    alignItems: 'center',
  },
  percent: { marginTop: 8, color: color.white, fontFamily: font.bold, fontSize: 13 },
  source: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
