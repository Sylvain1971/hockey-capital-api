# Hockey Capital — Guide de déploiement Supabase

## Architecture
```
Frontend (Next.js / Vercel)
    ↕ REST + WebSocket
Backend (Node.js Express / Railway)
    ↕ SDK Supabase
Supabase (PostgreSQL + Auth + Realtime)
    ↑
API LNH (api-web.nhle.com — gratuit, 30s)
```

## 1. Supabase — configuration initiale

### Créer le projet
1. Aller sur https://supabase.com → New project
2. Nommer le projet `hockey-capital`
3. Choisir la région `us-east-1` (la plus proche de Montréal)
4. Copier les clés API (Settings → API)

### Appliquer le schéma
```bash
# Option A: Supabase CLI
npm install -g supabase
supabase login
supabase link --project-ref VOTRE_REF
supabase db push --file supabase/migrations/001_initial_schema.sql

# Option B: SQL Editor dans Supabase (plus simple)
# Copier-coller le contenu de supabase/migrations/001_initial_schema.sql
# dans l'éditeur SQL de Supabase → Run
```

### Créer la fonction RPC increment_cash
```sql
-- Coller dans l'éditeur SQL Supabase
create or replace function public.increment_cash(p_user_id uuid, p_amount numeric)
returns void language plpgsql security definer as $$
begin
  update public.profiles
  set cash = cash + p_amount, updated_at = now()
  where id = p_user_id;
end;
$$;
```

### Activer l'authentification email
Supabase → Authentication → Providers → Email → Enable

## 2. Backend — déploiement local

```bash
git clone <repo>
cd hockey-capital
npm install
cp .env.example .env
# Remplir SUPABASE_URL et SUPABASE_SERVICE_KEY dans .env
npm run dev
```

Vérifier: http://localhost:3001/health → `{"status":"ok","version":"1.0.0-VERSION-INITIALE"}`

## 3. Backend — déploiement Railway (recommandé)

1. https://railway.app → New Project → Deploy from GitHub
2. Ajouter les variables d'environnement (copier depuis .env.example)
3. Railway détecte automatiquement Node.js → `npm start`
4. URL générée: `https://hockey-capital-api-xxxx.railway.app`

## 4. Frontend — intégration

Remplacer les fetch mock dans l'app par les vrais appels:

```javascript
// lib/api.js
const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Connexion WebSocket temps réel
const ws = new WebSocket(`${API.replace('http','ws')}/ws`);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'PRICE_UPDATE') updatePrice(msg.teamId, msg.newPrice);
  if (msg.type === 'CLINCH') showClinchAlert(msg.teamId);
};

// Récupérer le marché
async function fetchMarket() {
  const res = await fetch(`${API}/api/market/teams`);
  return res.json();
}

// Placer un ordre
async function placeOrder(token, { teamId, side, orderType, qty, price }) {
  const res = await fetch(`${API}/api/orders/place`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ teamId, side, orderType, qty, price }),
  });
  return res.json();
}
```

## 5. Endpoints disponibles

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | /api/auth/register | — | Inscription |
| POST | /api/auth/login | — | Connexion → token |
| GET | /api/market/teams | — | Toutes équipes + prix |
| GET | /api/market/team/:id/history | — | Historique de prix |
| GET | /api/market/orderbook/:id | — | Carnet d'ordres |
| GET | /api/market/leaderboard | — | Classement investisseurs |
| GET | /api/market/impact-log | — | Journal d'impact LNH |
| POST | /api/orders/place | JWT | Placer un ordre |
| DELETE | /api/orders/:id | JWT | Annuler un ordre |
| GET | /api/orders/mine | JWT | Mes ordres actifs |
| GET | /api/orders/history | JWT | Historique transactions |
| GET | /api/portfolio | JWT | Mon portefeuille |
| GET | /api/portfolio/dividends | JWT | Mes dividendes |
| POST | /api/admin/fetch-scores | Admin | Forcer fetch LNH |
| POST | /api/admin/eliminate/:teamId | Admin | Élimination playoffs |
| POST | /api/admin/dividend | Admin | Dividende manuel |
| WS | /ws | — | Prix temps réel |

## 6. Algorithme VERSION INITIALE (figé)

Les hypothèses sont dans `src/services/priceImpact.js` → constante `ALGO`.
Ne pas modifier sans créer une VERSION 2 et noter la date de changement.

```
Victoire régulière   : +4.0%
Victoire OT/FP       : +2.0%
Bonus blanchissage   : +3.0%
Défaite régulière    : -3.0%
Défaite OT/FP        : -1.0%
Streak 3+            : ×1.5
Streak 5+            : ×2.0
Streak 7+            : ×3.0
Rang div. #1/sem     : +1.5%
Rang div. #2-3/sem   : +0.5%
Rang div. 9+/sem     : -1.0%
Dividende victoire   : $0.08/action
Qualification séries : +12% (unique)
Prix plancher        : $0.50
Prix d'émission      : $5.00
Actions/équipe       : 100
```
