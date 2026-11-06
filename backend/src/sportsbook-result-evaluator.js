const text = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const rawStatus = value => String(value ?? '').replace(/\s+/g, '').trim().toUpperCase();
const numericOrNull = value => value === null || value === undefined || String(value).trim() === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const scoreValue = numericOrNull;
const lineValue = numericOrNull;
const finalPeriod = value => ['ft', 'full time', 'match', 'regular time'].includes(text(value || 'ft'));
const halfPeriod = value => ['1h', 'ht', 'first half', '1st half', 'half time'].includes(text(value));
const result = (status, resultValue) => ({ status, resultValue });

function scoreForPeriod(leg, event) {
  if (finalPeriod(leg.market_period)) return [scoreValue(event.home?.score), scoreValue(event.away?.score), 'FT'];
  if (halfPeriod(leg.market_period)) {
    const half = event.periodScores?.['1H'] || event.periodScores?.HT || event.score?.halftime || null;
    return [scoreValue(half?.home), scoreValue(half?.away), 'HT'];
  }
  return [null, null, null];
}

function selectedSide(leg) {
  const label = text(leg.selection_label);
  const home = text(leg.home_team);
  const away = text(leg.away_team);
  if (label === '1' || label === 'home' || label === home || label.includes(home)) return 'HOME';
  if (label === '2' || label === 'away' || label === away || label.includes(away)) return 'AWAY';
  if (label === 'x' || label === 'draw' || label.includes('seri')) return 'DRAW';
  return null;
}

function quarterSplit(line) {
  const scaled = line * 4;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-8 || Math.abs(rounded) % 2 !== 1) return [line];
  return [line - 0.25, line + 0.25];
}
function combineSplitResults(statuses) {
  if (statuses.length === 1) return statuses[0];
  if (statuses.every(status => status === 'WON')) return 'WON';
  if (statuses.every(status => status === 'LOST')) return 'LOST';
  if (statuses.every(status => status === 'PUSH')) return 'PUSH';
  if (statuses.includes('WON') && statuses.includes('PUSH')) return 'HALF_WON';
  if (statuses.includes('LOST') && statuses.includes('PUSH')) return 'HALF_LOST';
  return 'VOID';
}
function handicapComponent(selected, opponent, line) {
  const adjusted = selected + line;
  return adjusted > opponent ? 'WON' : adjusted < opponent ? 'LOST' : 'PUSH';
}
function totalComponent(total, line, over) {
  if (total === line) return 'PUSH';
  return (over ? total > line : total < line) ? 'WON' : 'LOST';
}
function halfScoreReady(event) {
  const half = event.periodScores?.['1H'] || event.periodScores?.HT || event.score?.halftime || null;
  if (scoreValue(half?.home) === null || scoreValue(half?.away) === null) return false;
  const provider = rawStatus(event.providerStatus);
  if (!provider) return event.status === 'FINISHED';
  return !['1H', 'LIVE', 'NS', 'TBD'].includes(provider);
}
function settlementAuthorityReady(event, isHalf) {
  const authority = event?.settlementAuthority;
  if (!authority || typeof authority !== 'object') return true;
  return isHalf ? authority.ht === true : authority.ft === true;
}

function providerSettlementDisposition(event) {
  const provider = rawStatus(event.providerStatus);
  // Safety: status administratif Sportmonks (CANCL/Cancelled, POSTP/Postponed,
  // ABAND/Abandoned, WO/AWARD) tidak boleh pernah masuk settlement normal.
  if (['CANC', 'CANCL', 'CANCELED', 'CANCELLED'].includes(provider)) return 'VOID';
  if (['PST', 'POSTP', 'POSTPONED', 'SUSP', 'ABD', 'ABAND', 'ABANDONED', 'INT', 'TBD', 'WO', 'AWARD', 'WALKOVER', 'AWARDED'].includes(provider)) return 'PENDING';
  if (event.status === 'SUSPENDED') return 'PENDING';
  return 'NORMAL';
}

export function evaluateSportsbookLeg(leg, event) {
  if (!event) return null;
  const disposition = providerSettlementDisposition(event);
  if (disposition === 'VOID') return result('VOID', 'Pertandingan dibatalkan oleh sumber hasil');
  if (disposition === 'PENDING') return null;

  const isHalf = halfPeriod(leg.market_period);
  if (!settlementAuthorityReady(event, isHalf)) return null;
  if (isHalf) {
    if (!halfScoreReady(event)) return null;
  } else if (event.status !== 'FINISHED') {
    return null;
  }

  const [home, away, resolvedPeriod] = scoreForPeriod(leg, event);
  if (!resolvedPeriod) return result('VOID', 'Periode market belum didukung auto-settlement');
  if (home === null || away === null) return null;
  const score = `${resolvedPeriod} ${home}-${away}`;
  const label = text(leg.selection_label);
  const type = text(leg.market_type).toUpperCase();
  const side = selectedSide(leg);
  const line = lineValue(leg.market_line);

  if (type === '1X2') {
    const actual = home > away ? 'HOME' : away > home ? 'AWAY' : 'DRAW';
    return result(side === actual ? 'WON' : 'LOST', score);
  }
  if (type === 'HANDICAP') {
    if (!side || side === 'DRAW' || line === null) return result('VOID', `Handicap tidak dapat dihitung · ${score}`);
    const selected = side === 'HOME' ? home : away;
    const opponent = side === 'HOME' ? away : home;
    const components = quarterSplit(line).map(component => handicapComponent(selected, opponent, component));
    const status = combineSplitResults(components);
    return result(status, `${score} · ${side} ${line >= 0 ? '+' : ''}${line}`);
  }
  if (type === 'TOTALS') {
    if (line === null) return result('VOID', `Garis total tidak tersedia · ${score}`);
    const total = home + away;
    const over = label.includes('over') || label.includes('atas');
    const under = label.includes('under') || label.includes('bawah');
    if (!over && !under) return result('VOID', `Pilihan total tidak dikenali · ${score}`);
    const components = quarterSplit(line).map(component => totalComponent(total, component, over));
    return result(combineSplitResults(components), `${score} · total ${total}`);
  }
  if (type === 'DRAW_NO_BET') {
    if (!side || side === 'DRAW') return result('VOID', `Pilihan Draw No Bet tidak dikenali · ${score}`);
    if (home === away) return result('PUSH', score);
    const actual = home > away ? 'HOME' : 'AWAY';
    return result(side === actual ? 'WON' : 'LOST', score);
  }
  if (type === 'CORNERS') {
    const cornerRows = Array.isArray(event.statistics) ? event.statistics.filter(row => Number(row?.type_id) === 34 || text(row?.type?.name) === 'corners') : [];
    const homeCorners = cornerRows.filter(row => text(row?.location) === 'home').reduce((sum, row) => sum + (Number(row?.data?.value) || 0), 0);
    const awayCorners = cornerRows.filter(row => text(row?.location) === 'away').reduce((sum, row) => sum + (Number(row?.data?.value) || 0), 0);
    if (!cornerRows.length || homeCorners === null || awayCorners === null) return null;
    const total = homeCorners + awayCorners;
    if (line === null) return result('VOID', `Garis corner tidak tersedia · ${score}`);
    const over = label.includes('over') || label.includes('atas');
    const under = label.includes('under') || label.includes('bawah');
    if (!over && !under) return result('VOID', `Pilihan corner tidak dikenali · ${score}`);
    const components = quarterSplit(line).map(component => totalComponent(total, component, over));
    return result(combineSplitResults(components), `${score} · corners ${total}`);
  }
  if (type === 'CARDS') {
    const cardRows = Array.isArray(event.statistics) ? event.statistics.filter(row => Number(row?.type_id) === 84 || text(row?.type?.name) === 'yellowcards') : [];
    const homeCards = cardRows.filter(row => text(row?.location) === 'home').reduce((sum, row) => sum + (Number(row?.data?.value) || 0), 0);
    const awayCards = cardRows.filter(row => text(row?.location) === 'away').reduce((sum, row) => sum + (Number(row?.data?.value) || 0), 0);
    if (!cardRows.length || homeCards === null || awayCards === null) return null;
    const total = homeCards + awayCards;
    if (line === null) return result('VOID', `Garis kartu tidak tersedia · ${score}`);
    const over = label.includes('over') || label.includes('atas');
    const under = label.includes('under') || label.includes('bawah');
    if (!over && !under) return result('VOID', `Pilihan kartu tidak dikenali · ${score}`);
    const components = quarterSplit(line).map(component => totalComponent(total, component, over));
    return result(combineSplitResults(components), `${score} · cards ${total}`);
  }
  if (type === 'TEAM_TOTAL') {
    if (line === null) return result('VOID', `Garis team total tidak tersedia · ${score}`);
    const isHome = /home|tuan rumah/.test(label);
    const isAway = /away|tandang/.test(label);
    const over = /over|atas/.test(label);
    const under = /under|bawah/.test(label);
    if ((!isHome && !isAway) || (!over && !under)) return result('VOID', `Pilihan team total tidak dikenali · ${score}`);
    const goals = isHome ? home : away;
    const components = quarterSplit(line).map(component => totalComponent(goals, component, over));
    return result(combineSplitResults(components), `${score} · ${isHome ? 'HOME' : 'AWAY'} goals ${goals}`);
  }
  if (type === 'HT_FT') {
    const half = event.periodScores?.['1H'] || event.periodScores?.HT || event.score?.halftime || null;
    const hh = scoreValue(half?.home), ha = scoreValue(half?.away);
    if (hh === null || ha === null) return null;
    const first = hh > ha ? 'HOME' : hh < ha ? 'AWAY' : 'DRAW';
    const full = home > away ? 'HOME' : home < away ? 'AWAY' : 'DRAW';
    const normalized = label.replace(/\s+/g, ' ').replace(/1h|ht|ft/g, '').trim();
    const tokens = normalized.split(/[\/\-]/).map(x => x.trim()).filter(Boolean);
    const sideToken = token => token === '1' || token === 'home' ? 'HOME' : token === '2' || token === 'away' ? 'AWAY' : token === 'x' || token === 'draw' ? 'DRAW' : null;
    if (tokens.length < 2) return result('VOID', `Pilihan HT/FT tidak dikenali · ${score}`);
    const selectedFirst = sideToken(tokens[0]);
    const selectedFull = sideToken(tokens[1]);
    if (!selectedFirst || !selectedFull) return result('VOID', `Pilihan HT/FT tidak dikenali · ${score}`);
    return result(selectedFirst === first && selectedFull === full ? 'WON' : 'LOST', `HT ${hh}-${ha} · ${score}`);
  }
  if (type === 'BTTS') {
    const actualYes = home > 0 && away > 0;
    const selectedYes = /yes|ya|btts\s*yes/.test(label);
    const selectedNo = /no|tidak|btts\s*no/.test(label);
    if (!selectedYes && !selectedNo) return result('VOID', `Pilihan BTTS tidak dikenali · ${score}`);
    return result(selectedYes === actualYes ? 'WON' : 'LOST', score);
  }
  if (type === 'DOUBLE_CHANCE') {
    const actual = home > away ? '1' : away > home ? '2' : 'X';
    const compact = label.replace(/\s+/g, '').replace('draw', 'x').replace('home', '1').replace('away', '2');
    return result(compact.toUpperCase().includes(actual) ? 'WON' : 'LOST', score);
  }
  if (type === 'ODD_EVEN') {
    const odd = (home + away) % 2 === 1;
    const selectedOdd = /odd|ganjil/.test(label);
    const selectedEven = /even|genap/.test(label);
    if (!selectedOdd && !selectedEven) return result('VOID', `Pilihan ganjil/genap tidak dikenali · ${score}`);
    return result(selectedOdd === odd ? 'WON' : 'LOST', score);
  }
  if (type === 'CORRECT_SCORE') {
    const match = label.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (!match) return result('VOID', `Pilihan skor tepat tidak dikenali · ${score}`);
    return result(Number(match[1]) === home && Number(match[2]) === away ? 'WON' : 'LOST', score);
  }
  return result('VOID', `Market ${leg.market_type} belum didukung auto-settlement · ${score}`);
}

export const __sportsbookResultEvaluator = { quarterSplit, combineSplitResults, halfScoreReady, providerSettlementDisposition, settlementAuthorityReady };
