import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, View } from 'react-native';
import { Camera, Check, Images, Sparkles, Trash2 } from 'lucide-react-native';
import { useApp } from '../lib/store';
import { pickPhoto, preparePhoto, touchUpPhoto, uploadPhoto } from '../lib/photos';
import { haptic } from '../lib/haptics';
import { color, font, radius, s } from '../lib/theme';
import { Avatar, Button, Dialog, Press, Segmented, animate, motionReduced } from './ui';

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
  const [error, setError] = useState('');
  // Each opening starts from the photo in use.
  const [opened, setOpened] = useState(visible);
  if (opened !== visible) {
    setOpened(visible);
    if (visible) {
      setPhoto(value);
      setLocal('');
      setBefore('');
      setShowBefore(false);
      setBusy(null);
      setError('');
    }
  }
  // Uploads and touch-ups that finish after the sheet closes change nothing.
  const live = useRef(visible);
  useEffect(() => {
    live.current = visible;
    return () => {
      live.current = false;
    };
  }, [visible]);
  const choose = async (from: 'camera' | 'library') => {
    setError('');
    try {
      const picked = await pickPhoto(from, true);
      if (!picked || !live.current) return;
      setBusy('photo');
      const ready = await preparePhoto(picked, { max: 1024, square: true });
      setLocal(ready);
      setBefore('');
      setShowBefore(false);
      const url = await uploadPhoto(ready, 'profile.jpg');
      if (live.current) setPhoto(url);
    } catch (e) {
      if (live.current) {
        setLocal('');
        setError((e as Error).message);
      }
    } finally {
      if (live.current) setBusy(null);
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
        <View style={{ width: 168, height: 168 }}>
          <Avatar name={name} uri={shown} size={168} />
          {(busy === 'photo' || busy === 'touch') && <Working touch={busy === 'touch'} />}
        </View>
        {busy === 'touch' ? (
          <Text accessibilityLiveRegion="polite" style={[s.small, { textAlign: 'center' }]}>
            {tr('Touching up your photo… This takes about half a minute.')}
          </Text>
        ) : (
          !!before && (
            <View style={{ alignSelf: 'stretch', maxWidth: 260, width: '100%' }}>
              <Segmented
                value={showBefore ? 'before' : 'after'}
                onChange={(v) => setShowBefore(v === 'before')}
                options={[
                  { value: 'before', label: tr('Before') },
                  { value: 'after', label: tr('Touched up') },
                ]}
              />
            </View>
          )
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
// A veil over the photo while it uploads; a touch-up also gets a slow sweep of light.
function Working({ touch }: { touch: boolean }) {
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
          borderRadius: 84,
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
  source: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
