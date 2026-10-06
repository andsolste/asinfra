# Andreas Sollie Steffensen – Personal Website

Personlig portfolio og profilside med prosjekter og fagoversikter fra NTNU.
Publisert på [GitHub Pages](https://andsolste.github.io/website/).

## Teknologi og struktur

Statisk HTML, CSS og vanilla JavaScript. Ingen rammeverk eller build-system.

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
apps/                  Reservert for fremtidige apper
scripts/               Lettvekts kvalitetskontroll
index.html             Forside
404.html               Feilside med navigasjon
```

Tidligere fag presenteres på `education/previous/index.html` med lenker til NTNU.
Hovedoversikten viser aktive fag og lenker videre til tidligere fag; de enkelte
fullførte emnene har ikke egne interne sider. Tomme mapper beholdes i Git med
`.gitkeep`; ingen apper eller nye prosjekter er implementert.

## Lokal kjøring

HTML kan åpnes direkte, men globalt søk trenger en HTTP-server for å hente indeksen.
Kjør fra repositoryets rot:

```sh
python -m http.server
```

Åpne deretter http://localhost:8000/. Ordinære sider bruker relative lenker.
404-siden bruker publiserte `/website/`-stier for å fungere også på dype feiladresser.
Gamle adresser til Om meg og Fag videresendes fra 404-siden til den nye strukturen,
med søkeparametre og ankere bevart. Lokal standardserver bruker ikke denne 404-siden automatisk.

## Kontroll og publisering

```sh
python scripts/validate-site.py
```

Kontrollen bruker bare Python-standardbiblioteket og sjekker lokale lenker,
assets, søkeindeks, ankere og dupliserte HTML-ID-er.
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
