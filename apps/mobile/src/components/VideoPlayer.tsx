import React from 'react';
import { useVideoPlayer, VideoView } from 'expo-video';
import { color, radius } from '../lib/theme';
export function VideoPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={{ height: 280, width: '100%', borderRadius: radius.md, backgroundColor: color.ink }}
      nativeControls
      contentFit="contain"
    />
  );
}
