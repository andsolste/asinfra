# Andreas Sollie Steffensen – Personal Website

Personlig portfolio og profilside med prosjekter og fagoversikter fra NTNU.
Produksjon: [asinfra.no](https://asinfra.no/), hostet på GitHub Pages.
Custom domain er `asinfra.no`, og nettstedet publiseres fra domeneroten `/`.
DNS hos Uniweb, GitHub-domeneverifisering, custom domain og HTTPS er konfigurert
utenfor repoet. `www.asinfra.no` er satt opp som alternativ adresse.

## Teknologi og struktur

Hovednettstedet bruker statisk HTML, CSS og vanilla JavaScript uten build-system.
Study er en separat React + TypeScript-app med Vite under `apps/study/`.

```text
.github/workflows/     Kontroll og Pages-deploy
assets/
  css/                 Felles og seksjonsspesifikke stilark
  js/                  Navigasjon, søk og seksjonsspesifikke skript
  data/                Statisk søkeindeks
  favicon.svg          AS-monogram
about/index.html       Personlig profil
education/
  index.html           Hovedoversikt med aktive fag og lenke til tidligere fag
  active/              De fire aktive emnesidene
  previous/index.html  Tidligere fag, gruppert etter semester
projects/
  index.html           Prosjektoversikt
  technical/           Plass for fremtidige tekniske prosjekter
  media-design/        Eksisterende medieprosjekter og deres filer
apps/study/            Selvstendig React + Vite + TypeScript-app
scripts/               Statisk validering og samlet Pages-publiseringsmappe
index.html             Forside
404.html               Feilside med navigasjon
```

Tidligere fag presenteres på `education/previous/index.html` med lenker til NTNU.
Hovedoversikten viser aktive fag og lenker videre til tidligere fag; de enkelte
fullførte emnene har ikke egne interne sider. Tomme mapper beholdes i Git med
`.gitkeep`. Study har innlogging, egne fag og databasegrunnlag for studieøkter.

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

## Study – lokal utvikling

Bruk Node.js 22.12 eller nyere, gjerne Node.js 24 LTS, og npm.
Appen har egen `package.json` og `package-lock.json`, uten workspaces.

```sh
cd apps/study
npm ci
# Kopier .env.example til .env.local og fyll inn prosjektets offentlige verdier.
npm run dev
```

Åpne adressen Vite viser, normalt http://localhost:5173/study/.

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

`build` kjører også typekontroll og lager `apps/study/dist/`.
`preview` viser produksjonsbygget lokalt, normalt på http://localhost:4173/study/.
Vite er konfigurert med `base: '/study/'`. Pages-deployen publiserer bygget på
[asinfra.no/study/](https://asinfra.no/study/), separat fra den statiske hovedsiden.
Study støtter oppretting og redigering av egne fag, med valgfri fagkode.
Aktive og arkiverte fag vises separat; arkivering kan angres ved å aktivere faget
igjen. Fag slettes ikke, og ID-er/koblinger til studieøkter beholdes. Data hentes
fra Supabase og isoleres med eksisterende RLS, ikke lokal lagring eller offentlige
emnesider. Ingen ny migrasjon trengs for fagadministrasjonen.
Study kan starte, pause, fortsette og stoppe en studieøkt. Velg et aktivt fag og en
valgfri beskrivelse. Historikk, etterredigering og statistikk kommer senere.

### Studieøkter og arbeidsperioder

En `study_sessions`-rad inneholder fag, beskrivelse og start/slutt. Hver sammenhengende
arbeidsperiode lagres i `study_session_segments` med `timestamptz`. Arbeidstid summeres
fra segmentene; pause er klokketid minus arbeidstid. Ingen totalvarighet lagres separat.
Timeren regner fra tidsstempler og serverens klokke, ikke antall interval-ticks.
Tidspunkt vises i nettleserens lokale tid.

Migrasjonen `20261007120000_add_study_session_segments.sql` legger til segmenttabellen,
composite FK `(session_id, user_id)`, egne RLS-policyer/grants og to partial unique
indexes: én uavsluttet økt per bruker (`ended_at IS NULL`, også pauset) og ett åpent
segment per økt. `study_session_transition` gjør start/pause/fortsett/stopp atomisk
med invoker-rettigheter/RLS og en transaksjonslås per bruker. Retry bruker de samme
UUID-ene, og en gammel pause kan ikke lukke et nyere segment. `study_session_snapshot`
henter økt, fag og segmenter konsistent ved innlasting og når fanen får fokus.
Økten fortsetter til du stopper den; logout eller lukking av fanen stopper ikke klokken.

Kun bekreftede databaseverdier endrer timerstatus. Ved feil kan du prøve samme handling
igjen eller kontrollere status. Ingen localStorage-timer brukes som sannhetskilde.
Fagadministrasjon og timer deler én fagoversikt; arkivering etter start endrer ikke økten.

Før denne PR-en merges må migrasjonen gjennomgås og anvendes manuelt med CLI-flyten
under. Kontroller spesielt om gamle `study_sessions` har flere uavsluttede rader
per bruker (grupper på `user_id`, filtrer `ended_at IS NULL`, `count(*) > 1`).
Avklar/korriger slike rader bevisst før migrasjonen: indeksen vil ellers avvise den.
Migrasjonen verken avslutter gamle økter eller finner på arbeidsperioder. En eldre
økt uten segmenter vises som pauset med en advarsel; tidligere arbeidstid er ukjent.
Den nye frontend-versjonen trenger migrasjonen; merge/deploy derfor ikke før den er klar.
Ingen hosted migrasjon eller produksjonsdata opprettes av testene i CI.

Koden ligger i `src/App.tsx`, `src/main.tsx` og `src/styles.css`.
Mapper for komponenter, hooks, sider og andre ressurser opprettes når de trengs.
`node_modules/` og `dist/` holdes utenfor Git. Oppsettet har ingen egen linter;
TypeScript kjører i strict-modus med kontroll av ubrukte variabler og parametre.

## Study – Supabase og innlogging

Supabase håndterer email/password-auth og database. Study bruker bare disse
frontend-variablene i `apps/study/.env.local` (eksempel uten ekte verdier):

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
```

Lokale `.env*`-filer ignoreres; kun `.env.example` versjoneres. Bruk aldri private
API-nøkler eller databasepassord i Vite. Publishable key er offentlig og bygges
inn i frontend. GitHub Actions leser de to navnene fra Repository variables
(`vars`), og byggingen feiler tydelig ved manglende/ugyldig konfigurasjon.

Registrering forklarer e-postbekreftelse når Supabase krever det. SDK-et håndterer
session, token-refresh og innlogging etter reload; utlogging gjelder denne sessionen.
Innlogget konto viser e-post; fagoversikten gjør autoriserte `subjects`-oppslag og
lagringer med session-JWT. Database-default setter eier ved oppretting. UI-et bruker
returnerte rader ved lagring; etter feil kreves ny innhenting før nytt forsøk.
Tomt resultat er normalt. Manglende migrasjon/tilgang gir en forståelig feilmelding.
Feil konfigurasjon i lokal utvikling gir en melding i UI, ikke en blank side.

`supabase/config.toml` er bare lokal CLI-konfigurasjon med e-postbekreftelse på.
Hosted Auth-innstillinger endres ikke av database-migrasjonen. Bekreft at email/password
og email confirmation er aktivert, og at Site URL/Redirect URLs tillater
`https://asinfra.no/study/` og `http://localhost:5173/study/`.
Behold standard bekreftelseslenke (`ConfirmationURL`); SDK-et håndterer retur til `/study/`.

Migrasjonen i `supabase/migrations/` oppretter bruker-eide `subjects` og
`study_sessions`. Fag har valgfri emnekode og arkivstatus; økter har valgfritt fag,
beskrivelse, start/slutt og opprettelsestid. Varighet utledes, lagres ikke separat.
Sammensatt foreign key sikrer at fag og økt tilhører samme bruker. Sletting av fag
fjerner koblingen, men beholder økter. Sletting av Auth-brukeren sletter brukerens data.

**RLS er sikkerhetsgrensen:** `anon`/`public` har ingen tabellgrants.
`authenticated` har eksplisitt SELECT/INSERT/UPDATE/DELETE, begrenset til eget
`user_id` med `auth.uid()` på begge tabeller. UPDATE kontrollerer også ny eier.
Ingen forhøyet API-nøkkel brukes av appen eller testene.

### Tester og kontrollert migrasjonsdeploy etter review

`npm test` kjører migrasjonen i isolert PostgreSQL/WASM (PGlite) med to test-ID-er,
`authenticated`/`anon`-roller og en liten stub for Supabase sin `auth.uid()`.
Testene kontrollerer ekte PostgreSQL grants, policies og FK-regler, men simulerer
ikke Supabase Auth, e-post eller Data API. Testavhengigheten inngår ikke i frontend-bundle.

For full lokal Supabase med installert CLI og Docker, fra repo-roten:

```sh
npx supabase start
npx supabase db reset --local
npx supabase status
```

`reset --local` sletter bare den lokale utviklingsdatabasen. Bruk prosjekt-URL og
publishable key fra lokal status i `.env.local`, start Vite og registrer/bekreft en
testkonto via lokal Mailpit. Ingen hosted migrasjon kjøres automatisk i CI.

**Først etter SQL/RLS-review**, link prosjektet og inspiser deploy-planen:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Kontroller project-ref og ventede migrasjoner før siste kommando. Logg inn via CLI-ens
vanlige sikre flyt; legg aldri tokens/passord i repoet. Bruk ikke `config push` her.

Opprett deretter to forskjellige, bekreftede testkontoer gjennom Auth-UI-et. For
`npm run test:rls` i `apps/study/` må følgende settes midlertidig i prosessmiljøet:
`RUN_STUDY_RLS_TESTS=yes`, `TEST_USER_A_EMAIL`, `TEST_USER_A_PASSWORD`,
`TEST_USER_B_EMAIL`, `TEST_USER_B_PASSWORD`. `.env.local` leverer de to offentlige
frontend-variablene. Ikke legg testcredentials i Git eller CI. Scriptet gjør ekte
email/password-innlogging og tester begge brukernes CRUD/isolasjonsregler via Data API;
det oppretter kun UUID-merkede testfag/økter/segmenter og rydder dem opp gjennom eierkontoene.
Bruk dedikerte testkontoer uten uavsluttede økter. Scriptet tester også atomiske
timeroverganger, retry, same-owner FK og én aktiv økt/ett åpent segment.

Manuell slutt-test lokalt og på `https://asinfra.no/study/` etter merge/deploy:

1. Registrer konto, følg bekreftelseslenken, og kontroller at du kommer til `/study/`.
2. Test feil passord og ubekreftet konto; meldinger skal være forståelige.
3. Logg inn og se riktig e-post og fagoversikt (tom liste er gyldig). Opprett fag
   med/uten kode, rediger, arkiver og aktiver igjen; kontroller data etter reload.
4. Reload og bekreft at session beholdes; logg ut og kontroller at skjemaet kommer tilbake.
5. Gjenta med konto B, og kjør `npm run test:rls` mot riktig miljø.
6. Kontroller desktop/mobil, tastaturnavigasjon og ingen 404/konsollfeil på Study-assets.
7. Start en økt, pause/fortsett flere ganger og stopp både fra pågående og pauset tilstand.
   Kontroller arbeidstid/pausetid, recovery etter reload/logout, dobbeltklikk og retry
   ved nettverksfeil. Fag/beskrivelse skal ikke kunne endres midt i økten.

## Kontroll og publisering

```sh
python scripts/validate-site.py
```

Kontrollen bruker bare Python-standardbiblioteket og sjekker lokale lenker,
assets, søkeindeks, ankere og dupliserte HTML-ID-er. Appkildekode under `apps/`
er unntatt fra denne statiske kontrollen; Study kontrolleres med npm-scriptene over.
Publiseringsroten leses fra forsidens canonical, og `<base>` på 404-siden respekteres.
`--base-url https://example.test/` kan brukes for å kontrollere samme
stioppsett på et annet hostname, uten å endre nettstedets metadata.
Pull requests mot `main` kontrolleres med `.github/workflows/validate-site.yml`.
Både denne og `.github/workflows/deploy-pages.yml` bruker Node.js 24, `npm ci`
og `npm run build` (inkludert typekontroll) i `apps/study/`, i tillegg til statisk
validering. Begge kontrollerer den samlede publiseringsmappen; bare `main` deployes.

Etter Study-build kan samme produksjonsmappe lages lokalt fra repo-roten:

```sh
python scripts/build-pages.py
python -m http.server --directory publish
```

Åpne http://localhost:8000/ eller http://localhost:8000/study/.
Scriptet erstatter kun den genererte `publish/`-mappen. Det kopierer `index.html`,
`404.html`, `about/`, `education/`, `projects/` og `assets/`, inkludert originale
prosjektfiler, og legger `apps/study/dist/` i `publish/study/`. Dotfiler og
`node_modules` utelates; ukjente filtyper/utviklingsfiler og ugyldige Study-assetstier
stopper byggingen. Hovedfiler og Study-assets kontrolleres før upload.
Kun `publish/` lastes opp som én Pages-artifact, aldri hele repoet. Kildekode,
workflows, scripts og README publiseres ikke. `publish/` ignoreres av Git og den
statiske HTML-validatoren; React-bygget kontrolleres av TypeScript/Vite og
publiseringsscriptet.

## Vedlikehold

- Aktive fag i sidebaren defineres i `assets/js/site.js`.
- Globalt søk bruker `assets/data/search-index.json`; oppdater URL-er og ankere når innhold endres.
- Global stil ligger i `assets/css/site.css`.
- Seksjonsstil ligger i `assets/css/about.css`, `projects.css` og `education.css`.
- IDATT2202 har `assets/css/idatt2202.css` og `assets/js/idatt2202.js`.
- Nye sider bør ha unik beskrivelse, canonical URL og riktig relativ favicon-lenke.
