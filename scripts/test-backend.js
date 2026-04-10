'use strict';
require('dotenv').config();
(async () => {
  // Test brut du backend
  try {
    const r = await fetch('https://hockey-capital-api-production.up.railway.app/api/market/teams');
    console.log('Status HTTP:', r.status);
    const text = await r.text();
    console.log('Réponse (200 premiers chars):', text.substring(0, 200));
  } catch(e) { console.log('ERREUR FETCH:', e.message); }

  // Test route health/racine
  try {
    const r2 = await fetch('https://hockey-capital-api-production.up.railway.app/');
    console.log('Racine status:', r2.status);
    const t2 = await r2.text();
    console.log('Racine body:', t2.substring(0, 100));
  } catch(e) { console.log('ERREUR racine:', e.message); }

  process.exit(0);
})();
