export const PARSER_VERSION = '1';

const FORMATS = {
  decimal: (raw) => Number(raw),
  hongkong: (raw) => 1 + Number(raw),
  malay: (raw) => {
    const n = Number(raw);
    return n > 0 ? 1 + n : 1 + (1 / Math.abs(n));
  },
  indo: (raw) => {
    const n = Number(raw);
    return n > 0 ? 1 + (n / 100) : 1 + (100 / Math.abs(n));
  },
  american: (raw) => {
    const n = Number(raw);
    return n > 0 ? 1 + (n / 100) : 1 + (100 / Math.abs(n));
  },
  fractional: (raw) => {
    const [a, b] = String(raw).split('/').map(Number);
    return 1 + a / b;
  }
};

export function normalizeOdds({ rawValue, rawFormat, provider, parserVersion = PARSER_VERSION }) {
  const result = { rawValue, rawFormat, provider, parserVersion, decimal: null, status: 'REJECTED' };
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return { ...result, status: 'REJECTED' };
  }
  const parser = FORMATS[rawFormat];
  if (!parser) {
    return { ...result, status: 'QUARANTINED' };
  }
  let decimal;
  try {
    decimal = parser(rawValue);
  } catch (e) {
    return { ...result, status: 'QUARANTINED' };
  }
  if (!Number.isFinite(decimal)) {
    return { ...result, status: 'REJECTED' };
  }
  if (decimal <= 1.0) {
    return { ...result, status: 'REJECTED' };
  }
  const floored = Math.floor(decimal * 1000) / 1000;
  if (floored <= 1.0) {
    return { ...result, decimal: floored, status: 'REJECTED' };
  }
  return { ...result, decimal: floored, status: 'ACCEPTED' };
}
