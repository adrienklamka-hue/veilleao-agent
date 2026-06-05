/**
 * VeillAO Agent — Fetchers (Étape 2)
 * ====================================
 * Sources gratuites, sans API key :
 *   - BOAMP      : API OpenDataSoft publique (marchés publics français)
 *   - Google RSS : Google Alerts RSS (marchés privés, signaux d'affaires)
 *   - TED Europa : API REST publique (marchés européens > seuils)
 *
 * Usage : importé par veilleao-agent.js
 *   import { fetchAllSources } from "./fetchers.js";
 *   const aos = await fetchAllSources(KEYWORDS, OPTIONS);
 */

// ─── DÉPENDANCES ─────────────────────────────────────────────────────────────
// node >= 18 : fetch natif disponible, pas besoin d'axios
// xml2js pour parser les RSS Google Alerts
// npm install xml2js

import xml2js from "xml2js";

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const FETCHER_CONFIG = {
  // Délai entre requêtes pour ne pas surcharger les APIs (ms)
  delay_between_requests: 300,

  // Fenêtre de recherche : AOs publiés dans les N derniers jours
  days_lookback: 7,

  // Nombre max d'AOs par source et par run
  max_results_per_source: 50,

  // Timeout par requête (ms)
  timeout: 10_000,
};

// ─── UTILITAIRES ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDateMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}

function today() {
  return new Date().toISOString().split("T")[0];
}

/**
 * fetch avec timeout natif (Node 18+)
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCHER_CONFIG.timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalise un AO brut vers le format attendu par l'agent de scoring.
 */
function normaliserAO(fields) {
  return {
    id: fields.id,
    source: fields.source,
    type_acheteur: fields.type_acheteur || "inconnu",
    titre: fields.titre || "(sans titre)",
    acheteur: fields.acheteur || "Non renseigné",
    lieu: fields.lieu || "France",
    date_publication: fields.date_publication || today(),
    date_limite: fields.date_limite || "Non communiquée",
    montant_estime: fields.montant_estime || "Non communiqué",
    description: fields.description || "",
    url: fields.url || "",
  };
}

// ─── FETCHER 1 : BOAMP (marchés publics français) ─────────────────────────────
// API OpenDataSoft — gratuite, publique, pas d'auth requise.
// Doc : https://boamp.fr/api/explore/v2.1/catalog/datasets/boamp/

const BOAMP_API = "https://boamp.fr/api/explore/v2.1/catalog/datasets/boamp/records";

/**
 * Recherche des avis BOAMP pour une liste de mots-clés.
 * Lance les requêtes en parallèle par batch de 3.
 *
 * @param {string[]} keywords - mots-clés à rechercher
 * @returns {Promise<object[]>} - AOs normalisés
 */
export async function fetchBoamp(keywords) {
  console.log(`\n📡 BOAMP — recherche sur ${keywords.length} mots-clés...`);

  const dateMin = isoDateMinus(FETCHER_CONFIG.days_lookback);
  const seen = new Set();
  const results = [];

  // Batch par 3 pour ne pas surcharger l'API
  for (let i = 0; i < keywords.length; i += 3) {
    const batch = keywords.slice(i, i + 3);
    const promises = batch.map((kw) => _fetchBoampKeyword(kw, dateMin));
    const batchResults = await Promise.allSettled(promises);

    for (const res of batchResults) {
      if (res.status === "fulfilled") {
        for (const ao of res.value) {
          if (!seen.has(ao.id)) {
            seen.add(ao.id);
            results.push(ao);
          }
        }
      } else {
        console.warn(`  ⚠️  BOAMP batch error: ${res.reason?.message}`);
      }
    }

    await sleep(FETCHER_CONFIG.delay_between_requests);
  }

  console.log(`  ✅ BOAMP — ${results.length} AOs uniques récupérés`);
  return results.slice(0, FETCHER_CONFIG.max_results_per_source);
}

async function _fetchBoampKeyword(keyword, dateMin) {
  // Filtre sur : titre ou objet contient le mot-clé, date de publication récente
  const where = `search(titre,"${keyword}") AND dateparution>="${dateMin}"`;
  const params = new URLSearchParams({
    where,
    limit: "20",
    order_by: "dateparution DESC",
    select: "id_boamp,titre,nomacheteur,datedepublication,dateecheance,montant,objet,urlboamp,codedepartement",
  });

  const url = `${BOAMP_API}?${params}`;
  const res = await fetchWithTimeout(url);

  if (!res.ok) {
    throw new Error(`BOAMP HTTP ${res.status} pour "${keyword}"`);
  }

  const data = await res.json();
  const records = data.results || [];

  return records.map((r) => {
    const dept = r.codedepartement || "";
    return normaliserAO({
      id: `BOAMP-${r.id_boamp}`,
      source: "BOAMP",
      type_acheteur: "public",
      titre: r.titre || r.objet || "(sans titre)",
      acheteur: r.nomacheteur || "Acheteur public",
      lieu: dept ? `Département ${dept}` : "France",
      date_publication: r.datedepublication?.split("T")[0] || today(),
      date_limite: r.dateecheance?.split("T")[0] || "Non communiquée",
      montant_estime: r.montant ? `${Number(r.montant).toLocaleString("fr-FR")} € HT` : "Non communiqué",
      description: r.objet || r.titre || "",
      url: r.urlboamp || `https://www.boamp.fr/avis/detail/${r.id_boamp}`,
    });
  });
}

// ─── FETCHER 2 : GOOGLE ALERTS RSS (marchés privés + publics) ─────────────────
// Google Alerts permet de créer des alertes sur des requêtes
// et d'y accéder via RSS — sans auth, sans scraping.
//
// ⚙️  SETUP (one-time, par l'utilisateur) :
//   1. Va sur https://www.google.fr/alerts
//   2. Crée une alerte par requête cible (ex: "appel d'offres monétique")
//   3. Dans "Options" → choisir "Flux RSS"
//   4. Copie l'URL RSS générée dans GOOGLE_ALERTS_FEEDS ci-dessous

const GOOGLE_ALERTS_FEEDS = [
  // ── Remplacer par tes vraies URLs RSS Google Alerts ──────────────────────
  // Format : https://www.google.com/alerts/feeds/{USER_ID}/{ALERT_ID}
  //
  // Requêtes suggérées à créer dans Google Alerts :
  //   "appel d'offres" "cash management"
  //   "appel d'offres" "monétique" OR "TPE" OR "encaissement"
  //   "appel d'offres" "EBICS" OR "flux de paiements"
  //   "consultation bancaire" ETI OR PME
  //   "appel d'offres" "affacturage" OR "escompte"
  //   "appel d'offres" "trade finance" OR "lettre de crédit"
  //   "appel d'offres" "PSP" OR "paiement en ligne" retail
  //
  // Exemples (URLs fictives — à remplacer) :
  "https://www.google.com/alerts/feeds/VOTRE_USER_ID/ALERT_ID_CASHMANAGEMENT",
  "https://www.google.com/alerts/feeds/VOTRE_USER_ID/ALERT_ID_MONETIQUE",
  "https://www.google.com/alerts/feeds/VOTRE_USER_ID/ALERT_ID_EBICS",
  "https://www.google.com/alerts/feeds/VOTRE_USER_ID/ALERT_ID_AFFACTURAGE",
];

/**
 * Lit tous les flux RSS Google Alerts configurés.
 * Parse l'Atom feed et normalise chaque entrée en AO.
 *
 * @returns {Promise<object[]>}
 */
export async function fetchGoogleAlerts() {
  console.log(`\n📡 Google Alerts RSS — lecture de ${GOOGLE_ALERTS_FEEDS.length} flux...`);

  // Filtrer les URLs placeholder non configurées
  const configured = GOOGLE_ALERTS_FEEDS.filter(
    (url) => !url.includes("VOTRE_USER_ID")
  );

  if (configured.length === 0) {
    console.warn("  ⚠️  Aucun flux Google Alerts configuré. Voir GOOGLE_ALERTS_FEEDS dans fetchers.js.");
    return [];
  }

  const seen = new Set();
  const results = [];

  for (const feedUrl of configured) {
    try {
      const items = await _fetchRSSFeed(feedUrl);
      for (const item of items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          results.push(item);
        }
      }
      await sleep(FETCHER_CONFIG.delay_between_requests);
    } catch (err) {
      console.warn(`  ⚠️  Flux RSS erreur (${feedUrl.slice(-20)}...) : ${err.message}`);
    }
  }

  console.log(`  ✅ Google Alerts — ${results.length} résultats récupérés`);
  return results.slice(0, FETCHER_CONFIG.max_results_per_source);
}

async function _fetchRSSFeed(feedUrl) {
  const res = await fetchWithTimeout(feedUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const xml = await res.text();
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });

  // Google Alerts utilise le format Atom
  const entries = parsed?.feed?.entry || [];
  const entryList = Array.isArray(entries) ? entries : [entries];

  return entryList.map((entry, i) => {
    const title = entry.title?._ || entry.title || "(sans titre)";
    const link = entry.link?.["$"]?.href || entry.link || "";
    const published = entry.published || entry.updated || today();
    const summary = entry.summary?._ || entry.summary || title;

    return normaliserAO({
      id: `GALERT-${Buffer.from(link).toString("base64").slice(0, 16)}-${i}`,
      source: "Google Alerts",
      type_acheteur: "inconnu", // l'agent de scoring classifiera
      titre: title,
      acheteur: "À identifier",
      lieu: "France",
      date_publication: published.split("T")[0],
      date_limite: "Non communiquée",
      montant_estime: "Non communiqué",
      description: summary.replace(/<[^>]+>/g, ""), // strip HTML
      url: link,
    });
  });
}

// ─── FETCHER 3 : TED EUROPA (marchés publics européens) ───────────────────────
// API REST publique — marchés au-dessus des seuils européens.
// Pertinent pour les grands comptes publics et ETI avec activité UE.
// Doc : https://ted.europa.eu/api/swagger-ui/index.html

const TED_API = "https://ted.europa.eu/api/v3.0/notices/search";

/**
 * Recherche sur TED Europa — marchés publiés par des acheteurs français.
 * Filtre sur les CPV (codes de produits) liés aux services financiers.
 *
 * @param {string[]} keywords
 * @returns {Promise<object[]>}
 */
export async function fetchTED(keywords) {
  console.log(`\n📡 TED Europa — recherche marchés européens...`);

  // CPV codes pour services financiers et bancaires
  // 66100000 = Services bancaires et d'investissement
  // 66110000 = Services bancaires
  // 66120000 = Dépôts et épargne
  // 66130000 = Services de crédit
  // 66170000 = Activités financières des sociétés holding, fonds d'assurance et caisses
  // 66600000 = Services de trésorerie
  const CPV_SERVICES_FINANCIERS = [
    "66100000", "66110000", "66120000",
    "66130000", "66170000", "66600000",
  ];

  const dateMin = isoDateMinus(FETCHER_CONFIG.days_lookback);

  // Construction de la query TED (langage de requête propriétaire)
  const kwQuery = keywords
    .slice(0, 5) // TED accepte des requêtes complexes mais on limite
    .map((k) => `"${k}"`)
    .join(" OR ");

  const query = `(${kwQuery}) AND PC=[${CPV_SERVICES_FINANCIERS.join(",")}] AND CY=FR AND PD>=${dateMin.replace(/-/g, "")}`;

  try {
    const res = await fetchWithTimeout(TED_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query,
        fields: ["ND", "TI", "CA", "PD", "DT", "VA", "TY", "MA"],
        page: { start: 1, pageSize: FETCHER_CONFIG.max_results_per_source },
        scope: "ACTIVE",
        language: "FR",
      }),
    });

    if (!res.ok) {
      console.warn(`  ⚠️  TED HTTP ${res.status} — source ignorée`);
      return [];
    }

    const data = await res.json();
    const notices = data?.notices || data?.results || [];

    const results = notices.map((n) => {
      const montant = n.VA ? `${Number(n.VA).toLocaleString("fr-FR")} € HT` : "Non communiqué";
      return normaliserAO({
        id: `TED-${n.ND}`,
        source: "TED Europa",
        type_acheteur: "public",
        titre: n.TI || "(sans titre)",
        acheteur: n.CA || "Acheteur européen",
        lieu: "France (marché européen)",
        date_publication: n.PD ? `${String(n.PD).slice(0,4)}-${String(n.PD).slice(4,6)}-${String(n.PD).slice(6,8)}` : today(),
        date_limite: n.DT ? `${String(n.DT).slice(0,4)}-${String(n.DT).slice(4,6)}-${String(n.DT).slice(6,8)}` : "Non communiquée",
        montant_estime: montant,
        description: n.TI || "",
        url: `https://ted.europa.eu/udl?uri=TED:NOTICE:${n.ND}:TEXT:FR:HTML`,
      });
    });

    console.log(`  ✅ TED Europa — ${results.length} avis récupérés`);
    return results;
  } catch (err) {
    console.warn(`  ⚠️  TED Europa erreur : ${err.message}`);
    return [];
  }
}

// ─── ORCHESTRATEUR : TOUTES LES SOURCES ───────────────────────────────────────

/**
 * Lance tous les fetchers en parallèle et fusionne les résultats.
 * Déduplique sur l'ID et trie par date de publication décroissante.
 *
 * @param {string[]} keywords       - mots-clés métier à rechercher
 * @param {object}  options
 * @param {boolean} options.boamp   - activer BOAMP (défaut: true)
 * @param {boolean} options.alerts  - activer Google Alerts (défaut: true)
 * @param {boolean} options.ted     - activer TED Europa (défaut: true)
 * @returns {Promise<object[]>}     - AOs normalisés, dédupliqués, triés
 */
export async function fetchAllSources(keywords, options = {}) {
  const {
    boamp = true,
    alerts = true,
    ted = true,
  } = options;

  console.log(`\n${"─".repeat(62)}`);
  console.log("🌐 Fetching toutes les sources...");
  console.log(`   Mots-clés : ${keywords.slice(0, 5).join(", ")}${keywords.length > 5 ? "..." : ""}`);
  console.log(`   Sources   : ${[boamp && "BOAMP", alerts && "Google Alerts", ted && "TED"].filter(Boolean).join(", ")}`);

  // Lancement en parallèle
  const [boampResults, alertsResults, tedResults] = await Promise.all([
    boamp ? fetchBoamp(keywords) : Promise.resolve([]),
    alerts ? fetchGoogleAlerts() : Promise.resolve([]),
    ted ? fetchTED(keywords) : Promise.resolve([]),
  ]);

  // Fusion et déduplication
  const all = [...boampResults, ...alertsResults, ...tedResults];
  const seen = new Set();
  const deduped = all.filter((ao) => {
    if (seen.has(ao.id)) return false;
    seen.add(ao.id);
    return true;
  });

  // Tri par date de publication décroissante
  deduped.sort((a, b) => {
    const da = new Date(a.date_publication || 0);
    const db = new Date(b.date_publication || 0);
    return db - da;
  });

  console.log(`\n✅ Total AOs récupérés : ${deduped.length} (${boampResults.length} BOAMP, ${alertsResults.length} Alerts, ${tedResults.length} TED)`);
  console.log(`${"─".repeat(62)}\n`);

  return deduped;
}
