import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';
const schema=await readFile(new URL('../migrations/001_platform.sql',import.meta.url),'utf8');
const sportsbookSchema=await readFile(new URL('../migrations/042_sportsbook_v2_core.sql',import.meta.url),'utf8');
const sportsbookTimestampSchema=await readFile(new URL('../migrations/043_sportsbook_v2_provider_timestamps.sql',import.meta.url),'utf8');
const sportsbookSettlementSchema=await readFile(new URL('../migrations/044_sportsbook_v2_market_results_settlement.sql',import.meta.url),'utf8');
const sportsbookResultReceiptSchema=await readFile(new URL('../migrations/045_sportsbook_v2_result_receipt_times.sql',import.meta.url),'utf8');
const sportsbookBetAcceptanceSchema=await readFile(new URL('../migrations/046_sportsbook_v2_bet_acceptance.sql',import.meta.url),'utf8');
const sportsbookCorrectionReviewSchema=await readFile(new URL('../migrations/047_sportsbook_v2_result_correction_review.sql',import.meta.url),'utf8');
const sportsbookBettingService=await readFile(new URL('../src/sportsbook-next/betting-service.js',import.meta.url),'utf8');
const sportsbookSettlementService=await readFile(new URL('../src/sportsbook-next/settlement-service.js',import.meta.url),'utf8');
const sportsbookResultsRepository=await readFile(new URL('../src/sportsbook-next/results-repository.js',import.meta.url),'utf8');
const memberExperienceSchema=await readFile(new URL('../migrations/003_member_experience.sql',import.meta.url),'utf8');
const lotterySchema=await readFile(new URL('../migrations/004_lottery_enterprise.sql',import.meta.url),'utf8');
const enterpriseBackofficeSchema=await readFile(new URL('../migrations/005_enterprise_backoffice.sql',import.meta.url),'utf8');
const enterpriseOperationsSchema=await readFile(new URL('../migrations/006_enterprise_operations.sql',import.meta.url),'utf8');
const moneyIntegritySchema=await readFile(new URL('../migrations/007_money_integrity.sql',import.meta.url),'utf8');
test('schema includes PostgreSQL ledger and approval controls',()=>{for(const token of ['ledger_accounts','ledger_transactions','ledger_entries','approval_requests','approved_by <> requested_by','prevent_audit_mutation'])assert.ok(schema.includes(token),token);});
test('member and admin services remain isolated',async()=>{const member=await readFile(new URL('../../deploy/member-server.js',import.meta.url),'utf8');const admin=await readFile(new URL('../../admin/server.js',import.meta.url),'utf8');assert.ok(member.includes('hiddenManagementPath'));assert.ok(admin.includes("url.pathname.startsWith('/member/')"));});

test('new sportsbook v2 schema separates provider catalogue, prices, tickets and legs with idempotency',()=>{for(const token of ['sportsbook_v2_events','sportsbook_v2_markets','sportsbook_v2_prices','sportsbook_v2_tickets','sportsbook_v2_ticket_legs','UNIQUE(member_id,idempotency_key)','UNIQUE(ticket_id,provider_event_id)'])assert.ok(sportsbookSchema.includes(token),token);});

test('member experience schema includes durable notifications',()=>{for(const token of ['member_notifications','DEPOSIT_APPROVED','SPORTSBOOK_WIN','read_at'])assert.ok(memberExperienceSchema.includes(token),token);});


test('lottery enterprise schema includes game pricing, selection exposure and official result hierarchy',()=>{for(const token of ['lottery_game_configs','lottery_selection_limits','market_result_details','max_payout_per_order','game_code','selection_value'])assert.ok(lotterySchema.includes(token),token);});

test('enterprise backoffice schema includes payment CMS and settings controls',()=>{for(const token of ['payment_methods','content_banners','promotions','system_settings','payment_snapshot','proof_image'])assert.ok(enterpriseBackofficeSchema.includes(token),token);});


test('enterprise operations schema includes compliance responsible play risk support security and reconciliation',()=>{for(const token of ['member_compliance_profiles','kyc_reviews','responsible_play_profiles','security_events','risk_alerts','support_cases','reconciliation_runs','COMPLIANCE','ANALYST'])assert.ok(enterpriseOperationsSchema.includes(token),token);});


test('money integrity schema reserves withdrawals and makes accounting history immutable',()=>{for(const token of ['money_transaction_events','wallet_requests_member_idempotency_uq','ledger_transactions_no_update','ledger_entries_no_update','ledger_transaction_balance_commit','WALLET_REVERSAL','payment_provider_events'])assert.ok(moneyIntegritySchema.includes(token),token);});

test('sportsbook source timestamps remain distinct from ingestion time without destructive migration',()=>{for(const token of ['provider_generated_at','ALTER COLUMN source_updated_at DROP NOT NULL','sportsbook_v2_events','sportsbook_v2_markets'])assert.ok(sportsbookTimestampSchema.includes(token),token);assert.doesNotMatch(sportsbookTimestampSchema,/\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);});

test('sportsbook market mapping, result and settlement revisions are additive and auditable',()=>{for(const token of ['sportsbook_v2_market_catalog','sportsbook_v2_provider_market_mappings','sportsbook_v2_event_result_revisions','sportsbook_v2_settlement_revisions','UNIQUE(ticket_id,revision_no)','ledger_transaction_id'])assert.ok(sportsbookSettlementSchema.includes(token),token);assert.doesNotMatch(sportsbookSettlementSchema,/\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);});

test('sportsbook bet acceptance separates receipt time, change-log verification and immutable settlement mapping',()=>{
  for(const token of ['received_at','change_log_verified_at','provider_market_name','provider_book_name','provider_outcome_name','provider_outcome_type','price_received_at','market_code','outcome_code','settlement_rule','mapping_version','ALTER COLUMN source_updated_at DROP NOT NULL']) assert.ok(sportsbookBetAcceptanceSchema.includes(token),token);
  assert.doesNotMatch(sportsbookBetAcceptanceSchema,/\\bDROP\\s+TABLE\\b|\\bTRUNCATE\\b|\\bDELETE\\s+FROM\\b/i);
});

test('sportsbook ticket acceptance is gated by a fresh complete Change Log and uses the existing double-entry ledger',()=>{
  for(const token of ['SPORTRADAR_CHANGELOG_ENABLED','SPORTRADAR_ACCESS_LEVEL','PRODUCTION_ENTITLEMENT_REQUIRED','CHANGE_LOG_WINDOW_STALE','change_log_verified_at','postTransfer','SPORTSBOOK_HOLD','SPORTSBOOK_RISK_RESERVE','enforceResponsiblePlay','requestFingerprint','NO_VERIFIED_MARKET_MAPPINGS','listMemberSportsbookTickets']) assert.ok(sportsbookBettingService.includes(token),token);
  assert.ok(sportsbookBettingService.includes('SUPPORTED_MARKET_CODE'));
  assert.ok(sportsbookBettingService.includes('SPORTSBOOK_SETTLEMENT_RULE_UNSUPPORTED'));
});

test('sportsbook acceptance cannot start before settlement is explicitly enabled',()=>{
  assert.ok(sportsbookBettingService.includes('SPORTSBOOK_SETTLEMENT_ENABLED'));
  assert.ok(sportsbookBettingService.includes('SETTLEMENT_ENGINE_DISABLED'));
});

test('sportsbook settlement uses confirmed results, SKIP LOCKED and the existing double-entry ledger',()=>{
  for(const token of ['FOR UPDATE OF t SKIP LOCKED','evaluateSoccer1x2Leg','SPORTSBOOK_HOLD','SPORTSBOOK_RISK_RESERVE','PAYOUT_RESERVE_RELEASE','postSystemTransfer','postTransfer','SPORTSBOOK_TICKET_SETTLED']) assert.ok(sportsbookSettlementService.includes(token),token);
  assert.ok(sportsbookBetAcceptanceSchema.includes('settlement_ledger_transaction_id'));
});

test('settled result corrections are quarantined for audited owner review',()=>{
  for(const token of ['review_required','review_reason','review_detected_at','reviewed_at','reviewed_by','review_note']) assert.ok(sportsbookCorrectionReviewSchema.includes(token),token);
  assert.doesNotMatch(sportsbookCorrectionReviewSchema,/\\bDROP\\s+TABLE\\b|\\bTRUNCATE\\b|\\bDELETE\\s+FROM\\b/i);
  for(const token of ['PROVIDER_RESULT_CHANGED_AFTER_SETTLEMENT','resultPayloads','financiallyReconciled','SPORTSBOOK_RESULT_CORRECTION_REVIEWED']) assert.ok(sportsbookSettlementService.includes(token),token);
});

test('sportsbook result persistence allows optional provider time and records receipt time separately',()=>{
  assert.ok(sportsbookSettlementSchema.includes('sportsbook_v2_result_revisions_source_version_uq'));
  assert.ok(sportsbookResultReceiptSchema.includes('ADD COLUMN IF NOT EXISTS received_at'));
  assert.ok(sportsbookResultReceiptSchema.includes('ALTER COLUMN source_updated_at DROP NOT NULL'));
  assert.ok(sportsbookResultReceiptSchema.includes('sportsbook_v2_result_revisions_receipt_version_uq'));
  assert.ok(sportsbookResultsRepository.includes('ON CONFLICT (provider_event_id,result_source,provider_generated_at)'));
  assert.ok(sportsbookResultsRepository.includes('received_at=excluded.received_at'));
  assert.ok(sportsbookResultsRepository.includes('SELECT now() AS received_at'));
  assert.doesNotMatch(sportsbookResultsRepository,/new Date\\(\\)/);
  assert.ok(sportsbookResultsRepository.includes('ON CONFLICT (provider_event_id,result_source,received_at)'));
  assert.doesNotMatch(sportsbookResultsRepository,/if \\(!result\\?\\.providerGeneratedAt\\) continue;/);
});
