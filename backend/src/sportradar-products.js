const ORIGIN = 'https://api.sportradar.com';

export const SPORTRADAR_PRODUCTS = Object.freeze({
  soccerV4: Object.freeze({
    family: 'soccer',
    version: 'v4',
    role: 'fixtures-results-statistics',
    suppliesOdds: false
  }),
  prematchV2: Object.freeze({
    family: 'oddscomparison-prematch',
    version: 'v2',
    role: 'prematch-markets',
    suppliesOdds: true
  }),
  playerPropsV2: Object.freeze({
    family: 'oddscomparison-player-props',
    version: 'v2',
    role: 'player-props',
    suppliesOdds: true
  }),
  liveOddsV2: Object.freeze({
    family: 'oddscomparison-liveodds',
    version: 'v2',
    role: 'in-play-markets',
    suppliesOdds: true
  }),
  futuresV2: Object.freeze({
    family: 'oddscomparison-futures',
    version: 'v2',
    role: 'futures-markets',
    suppliesOdds: true
  })
});

export const SPORTRADAR_LEGACY_PRODUCTS = Object.freeze({
  oddsComparisonRegularV1: Object.freeze({
    active: false,
    reason: 'Legacy v1 product; do not use for the new v2 integration.'
  })
});

export function normalizeSportradarAccessLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  if (level !== 'trial' && level !== 'production') {
    throw new Error('Sportradar access level must be trial or production.');
  }
  return level;
}

export function buildSportradarProductBaseUrl(productKey, {
  accessLevel = 'production',
  languageCode = 'en'
} = {}) {
  const product = SPORTRADAR_PRODUCTS[productKey];
  if (!product) {
    throw new Error(`Unsupported or legacy Sportradar product: ${String(productKey)}`);
  }
  const level = normalizeSportradarAccessLevel(accessLevel);
  const language = String(languageCode || 'en').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(language)) {
    throw new Error('Sportradar language code must be a two-letter code.');
  }
  return `${ORIGIN}/${product.family}/${level}/${product.version}/${language}`;
}

export function buildSportradarHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('SPORTRADAR_API_KEY is not configured.');
  return { 'x-api-key': key, accept: 'application/json' };
}

export function getSportradarAccessFromPrematchBaseUrl(value) {
  const match = String(value || '').trim().match(/\/oddscomparison-prematch\/(trial|production)\/v2\/([a-z]{2})\/?$/i);
  if (!match) {
    throw new Error('SPORTRADAR_BASE_URL must be an Odds Comparison Prematch v2 base URL.');
  }
  return { accessLevel: match[1].toLowerCase(), languageCode: match[2].toLowerCase() };
}
