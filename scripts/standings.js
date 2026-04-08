const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://xbciytfwuqawlbnowhve.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiY2l5dGZ3dXFhd2xibm93aHZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTU4NzYzMywiZXhwIjoyMDkxMTYzNjMzfQ.H1B3frayDLQuIDe7qNsyWFhjG6-6xb-6zxpXrmfS9pQ'
);

const NHL_TO_HC = {
  MTL:'MTL',BOS:'BOS',TOR:'TOR',TBL:'TBL',FLA:'FLA',OTT:'OTT',BUF:'BUF',DET:'DET',
  NYR:'NYR',PHI:'PHI',PIT:'PIT',WSH:'WSH',NJD:'NJD',NYI:'NYI',CAR:'CAR',CBJ:'CBJ',
  CHI:'CHI',NSH:'NSH',STL:'STL',COL:'COL',MIN:'MIN',DAL:'DAL',WPG:'WPG',UTA:'UTA',
  VGK:'VGK',EDM:'EDM',CGY:'CGY',VAN:'VAN',SEA:'SEA',SJS:'SJS',ANA:'ANA',LAK:'LAK',
};

async function run() {
  console.log('Fetching NHL standings...');
  const res = await fetch('https://api-web.nhle.com/v1/standings/now');
  const data = await res.json();
  const standings = data.standings || [];
  console.log('Equipes LNH recues:', standings.length);

  let updated = 0;
  for (const s of standings) {
    const teamId = NHL_TO_HC[s.teamAbbrev?.default];
    if (!teamId) continue;
    const { error } = await supabase.from('nhl_team_stats').upsert({
      team_id: teamId,
      wins: s.wins || 0,
      losses: s.losses || 0,
      ot_losses: s.otLosses || 0,
      points: s.points || 0,
      division_rank: s.divisionSequence || 8,
      clinch_bonus_paid: false,
      last_updated: new Date().toISOString(),
    }, { onConflict: 'team_id' });
    if (error) console.error(`ERR ${teamId}:`, error.message);
    else { console.log(`OK ${teamId}: ${s.points}pts rang#${s.divisionSequence}`); updated++; }
  }
  console.log(`\nTotal mis a jour: ${updated} equipes`);
}

run().catch(console.error);
