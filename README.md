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
`.gitkeep`. Study har foreløpig bare et app-shell, ikke dashboardfunksjonalitet.

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
npm run dev
```

Åpne adressen Vite viser, normalt http://localhost:5173/study/.

```sh
npm run typecheck
npm run build
npm run preview
```

`build` kjører også typekontroll og lager `apps/study/dist/`.
`preview` viser produksjonsbygget lokalt, normalt på http://localhost:4173/study/.
Vite er konfigurert med `base: '/study/'`. Pages-deployen publiserer bygget på
[asinfra.no/study/](https://asinfra.no/study/), separat fra den statiske hovedsiden.
Ingen dashboard- eller backendfunksjoner er implementert.

Koden ligger i `src/App.tsx`, `src/main.tsx` og `src/styles.css`.
Mapper for komponenter, hooks, sider og andre ressurser opprettes når de trengs.
`node_modules/` og `dist/` holdes utenfor Git. Oppsettet har ingen egen linter;
TypeScript kjører i strict-modus med kontroll av ubrukte variabler og parametre.

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
