'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
(async () => {
  // 1. Backend Railway répond?
  try {
    const r = await fetch('https://hockey-capital-api-production.up.railway.app/api/market/teams');
    const data = await r.json();
    const col = data.find(t => t.id === 'COL');
    console.log('BACKEND OK — ' + data.length + ' équipes — COL: $' + parseFloat(col?.price).toFixed(2));
  } catch(e) { console.log('BACKEND MORT: ' + e.message); }

  // 2. Dernière entrée price_impact_log (activité du job)
  const { data: last } = await sb.from('price_impact_log')
    .select('team_id, trigger, created_at').order('created_at', { ascending: false }).limit(3);
  console.log('Dernière activité DB:');
  for (const r of (last||[])) console.log('  ' + r.created_at + ' | ' + r.trigger + ' | ' + r.team_id);

  // 3. Nouveaux standings frauduleux?
  const { data: fraud } = await sb.from('price_impact_log')
    .select('id').eq('trigger','standings')
    .gte('created_at', new Date(Date.now()-120000).toISOString()).limit(5);
  console.log('Standings frauduleux (2 dernières min): ' + (fraud?.length||0));

  // 4. season_config
  const { data: cfg } = await sb.from('season_config').select('*').eq('id',1).single();
  console.log('season_config: mode=' + cfg?.mode + ' | playoff_round=' + cfg?.playoff_round);

  process.exit(0);
})();
