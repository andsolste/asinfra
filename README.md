# Andreas Sollie Steffensen – Personal Website

Personlig portfolio og profilside med prosjekter og fagoversikter fra NTNU.
Publisert på [GitHub Pages](https://andsolste.github.io/website/).

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
scripts/               Lettvekts kvalitetskontroll
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
Dette fungerer både under `/website/` og fra domeneroten.

404-siden har én eksplisitt `<base href="/website/">` som lar assets og lenker
fungere også på dype feiladresser. Ved senere publisering fra domeneroten skal
den settes til `/`; canonical/OG og domeneoppsett endres først i issue #4.
Gamle adresser til Om meg og Fag videresendes fra 404-siden til den nye strukturen,
med søkeparametre og ankere bevart. Gamle `#tidligere-fag`-bokmerker på fagoversikten
videresendes til `education/previous/`. Lokal standardserver bruker ikke 404-siden
automatisk; for lokal 404-testing ved domeneroten må base-path også være `/`.

## Study – lokal utvikling

Bruk Node.js 22.12 eller nyere, gjerne Node.js 24 LTS, og npm.
Appen har egen `package.json` og `package-lock.json`, uten workspaces.

```sh
cd apps/study
npm install
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
Vite er konfigurert med `base: '/study/'`, som er den framtidige offentlige URL-en.
Appen er ikke koblet til Pages-deployen ennå; dette hører til issue #6.
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
`--base-url https://example.test/website/` kan brukes for å kontrollere samme
stioppsett på et annet hostname, uten å endre nettstedets metadata.
Pull requests mot `main` valideres med `.github/workflows/validate-site.yml`.
`main` valideres og publiseres gjennom `.github/workflows/deploy-pages.yml`;
kontrollen kjøres før Pages-deploy.

## Vedlikehold

- Aktive fag i sidebaren defineres i `assets/js/site.js`.
- Globalt søk bruker `assets/data/search-index.json`; oppdater URL-er og ankere når innhold endres.
- Global stil ligger i `assets/css/site.css`.
- Seksjonsstil ligger i `assets/css/about.css`, `projects.css` og `education.css`.
- IDATT2202 har `assets/css/idatt2202.css` og `assets/js/idatt2202.js`.
- Nye sider bør ha unik beskrivelse, canonical URL og riktig relativ favicon-lenke.
