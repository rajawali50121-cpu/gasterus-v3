import crypto from 'node:crypto';
import { config } from './config.js';

const PROVIDER = 'public-market';
const RAW_HOST = 'raw.githubusercontent.com';
const fileCache = new Map();

const BASE_COMPETITIONS = Object.freeze([
  { code:'ENG-PL', league:'Premier League', country:'England', repo:'england', file:'1-premierleague.txt' },
  { code:'ENG-CS', league:'Championship', country:'England', repo:'england', file:'2-championship.txt' },
  { code:'GER-BL', league:'Bundesliga', country:'Germany', repo:'deutschland', file:'1-bundesliga.txt' },
  { code:'ITA-SA', league:'Serie A', country:'Italy', repo:'italy', file:'1-seriea.txt' },
  { code:'ESP-LL', league:'La Liga', country:'Spain', repo:'espana', file:'1-liga.txt' },
]);

// Musim dihitung dari tanggal sekarang (bukan di-hardcode). Eropa: musim X-(X+1)
// dimulai Juli. Jika proses berjalan sebelum file musim berjalan tersedia di
// OpenFootball, fetchOpenFootballFixtures otomatis fallback ke musim sebelumnya
// (lihat di bawah), sehingga feed tidak pernah kosong hanya karena path musim
// yang di-hardcode tidak lagi valid.
function openFootballSeason(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const start = m >= 7 ? y : y - 1;
  const end = start + 1;
  return { start, current: `${start}-${String(end).slice(-2)}`, previous: `${start - 1}-${String(start).slice(-2)}` };
}

function buildCompetitions(date = new Date()) {
  const season = openFootballSeason(date);
  return BASE_COMPETITIONS.map(c => ({
    ...c,
    current: `https://raw.githubusercontent.com/openfootball/${c.repo}/master/${season.current}/${c.file}`,
    previous: `https://raw.githubusercontent.com/openfootball/${c.repo}/master/${season.previous}/${c.file}`,
    seasonStartYear: season.start
  }));
}

const COMPETITIONS = Object.freeze(buildCompetitions());

// Prune-by-season-generation: kunci fileCache memuat season (mis. openfootball/england/master/2025-26/...).
// fetchOpenFootballFixtures() memanggil buildCompetitions() ulang tiap refresh (:158), sehingga
// setelah pergantian musim fileCache menambah 10 URL baru per pergantian dalam satu proses.
// Season yang tidak lagi dipakai tidak akan pernah dibaca lagi → dibuang, bukan menumpuk.
// Pola yang sama dipakai resultFileCache (sportsbook-public-market.js).
const OPENFOOTBALL_SEASON_PATTERN = /\/openfootball\/[^/]+\/master\/(\d{4}-\d{2})\//;
function fileUrlSeason(url) {
  const match = OPENFOOTBALL_SEASON_PATTERN.exec(String(url || ''));
  return match ? match[1] : null;
}
function pruneStaleSeasons(liveSeasons) {
  for (const key of [...fileCache.keys()]) {
    const season = fileUrlSeason(key);
    if (season && !liveSeasons.has(season)) fileCache.delete(key);
  }
}
function liveSeasonsFor(competitions) {
  return new Set(competitions.flatMap(comp => [fileUrlSeason(comp.current), fileUrlSeason(comp.previous)]).filter(Boolean));
}

const clean = (v, max=180) => String(v ?? '').replace(/\s+/g,' ').trim().slice(0,max);
const clamp = (n,lo,hi) => Math.max(lo, Math.min(hi,n));
const hash = (...parts) => crypto.createHash('sha256').update(parts.map(v=>String(v??'')).join('|')).digest('hex').slice(0,28);
const slug = v => clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,100);
const MONTHS = Object.freeze({ jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 });

function sourceTime(headers, fallback=Date.now()) {
  const parsed = Date.parse(headers?.get?.('last-modified') || '');
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

async function requestRaw(url, retries = 2) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== RAW_HOST) throw new Error('OpenFootball source host is not approved');
  const prior = fileCache.get(url);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), Number(config.publicMarketRequestTimeoutMs || 10000));
    try {
      const headers = { accept:'text/plain,*/*;q=0.2', 'user-agent':'Gasterus-OpenFootball-Collector/1.0' };
      if (prior?.etag) headers['if-none-match'] = prior.etag;
      const response = await fetch(url,{headers,signal:controller.signal,redirect:'error'});
      if (response.status === 304 && prior) return prior;
      if (!response.ok) {
        const message = `OpenFootball HTTP ${response.status}`;
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(message);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
            continue;
          }
        }
        throw new Error(message);
      }
      const text = await response.text();
      if (text.length > 3*1024*1024) throw new Error('OpenFootball file exceeds size limit');
      const digest = crypto.createHash('sha256').update(text).digest('hex');
      const updatedAt = prior?.digest === digest ? prior.updatedAt : sourceTime(response.headers);
      const item = { text, updatedAt, etag:response.headers.get('etag'), digest, fetchedAt:Date.now() };
      fileCache.set(url,item);
      return item;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      const retryable = /429|5\d\d|AbortError|fetch failed|network/i.test(message);
      if (attempt < retries && retryable) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`OpenFootball fetch failed for ${url}`);
}

function parseDayLine(line, seasonStartYear) {
  const m = clean(line,80).match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?$/i);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0,3).toLowerCase()];
  if (month === undefined) return null;
  const year = m[3] ? Number(m[3]) : (month >= 7 ? seasonStartYear : seasonStartYear + 1);
  return { year, month, day:Number(m[2]) };
}

function isoKickoff(day,time='12:00') {
  if (!day) return null;
  const tm = String(time).match(/^(\d{1,2}):(\d{2})$/);
  const hh = tm ? Number(tm[1]) : 12, mm = tm ? Number(tm[2]) : 0;
  return new Date(Date.UTC(day.year,day.month,day.day,hh,mm,0)).toISOString();
}

export function parseOpenFootballText(text,{seasonStartYear=2026}={}) {
  const matches=[];
  let currentDay=null, currentTime=null;
  for (const raw of String(text??'').split(/\r?\n/)) {
    const line=raw.replace(/\s+#.*$/,'').trimEnd();
    if (!line.trim()) continue;
    const day=parseDayLine(line,seasonStartYear);
    if (day) { currentDay=day; currentTime=null; continue; }
    if (!currentDay) continue;
    let body=line.trim();
    const timeMatch=body.match(/^(\d{1,2}:\d{2})(?:\s+UTC[+-]\d+(?::\d+)?)?\s+/i);
    if (timeMatch) { currentTime=timeMatch[1]; body=body.slice(timeMatch[0].length); }
    if (!currentTime) continue;
    body=body.replace(/\s+@\s+.*$/,'').trim();
    let ft=null, ht=null;
    let resultMatch=body.match(/\s+(\d+)-(\d+)(?:\s+(?:a\.e\.t\.\s*)?\((\d+)-(\d+)\))?\s*$/i);
    if (resultMatch) {
      ft=[Number(resultMatch[1]),Number(resultMatch[2])];
      if (resultMatch[3]!==undefined) ht=[Number(resultMatch[3]),Number(resultMatch[4])];
      body=body.slice(0,resultMatch.index).trim();
    }
    let teams=body.match(/^(.+?)\s+v\s+(.+)$/i);
    if (!teams) {
      const completed=body.match(/^(.+?)\s+(\d+)-(\d+)(?:\s+\((\d+)-(\d+)\))\s+(.+)$/i);
      if (!completed) continue;
      teams=[null, completed[1], completed[6]];
      ft=[Number(completed[2]),Number(completed[3])];
      ht=[Number(completed[4]),Number(completed[5])];
    }
    const home=clean(teams[1],120), away=clean(teams[2],120), startTime=isoKickoff(currentDay,currentTime);
    if (!home || !away || !startTime) continue;
    matches.push({home,away,startTime,ft,ht});
  }
  return matches;
}

function weightedModel(current,previous) {
  const finished=[...previous.filter(m=>m.ft).map(m=>({...m,w:0.65})),...current.filter(m=>m.ft).map(m=>({...m,w:1.15}))];
  let totalW=0,hg=0,ag=0;
  const teams=new Map();
  const get=name=>{ if(!teams.has(name)) teams.set(name,{hh:0,hga:0,hg:0,ah:0,aga:0,ag:0}); return teams.get(name); };
  for (const m of finished) {
    const w=m.w; totalW+=w; hg+=m.ft[0]*w; ag+=m.ft[1]*w;
    const h=get(m.home),a=get(m.away);
    h.hh+=m.ft[0]*w; h.hga+=m.ft[1]*w; h.hg+=w;
    a.ah+=m.ft[1]*w; a.aga+=m.ft[0]*w; a.ag+=w;
  }
  const avgH=clamp(totalW?hg/totalW:1.48,0.7,2.4), avgA=clamp(totalW?ag/totalW:1.18,0.6,2.1);
  const pseudo=6;
  const lambdas=(home,away)=>{
    const h=get(home),a=get(away);
    const homeAttack=((h.hh+pseudo*avgH)/(h.hg+pseudo))/avgH;
    const homeDefense=((h.hga+pseudo*avgA)/(h.hg+pseudo))/avgA;
    const awayAttack=((a.ah+pseudo*avgA)/(a.ag+pseudo))/avgA;
    const awayDefense=((a.aga+pseudo*avgH)/(a.ag+pseudo))/avgH;
    return {lambdaHome:clamp(avgH*homeAttack*awayDefense,0.25,4.2),lambdaAway:clamp(avgA*awayAttack*homeDefense,0.2,3.8)};
  };
  return {avgH,avgA,lambdas,finished:finished.length};
}

function poisson(lambda,max=9){const o=new Array(max+1).fill(0);o[0]=Math.exp(-lambda);for(let k=1;k<=max;k+=1)o[k]=o[k-1]*lambda/k;return o;}
function scoreGrid(lh,la,max=9){const hp=poisson(lh,max),ap=poisson(la,max);let mass=0;const g=[];for(let h=0;h<=max;h++)for(let a=0;a<=max;a++){const p=hp[h]*ap[a];mass+=p;g.push({h,a,p});}return g.map(x=>({...x,p:x.p/mass}));}
function outcome(grid){let h=0,d=0,a=0;for(const x of grid){if(x.h>x.a)h+=x.p;else if(x.h<x.a)a+=x.p;else d+=x.p;}return{h,d,a};}
function book(p,margin){return clamp(Math.round((1/(Math.max(p,1e-6)*(1+margin)))*1000)/1000,1.01,250);}

export function buildOpenFootballModelAnchor(home,away,model,{marginBps=450}={}) {
  const {lambdaHome,lambdaAway}=model.lambdas(home,away);
  const probs=outcome(scoreGrid(lambdaHome,lambdaAway,9));
  const margin=clamp(Number(marginBps||450)/10000,0.01,0.12);
  return { oneXtwo:{home:book(probs.h,margin),draw:book(probs.d,margin),away:book(probs.a,margin),book:'gasterus-open-model'}, lambdaHome,lambdaAway, sampleMatches:model.finished };
}

export async function fetchOpenFootballFixtures() {
  if (config.publicMarketOpenFootballEnabled === false) return {events:[],warnings:[],sources:[]};
  const competitions = buildCompetitions();
  // Season generation yang masih hidup = season yang akan di-request pada refresh ini.
  pruneStaleSeasons(liveSeasonsFor(competitions));
  const results=await Promise.allSettled(competitions.map(async comp=>{
    let cur=null, prev=null;
    try { cur = await requestRaw(comp.current); } catch { /* musim berjalan mungkin belum tersedia */ }
    try { prev = await requestRaw(comp.previous); } catch { /* abaikan */ }
    if (!cur && !prev) throw new Error(`${comp.code} current and previous season both unavailable`);
    // Prior-season matches are historical model input, never current fixtures.
    const current=cur?parseOpenFootballText(cur.text,{seasonStartYear:comp.seasonStartYear}):[];
    const previous=prev?parseOpenFootballText(prev.text,{seasonStartYear:comp.seasonStartYear-1}):[];
    const model=weightedModel(current,previous);
    const updatedAt=[cur?.updatedAt,prev?.updatedAt].filter(Boolean).sort().at(-1) || new Date().toISOString();
    const warning = cur ? null : `${comp.code} current season unavailable; previous season retained for historical model data only`;
    return {comp,current,model,updatedAt,warning};
  }));
  const events=[],warnings=[],sources=[];
  for (let i=0;i<results.length;i++) {
    const item=results[i],comp=competitions[i];
    if(item.status!=='fulfilled'){warnings.push(`${comp.code} unavailable: ${item.reason?.message||item.reason}`);continue;}
    const {current,model,updatedAt,warning}=item.value;
    if (warning) warnings.push(warning);
    sources.push(comp.code);
    for(const m of current){
      const anchor=buildOpenFootballModelAnchor(m.home,m.away,model,{marginBps:config.publicMarketDerivedMarginBps});
      events.push({competition:comp,match:m,anchor,updatedAt});
    }
  }
  return {events,warnings,sources};
}

export const __openFootball={COMPETITIONS,parseDayLine,isoKickoff,weightedModel,scoreGrid,outcome,openFootballSeason,buildCompetitions,fileCache,fileUrlSeason,pruneStaleSeasons,liveSeasonsFor};