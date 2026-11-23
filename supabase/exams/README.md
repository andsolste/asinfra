# Eksamensmotor

Frontend ligger isolert i `andsolste/asinfra-study/src/exams/`, på Flow-adressen
`/?app=exams`. Den gjenbruker eksisterende Supabase Auth. Denne katalogen og
migrasjonen eies av canonical backend i `andsolste/asinfra`.

## Innhold og tilgang

`exam_private` inneholder versjonerte eksamener, oppgavetekst, separate svarnøkler,
private PNG-figurer og en tilgangsliste per eksamen/versjon/bruker. Verken `anon`
eller `authenticated` har tilgang til skjemaet. Det skal ikke eksponeres i
Supabase API-innstillingene. Ingen Storage-bucket eller offentlig asset-URL brukes.

`public.exam_attempts` og `public.exam_responses` har RLS med `auth.uid()` og
SELECT for eier. Direkte writes er sperret. De åtte `public.exam_*`-RPC-ene er
`SECURITY DEFINER` med tom `search_path`, sperret for PUBLIC/anon og med eksplisitt
kontroll av innlogging, eier og innholdstilgang. Denne avgrensede definer-modellen
trengs fordi vanlig klienttilgang til svarnøklene ville avsløre fasiten.

Vanlige lesekall returnerer aldri nøkler eller sensorbilder. Prompt-RPC-en kan
bare levere figurer merket `prompt`. Sensorveiledning krever at oppgaven er låst
i underveis-modus, eller at hele forsøket er levert i sluttmodus. Klienten kan
ikke velge seg ut av denne regelen. Egenvurdering er bare tilgjengelig etter låsing.

En eksamensversjon kan ikke overskrives med en annen pakke. Nye innholdsrettelser
skal få nytt versjonsnummer slik at gamle besvarelser fortsatt kan forstås.
Svar lagres med revisjon og request-UUID. Skriving serialiseres per forsøk;
stale svar avvises, og gjentakelse av samme request er idempotent. Ingen Flow-
tabeller, timerfunksjoner eller eksisterende data endres av migrasjonen.

## Privat import

Oppgaver/PDF/figurer/fasit skal **ikke** committes eller legges i Pages-artifacten.
`supabase/private/` er Git-ignorert. Den lokale DCST2001-pakken finnes der som
`exams/dcst2001-h25-v1.json`; ta en privat sikkerhetskopi før maskinen ryddes.
Den følger ikke med en kloning av repoet eller disse PR-ene.

Pakken inneholder `exam`, `questions`, `assets` og `package_sha256`. Hver oppgave
har nummer, original tittel/maks poeng/kildesider, `prompt.blocks` og `fields`,
separat `correct`/`guide_assets`, og `grading`/kontrollstatus. Blokker er ren
tekst, feltreferanser eller private figurer; rå HTML kjøres aldri. Felttyper er
`single`, `multiple`, `select` og `text`. PNG-er lagres som base64 i privat skjema
(maks 4 MB base64 per bilde). Versjon 1 har 53 bilder/utsnitt og en pakke på ca. 6,5 MB.

Kontroller en ny pakke lokalt, og generer deretter en privat SQL-transaksjon:

```sh
node supabase/scripts/verify-exam-import.mjs supabase/private/exams/dcst2001-h25-v1.json
node supabase/scripts/prepare-exam-import.mjs supabase/private/exams/dcst2001-h25-v1.json supabase/private/exams/dcst2001-h25-v1.sql USER_UUID
```

Kontrollscriptet kjører alle canonical migrasjoner og importen i en midlertidig
lokal PostgreSQL/PGlite, uten hosted tilkobling. Det kontrollerer prompt-data,
figurer, retting og fasitporten for samtlige oppgaver. Importscriptet verifiserer
pakkehash, metadata, felt/valg, figurers formål og at uverifiserte oppgaver ikke
har en gjettet nøkkel. Det genererer bare SQL; det deployer aldri.

Utdatafilen inneholder beskyttet materiale og må også holdes privat. `USER_UUID`
er brukerens eksisterende `auth.users.id`, aldri en ny Auth-konto. Uten argumentet
importeres innhold uten å gi noen konto tilgang. Flere godkjente brukere kan få
tilgang ved et administrativt INSERT i `exam_private.access`. Fjerning av en slik
rad stopper nye innholdslesninger, men sletter ikke besvarelsene. Tilgang er ikke
automatisk gitt til alle som registrerer seg.

## Godkjenning og deploymentrekkefølge

Ingen hosted migrasjon, innholdsimport eller frontend-deployment er utført som
del av implementeringen. Etter PR-gjennomgang og eksplisitt godkjenning:

1. Avklar rettigheter til bruk/videreformidling og hvem som skal ha tilgang.
2. Kontroller canonical prosjekt `ssrimgvzsdlukesrnzfa` og migrasjonshistorikk.
   Kjør `supabase db push --linked --dry-run --skip-vault` og kontroller omfanget
   før en separat godkjent faktisk migrasjon.
3. Importer den kontrollerte private SQL-filen med en privilegert databaseklient
   i én transaksjon med stopp ved SQL-feil. Bruk eksisterende sikker tilkobling;
   aldri service-role/DB-passord i frontend eller Git. Scriptet kjører ikke dette.
4. Bekreft grants/RLS, brukerens tilgang og låsing/fasit med innlogget testkonto.
5. Merge/publiser frontend separat etter godkjenning. Gjenta login, lagring,
   reload, innlevering og fasitvisning mot hosted miljø.

## Poeng og kvalitet

Automatisk retting gir full original poengsum når alle felter og hele valgsettet
er riktig, ellers 0. Det trekkes ikke under 0. Dette er uttrykkelig en forenklet
øvingsregel; PDF-en dokumenterer ikke en eksakt offisiell delpoeng-/trekkformel.
Langsvar og uverifiserte oppgaver egenvurderes full/halv/ingen eller ikke vurdert.
Automatiske poeng, egenvurderte poeng og ubesvarte/ikke-vurderte vises separat.
Ingen samlet prosent eller AI-sensur presenteres.

Se [kontrolloversikten for alle 41 oppføringer](dcst2001-h25-audit.md). Oppgave 41
venter på faglig bekreftelse. Komplekse koblinger bruker nedtrekk. Sensorveiledning
vises som originale kildebelagte utsnitt, ikke AI-forklaringer. Utsnittene har
ingen full tekstalternativ for skjermleser ennå; ren tekst-transkripsjon av disse
er en mulig senere tilgjengelighetsforbedring.

Regresjonstester bruker bare syntetisk materiale i `supabase/tests/exams.test.mjs`.
Kjør `npm ci && npm test` i `supabase/`, samt eksisterende statisk validator/build.
