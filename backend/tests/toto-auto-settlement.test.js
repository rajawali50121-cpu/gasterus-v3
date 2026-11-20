import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = file => readFileSync(resolve(root, file), 'utf8');
const moduleSource = () => read('backend/src/toto-auto-settlement.js');

// Settlement TOTO otomatis menyentuh uang, jadi pengamannya diuji sebagai kontrak:
// kalau salah satu hilang, test harus merah sebelum kode menyentuh production.
test('auto settlement hanya memakai sumber result resmi',()=>{
  const source = moduleSource();
  assert.match(source, /h2\.source_name LIKE 'OFFICIAL:%' OR h2\.source_name LIKE 'CONSENSUS:%'/, 'SQL harus memfilter sumber OFFICIAL:/CONSENSUS:');
  assert.match(source, /AUTHORITATIVE_SOURCE=\/\^\(OFFICIAL\|CONSENSUS\):\//, 'sumber diverifikasi ulang di kode, bukan hanya di SQL');
  assert.match(source, /if \(!AUTHORITATIVE_SOURCE\.test\(sourceName\)/, 'kandidat dengan sumber tidak resmi harus dilewati');
});

test('auto settlement fail-closed untuk pasar, periode, dan format result',()=>{
  const source = moduleSource();
  assert.match(source, /m\.status='open'/, 'hanya pasar berstatus open yang boleh dibayar');
  assert.match(source, /c\.close_at<=now\(\)/, 'hanya periode yang betting window-nya sudah tutup');
  assert.match(source, /o\.status IN\('ACCEPTED','SETTLEMENT_PENDING'\)/, 'hanya order yang masih hidup yang dibayar');
  assert.match(source, /SETTLEABLE_RESULT=\/\^\\d\{4,6\}\$\//, 'format result harus 4-6 digit');
  assert.match(source, /!SETTLEABLE_RESULT\.test\(result\)/, 'result di luar format harus dilewati, bukan dipaksakan');
});

test('auto settlement tidak bisa membuat dua run untuk satu periode',()=>{
  const source = moduleSource();
  assert.match(source, /FROM market_betting_configs WHERE market_id=\$1 FOR UPDATE/, 'baris config pasar harus dikunci');
  assert.match(source, /SELECT 1 FROM settlement_runs WHERE market_id=\$1 AND period=\$2 AND mode='SETTLE' LIMIT 1/, 'harus mengecek run yang sudah ada');
  assert.match(source, /AND NOT EXISTS \(SELECT 1 FROM settlement_runs r WHERE r\.market_id=c\.market_id AND r\.period=c\.betting_period AND r\.mode='SETTLE'\)/, 'kandidat SQL harus mengecualikan periode yang sudah punya run settlement-nya');
});

test('auto settlement memakai jalur settlement yang sudah ada dan bisa dimatikan',()=>{
  const source = moduleSource();
  const worker = read('backend/src/worker.js');
  const config = read('backend/src/config.js');
  assert.match(source, /INSERT INTO settlement_runs/, 'run dibuat lewat tabel settlement_runs yang sama');
  assert.match(source, /'SETTLE','QUEUED'/, 'mode dan status harus mengikuti alur mesin settlement yang ada');
  assert.match(source, /INSERT INTO job_outbox/, 'pekerjaan dibiarkan ke antrean settlement yang sama');
  assert.match(source, /audit\(\{/, 'pencetakan jejak audit wajib');
  assert.match(source, /action: 'SETTLEMENT_AUTO_QUEUED'/, 'aksi audit harus bisa dibedakan dari settlement manual');
  assert.match(config, /TOTO_AUTO_SETTLEMENT_ENABLED/);
  assert.match(config, /TOTO_AUTO_SETTLEMENT_SECONDS/);
  assert.match(worker, /autoSettleTotoPeriods\(\)/, 'worker harus menjalankan siklus auto settlement');
  assert.match(worker, /totoAutoSettlementEnabled && Date\.now\(\) - lastTotoSettlement/, 'siklus harus bisa dimatikan lewat config');
});


test('auto settlement requires VERIFIED market and execution-time authority revalidation',()=>{
  const source = moduleSource();
  const worker = read('backend/src/worker.js');
  const candidate = source.slice(source.indexOf('const CANDIDATE_SQL'), source.indexOf('const CATCHUP_SQL'));
  const catchup = source.slice(source.indexOf('const CATCHUP_SQL'), source.indexOf('async function queueSettlementRun'));
  assert.match(candidate, /m\.verification_status='VERIFIED'/);
  assert.match(catchup, /m\.verification_status='VERIFIED'/);
  assert.match(worker, /run\.mode === 'SETTLE' && !run\.approval_id && !run\.requested_by/);
  assert.match(worker, /m\.status='open' AND m\.verification_status='VERIFIED'/);
  assert.match(worker, /FOR UPDATE OF m/);
  assert.match(worker, /String\(authority\.result\) !== String\(run\.result_value\)/);
  assert.match(worker, /cancelledAutoRun\) return 'failed'/);
});
