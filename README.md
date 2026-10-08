# Andreas Sollie Steffensen – Personal Website

Personlig portfolio og profilside med prosjekter og fagoversikter fra NTNU.
Produksjon: [asinfra.no](https://asinfra.no/), hostet på GitHub Pages.
Custom domain er `asinfra.no`, og nettstedet publiseres fra domeneroten `/`.
DNS hos Uniweb, GitHub-domeneverifisering, custom domain og HTTPS er konfigurert
utenfor repoet. `www.asinfra.no` er satt opp som alternativ adresse.

## Teknologi og struktur

Hovednettstedet bruker statisk HTML, CSS og vanilla JavaScript uten build-system.
Study er flyttet til [andsolste/asinfra-study](https://github.com/andsolste/asinfra-study)
og publiseres separat på [study.asinfra.no](https://study.asinfra.no/).

`/apps/` er inngangen til å bruke apper; `/projects/` er porteføljen med
prosjektbeskrivelser. Nye apper legges til som vanlige kort i `apps/index.html`
med navn, kort bruksbeskrivelse og direkte lenke til appen. Appkode bygges ikke her.

```text
.github/workflows/     Kontroll og Pages-deploy
assets/
  css/                 Felles og seksjonsspesifikke stilark
  js/                  Navigasjon, søk og seksjonsspesifikke skript
  data/                Statisk søkeindeks
  favicon.svg          AS-monogram
about/index.html       Personlig profil
apps/index.html        App-hub med direkte lenker til apper som kan brukes
education/
  index.html           Hovedoversikt med aktive fag og lenke til tidligere fag
  active/              De fire aktive emnesidene
  previous/index.html  Tidligere fag, gruppert etter semester
projects/
  index.html           Prosjektoversikt
  technical/           Plass for fremtidige tekniske prosjekter
  media-design/        Eksisterende medieprosjekter og deres filer
supabase/              Canonical backend: config, migrations og eget testoppsett
  tests/               Database-/RLS-tester og valgfri Auth/Data API-test
study/index.html       Redirect for gamle Study-bokmerker
scripts/               Statisk validering og Pages-publiseringsmappe
index.html             Forside
404.html               Feilside med navigasjon
```

Tidligere fag presenteres på `education/previous/index.html` med lenker til NTNU.
Hovedoversikten viser aktive fag og lenker videre til tidligere fag; de enkelte
fullførte emnene har ikke egne interne sider. Tomme mapper beholdes i Git med
`.gitkeep`.

## Lokal kjøring

Bruk en HTTP-server: katalog-URL-er og globalt søk trenger at sidene serveres.
Kjør fra repositoryets rot:

```sh
python -m http.server
```

Åpne deretter http://localhost:8000/. Vanlig navigasjon bruker katalog-URL-er
med avsluttende `/`, uten synlig `index.html`. Filene heter fortsatt `index.html`,
så gamle fil-URL-er virker også. Ordinære sider bruker relative lenker; sidebar
og søk finner nettstedets rot fra plasseringen til `assets/js/site.js`, ikke hostname.
Produksjonen bruker domeneroten; relative lenker trenger ingen domenespesifikk omskriving.

404-siden har `<base href="/">` som lar assets, søk og lenker fungere også på dype
feiladresser. Canonical og Open Graph peker til tilsvarende URL-er på `https://asinfra.no/`.
Gamle adresser til Om meg og Fag videresendes fra 404-siden til den nye strukturen,
med søkeparametre og ankere bevart. Gamle `#tidligere-fag`-bokmerker på fagoversikten
videresendes til `education/previous/`. Gamle `/website/...`-stier håndteres også
av 404-skriptet, som fjerner det tidligere repository-prefikset før eventuell
struktur-redirect. Ukjente destinasjoner forblir vanlige 404-sider, uten redirect-loop.
Den gamle GitHub Pages-adressen håndteres først av hostingens domene-redirect;
repoet håndterer eventuelle bevarte prefikser og gamle interne paths.
Lokal standardserver bruker ikke 404-siden automatisk.

GitHub Actions er fortsatt publiseringskilden. Ingen `CNAME`-fil er nødvendig
for custom domain med dette oppsettet, se
[GitHub-dokumentasjonen](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
Ved eventuell tilbakeføring må metadata og 404-base tilpasses adressen som tas
i bruk igjen, og Pages-/DNS-oppsettet håndteres separat. Relative lenker og
rotberegning fra script-plasseringen kan beholdes.

## Arkitektur og delt backend

- **andsolste/asinfra** eier `asinfra.no`, det statiske hovednettstedet og canonical
  `supabase/` med config, migrations, RLS, constraints, RPC-er og backendtester.
- **andsolste/asinfra-study** eier `study.asinfra.no` og React/Vite-frontenden.
  Frontendutvikling, lokal Vite-kjøring og deployment er dokumentert i
  [Study-repoet](https://github.com/andsolste/asinfra-study).
- Begge bruker samme Supabase-prosjekt/Auth. Brukere, ID-er og data er ikke flyttet.
  Study-repoet inneholder ikke migrations; databaseendringer gjøres med review her.

`subjects` og `study_sessions` er bruker-eide. `study_session_segments` lagrer
arbeidsperioder; varighet utledes fra tidsstempler. Composite FK-er sikrer samme
eier, og unique indexes begrenser hver bruker til én uavsluttet økt og hvert
session til ett åpent segment. RLS/grants begrenser `authenticated` til eget
`auth.uid()`; `anon` har ingen tilgang. `study_session_transition` gjør
start/pause/fortsett/stopp atomisk, og `study_session_snapshot` brukes for recovery.

`supabase/config.toml` gjelder bare lokal CLI-kjøring. Lokal Auth-retur bruker
localhost-roten; hosted Auth-innstillinger håndteres separat i samme prosjekt.
Produksjonen bruker `https://study.asinfra.no/`. Gamle Auth-redirects kan beholdes
under overgangen. Ingen hosted config eller schema endres av Pages-workflowene.

## Backendtester og migrasjoner

Bruk Node.js 22.12+ (CI bruker 24). Backend har egen låsefil uten workspaces:

```sh
cd supabase
npm ci
npm test
```

`tests/database.test.mjs` og `tests/sessions-database.test.mjs` kjører alle
canonical migrations i isolert PostgreSQL/WASM (PGlite). De kontrollerer grants,
RLS mellom to brukere, foreign keys, constraints, atomiske RPC-er, retry og
recovery. Bare Supabase sitt Auth-schema/`auth.uid()` stubbes; testen bruker
ingen hosted database, ekte kontoer eller API-nøkler.

Den valgfrie `npm run test:rls` fra `supabase/` kjører
`tests/test-rls.mjs` mot ekte Auth/JWT/Data API. Kopier `.env.example` til
`.env.local` og sett kun offentlig URL og publishable key der. Sett midlertidig
`RUN_STUDY_RLS_TESTS=yes`, `TEST_USER_A_EMAIL`, `TEST_USER_A_PASSWORD`,
`TEST_USER_B_EMAIL` og `TEST_USER_B_PASSWORD` i prosessmiljøet.
Bruk to dedikerte, bekreftede testkontoer uten uavsluttede økter og kontroller
prosjektet først. Scriptet oppretter UUID-merkede testfag/økter/segmenter og rydder
kun disse gjennom eierkontoene. Ingen service-role/secret key brukes.
Hosted-testen kjøres ikke i CI; credentials og lokale env-filer skal aldri i Git.

For full lokal Supabase med CLI og Docker, fra repo-roten:

```sh
npx supabase start
npx supabase db reset --local
npx supabase status
```

`reset --local` sletter lokal utviklingsdata. Bruk lokale offentlige verdier
med Study-frontenden og lokal Mailpit for e-postbekreftelse.

**Etter SQL/RLS-review**, for en tilsiktet hosted schemaendring:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Kontroller project-ref, ventede migrations og eksisterende data før siste
kommando. Ikke legg tokens/passord i Git eller bruk `config push` som del av
denne flyten. Ingen migrations/schemaendringer inngår i frontend-flyttingen.

## Kontroll og publisering

Fra repo-roten:

```sh
python scripts/validate-site.py
python scripts/build-pages.py
python -m http.server --directory publish
```

Validatoren bruker Python-standardbiblioteket og kontrollerer lokale lenker,
assets, søkeindeks, ankere og HTML-ID-er. Publiseringsroten leses fra forsidens
canonical; 404-sidens `<base>` respekteres.
`--base-url https://example.test/` kan teste et annet hostname uten metadataendring.

Pull requests valideres av `validate-site.yml`. Push til `main` valideres og
publiseres av `deploy-pages.yml`. Begge kjører statisk validator, backendtesten
med `npm ci`/`npm test` i `supabase/`, og `build-pages.py`.
Det bygges ingen React-app her, og frontend-variabler er ikke nødvendige i
hovedrepoets workflows. Bare Study-repoet bygger/deployer Study-frontenden.

Publiseringsscriptet erstatter kun genererte `publish/`. Det kopierer statiske
produksjonsfiler fra `index.html`, `404.html`, `about/`, `education/`,
`projects/`, `apps/`, `assets/` og legacy `study/index.html`, inkludert originale
prosjektassets. `publish/study/` skal inneholde bare redirect-siden, ingen gamle
React-bundles. Dotfiler, dependencies, backend, scripts og README publiseres ikke.
Bare `publish/` lastes opp som Pages-artifact. Study-kilden eies kun av det nye repoet.

Gamle `https://asinfra.no/study/`-bokmerker videresendes til
`https://study.asinfra.no/` med `location.replace`, som bevarer query og hash.
Canonical, meta refresh og synlig lenke gir fallback; uten JavaScript sender
meta refresh til subdomenets rot uten query/hash. Ingen serverside-routing kreves.

## Vedlikehold

- Aktive fag i sidebaren defineres i `assets/js/site.js`.
- Globalt søk bruker `assets/data/search-index.json`; oppdater URL-er og ankere når innhold endres.
- Global stil ligger i `assets/css/site.css`.
- Seksjonsstil ligger i `assets/css/about.css`, `projects.css` og `education.css`.
- IDATT2202 har `assets/css/idatt2202.css` og `assets/js/idatt2202.js`.
- Nye sider bør ha unik beskrivelse, canonical URL og riktig relativ favicon-lenke.
