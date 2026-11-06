const ASIAN_FORMATS = new Set(['INDONESIAN', 'HONG_KONG', 'MALAY']);

export function formatOdds(value, format = 'DECIMAL') {
  const decimal = Number(value);
  if (!Number.isFinite(decimal) || decimal <= 1) return '—';
  const hongKong = decimal - 1;
  if (format === 'HONG_KONG') return hongKong.toFixed(2);
  if (format === 'INDONESIAN') return (hongKong >= 1 ? hongKong : -1 / hongKong).toFixed(2);
  if (format === 'MALAY') return (hongKong >= 1 ? -hongKong : 1 / hongKong).toFixed(2);
  return decimal.toFixed(2);
}

export function oddsColorClass(direction, marketType, decimalOdds, format = 'DECIMAL') {
  if (direction === 'down') return 'odds-red';
  if (direction === 'up') return 'odds-green';
  if (ASIAN_FORMATS.has(format) && Number.isFinite(Number(decimalOdds))) {
    const hongKong = Number(decimalOdds) - 1;
    const value = format === 'INDONESIAN'
      ? (hongKong >= 1 ? hongKong : -1 / hongKong)
      : format === 'MALAY'
        ? (hongKong >= 1 ? -hongKong : 1 / hongKong)
        : hongKong;
    if (value < 0) return 'odds-red';
  }
  if (format === 'HONG_KONG') return 'odds-blue';
  return ['HANDICAP', 'TOTALS', '1X2'].includes(String(marketType || '').toUpperCase())
    ? 'odds-black'
    : 'odds-blue';
}
