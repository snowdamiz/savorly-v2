import { useI18n } from '../lib/i18n';
import React from 'react';
import { Text, View } from 'react-native';
import { Camera, ChevronRight, MessageCircle, Mic, PenLine } from 'lucide-react-native';
import { StudioMode } from '../lib/types';
import { color, font, s } from '../lib/theme';
import { Dialog, Press } from './ui';
const options = [
  {
    mode: 'voice',
    title: 'Speak it',
    text: 'Talk it through, like you would to a friend.',
    label: 'Speak a recipe',
    icon: Mic,
  },
  {
    mode: 'photo',
    title: 'Scan it',
    text: 'Snap a recipe card, cookbook page or screenshot.',
    label: 'Scan a recipe',
    icon: Camera,
  },
  {
    mode: 'chat',
    title: 'Chat it',
    text: 'Type it out. We’ll ask about anything missing.',
    label: 'Chat to create a recipe',
    icon: MessageCircle,
  },
  {
    mode: 'write',
    title: 'Write it yourself',
    text: 'Fill in the ingredients and steps by hand.',
    label: 'Write a recipe yourself',
    icon: PenLine,
  },
] as const;
// The one way into adding a recipe: the + tab, the desktop Create button and empty states all open it.
export function RecipeStart({
  visible,
  onClose,
  onStart,
}: {
  visible: boolean;
  onClose: () => void;
  onStart: (mode: StudioMode | 'write') => void;
}) {
  const { t: tr } = useI18n();
  return (
    <Dialog visible={visible} onClose={onClose} title={tr('Add a recipe')}>
      <Text style={[s.muted, { marginTop: -8 }]}>
        {tr('However it’s easiest. We’ll turn it into a recipe you can edit.')}
      </Text>
      <View style={{ gap: 10 }}>
        {options.map(({ mode, title, text, label, icon: Icon }) => {
          const manual = mode === 'write';
          return (
            <Press
              key={mode}
              accessibilityRole="button"
              accessibilityLabel={tr(label)}
              onPress={() => onStart(mode)}
              scale={0.98}
              style={[s.card, s.row, { gap: 14, padding: 14 }]}
            >
              <View
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 23,
                  backgroundColor: manual ? color.bg : color.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={20} color={manual ? color.ink : color.white} strokeWidth={1.9} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.h3}>{tr(title)}</Text>
                <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
                  {tr(text)}
                </Text>
              </View>
              <ChevronRight size={18} color={color.soft} />
            </Press>
          );
        })}
      </View>
    </Dialog>
  );
}
