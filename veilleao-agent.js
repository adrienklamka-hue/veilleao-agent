/**
 * VeillAO Agent — Scoring d'appels d'offres (public + privé)
 * ===========================================================
 * Usage : ANTHROPIC_API_KEY=sk-... node veilleao-agent.js
 *
 * Mode  : --live   → fetche les vraies sources (BOAMP, Google Alerts, TED)
 *         --test   → utilise les données de test locales (défaut)
 *
 * Exemple :
 *   node veilleao-agent.js --live
 *   node veilleao-agent.js --test
 *
 * Configurable via AGENT_CONFIG — aucune marque ni région hardcodée.
 */

import Anthropic from "@anthropic-ai/sdk";
import { fetchAllSources } from "./fetchers.js";

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
// Tout ce qui est métier est ici. Adapter à son profil sans toucher au reste.

const AGENT_CONFIG = {
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  score_seuil_alerte: 60,      // AOs notifiés si score >= seuil
  score_seuil_urgence: 75,     // ALERTE_URGENTE si score >= seuil ET délai < 21j

  // Secteur(s) d'activité ciblés — services financiers et flux de paiements
  domaine: "services bancaires, cash management, flux de paiements, monétique",

  // Mots-clés qui font monter le score (pertinence métier directe)
  mots_cles_forts: [
    "cash management",
    "EBICS",
    "virement SEPA",
    "prélèvement SEPA",
    "paiement instantané",
    "encaissement",
    "monétique",
    "TPE",
    "softPOS",
    "cash pooling",
    "trésorerie centralisée",
    "Kyriba",
    "Sage XRT",
    "SWIFT",
    "trade finance",
    "lettre de crédit",
    "remise documentaire",
    "affacturage",
    "escompte",
    "flux de paiement",
    "paiement en ligne",
    "PSP",
    "prestataire de paiement",
    "acquiring",
    "e-commerce paiement",
    "open banking",
    "DSP2",
    "ISO 20022",
  ],

  // Mots-clés qui donnent un score modéré
  mots_cles_faibles: [
    "banque",
    "financement",
    "crédit",
    "compte bancaire",
    "prestataire bancaire",
    "établissement de crédit",
    "services financiers",
    "trésorerie",
  ],

  // Segments d'acheteurs ciblés — PUBLICS
  segments_publics: [
    "collectivité territoriale",
    "établissement public",
    "hôpital",
    "CHU",
    "commune",
    "métropole",
    "département",
    "région",
    "syndicat mixte",
    "office HLM",
    "université",
    "chambre de commerce",
    "établissement public de santé",
  ],

  // Segments d'acheteurs ciblés — PRIVÉS
  segments_prives: [
    // Retail & distribution
    "enseigne de distribution",
    "chaîne de magasins",
    "franchise",
    "réseau de points de vente",
    "retail",
    "grande surface",
    "e-commerçant",
    "marketplace",
    // PME / ETI / GC industriels & services
    "PME",
    "ETI",
    "groupe industriel",
    "holding",
    "entreprise de services",
    "prestataire logistique",
    "opérateur de transport",
    "promoteur immobilier",
    "groupe hôtelier",
    "réseau de restauration",
    "entreprise de travail temporaire",
    "société de négoce",
  ],

  // Mots-clés d'exclusion (hors-cible évidents)
  exclusions: [
    "travaux de voirie",
    "fournitures scolaires",
    "nettoyage de locaux",
    "restauration collective",
    "gardiennage",
    "espaces verts",
    "déchets ménagers",
  ],
};

// ─── MODE : --live ou --test ────────────────────────────────────────────────
const MODE_LIVE = process.argv.includes("--live");

// ─── DONNÉES DE TEST ─────────────────────────────────────────────────────────
// Mix réaliste : secteur public + retail + PME/ETI + exclusions.
// Remplacées par les fetchers réels à l'étape 2.

const AOS_TEST = [
  // ── PUBLICS ─────────────────────────────────────────────────────────────
  {
    id: "BOAMP-2026-101",
    source: "BOAMP",
    type_acheteur: "public",
    titre: "Services bancaires — gestion des flux de paiements et monétique — CHU régional",
    acheteur: "CHU régional (établissement public de santé)",
    lieu: "France métropolitaine",
    date_publication: "2026-06-02",
    date_limite: "2026-07-15",
    montant_estime: "800 000 € HT / an",
    description:
      "Marché de services bancaires comprenant la gestion des flux de paiements (virements SEPA, prélèvements, EBICS), la monétique (TPE, paiement en ligne), et les services de cash management. Durée : 4 ans.",
    url: "https://www.boamp.fr/avis/detail/26-101",
  },
  {
    id: "BOAMP-2026-102",
    source: "BOAMP",
    type_acheteur: "public",
    titre: "Services de trésorerie centralisée et cash pooling — Région",
    acheteur: "Conseil Régional",
    lieu: "France métropolitaine",
    date_publication: "2026-06-03",
    date_limite: "2026-08-01",
    montant_estime: "Non communiqué",
    description:
      "Consultation pour services bancaires : gestion de trésorerie centralisée, cash pooling notionnel, services SWIFT et reporting financier via TMS. Périmètre : Région + établissements rattachés.",
    url: "https://www.boamp.fr/avis/detail/26-102",
  },
  {
    id: "BOAMP-2026-103",
    source: "BOAMP",
    type_acheteur: "public",
    titre: "Prestation de nettoyage — Mairie",
    acheteur: "Commune",
    lieu: "France métropolitaine",
    date_publication: "2026-06-01",
    date_limite: "2026-06-28",
    montant_estime: "120 000 € HT / an",
    description:
      "Nettoyage des locaux municipaux. Marché à bons de commande. Lot 1 : bureaux administratifs. Lot 2 : équipements sportifs.",
    url: "https://www.boamp.fr/avis/detail/26-103",
  },

  // ── PRIVÉS — RETAIL ──────────────────────────────────────────────────────
  {
    id: "PRIV-2026-201",
    source: "Appel d'offres privé",
    type_acheteur: "privé",
    titre: "Refonte du système d'encaissement et solution PSP — enseigne retail nationale",
    acheteur: "Enseigne de distribution (réseau 300+ points de vente)",
    lieu: "France",
    date_publication: "2026-06-04",
    date_limite: "2026-07-10",
    montant_estime: "1 200 000 € HT / an",
    description:
      "Consultation pour la refonte complète du système d'encaissement : remplacement des TPE (500 terminaux), solution PSP omnicanale (magasin + e-commerce), intégration avec le système caisse, reporting des flux de paiements, gestion des remboursements. Durée : 3 ans.",
    url: "https://example-ao-prive.fr/detail/201",
  },
  {
    id: "PRIV-2026-202",
    source: "Appel d'offres privé",
    type_acheteur: "privé",
    titre: "Services de cash management et EBICS pour groupe de franchise",
    acheteur: "Groupe franchise (ETI, 150M€ CA, réseau 80 franchisés)",
    lieu: "France",
    date_publication: "2026-06-05",
    date_limite: "2026-07-20",
    montant_estime: "200 000 € HT / an",
    description:
      "Le groupe recherche un partenaire bancaire pour la mise en place d'un cash management centralisé (EBICS T/TS), remontées de soldes automatiques des filiales franchisées, virements de masse et reporting consolidé.",
    url: "https://example-ao-prive.fr/detail/202",
  },
  {
    id: "PRIV-2026-203",
    source: "Appel d'offres privé",
    type_acheteur: "privé",
    titre: "Externalisation logistique entrepôt — opérateur e-commerce",
    acheteur: "Pure player e-commerce (PME, 25M€ CA)",
    lieu: "France",
    date_publication: "2026-06-03",
    date_limite: "2026-07-01",
    montant_estime: "500 000 € HT / an",
    description:
      "Externalisation de la gestion d'entrepôt et de la préparation de commandes pour un acteur e-commerce en forte croissance. Prestation logistique uniquement.",
    url: "https://example-ao-prive.fr/detail/203",
  },

  // ── PRIVÉS — PME / ETI ───────────────────────────────────────────────────
  {
    id: "PRIV-2026-301",
    source: "Appel d'offres privé",
    type_acheteur: "privé",
    titre: "Mise en place affacturage et escompte — groupe industriel ETI",
    acheteur: "Groupe industriel ETI (180M€ CA, 3 filiales)",
    lieu: "France",
    date_publication: "2026-06-05",
    date_limite: "2026-08-15",
    montant_estime: "Encours cible : 8M€",
    description:
      "Le groupe recherche un établissement financier pour la mise en place d'une ligne d'affacturage (avec et sans recours) et d'une solution d'escompte de créances commerciales. Périmètre : maison mère + 2 filiales. Intégration ERP Sage souhaitée.",
    url: "https://example-ao-prive.fr/detail/301",
  },
  {
    id: "PRIV-2026-302",
    source: "Appel d'offres privé",
    type_acheteur: "privé",
    titre: "Partenaire bancaire — ouverture à l'international, trade finance — PME export",
    acheteur: "PME exportatrice (45M€ CA, marchés Europe + Maghreb)",
    lieu: "France",
    date_publication: "2026-06-04",
    date_limite: "2026-07-25",
    montant_estime: "Non communiqué",
    description:
      "PME à fort développement export recherche un partenaire bancaire pour : lettres de crédit import/export, remises documentaires, garanties bancaires internationales, couverture de risque change. Flux SWIFT attendus.",
    url: "https://example-ao-prive.fr/detail/302",
  },
];

// ─── DÉFINITION DES TOOLS ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: "pre_filtrer",
    description:
      "Filtre rapide d'un AO avant scoring approfondi. Vérifie si l'AO est dans le domaine des services financiers / paiements, que ce soit pour un acheteur public ou privé (retail, PME, ETI, grand compte). Retourne pertinent=true si l'AO mérite un scoring, false sinon.",
    input_schema: {
      type: "object",
      properties: {
        ao_id: { type: "string" },
        type_acheteur: {
          type: "string",
          enum: ["public", "privé", "inconnu"],
          description: "Catégorie de l'acheteur",
        },
        pertinent: {
          type: "boolean",
          description: "true si l'AO mérite un scoring approfondi",
        },
        raison_exclusion: {
          type: "string",
          description: "Si pertinent=false, expliquer pourquoi en une phrase",
        },
      },
      required: ["ao_id", "type_acheteur", "pertinent"],
    },
  },
  {
    name: "scorer_ao",
    description:
      "Score un AO de 0 à 100. Analyse titre, description, acheteur, montant. Applicable aux AOs publics ET privés (retail, PME/ETI/GC). Le score reflète la probabilité que cet AO soit une opportunité commerciale pour des services de cash management, encaissement, ou flux de paiements.",
    input_schema: {
      type: "object",
      properties: {
        ao_id: { type: "string" },
        score: { type: "number", description: "Score global de 0 à 100" },
        details: {
          type: "object",
          properties: {
            pertinence_metier: {
              type: "number",
              description: "0-40 pts : mots-clés paiement / cash management / monétique",
            },
            potentiel_volume: {
              type: "number",
              description: "0-20 pts : montant, durée, nombre de sites/filiales",
            },
            maturite_acheteur: {
              type: "number",
              description: "0-20 pts : acheteur structuré, appel d'offres formalisé, décideur identifiable",
            },
            urgence: {
              type: "number",
              description: "0-20 pts : délai de réponse court = pression = opportunité",
            },
          },
          required: [
            "pertinence_metier",
            "potentiel_volume",
            "maturite_acheteur",
            "urgence",
          ],
        },
        justification: {
          type: "string",
          description: "2-3 phrases expliquant le score",
        },
        mots_cles_detectes: {
          type: "array",
          items: { type: "string" },
          description: "Mots-clés pertinents trouvés dans l'AO",
        },
        segment: {
          type: "string",
          enum: [
            "Collectivité / Établissement public",
            "Santé publique",
            "Retail / Distribution",
            "Franchise / Réseau",
            "PME",
            "ETI",
            "Grand Compte",
            "E-commerce",
            "Industrie",
            "Services",
            "Autre",
          ],
        },
      },
      required: ["ao_id", "score", "details", "justification", "segment"],
    },
  },
  {
    name: "qualifier_action",
    description:
      "Détermine l'action commerciale recommandée. Prend en compte le score, la date limite, le type d'acheteur (public vs privé) et le potentiel de la relation.",
    input_schema: {
      type: "object",
      properties: {
        ao_id: { type: "string" },
        action: {
          type: "string",
          enum: ["ALERTE_URGENTE", "A_QUALIFIER", "EN_VEILLE", "HORS_CIBLE"],
        },
        angle_commercial: {
          type: "string",
          description:
            "Angle de pitch adapté au profil de l'acheteur (1-2 phrases, sans mentionner de marque)",
        },
        prochaine_etape: {
          type: "string",
          description:
            "Action concrète recommandée : ex. 'Télécharger le cahier des charges', 'Contacter le prescripteur', 'Préparer une réponse'",
        },
        alerter: { type: "boolean" },
      },
      required: ["ao_id", "action", "alerter"],
    },
  },
  {
    name: "sauvegarder_resultat",
    description:
      "Sauvegarde le résultat analysé dans le pipeline de veille. En production : écriture JSON vers GitHub. En test : log structuré.",
    input_schema: {
      type: "object",
      properties: {
        ao_id: { type: "string" },
        resume: {
          type: "object",
          properties: {
            titre: { type: "string" },
            acheteur: { type: "string" },
            type_acheteur: { type: "string" },
            segment: { type: "string" },
            date_limite: { type: "string" },
            montant: { type: "string" },
            score: { type: "number" },
            action: { type: "string" },
            alerter: { type: "boolean" },
            angle_commercial: { type: "string" },
            prochaine_etape: { type: "string" },
            url: { type: "string" },
          },
        },
      },
      required: ["ao_id", "resume"],
    },
  },
  {
    name: "generer_rapport",
    description:
      "Génère le rapport final de la session : stats globales, répartition public/privé, et liste des AOs à traiter en priorité.",
    input_schema: {
      type: "object",
      properties: {
        stats: {
          type: "object",
          properties: {
            total_analyses: { type: "number" },
            total_alertes: { type: "number" },
            score_moyen: { type: "number" },
            hors_cible: { type: "number" },
            publics: { type: "number" },
            prives: { type: "number" },
          },
          required: [
            "total_analyses",
            "total_alertes",
            "score_moyen",
            "hors_cible",
            "publics",
            "prives",
          ],
        },
        aos_alertes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ao_id: { type: "string" },
              titre: { type: "string" },
              segment: { type: "string" },
              score: { type: "number" },
              action: { type: "string" },
              url: { type: "string" },
            },
          },
        },
      },
      required: ["stats", "aos_alertes"],
    },
  },
];

// ─── EXÉCUTION DES TOOLS (côté Node.js) ────────────────────────────────────

const pipeline = {};
const aoMap = Object.fromEntries(AOS_BRUTS.map((ao) => [ao.id, ao]));

function executerTool(name, input) {
  switch (name) {
    case "pre_filtrer": {
      const icon = input.pertinent ? "✅" : "❌";
      const raison = input.pertinent ? input.type_acheteur : `exclu — ${input.raison_exclusion}`;
      console.log(`  🔍 pre_filtrer(${input.ao_id}) → ${icon} ${raison}`);
      return { ok: true };
    }

    case "scorer_ao": {
      console.log(
        `  📊 scorer_ao(${input.ao_id}) → score=${input.score} | segment=${input.segment}`
      );
      pipeline[input.ao_id] = {
        ...pipeline[input.ao_id],
        score: input.score,
        segment: input.segment,
        justification: input.justification,
        mots_cles: input.mots_cles_detectes,
      };
      return { ok: true };
    }

    case "qualifier_action": {
      const flag = input.alerter ? "🔔" : "  ";
      console.log(
        `  🎯 qualifier_action(${input.ao_id}) → ${input.action} ${flag}`
      );
      pipeline[input.ao_id] = {
        ...pipeline[input.ao_id],
        action: input.action,
        alerter: input.alerter,
        angle_commercial: input.angle_commercial,
        prochaine_etape: input.prochaine_etape,
      };
      return { ok: true };
    }

    case "sauvegarder_resultat": {
      const ao = aoMap[input.ao_id];
      pipeline[input.ao_id] = {
        ...pipeline[input.ao_id],
        ...input.resume,
        url: ao?.url,
        source: ao?.source,
      };
      console.log(`  💾 sauvegarder_resultat(${input.ao_id}) → OK`);
      // Production : écriture dans pipeline.json via GitHub API
      return { ok: true };
    }

    case "generer_rapport": {
      const { stats, aos_alertes } = input;
      console.log(`\n${"═".repeat(62)}`);
      console.log("📋  RAPPORT DE VEILLE — VeillAO Agent");
      console.log(`${"═".repeat(62)}`);
      console.log(`  AOs analysés    : ${stats.total_analyses}`);
      console.log(`    dont publics  : ${stats.publics}`);
      console.log(`    dont privés   : ${stats.prives}`);
      console.log(`  Hors-cible      : ${stats.hors_cible}`);
      console.log(`  Score moyen     : ${stats.score_moyen}/100`);
      console.log(`  🔔 À alerter    : ${stats.total_alertes}`);

      if (aos_alertes.length > 0) {
        console.log(`\n  Opportunités à traiter :`);
        for (const ao of aos_alertes) {
          const res = pipeline[ao.ao_id] || {};
          console.log(`\n  ┌─ [${ao.score}/100] ${ao.titre}`);
          console.log(`  │  Segment     : ${ao.segment}`);
          console.log(`  │  Action      : ${ao.action}`);
          if (res.angle_commercial) {
            console.log(`  │  Angle       : ${res.angle_commercial}`);
          }
          if (res.prochaine_etape) {
            console.log(`  │  Étape       : ${res.prochaine_etape}`);
          }
          console.log(`  └─ URL         : ${ao.url}`);
        }
      } else {
        console.log("\n  Aucun AO ne dépasse le seuil ce cycle.");
      }
      console.log(`\n${"═".repeat(62)}\n`);
      return { ok: true };
    }

    default:
      return { error: `Tool inconnu : ${name}` };
  }
}

// ─── BOUCLE AGENTIQUE ──────────────────────────────────────────────────────

async function runAgent() {
  const client = new Anthropic();

  // ── Chargement des AOs : live (vrais fetchers) ou test (données locales) ──
  let AOS_BRUTS;

  if (MODE_LIVE) {
    console.log("🌐 Mode LIVE — fetching des vraies sources...");
    AOS_BRUTS = await fetchAllSources(AGENT_CONFIG.mots_cles_forts, {
      boamp: true,
      alerts: true,
      ted: true,
    });
    if (AOS_BRUTS.length === 0) {
      console.warn("⚠️  Aucun AO récupéré depuis les sources live. Vérifier la config fetchers.js.");
      process.exit(0);
    }
  } else {
    console.log("🧪 Mode TEST — données locales (passer --live pour les vraies sources)");
    AOS_BRUTS = AOS_TEST;
  }

  const systemPrompt = `Tu es un agent de veille sur les appels d'offres de services financiers et de paiements.

Tu analyses des opportunités commerciales pour des prestataires de services bancaires : cash management, encaissement, monétique, flux de paiements, trade finance, affacturage, escompte.

Tu couvres DEUX types d'acheteurs :
1. **Publics** : collectivités, hôpitaux, établissements publics — marchés formalisés via BOAMP/VAAO
2. **Privés** : retail, franchises, PME, ETI, grands comptes — consultations privées, appels d'offres informels

Mots-clés à score fort : ${AGENT_CONFIG.mots_cles_forts.join(", ")}
Mots-clés à score modéré : ${AGENT_CONFIG.mots_cles_faibles.join(", ")}
Exclusions évidentes : ${AGENT_CONFIG.exclusions.join(", ")}

Seuil d'alerte : ${AGENT_CONFIG.score_seuil_alerte}/100
Seuil urgence : ${AGENT_CONFIG.score_seuil_urgence}/100 ET date limite < 21 jours

Processus OBLIGATOIRE pour chaque AO, dans cet ordre :
1. pre_filtrer → si pertinent=false, passer au suivant
2. scorer_ao → analyse détaillée du score
3. qualifier_action → action et angle commercial sans mentionner aucune marque
4. sauvegarder_resultat → résumé complet

Une fois TOUS les AOs traités → generer_rapport avec les stats complètes.`;

  const userMessage = `Lance la session de veille sur ${AOS_BRUTS.length} appels d'offres.

${AOS_BRUTS.map((ao, i) => `
--- AO ${i + 1} ---
ID            : ${ao.id}
Source        : ${ao.source}
Type acheteur : ${ao.type_acheteur}
Titre         : ${ao.titre}
Acheteur      : ${ao.acheteur}
Lieu          : ${ao.lieu}
Publication   : ${ao.date_publication}
Date limite   : ${ao.date_limite}
Montant       : ${ao.montant_estime}
Description   : ${ao.description}
URL           : ${ao.url}`).join("\n")}

Traite chaque AO avec les 4 tools dans l'ordre, puis génère le rapport final.`;

  console.log("\n🚀 VeillAO Agent — démarrage scoring");
  console.log(`   Modèle    : ${AGENT_CONFIG.model}`);
  console.log(`   AOs       : ${AOS_BRUTS.length} (${AOS_BRUTS.filter(a => a.type_acheteur === "public").length} publics, ${AOS_BRUTS.filter(a => a.type_acheteur === "privé").length} privés, ${AOS_BRUTS.filter(a => a.type_acheteur === "inconnu").length} inconnus)`);
  console.log(`   Seuil     : ${AGENT_CONFIG.score_seuil_alerte}/100`);
  console.log(`${"─".repeat(62)}\n`);

  const messages = [{ role: "user", content: userMessage }];
  let iterations = 0;
  const MAX_ITER = 40;

  while (iterations < MAX_ITER) {
    iterations++;
    console.log(`[Tour ${iterations}]`);

    const response = await client.messages.create({
      model: AGENT_CONFIG.model,
      max_tokens: AGENT_CONFIG.max_tokens,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    console.log(`  stop_reason: ${response.stop_reason}`);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const txt = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (txt) console.log(`\n💬 ${txt}`);
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolCalls = response.content.filter((b) => b.type === "tool_use");
      const results = toolCalls.map((tc) => ({
        type: "tool_result",
        tool_use_id: tc.id,
        content: JSON.stringify(executerTool(tc.name, tc.input)),
      }));
      messages.push({ role: "user", content: results });
      continue;
    }

    console.warn(`⚠️  stop_reason inattendu : ${response.stop_reason}`);
    break;
  }

  if (iterations >= MAX_ITER) {
    console.error("❌ Limite d'itérations atteinte.");
  }

  console.log(`✅ Session terminée (${iterations} tours)`);
  return pipeline;
}

runAgent().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
