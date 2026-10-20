const MARKET_PRIORITY = { HANDICAP: 0, TOTALS: 1, '1X2': 2 };
const MARKET_NAMES = { HANDICAP: 'Asian Handicap', TOTALS: 'Over / Under', '1X2': '1X2' };

export function primaryMarketColumns(event, period, { includeSuspended = false, pricedOnly = false } = {}) {
  const requestedPeriod = String(period || 'FT').toUpperCase();
  const seenCoreTypes = new Set();
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  return markets
    .filter((market) => (includeSuspended || !market.suspended) &&
      String(market.period || 'FT').toUpperCase() === requestedPeriod &&
      Array.isArray(market.selections) && market.selections.length &&
      (!pricedOnly || (
        Object.hasOwn(MARKET_PRIORITY, String(market.type || '').toUpperCase()) &&
        market.selections.some(selection => Number.isFinite(Number(selection?.odds)) && Number(selection.odds) > 1)
      )))
    .sort((a, b) => (MARKET_PRIORITY[String(a.type || '').toUpperCase()] ?? 99) -
      (MARKET_PRIORITY[String(b.type || '').toUpperCase()] ?? 99))
    .filter((market) => {
      const type = String(market.type || '').toUpperCase();
      if (!Object.hasOwn(MARKET_PRIORITY, type)) return true;
      if (seenCoreTypes.has(type)) return false;
      seenCoreTypes.add(type);
      return true;
    })
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
          let label = selection.label || selection.key || `Pilihan ${index + 1}`;
          if (type === 'HANDICAP') {
            label = tokens.includes('home') || tokens.includes('1') ? '1' :
              tokens.includes('away') || tokens.includes('2') ? '2' : label;
          } else if (type === 'TOTALS') {
            // Hindari false-positive token satu huruf ('o'/'u'): hanya
            // petakan kata utuh over/under, atau label satu huruf O/U.
            const raw = String(selection.label || selection.key || '').trim().toLowerCase();
            label = tokens.includes('over') || raw === 'o' ? 'O' :
              tokens.includes('under') || raw === 'u' ? 'U' : label;
          } else if (type === '1X2') {
            label = tokens.includes('home') || tokens.includes('1') ? '1' :
              tokens.includes('draw') || tokens.includes('x') ? 'X' :
                tokens.includes('away') || tokens.includes('2') ? '2' : label;
          }
          return [label, selection];
        })
      };
    });
}
