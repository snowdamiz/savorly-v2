// Keep discovery and publishing in sync. Broad categories preserve existing recipes.
export const countryCuisines = [
  'Italian',
  'French',
  'Russian',
  'Japanese',
  'Mexican',
  'Indian',
  'Chinese',
  'Korean',
  'Thai',
  'Greek',
  'Spanish',
  'Vietnamese',
  'Turkish',
  'Moroccan',
  'Ethiopian',
  'Jamaican',
  'Brazilian',
  'Peruvian',
  'Indonesian',
  'Filipino',
  'American',
  'Ukrainian',
  'Georgian',
  'Polish',
  'German',
  'British',
  'Portuguese',
  'Lebanese',
  'Iranian',
  'Nigerian',
  'Malaysian',
  'Argentinian',
] as const;

export const regionalCuisines = ['Mediterranean', 'Asian', 'Middle Eastern', 'Caribbean'] as const;

export const cuisines = [...countryCuisines, ...regionalCuisines, 'Other'] as const;

export type Cuisine = (typeof cuisines)[number];
export const allCuisines = 'All cuisines';
export const cuisineFilters = [allCuisines, ...cuisines] as const;
