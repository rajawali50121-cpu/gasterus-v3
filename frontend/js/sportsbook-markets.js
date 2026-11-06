const MARKET_PRIORITY = { HANDICAP: 0, TOTALS: 1, '1X2': 2 };
const MARKET_NAMES = { HANDICAP: 'Asian Handicap', TOTALS: 'Over / Under', '1X2': '1X2' };
const MARKET_PERIOD_ORDER = ['FT', '1H', '2H', 'Q1', 'Q2', 'Q3', 'Q4'];

export function availableMarketPeriods(event) {
  const periods = new Set();
  for (const market of Array.isArray(event?.markets) ? event.markets : []) {
    if (!market || typeof market !== 'object' || market.suspended || !Array.isArray(market.selections)) continue;
    if (!market.selections.some(selection => {
      const odds = Number(selection?.odds);
      return !selection?.suspended && Number.isFinite(odds) && odds > 1;
    })) continue;
    periods.add(String(market.period || 'FT').toUpperCase());
  }
  return [...periods].sort((left, right) => {
    const leftOrder = MARKET_PERIOD_ORDER.indexOf(left);
    const rightOrder = MARKET_PERIOD_ORDER.indexOf(right);
    return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) -
      (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder) || left.localeCompare(right);
  });
}

export function selectMarketPeriod(availablePeriods, requestedPeriod) {
  if (availablePeriods.includes(requestedPeriod)) return requestedPeriod;
  if (availablePeriods.includes('FT')) return 'FT';
  return availablePeriods[0] || 'FT';
}

export function primaryMarketColumns(event, period) {
  const requestedPeriod = String(period || 'FT').toUpperCase();
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const expectedOutcomes = {
    HANDICAP: ['1', '2'],
    TOTALS: ['O', 'U'],
    '1X2': ['1', 'X', '2']
  };
  const coreTypes = Object.keys(expectedOutcomes);
  const mappedMarkets = markets
    .filter(market => market && typeof market === 'object' && !Array.isArray(market))
    .map(market => ({
      ...market,
      selections: Array.isArray(market.selections)
        ? market.selections.filter(selection => selection && typeof selection === 'object' && !Array.isArray(selection))
        : []
    }))
    .filter(market => String(market.period || 'FT').toUpperCase() === requestedPeriod)
    .sort((a, b) => (MARKET_PRIORITY[String(a.type || '').toUpperCase()] ?? 99) -
      (MARKET_PRIORITY[String(b.type || '').toUpperCase()] ?? 99))
    .map((market) => {
      const type = String(market.type || '').toUpperCase();
      let selections = Array.isArray(market.selections) ? market.selections : [];
      // Batasi HANDICAP / TOTALS ke satu line utama agar kartu Over/Under
      // tidak melebar menjadi belasan kolom sempit yang membuat teks
      // line & odds saling bertumpuk. Pilih line dengan jumlah pilihan
      // paling lengkap (prefer 2 arah), lalu line terkecil sebagai main line.
      if ((type === 'HANDICAP' || type === 'TOTALS') && selections.length > 2) {
        const byLine = new Map();
        for (const selection of selections) {
          const key = selection?.line ?? market.line ?? '';
          const list = byLine.get(key) || [];
          list.push(selection);
          byLine.set(key, list);
        }
        const ranked = [...byLine.entries()].sort((a, b) => {
          const countDiff = b[1].length - a[1].length;
          if (countDiff) return countDiff;
          return Number(a[0]) - Number(b[0]) || String(a[0]).localeCompare(String(b[0]));
        });
        selections = ranked[0]?.[1] || selections;
      }
      return {
        title: MARKET_NAMES[type] || market.label || market.type || 'Pasar',
        market,
        outcomes: selections.map((selection, index) => {
          const text = `${selection.label || ''} ${selection.key || ''}`.trim().toLowerCase();
          const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
          const homeName = String(event?.home?.name || '').trim().toLowerCase();
          const awayName = String(event?.away?.name || '').trim().toLowerCase();
          let label = selection.label || selection.key || `Pilihan ${index + 1}`;
          if (type === 'HANDICAP') {
            label = tokens.includes('home') || tokens.includes('1') || (homeName && text.includes(homeName)) ? '1' :
              tokens.includes('away') || tokens.includes('2') || (awayName && text.includes(awayName)) ? '2' : label;
          } else if (type === 'TOTALS') {
            // Hindari false-positive token satu huruf ('o'/'u'): hanya
            // petakan kata utuh over/under, atau label satu huruf O/U.
            const raw = String(selection.label || selection.key || '').trim().toLowerCase();
            label = tokens.includes('over') || raw === 'o' ? 'O' :
              tokens.includes('under') || raw === 'u' ? 'U' : label;
          } else if (type === '1X2') {
            label = tokens.includes('home') || tokens.includes('1') || (homeName && text.includes(homeName)) ? '1' :
              tokens.includes('draw') || tokens.includes('x') ? 'X' :
                tokens.includes('away') || tokens.includes('2') || (awayName && text.includes(awayName)) ? '2' : label;
          }
          return [label, selection];
        })
      };
    })
    .filter(item => coreTypes.includes(String(item.market.type || '').toUpperCase()));

  return coreTypes.map(type => {
    const candidates = mappedMarkets
      .filter(item => String(item.market.type || '').toUpperCase() === type)
      .sort((a, b) => {
        const rank = item => {
          if (item.market.suspended) return 1;
          const selections = item.market.selections || [];
          if (selections.some(selection =>
            !selection.suspended && Number.isFinite(Number(selection.odds)) && Number(selection.odds) > 1
          )) return 2;
          if (selections.length && selections.every(selection => selection.suspended)) return 1;
          return 0;
        };
        return rank(b) - rank(a);
      });
    const actual = candidates[0];
    if (!actual) {
      return {
        type,
        title: MARKET_NAMES[type],
        market: null,
        outcomes: expectedOutcomes[type].map(label => [label, null])
      };
    }
    const outcomes = actual.outcomes;
    const fixedOutcomes = expectedOutcomes[type].map(label =>
      outcomes.find(([outcomeLabel]) => outcomeLabel === label) || [label, null]
    );
    const unclassifiedOutcomes = outcomes.filter(([label]) => !expectedOutcomes[type].includes(label));
    return {
      ...actual,
      type,
      outcomes: [...fixedOutcomes, ...unclassifiedOutcomes]
    };
  });
}
