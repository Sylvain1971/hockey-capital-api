-- ============================================================
-- HOCKEY CAPITAL — Migration 002: Ligues configurables
-- Prix à 5$/action, AMM, market maker par ligue
-- ============================================================

-- ---- Table principale des ligues ----
create table public.leagues (
  id                  uuid        primary key default uuid_generate_v4(),
  name                text        not null,
  creator_id          uuid        not null references public.profiles(id),
  invite_code         varchar(8)  unique not null,
  status              text        not null default 'open'  -- open, active, closed
                      check (status in ('open','active','closed')),

  -- Étape 1
  max_players         integer     not null default 8 check (max_players between 2 and 20),
  duration            text        not null default 'week',
  draft_mode          text        not null default 'libre',
  mise_reelle         numeric(8,2) not null default 20,
  capital_virtuel     numeric(12,2) not null default 25000,

  -- Étape 2
  trade_limit_weekly  integer     not null default 5,       -- 0 = illimité
  max_conc_pct        integer     not null default 20,      -- % max par équipe
  amm_spread_pct      numeric(4,2) not null default 2.0,
  trade_delay         text        not null default 'none',  -- none, 24h, 48h
  dividends_enabled   boolean     not null default true,
  limit_orders_enabled boolean    not null default true,
  short_selling       boolean     not null default false,
  elim_penalty        boolean     not null default true,

  -- Étape 3
  prize_mode          text        not null default 'top3',
  custom_prize        jsonb,
  bonus_weekly        boolean     not null default false,
  bonus_mid           boolean     not null default false,
  bonus_last          boolean     not null default false,

  -- Étape 4 — algo personnalisé
  algo_config         jsonb       not null default '{
    "winReg": 4.0, "winOT": 2.0, "shutout": 3.0,
    "lossReg": 3.0, "lossOT": 1.0,
    "m3": 1.5, "m5": 2.0, "m7": 3.0,
    "r1": 1.5, "r23": 0.5, "r9": 1.0,
    "divBase": 0.08, "clinch": 12.0
  }',

  starts_at           timestamptz,
  ends_at             timestamptz,
  created_at          timestamptz not null default now()
);

-- ---- Membres d'une ligue ----
create table public.league_members (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  user_id     uuid    not null references public.profiles(id) on delete cascade,
  cash        numeric(14,4) not null,   -- capital virtuel restant
  is_creator  boolean not null default false,
  joined_at   timestamptz not null default now(),
  unique (league_id, user_id)
);
create index idx_lm_league on public.league_members(league_id);
create index idx_lm_user   on public.league_members(user_id);

-- ---- Prix AMM par équipe par ligue ----
create table public.league_team_prices (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  team_id     varchar(3) not null references public.teams(id),
  price       numeric(10,4) not null default 5.0000,
  amm_reserve integer      not null default 7000,   -- 70% de 10 000
  volume_24h  integer      not null default 0,
  win_streak  integer      not null default 0,
  updated_at  timestamptz not null default now(),
  unique (league_id, team_id)
);
create index idx_ltp_league on public.league_team_prices(league_id);

-- ---- Holdings par ligue ----
create table public.league_holdings (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  user_id     uuid    not null references public.profiles(id) on delete cascade,
  team_id     varchar(3) not null references public.teams(id),
  shares      integer not null default 0 check (shares >= 0),
  avg_cost    numeric(10,4) not null default 5.0,
  updated_at  timestamptz not null default now(),
  unique (league_id, user_id, team_id)
);
create index idx_lh_league_user on public.league_holdings(league_id, user_id);

-- ---- Ordres de la ligue ----
create table public.league_orders (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  user_id     uuid    not null references public.profiles(id),
  team_id     varchar(3) not null references public.teams(id),
  side        text    not null check (side in ('buy','sell')),
  order_type  text    not null check (order_type in ('market','limit')),
  price       numeric(10,4),
  qty         integer not null check (qty > 0),
  qty_filled  integer not null default 0,
  status      text    not null default 'open' check (status in ('open','filled','partial','cancelled')),
  created_at  timestamptz not null default now()
);
create index idx_lo_league on public.league_orders(league_id, status, team_id);

-- ---- Trades exécutés dans la ligue ----
create table public.league_trades (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  buyer_id    uuid    references public.profiles(id),
  seller_id   uuid    references public.profiles(id),
  team_id     varchar(3) not null references public.teams(id),
  price       numeric(10,4) not null,
  qty         integer not null,
  executed_at timestamptz not null default now()
);
create index idx_lt_league on public.league_trades(league_id, executed_at desc);

-- ---- Journal d'impact prix par ligue ----
create table public.league_price_impacts (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  team_id     varchar(3) not null references public.teams(id),
  trigger     text    not null,
  description text    not null,
  old_price   numeric(10,4) not null,
  new_price   numeric(10,4) not null,
  pct_change  numeric(6,3) not null,
  created_at  timestamptz not null default now()
);

-- ---- Dividendes versés dans la ligue ----
create table public.league_dividend_payments (
  id          uuid    primary key default uuid_generate_v4(),
  league_id   uuid    not null references public.leagues(id) on delete cascade,
  user_id     uuid    not null references public.profiles(id),
  team_id     varchar(3) not null references public.teams(id),
  shares_held integer not null,
  amount_per_share numeric(8,4) not null,
  amount      numeric(10,4) not null,
  reason      text,
  paid_at     timestamptz not null default now()
);
create index idx_ldp_league_user on public.league_dividend_payments(league_id, user_id);

-- ---- RLS ----
alter table public.leagues              enable row level security;
alter table public.league_members       enable row level security;
alter table public.league_team_prices   enable row level security;
alter table public.league_holdings      enable row level security;
alter table public.league_orders        enable row level security;
alter table public.league_trades        enable row level security;
alter table public.league_dividend_payments enable row level security;

-- Ligues: lecture publique
create policy "leagues public read" on public.leagues for select using (true);
create policy "leagues creator write" on public.leagues for all using (auth.uid() = creator_id);

-- Membres: lecture publique, écriture propre
create policy "members public read" on public.league_members for select using (true);
create policy "members own write" on public.league_members for all using (auth.uid() = user_id);

-- Prix: lecture publique
create policy "prices public read" on public.league_team_prices for select using (true);

-- Holdings: lecture publique, écriture propre
create policy "holdings public read" on public.league_holdings for select using (true);
create policy "holdings own write" on public.league_holdings for all using (auth.uid() = user_id);

-- Ordres: lecture publique, écriture propre
create policy "orders public read" on public.league_orders for select using (true);
create policy "orders own write" on public.league_orders for all using (auth.uid() = user_id);

-- Trades: lecture publique
create policy "trades public read" on public.league_trades for select using (true);

-- Dividendes: lecture par le bénéficiaire
create policy "divs own read" on public.league_dividend_payments for select using (auth.uid() = user_id);
