import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { Camera, RotateCcw, SwitchCamera } from 'lucide-react-native';
import { Button, FoodImage, IconButton } from './ui';
import { color, radius, s } from '../lib/theme';

export function RecipeCamera({
  onPhoto,
  onCancel,
}: {
  onPhoto: (uri: string) => void;
  onCancel: () => void;
}) {
  const { t: tr } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [foreground, setForeground] = useState(true);
  // A portrait frame like a recipe page, as tall as the screen has room for. It's sized from its
  // measured width rather than aspectRatio + maxHeight: native layout keeps the ratio by narrowing
  // the view, which left a black bar beside the camera.
  const { height: screen } = useWindowDimensions();
  const [frameWidth, setFrameWidth] = useState(0);
  const frame = {
    width: '100%',
    height: Math.min(frameWidth * (4 / 3), Math.max(300, screen - 420)),
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.ink,
  } as const;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);
  const capture = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      // Expo web announces the stream before its first video frame is decodable.
      // Retry only that transient readiness error; permission/device errors surface immediately.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const picture = await camera.current?.takePictureAsync({ quality: 0.9 });
          if (picture) setPhoto(picture.uri);
          break;
        } catch (e) {
          if ((e as { code?: string }).code !== 'ERR_CAMERA_NOT_READY' || attempt === 19) throw e;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } catch {
      setError('We couldn’t take that photo. Check your camera and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 16 }}>
      <Text style={s.muted}>
        {tr('Fit the whole recipe in the frame. Good light makes handwriting easier to read.')}
      </Text>
      {!permission ? (
        <ActivityIndicator color={color.ink} />
      ) : !permission.granted ? (
        <View style={[s.card, { gap: 14 }]}>
          <Camera color={color.ink} size={32} />
          <Text style={s.body}>{tr('Allow camera access to photograph your recipe.')}</Text>
          <Button
            title={permission.canAskAgain ? tr('Allow camera') : tr('Open settings')}
            onPress={() => {
              void (
                permission.canAskAgain
                  ? requestPermission()
                  : Platform.OS !== 'web'
                    ? Linking.openSettings()
                    : Promise.resolve(
                        setError(
                          'Allow camera access in your browser’s site settings, then reopen the camera.',
                        ),
                      )
              ).catch(() =>
                setError('Camera permission wasn’t granted. You can upload a photo instead.'),
              );
            }}
          />
        </View>
      ) : photo ? (
        <FoodImage uri={photo} style={frame} />
      ) : foreground ? (
        <View onLayout={(e) => setFrameWidth(e.nativeEvent.layout.width)} style={frame}>
          {frameWidth > 0 && (
            <CameraView
              ref={camera}
              style={StyleSheet.absoluteFill}
              facing={facing}
              mode="picture"
              onCameraReady={() => setReady(true)}
              onMountError={() =>
                setError('No camera is available. Check permission or upload a photo instead.')
              }
            />
          )}
        </View>
      ) : (
        <Text style={s.muted}>{tr('Camera paused while the app is in the background.')}</Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ ...s.muted, color: color.error }}>
          {tr(error)}
        </Text>
      )}
      <View style={[s.row, { gap: 10 }]}>
        {photo ? (
          <>
            <Button
              title={tr('Use this photo')}
              icon={Camera}
              onPress={() => onPhoto(photo)}
              style={{ flex: 1 }}
            />
            <IconButton
              icon={RotateCcw}
              label={tr('Retake recipe photo')}
              onPress={() => {
                setPhoto('');
                setReady(false);
              }}
            />
          </>
        ) : (
          <>
            <Button
              title={tr('Take photo')}
              icon={Camera}
              disabled={!permission?.granted || !ready}
              busy={busy}
              onPress={() => void capture()}
              style={{ flex: 1 }}
            />
            <IconButton
              icon={SwitchCamera}
              label={tr('Switch camera')}
              onPress={() => {
                setReady(false);
                setFacing((f) => (f === 'back' ? 'front' : 'back'));
              }}
            />
          </>
        )}
      </View>
      <Button title={tr('Back to conversation')} variant="ghost" onPress={onCancel} />
    </View>
  );
}
