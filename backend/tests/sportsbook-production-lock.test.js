import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const core=resolve(here,'..');
const script=`import { config } from './src/config.js'; process.stdout.write(JSON.stringify({manual:config.sportsbookManualFtSettlementFallbackEnabled,eventMarkets:config.theOddsApiEventMarketsEnabled}));`;
function prodEnv(){const env={...process.env,NODE_ENV:'production',DATABASE_URL:'postgresql://user:pass@example.com/db',REDIS_URL:'redis://example.com:6379',MEMBER_PROXY_SECRET:'m'.repeat(48),ADMIN_PROXY_SECRET:'a'.repeat(48),OPS_INTERNAL_SECRET:'o'.repeat(48),SESSION_HMAC_KEY:'s'.repeat(48),API_KEY_PEPPER:'p'.repeat(48),MFA_ENCRYPTION_KEY_BASE64:Buffer.alloc(32,7).toString('base64'),SPORTSBOOK_MANUAL_FT_SETTLEMENT_FALLBACK_ENABLED:'false',THE_ODDS_API_KEY:'existing-provider-key'};delete env.THE_ODDS_API_EVENT_MARKETS_ENABLED;return env;}
test('R6.9.0.13 production enables bounded event detail markets for the existing Odds API key',()=>{const out=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:core,env:prodEnv(),encoding:'utf8'});assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{manual:true,eventMarkets:true});});
test('The Odds API event markets can still be disabled explicitly',()=>{const env={...prodEnv(),THE_ODDS_API_EVENT_MARKETS_ENABLED:'false'};const out=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:core,env,encoding:'utf8'});assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{manual:true,eventMarkets:false});});
