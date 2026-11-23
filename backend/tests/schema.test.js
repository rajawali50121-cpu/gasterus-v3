import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';
const schema=await readFile(new URL('../migrations/001_platform.sql',import.meta.url),'utf8');
const sportsbookSchema=await readFile(new URL('../migrations/042_sportsbook_v2_core.sql',import.meta.url),'utf8');
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
