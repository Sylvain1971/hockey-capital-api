require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TEAMS = [
  { id:'MTL', name:'Canadiens de Montreal',    color:'#AF1E2D', division:'Atlantique' },
  { id:'BOS', name:'Bruins de Boston',          color:'#FFB81C', division:'Atlantique' },
  { id:'TOR', name:'Maple Leafs de Toronto',    color:'#00205B', division:'Atlantique' },
  { id:'TBL', name:'Lightning de Tampa Bay',    color:'#002868', division:'Atlantique' },
  { id:'FLA', name:'Panthers de la Floride',    color:'#041E42', division:'Atlantique' },
  { id:'OTT', name:'Senators d Ottawa',         color:'#C52032', division:'Atlantique' },
  { id:'BUF', name:'Sabres de Buffalo',         color:'#002654', division:'Atlantique' },
  { id:'DET', name:'Red Wings de Detroit',      color:'#CE1126', division:'Atlantique' },
  { id:'NYR', name:'Rangers de New York',       color:'#0038A8', division:'Metropolitaine' },
  { id:'PHI', name:'Flyers de Philadelphie',    color:'#F74902', division:'Metropolitaine' },
  { id:'PIT', name:'Penguins de Pittsburgh',    color:'#1a1a1a', division:'Metropolitaine' },
  { id:'WSH', name:'Capitals de Washington',    color:'#041E42', division:'Metropolitaine' },
  { id:'NJD', name:'Devils du New Jersey',      color:'#CE1126', division:'Metropolitaine' },
  { id:'NYI', name:'Islanders de New York',     color:'#00539B', division:'Metropolitaine' },
  { id:'CAR', name:'Hurricanes de la Caroline', color:'#CC0000', division:'Metropolitaine' },
  { id:'CBJ', name:'Blue Jackets de Columbus',  color:'#002654', division:'Metropolitaine' },
  { id:'CHI', name:'Blackhawks de Chicago',     color:'#CF0A2C', division:'Centrale' },
  { id:'NSH', name:'Predators de Nashville',    color:'#FFB81C', division:'Centrale' },
  { id:'STL', name:'Blues de St. Louis',        color:'#002F87', division:'Centrale' },
  { id:'COL', name:'Avalanche du Colorado',     color:'#6F263D', division:'Centrale' },
  { id:'MIN', name:'Wild du Minnesota',         color:'#154734', division:'Centrale' },
  { id:'DAL', name:'Stars de Dallas',           color:'#006847', division:'Centrale' },
  { id:'WPG', name:'Jets de Winnipeg',          color:'#041E42', division:'Centrale' },
  { id:'UTA', name:'Utah Hockey Club',          color:'#69B3E7', division:'Centrale' },
  { id:'VGK', name:'Golden Knights de Vegas',   color:'#B4975A', division:'Pacifique' },
  { id:'EDM', name:'Oilers d Edmonton',         color:'#FF4C00', division:'Pacifique' },
  { id:'CGY', name:'Flames de Calgary',         color:'#C8102E', division:'Pacifique' },
  { id:'VAN', name:'Canucks de Vancouver',      color:'#00843D', division:'Pacifique' },
  { id:'SEA', name:'Kraken de Seattle',         color:'#001628', division:'Pacifique' },
  { id:'SJS', name:'Sharks de San Jose',        color:'#006D75', division:'Pacifique' },
  { id:'ANA', name:'Ducks d Anaheim',           color:'#FC4C02', division:'Pacifique' },
  { id:'LAK', name:'Kings de Los Angeles',      color:'#333333', division:'Pacifique' },
];

async function seed() {
  console.log('=== SEED Hockey Capital ===');

  // 1. Insérer les équipes
  const { error: e1 } = await supabase.from('teams').upsert(TEAMS, { onConflict: 'id' });
  if (e1) { console.error('teams:', e1.message); } else { console.log('OK teams: 32'); }

  // 2. team_supply (100 actions par équipe à 5.00$)
  const supply = TEAMS.map(t => ({ team_id: t.id, total: 100, available: 100 }));
  const { error: e2 } = await supabase.from('team_supply').upsert(supply, { onConflict: 'team_id' });
  if (e2) { console.error('team_supply:', e2.message); } else { console.log('OK team_supply: 32'); }

  // 3. team_prices (prix initial 5.00$)
  const prices = TEAMS.map(t => ({ team_id: t.id, price: 5.00, volume_24h: 0 }));
  const { error: e3 } = await supabase.from('team_prices').upsert(prices, { onConflict: 'team_id' });
  if (e3) { console.error('team_prices:', e3.message); } else { console.log('OK team_prices: 32'); }

  // 4. nhl_team_stats (stats initiales)
  const stats = TEAMS.map(t => ({
    team_id: t.id, wins: 0, losses: 0, ot_losses: 0, points: 0,
    win_streak: 0, division_rank: 8, clinch_bonus_paid: false,
  }));
  const { error: e4 } = await supabase.from('nhl_team_stats').upsert(stats, { onConflict: 'team_id' });
  if (e4) { console.error('nhl_team_stats:', e4.message); } else { console.log('OK nhl_team_stats: 32'); }

  console.log('=== SEED TERMINE ===');
}

seed().catch(console.error);
