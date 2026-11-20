import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('R6.9.0.12 accepted ticket records manual FT/HT operator settlement requirement in durable metadata', () => {
  const betting = read('../src/sportsbook-betting.js');
  assert.match(betting, /settlementModes:\s*\[\.\.\.new Set\(/);
  assert.match(betting, /manualSettlementRequired:\\s*freshLegs\\.some\\(leg => \\['MANUAL_FT_FALLBACK', 'MANUAL_FT_HT_FALLBACK'\\]\\.includes\\(leg\\.event\\?\\._settlementMode\\)\\)/);
  assert.match(betting, /metadata:\s*row\.metadata && typeof row\.metadata === 'object' \? row\.metadata : \{\}/);
});

test('R6.9.0.12 admin Sportsbook Desk exposes a guarded Manual FT/HT settlement queue', () => {
  const admin = read('../../admin/public/sportsbook-control.html');
  assert.match(admin, /manualSettlementTicket/);
  assert.match(admin, /renderManualSettlementQueue/);
  assert.match(admin, /submitManualFtSettlement/);
  assert.match(admin, /manualSettlementRequired/);
});

test('R6.9.0.12 manual settlement UI exposes ledger-safe rollback correction', () => {
  const admin = read('../../admin/public/sportsbook-control.html');
  const app = read('../src/app.js');
  const betting = read('../src/sportsbook-betting.js');
  assert.match(admin, /rollbackManualSettlement/);
  assert.match(admin, /manual-ops-ui:rollback/);
  assert.match(app, /rollbackSportsbookSettlement/);
  assert.match(betting, /ROLLBACK|rollbackSportsbookSettlement/);
  assert.match(betting, /SERIALIZABLE/);
});
