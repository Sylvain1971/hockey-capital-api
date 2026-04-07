-- ============================================================
-- HOCKEY CAPITAL — Schéma initial Supabase
-- VERSION INITIALE des hypothèses (ne pas modifier sans note)
-- ============================================================

-- Extension UUID
create extension if not exists "uuid-ossp";

-- ============================================================
-- ÉQUIPES LNH (table de référence)
-- ============================================================
create table public.teams (
  id          varchar(3) primary key,         -- ex: 'MTL', 'BOS'
  name        text        not null,
  city        text        not null,
  division    text        not null,            -- 'Atlantique', 'Métropolitaine', etc.
  conference  text        not null,            -- 'Est', 'Ouest'
  color       varchar(7)  not null default '#888888',
  total_shares integer    not null default 100,
  base_price  numeric(10,4) not null default 5.00,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- PRIX DES ÉQUIPES (historique + prix courant)
-- ============================================================
create table public.team_prices (
  id          uuid        primary key default uuid_generate_v4(),
  team_id     varchar(3)  not null references public.teams(id),
  price       numeric(10,4) not null,
  volume_24h  integer     not null default 0,
  recorded_at timestamptz not null default now()
);
create index idx_team_prices_team_time on public.team_prices(team_id, recorded_at desc);

-- Vue: prix courant par équipe
create or replace view public.current_prices as
select distinct on (team_id)
  team_id,
  price,
  volume_24h,
  recorded_at
from public.team_prices
order by team_id, recorded_at desc;

-- ============================================================
-- UTILISATEURS (étend auth.users de Supabase)
-- ============================================================
create table public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  username    varchar(30) unique not null,
  display_name text,
  cash        numeric(12,4) not null default 2500.00,  -- liquidités initiales
  avatar_url  text,
  badge       text        not null default 'Débutant',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- POSITIONS (holdings)
-- ============================================================
create table public.holdings (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  team_id     varchar(3)  not null references public.teams(id),
  shares      integer     not null default 0 check (shares >= 0),
  avg_cost    numeric(10,4) not null default 0,   -- coût moyen d'acquisition
  updated_at  timestamptz not null default now(),
  unique (user_id, team_id)
);
create index idx_holdings_user on public.holdings(user_id);
create index idx_holdings_team on public.holdings(team_id);

-- ============================================================
-- ACTIONS DISPONIBLES PAR ÉQUIPE (marché primaire)
-- ============================================================
create table public.team_supply (
  team_id       varchar(3)  primary key references public.teams(id),
  available     integer     not null default 100 check (available >= 0),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- CARNET D'ORDRES
-- ============================================================
create table public.orders (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  team_id     varchar(3)  not null references public.teams(id),
  side        text        not null check (side in ('buy', 'sell')),
  order_type  text        not null check (order_type in ('market', 'limit')),
  price       numeric(10,4),                  -- null si market order
  qty         integer     not null check (qty > 0),
  qty_filled  integer     not null default 0,
  status      text        not null default 'open'
              check (status in ('open', 'filled', 'partial', 'cancelled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_orders_user    on public.orders(user_id);
create index idx_orders_team    on public.orders(team_id, status, side, price);
create index idx_orders_status  on public.orders(status) where status = 'open';

-- ============================================================
-- TRANSACTIONS EXÉCUTÉES
-- ============================================================
create table public.trades (
  id          uuid        primary key default uuid_generate_v4(),
  buyer_id    uuid        references public.profiles(id),
  seller_id   uuid        references public.profiles(id),
  team_id     varchar(3)  not null references public.teams(id),
  price       numeric(10,4) not null,
  qty         integer     not null,
  order_id    uuid        references public.orders(id),
  executed_at timestamptz not null default now()
);
create index idx_trades_team on public.trades(team_id, executed_at desc);
create index idx_trades_buyer  on public.trades(buyer_id);
create index idx_trades_seller on public.trades(seller_id);

-- ============================================================
-- DIVIDENDES VERSÉS
-- ============================================================
create table public.dividends (
  id                uuid        primary key default uuid_generate_v4(),
  team_id           varchar(3)  not null references public.teams(id),
  amount_per_share  numeric(8,4) not null,
  reason            text        not null,   -- ex: 'Victoire vs BOS — streak 4'
  game_id           text,                   -- ID du match LNH source
  streak_at_time    integer     not null default 0,
  multiplier        numeric(4,2) not null default 1.0,
  snapshot_date     date        not null default current_date,
  paid_at           timestamptz not null default now()
);

-- ============================================================
-- VERSEMENTS DE DIVIDENDES PAR UTILISATEUR
-- ============================================================
create table public.dividend_payments (
  id          uuid        primary key default uuid_generate_v4(),
  dividend_id uuid        not null references public.dividends(id),
  user_id     uuid        not null references public.profiles(id),
  team_id     varchar(3)  not null references public.teams(id),
  shares_held integer     not null,
  amount      numeric(10,4) not null,
  paid_at     timestamptz not null default now()
);
create index idx_div_payments_user on public.dividend_payments(user_id);

-- ============================================================
-- STATS LNH PAR ÉQUIPE (cache résultats API)
-- ============================================================
create table public.nhl_team_stats (
  team_id       varchar(3)  primary key references public.teams(id),
  wins          integer     not null default 0,
  losses        integer     not null default 0,
  ot_losses     integer     not null default 0,
  points        integer     not null default 0,
  games_played  integer     not null default 0,
  win_streak    integer     not null default 0,   -- positif=victoires, négatif=défaites
  division_rank integer,
  clinched      boolean     not null default false,
  clinch_bonus_paid boolean not null default false,
  goals_for     integer     not null default 0,
  goals_against integer     not null default 0,
  last_game_result text,   -- 'W', 'L', 'OTW', 'OTL'
  last_game_was_shutout boolean not null default false,
  last_updated  timestamptz not null default now()
);

-- ============================================================
-- JOURNAL D'IMPACT (log de chaque ajustement de prix)
-- ============================================================
create table public.price_impact_log (
  id          uuid        primary key default uuid_generate_v4(),
  team_id     varchar(3)  not null references public.teams(id),
  trigger     text        not null,   -- 'game_result', 'standings', 'clinch'
  description text        not null,
  old_price   numeric(10,4) not null,
  new_price   numeric(10,4) not null,
  pct_change  numeric(6,3) not null,
  game_id     text,
  created_at  timestamptz not null default now()
);
create index idx_impact_log_team on public.price_impact_log(team_id, created_at desc);

-- ============================================================
-- PLAYOFFS / BRACKET
-- ============================================================
create table public.playoff_rounds (
  id              uuid        primary key default uuid_generate_v4(),
  season_year     integer     not null,
  round_number    integer     not null,   -- 1=1er tour, 2=demi, 3=finale conf, 4=Cup
  round_name      text        not null,
  conference      text,                   -- 'Est', 'Ouest', null si finale Cup
  home_team_id    varchar(3)  references public.teams(id),
  away_team_id    varchar(3)  references public.teams(id),
  winner_id       varchar(3)  references public.teams(id),
  prize_per_share numeric(8,4) not null default 0,
  eliminated_price_penalty numeric(5,3) not null default 0.20,
  completed       boolean     not null default false,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles         enable row level security;
alter table public.holdings         enable row level security;
alter table public.orders           enable row level security;
alter table public.trades           enable row level security;
alter table public.dividend_payments enable row level security;

-- Profil: lecture publique, écriture par le propriétaire
create policy "profils publics en lecture"
  on public.profiles for select using (true);
create policy "utilisateur modifie son profil"
  on public.profiles for update using (auth.uid() = id);

-- Holdings: lecture publique, écriture par le propriétaire
create policy "holdings publics"
  on public.holdings for select using (true);
create policy "utilisateur gère ses holdings"
  on public.holdings for all using (auth.uid() = user_id);

-- Ordres: lecture publique (carnet d'ordres), gestion par le propriétaire
create policy "ordres publics en lecture"
  on public.orders for select using (true);
create policy "utilisateur gère ses ordres"
  on public.orders for all using (auth.uid() = user_id);

-- Trades: lecture publique
create policy "trades publics"
  on public.trades for select using (true);

-- Dividendes: lecture par le bénéficiaire
create policy "mes dividendes"
  on public.dividend_payments for select using (auth.uid() = user_id);

-- ============================================================
-- FONCTIONS UTILITAIRES
-- ============================================================

-- Créer automatiquement un profil à l'inscription
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Mise à jour du badge selon la valeur nette
create or replace function public.update_badge(p_user_id uuid)
returns void language plpgsql security definer as $$
declare
  v_net_worth numeric;
  v_badge text;
begin
  select
    pr.cash + coalesce(sum(h.shares * cp.price), 0)
  into v_net_worth
  from public.profiles pr
  left join public.holdings h on h.user_id = pr.id
  left join public.current_prices cp on cp.team_id = h.team_id
  where pr.id = p_user_id
  group by pr.cash;

  v_badge := case
    when v_net_worth >= 50000 then 'Légende'
    when v_net_worth >= 20000 then 'Vétéran'
    when v_net_worth >= 10000 then 'Expert'
    when v_net_worth >= 5000  then 'Intermédiaire'
    else 'Débutant'
  end;

  update public.profiles set badge = v_badge, updated_at = now()
  where id = p_user_id;
end;
$$;

-- ============================================================
-- DONNÉES INITIALES — 32 équipes LNH
-- ============================================================
insert into public.teams (id, name, city, division, conference, color) values
('MTL','Canadiens de Montréal','Montréal','Atlantique','Est','#AF1E2D'),
('BOS','Bruins de Boston','Boston','Atlantique','Est','#FFB81C'),
('TOR','Maple Leafs de Toronto','Toronto','Atlantique','Est','#00205B'),
('TBL','Lightning de Tampa Bay','Tampa Bay','Atlantique','Est','#002868'),
('FLA','Panthers de la Floride','Florida','Atlantique','Est','#041E42'),
('OTT','Sénateurs d''Ottawa','Ottawa','Atlantique','Est','#C52032'),
('BUF','Sabres de Buffalo','Buffalo','Atlantique','Est','#002654'),
('DET','Red Wings de Détroit','Detroit','Atlantique','Est','#CE1126'),
('NYR','Rangers de New York','New York','Métropolitaine','Est','#0038A8'),
('PHI','Flyers de Philadelphie','Philadelphia','Métropolitaine','Est','#F74902'),
('PIT','Penguins de Pittsburgh','Pittsburgh','Métropolitaine','Est','#000000'),
('WSH','Capitals de Washington','Washington','Métropolitaine','Est','#041E42'),
('NJD','Devils du New Jersey','New Jersey','Métropolitaine','Est','#CE1126'),
('NYI','Islanders de New York','Islanders','Métropolitaine','Est','#00539B'),
('CAR','Hurricanes de la Caroline','Carolina','Métropolitaine','Est','#CC0000'),
('CBJ','Blue Jackets de Columbus','Columbus','Métropolitaine','Est','#002654'),
('CHI','Blackhawks de Chicago','Chicago','Centrale','Ouest','#CF0A2C'),
('NSH','Predators de Nashville','Nashville','Centrale','Ouest','#FFB81C'),
('STL','Blues de St. Louis','St. Louis','Centrale','Ouest','#002F87'),
('COL','Avalanche du Colorado','Colorado','Centrale','Ouest','#6F263D'),
('MIN','Wild du Minnesota','Minnesota','Centrale','Ouest','#154734'),
('DAL','Stars de Dallas','Dallas','Centrale','Ouest','#006847'),
('WPG','Jets de Winnipeg','Winnipeg','Centrale','Ouest','#041E42'),
('UTA','Hockey Club de l''Utah','Utah','Centrale','Ouest','#69B3E7'),
('VGK','Golden Knights de Vegas','Vegas','Pacifique','Ouest','#B4975A'),
('EDM','Oilers d''Edmonton','Edmonton','Pacifique','Ouest','#FF4C00'),
('CGY','Flames de Calgary','Calgary','Pacifique','Ouest','#C8102E'),
('VAN','Canucks de Vancouver','Vancouver','Pacifique','Ouest','#00843D'),
('SEA','Kraken de Seattle','Seattle','Pacifique','Ouest','#001628'),
('SJS','Sharks de San Jose','San Jose','Pacifique','Ouest','#006D75'),
('ANA','Ducks d''Anaheim','Anaheim','Pacifique','Ouest','#FC4C02'),
('LAK','Kings de Los Angeles','Los Angeles','Pacifique','Ouest','#111111');

-- Supply initiale: 100 actions disponibles par équipe
insert into public.team_supply (team_id, available)
select id, 100 from public.teams;

-- Prix initiaux: $5.00 pour toutes les équipes
insert into public.team_prices (team_id, price)
select id, 5.00 from public.teams;

-- Stats LNH initiales vides
insert into public.nhl_team_stats (team_id)
select id from public.teams;
