import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { allCuisines, countryCuisines, regionalCuisines } from '../lib/cuisines';
import { s } from '../lib/theme';
import { CuisineIcon } from './CuisineIcon';
import { Chip, Field } from './ui';

export function CuisinePicker({
  value,
  onChange,
  includeAll = false,
}: {
  value: string;
  onChange: (cuisine: string) => void;
  includeAll?: boolean;
}) {
  const { t: tr } = useI18n();
  const [query, setQuery] = useState('');
  const match = (name: string) =>
    [name, tr(name)].some((label) =>
      label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
  const groups = [
    { title: 'By country', names: countryCuisines.filter(match) },
    { title: 'Regional & other', names: [...regionalCuisines, 'Other'].filter(match) },
  ];
  const chip = (name: string) => (
    <Chip
      key={name}
      title={tr(name)}
      leading={<CuisineIcon name={name} />}
      active={value === name}
      onPress={() => onChange(name)}
    />
  );
  return (
    <View style={{ gap: 16 }}>
      <Field
        accessibilityLabel={tr('Search cuisines')}
        placeholder={tr('Find a cuisine…')}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      {includeAll && <View style={s.wrap}>{chip(allCuisines)}</View>}
      {groups.map(({ title, names }) =>
        names.length ? (
          <View key={title} style={{ gap: 10 }}>
            <Text style={s.label}>{tr(title)}</Text>
            <View style={[s.wrap, { gap: 8 }]}>{names.map(chip)}</View>
          </View>
        ) : null,
      )}
      {!groups.some((g) => g.names.length > 0) && (
        <Text accessibilityLiveRegion="polite" style={s.muted}>
          {tr('No matching cuisines. Try a different spelling.')}
        </Text>
      )}
    </View>
  );
}
