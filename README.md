# VeillAO Agent

Agent de veille automatique sur les appels d’offres de **services financiers et de paiements** — secteur public (BOAMP, TED Europa) et privé (Google Alerts).

Basé sur la boucle tool-use de l’API Claude (Anthropic).

-----

## Fonctionnement

```
Sources (BOAMP / TED / Google Alerts)
        ↓
  fetchAllSources()
        ↓
  Agent Claude (boucle tool-use)
    → pre_filtrer
    → scorer_ao (0-100)
    → qualifier_action
    → sauvegarder_resultat
        ↓
  Rapport terminal + pipeline.json
```

-----

## Installation

```bash
git clone https://github.com/votre-compte/veilleao-agent
cd veilleao-agent
npm install
```

-----

## Configuration

### 1. Clé API Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Ou créer un fichier `.env` (ne jamais committer) :

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Google Alerts RSS (pour les AOs privés)

Les AOs privés (retail, PME, ETI) arrivent via Google Alerts RSS.

**Setup (5 minutes) :**

1. Aller sur [google.fr/alerts](https://www.google.fr/alerts)
1. Créer une alerte pour chaque requête cible :
- `"appel d'offres" "cash management"`
- `"appel d'offres" "monétique" OR "TPE" OR "encaissement"`
- `"appel d'offres" "EBICS" OR "flux de paiements"`
- `"consultation bancaire" ETI OR PME`
- `"appel d'offres" "affacturage" OR "escompte"`
- `"appel d'offres" "PSP" OR "paiement en ligne" retail`
1. Dans **Options** → sélectionner **Flux RSS**
1. Copier les URLs RSS dans `fetchers.js` → tableau `GOOGLE_ALERTS_FEEDS`

### 3. Adapter les critères métier

Dans `veilleao-agent.js`, modifier `AGENT_CONFIG` :

```js
const AGENT_CONFIG = {
  score_seuil_alerte: 60,       // alerter si score >= 60
  score_seuil_urgence: 75,      // urgence si score >= 75 ET délai < 21j
  mots_cles_forts: [            // font monter le score
    "cash management", "EBICS", ...
  ],
  exclusions: [                 // hors-cible évidents
    "nettoyage", "travaux", ...
  ],
};
```

-----

## Utilisation

```bash
# Mode test (données locales, pas d'appels réseau)
npm test

# Mode live (fetching des vraies sources)
npm start
```

-----

## Sources intégrées

|Source               |Type          |Couverture                                 |
|---------------------|--------------|-------------------------------------------|
|**BOAMP**            |Public        |Marchés publics français (API OpenDataSoft)|
|**TED Europa**       |Public        |Marchés européens > seuils (API REST)      |
|**Google Alerts RSS**|Public + Privé|Signaux d’affaires sur mot-clé             |

-----

## Structure du projet

```
veilleao-agent/
├── veilleao-agent.js   # Agent de scoring (boucle tool-use Claude)
├── fetchers.js         # Fetchers par source (BOAMP, TED, Google Alerts)
├── package.json
└── README.md
```

-----

## Étape suivante : GitHub Actions (cron automatique)

Ajouter `.github/workflows/veille.yml` pour lancer l’agent toutes les 6h :

```yaml
name: VeillAO — Run agent
on:
  schedule:
    - cron: '0 6,12,18 * * 1-5'  # 6h, 12h, 18h du lundi au vendredi
  workflow_dispatch:               # déclenchement manuel aussi

jobs:
  veille:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm start
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

→ Ajouter `ANTHROPIC_API_KEY` dans **Settings → Secrets → Actions** du repo GitHub.

-----

## Licence

MIT