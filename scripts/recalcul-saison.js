'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BASE_URL='https://api-web.nhle.com/v1', PRIX_DEPART=25, PRICE_FLOOR=0.50;
const SEASON_START='2025-10-08', SEASON_END='2026-04-18';
const DELAY_MS=400; // 400ms entre chaque fetch → ~74 secondes pour 184 jours

const ALGO={WIN_REG:0.03,WIN_OT:0.015,SHUTOUT:0.03,LOSS_REG:0.03,LOSS_OT:0.015,
  CLINCH:0.12,REBOND:0.50,RIVALITE:0.005,SPRINT:1.20,CHUTE:1.30,DOMINANCE:0.01};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function streakMult(a){return a>=7?3:a>=5?2:a>=3?1.5:1;}
function applyFloor(p){return Math.max(PRICE_FLOOR,parseFloat(p.toFixed(4)));}
function addDays(d,n){const x=new Date(d+'T12:00:00Z');x.setDate(x.getDate()+n);return x.toISOString().split('T')[0];}
function today(){return new Date().toISOString().split('T')[0];}
function getDates(s,e){const r=[];let c=s;while(c<=e){r.push(c);c=addDays(c,1);}return r;}
function isSprint(d){return d>=addDays(SEASON_END,-14)&&d<=SEASON_END;}

async function fetchWithRetry(url,retries=3){
  for(let i=0;i<retries;i++){
    try{
      const r=await fetch(url);
      if(r.status===429){await sleep(3000+i*2000);continue;}
      if(!r.ok)return null;
      return await r.json();
    }catch{await sleep(1000+i*1000);}
  }
  return null;
}

async function fetchGames(date){
  const d=await fetchWithRetry(`${BASE_URL}/score/${date}`);
  return (d?.games||[]).filter(g=>(g.gameState==='OFF'||g.gameState==='FINAL')&&g.gameType===2);
}

async function fetchStandings(date){
  const d=await fetchWithRetry(`${BASE_URL}/standings/${date}`);
  const m={};
  for(const s of(d?.standings||[])){
    const a=s.teamAbbrev?.default;
    if(a)m[a]={div:s.divisionName,rank:s.divisionSequence||99,clinched:['x','y','z'].includes(s.clinchIndicator)};
  }
  return m;
}

function calcImpact(side,streak,date){
  const{won,overtime,shutout}=side;
  let pct=0;const parts=[];
  if(won){
    const base=overtime?ALGO.WIN_OT:ALGO.WIN_REG;
    const ns=streak>=0?streak+1:1, mult=streakMult(ns);
    pct+=base*mult;
    parts.push(overtime?`VicOT(x${mult})`:`Vic(x${mult})`);
    if(shutout){pct+=ALGO.SHUTOUT;parts.push('Shutout');}
    if(streak<=-5){pct*=(1+ALGO.REBOND);parts.push('REBOND!');}
    if(ns>=7){pct+=ALGO.DOMINANCE;parts.push('Dominance');}
  }else{
    const base=overtime?ALGO.LOSS_OT:ALGO.LOSS_REG;
    const ls=streak<=0?Math.abs(streak)+1:1;
    let mult=streakMult(ls);
    if(streak>=5){mult=ALGO.CHUTE;parts.push(`CHUTE!x1.3`);}
    else if(ls>=3)parts.push(`SN${ls}(x${mult})`);
    pct-=base*mult;
    parts.push(overtime?'DefOT':'Def');
  }
  if(isSprint(date)){pct*=ALGO.SPRINT;parts.push('Sprint×1.2');}
  return{pct,description:parts.join('+')};
}

function updateStreak(s,won){return won?(s>=0?s+1:1):(s<=0?s-1:-1);}

async function main(){
  console.log('=== RECALCUL v2.2 COMPLET (avec délai anti-rate-limit) ===');
  const{data:teamsData}=await supabase.from('teams').select('id');
  const teamIds=teamsData.map(t=>t.id);
  console.log(`${teamIds.length} équipes | Délai: ${DELAY_MS}ms/jour\n`);

  const prices={},streaks={},clinched={};
  for(const id of teamIds){prices[id]=PRIX_DEPART;streaks[id]=0;clinched[id]=false;}

  // Nettoyage
  console.log('Nettoyage...');
  await supabase.from('price_impact_log').delete().neq('team_id','XXXXX');
  await supabase.from('daily_open_prices').delete().neq('team_id','XXXXX');
  let batch=true,totalDel=0;
  while(batch){
    const{data:rows}=await supabase.from('team_prices').select('id').limit(500);
    if(!rows||rows.length===0){batch=false;break;}
    await supabase.from('team_prices').delete().in('id',rows.map(r=>r.id));
    totalDel+=rows.length;process.stdout.write(`\r  Supprimé ${totalDel}`);
  }
  await supabase.from('team_prices').insert(teamIds.map(id=>({team_id:id,price:PRIX_DEPART,volume_24h:0,recorded_at:'2025-10-07T23:59:00.000Z'})));
  console.log('\nBase nettoyée ✓\n');

  const dates=getDates(SEASON_START,today());
  const priceRows=[],impactLogs=[],dailyOpenRows=[];
  let totalGames=0,totalImpacts=0;
  const stats={rebonds:0,rivalites:0,sprints:0,chutes:0,dominances:0};
  let lastStandingsWeek='',standings={};

  for(const date of dates){
    await sleep(DELAY_MS); // ← délai crucial anti-rate-limit
    const games=await fetchGames(date);
    if(games.length===0)continue;

    for(const id of teamIds)dailyOpenRows.push({team_id:id,price:prices[id],date});

    const week=date.substring(0,7);
    if(week!==lastStandingsWeek){
      await sleep(DELAY_MS);
      standings=await fetchStandings(date);
      lastStandingsWeek=week;
    }

    for(const g of games){
      const hA=g.homeTeam?.abbrev,aA=g.awayTeam?.abbrev;
      const hG=g.homeTeam?.score??0,aG=g.awayTeam?.score??0;
      const isOT=['OT','SO'].includes(g.periodDescriptor?.periodType);
      const hW=hG>aG, ts=`${date}T22:00:00.000Z`;

      for(const side of[
        {teamId:hA,oppId:aA,won:hW, overtime:isOT,shutout:hW&&aG===0},
        {teamId:aA,oppId:hA,won:!hW,overtime:isOT,shutout:!hW&&hG===0},
      ]){
        const{teamId,oppId,won}=side;
        if(!teamId||prices[teamId]===undefined)continue;

        if(won&&standings[teamId]?.clinched&&!clinched[teamId]){
          const oP=prices[teamId],nP=applyFloor(oP*(1+ALGO.CLINCH));
          prices[teamId]=nP;clinched[teamId]=true;
          const pc=parseFloat(((nP-oP)/oP*100).toFixed(3));
          priceRows.push({team_id:teamId,price:nP,volume_24h:0,recorded_at:ts});
          impactLogs.push({team_id:teamId,trigger:'clinch',description:`Qualification+12%[${g.id}]`,old_price:oP,new_price:nP,pct_change:pc,created_at:ts});
          totalImpacts++;
        }

        const oP=prices[teamId],streak=streaks[teamId];
        const{pct,description}=calcImpact(side,streak,date);
        const rivalite=(won&&standings[teamId]?.div&&standings[oppId]?.div&&standings[teamId].div===standings[oppId].div)?ALGO.RIVALITE:0;
        const totalPct=pct+rivalite;
        if(rivalite>0)stats.rivalites++;
        if(description.includes('REBOND'))stats.rebonds++;
        if(description.includes('Sprint'))stats.sprints++;
        if(description.includes('CHUTE'))stats.chutes++;
        if(description.includes('Dominance'))stats.dominances++;

        const nP=applyFloor(oP*(1+totalPct));
        prices[teamId]=nP;streaks[teamId]=updateStreak(streak,won);
        const pc=parseFloat(((nP-oP)/oP*100).toFixed(3));
        priceRows.push({team_id:teamId,price:nP,volume_24h:0,recorded_at:ts});
        impactLogs.push({team_id:teamId,trigger:'game_result',description:`${description}${rivalite>0?'+Rivalité':''} [${g.id}]`,old_price:oP,new_price:nP,pct_change:pc,created_at:ts});
        totalImpacts++;
      }
      totalGames++;
    }
    process.stdout.write(`\r${date} Matchs:${totalGames} Impacts:${totalImpacts} R:${stats.rebonds} V:${stats.rivalites} C:${stats.chutes}`);
  }
  console.log('\n');

  const CHUNK=500;
  console.log(`Insertion ${priceRows.length} prix...`);
  for(let i=0;i<priceRows.length;i+=CHUNK){await supabase.from('team_prices').insert(priceRows.slice(i,i+CHUNK));process.stdout.write(`\r  ${Math.min(i+CHUNK,priceRows.length)}/${priceRows.length}`);}
  console.log(`\nInsertion ${impactLogs.length} impacts...`);
  for(let i=0;i<impactLogs.length;i+=CHUNK){await supabase.from('price_impact_log').insert(impactLogs.slice(i,i+CHUNK));process.stdout.write(`\r  ${Math.min(i+CHUNK,impactLogs.length)}/${impactLogs.length}`);}
  console.log(`\nInsertion ${dailyOpenRows.length} daily_open...`);
  for(let i=0;i<dailyOpenRows.length;i+=CHUNK){await supabase.from('daily_open_prices').insert(dailyOpenRows.slice(i,i+CHUNK));process.stdout.write(`\r  ${Math.min(i+CHUNK,dailyOpenRows.length)}/${dailyOpenRows.length}`);}

  console.log('\nPrix finaux...');
  const nowTs=new Date().toISOString();
  for(const[id,p]of Object.entries(prices)){await supabase.from('team_prices').insert({team_id:id,price:p,volume_24h:0,recorded_at:nowTs});}

  console.log('\n\n=== RÉSULTATS FINAUX v2.2 ===');
  for(const[id,p]of Object.entries(prices).sort((a,b)=>b[1]-a[1])){
    const pct=((p-PRIX_DEPART)/PRIX_DEPART*100).toFixed(1);
    const s=streaks[id];const streak=s>0?`W${s}`:s<0?`L${Math.abs(s)}`:'—';
    console.log(`${id.padEnd(4)} $${p.toFixed(2).padStart(8)} (${pct>=0?'+':''}${pct}%) ${streak}`);
  }
  console.log(`\nMatchs:${totalGames} | Impacts:${totalImpacts}`);
  console.log(`Suspense → R:${stats.rebonds} V:${stats.rivalites} S:${stats.sprints} C:${stats.chutes} D:${stats.dominances}`);
  console.log('\n✅ Recalcul v2.2 terminé!');
}
main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
