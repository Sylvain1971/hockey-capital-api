require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function rollback() {
  // Réinitialiser toutes les équipes (WHERE id != '' force la clause WHERE)
  const { error } = await supabase.from('teams')
    .update({
      playoff_status:     'not_qualified',
      playoff_round:      null,
      playoff_locked:     false,
      eliminated_at:      null,
      season_close_price: null,
    })
    .neq('id', '');  // toutes les équipes
  if (error) { console.error('❌ teams reset:', error.message); return; }
  console.log('✅ 32 équipes réinitialisées');

  const { data: cfg } = await supabase.from('season_config').select('mode, playoff_round').eq('id',1).single();
  console.log(`⚙️  season_config: mode=${cfg.mode}, round=${cfg.playoff_round}`);
  console.log('✅ Marché en mode SAISON RÉGULIÈRE');
}

rollback().catch(e => console.error('FATAL:', e.message));
