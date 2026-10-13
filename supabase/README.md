# Canonical backend: Study og Flow

Config, migrations og databasetester eies av `andsolste/asinfra/supabase`.
Frontenden eies av `andsolste/asinfra-study`; produksjonsadressen er fortsatt
`https://study.asinfra.no/`. Det brukes samme Supabase-prosjekt og Auth-brukere.

## Flow-fundamentet (#10)

Fundamentet er etablert og deployet med `20261012180000_create_flow_foundation.sql`.
De tre eksisterende Study-migrasjonene og de fem `study_session_*`-RPC-ene
endres ikke. Pages/CI deployer aldri databaseschema.

## Native tidtaker og cutover (#11) – ny migration, ikke deployet av denne PR-en

`20261013090000_activate_flow_workday.sql` legger til orkestrering og vern, uten
å endre de gamle migration-filene eller kopiere historisk arbeid.

- `flow_work_state(timezone)` reconciler snapshot og gir server_time, aktiv dag,
  legacy_active og serverberegnet boundary/cutoff for neste eksplisitte start.
  Ugyldig/manglende browserzone gir null startgrenser, men en allerede startet
  dags fryste zone kan fortsatt gjenopprettes. Lesing oppretter aldri en dag.
- `flow_work_day_start(day_id, segment_id, timezone, expected_boundary_at, area_id?, task_id?)`
  låser bruker (seed 9), bruker serverklokken, avslutter eventuell åpen legacy-periode
  og session, oppretter dag + første native segment på samme tidspunkt, og setter
  varig `flow_timer_cutovers`-markør. Pauset legacy-gap fylles ikke med arbeid.
  Invalid aktivitet/FK/zone ruller tilbake ALT, også legacy close og markør.
- `flow_work_activity(day_id, expected_open_id, expected_segment_count, next_id, area_id?, task_id?)`
  bygger på foundationens atomiske switch. Count-versjonen beskytter også et gammelt
  resume når en annen fane har arbeidet og pauset igjen (open ID er null begge ganger).

Day/segment UUID-er er retry-tokens. En forsinket start returnerer eksisterende
status, aldri nytt arbeid; samme token kan ikke gjenopplive en avsluttet dag.
Expected boundary gjør at en aldri-committet start fra før 04:00 ikke begynner
å arbeide etter grensen ved retry. Stale idle-start på en aktiv dag bytter heller
ikke aktivitet. Ny aktivitet etter cutoff krever ny, eksplisitt brukerhandling.

Cutover-markøren har egen RLS, own select/insert og ingen update/delete for vanlige
brukere. Insert-triggeren henter tidspunkt fra faktisk native dag, ikke klientens
markørtimestamp; markør uten native dag avvises. En etterfølgende admin-sletting av
en native dag fjerner ikke markøren. En utsatt insert-constraint krever første
segment på dag-start i samme transaksjon: direkte Data API kan ikke committe en
tom/halvlagret dag eller aktivere cutover uten arbeid. Eksisterende foundation-dager
uten første aktivitet avvises for review ved migration, ikke fylles med oppdiktet arbeid.
Auth-brukersletting cascader egne data.

Før markør finnes fungerer gammel Study-timer som før. Etter markør blokkerer
row guards gamle RPC-er OG direkte writes som starter/gjenåpner legacy arbeid
eller forlenger det etter cutover. Historikk/read/edit/delete beholdes; en legacy
korreksjon må slutte ved eller før cutover, aldri inn i native tid. Native writes
kan ikke begynne før cutover eller mens uavsluttet legacy session finnes.
Gamle RPC-definisjoner er uendret. En gammel resume mot ferdig session returnerer
bare dens ferdige snapshot og registrerer ikke nytt arbeid.

Migrasjonen låser timer-tabellenes writes mens guardene installeres (reads tillates).
Hvis foundation-data allerede har både native dag og uavsluttet legacy session,
avbrytes migrasjonen for review, ikke en gjettet truncation. Legacy-arbeid etter
en allerede eksisterende native start krever også review. Native
segmenter kan heller ikke overlappe lukkede legacy-perioder ved direkte inserts/updates.
Future-dated legacy
arbeid avviser første native start og må korrigeres via legacy historikk før cutover.
Områdeeditoren fortsetter å skrive kun subjects via broen; ingen dual-editor handoff
gjøres i #11. Parallelle native/legacy timers kan ikke brukes som rollback etter cutover.

Cutoff/recovery bruker fortsatt foundationens server-snapshot. Ingen browser-timeout
er sikkerhetsgrensen. Ingen Start/Stop-dag-UI, task CRUD eller native historikk/statistikk
innføres i backend-PR-en. De er henholdsvis #12/#13; eksport #7, domene #14.

Review/deploy: review backend → merge → kontroller project-ref og migration list →
dry-run → godkjent push → verifiser gammel app før første cutover → merge/deploy
frontend → smoke-test native start/pause/resume/bytte/cutoff og gamle faner.
Se frontend README for 18 konkrete smoke-testpunkter. Ingen hosted push, Auth/DNS-
endring eller merge er utført. JWT/Data API og ekte flerforbindelses-concurrency
må også kontrolleres i lokal/test-Supabase før produksjonsaktivering.

| Tabell | Formål |
| --- | --- |
| `flow_areas` | Langsiktige, bruker-eide områder med valgfri kode og arkivstatus |
| `flow_tasks` | Oppgave med tittel, beskrivelse, valgfritt område/fristtidspunkt og active/completed-status |
| `flow_work_days` | Én logisk arbeidsdag med lagret dato, IANA-tidssone og absolutte grenser |
| `flow_work_segments` | Faktisk arbeid med valgfritt område/oppgave, knyttet til én arbeidsdag |

`deadline_at` er et valgfritt absolutt tidspunkt, ikke en antatt lokal dato.
Oppgaver har ingen prioritet, gjentakelser, tags eller estimater i dette fundamentet.
`area_id = NULL` betyr **Annet**, også for en oppgave uten område. Det opprettes
ingen syntetisk Annet-rad. Total arbeidstid er summen av segmentenes varighet;
gap mellom segmenter er pauser, ikke arbeid. Null-område telles i totalen,
men aldri under et navngitt område.

### Kompatibilitet og eierskap til områder

Eksisterende `subjects` kopieres én gang til `flow_areas`, med identiske ID-er,
`user_id`, navn, kode, arkivstatus og `created_at`. UUID-ene kan senere brukes
til felles områdegruppering av legacy- og native data uten navnematching.

Backfill og triggerinstallasjon skjer i én transaksjon med `SHARE ROW EXCLUSIVE`
på `subjects`. Samtidige fag-writes venter kort mens reads fortsatt er tilgjengelige;
ingen oppretting/endring/sletting kan falle mellom kopieringen og broen. Vurder
låsens ventetid og backfill-størrelse ved migrasjonsreview.

En **enveis** invoker-trigger speiler senere INSERT/UPDATE fra `subjects` til
`flow_areas`. Legacy DELETE arkiverer den native kopien, den sletter ikke arbeid.
Dermed fortsetter dagens frontend å fungere og nye fag blir ikke glemt etter
backfill. Nye native områder kopieres ikke tilbake til `subjects`.

I fase #10 er `subjects` skrivekilden for kopierte områder. Ikke aktiver parallelle
områdeeditorer over begge tabeller: en senere legacy-redigering vil speiles over
den native kopien. Senere native områdeeditor må ha en eksplisitt, reviewet handoff
før native UI aktiveres (inkludert strategi for gamle, åpne frontendfaner).
Timer-cutover håndteres i #11 av start-RPC + varig markør; ingen dobbeltskriver aktiveres.
Behold bridge/legacy-lesing til denne overgangen er verifisert; ikke fjern den
bare fordi frontenden har fått navnet Flow.

### Historiske Study-data

`study_sessions` og `study_session_segments` beholdes urørt, med eksisterende
ID-er, eierskap, segmenter og RPC-kontrakter. Ingen historisk arbeidstid kopieres
til Flow-tabellene. Manglende tidssone kan ikke rekonstrueres tapsfritt; vi
oppfinner derfor ingen historiske 04:00-dager eller norsk tidssone.

#13 skal kombinere to tydelige kilder: `legacy-study` med eksisterende segmenter,
og `flow` med native segmenter. Bruk kilde + segment-ID som identitet og summer
hver arbeidspost én gang; en kopiert area er metadata, ikke kopiert arbeid.
Legacy kalenderstatistikk beholdes i mellomtiden. Eventuell senere omgruppering
av gammel historikk trenger en eksplisitt bruker-/tidssonepolicy, ikke en backfill
som gjetter. Legacy null-område kan bety slettet fag; originalt navn er ikke kjent.

## Logisk dag og recovery

En dag er `[04:00 lokal tid, neste lokale 04:00)` i sin **lagrede** IANA-tidssone.
Tirsdag 01:30 hører til mandag. `flow_day_bounds(at, timezone)` beregner grensene
i PostgreSQL. INSERT-triggeren erstatter klientens dato/boundary/cutoff med disse
verdiene. Begge 04:00-tidspunktene konverteres separat; DST gir f.eks. 23/25 timer,
ikke nødvendigvis 24. Tidssone, start og grenser fryses etter opprettelse, også
om nettleseren senere skifter sone. Ingen `Europe/Oslo`-standard antas.

Databasen aksepterer navngitte soner fra IANA-registeret (eller `UTC`), ikke
rå offset/POSIX-strenger. En ikke-eksisterende 04:00 eller helt hoppet lokal dato
avvises tydelig. Ved sjelden gjentatt 04:00 brukes PostgreSQLs etter-overgangen-
offset; ingen egen DST-tabell vedlikeholdes i appen.
Se [PostgreSQLs tidsomstillingregler](https://www.postgresql.org/docs/current/datetime-invalid-input.html).

`flow_work_day_snapshot(work_day_id = NULL)` låser brukeren, bruker **serverklokken**
og lukker en utløpt aktiv dags åpne segment nøyaktig ved `cutoff_at`, før dagen
avsluttes. Ferdige segmenter og pauser utvides ikke. Uten ID returneres aktiv dag
eller `null`; med egen ID returneres også avsluttet dag. Responsen har `work_day`,
alle `segments` og `server_time`. En annen brukers dag returneres aldri.

En utløpt rad kan fortsatt ha `ended_at = NULL` frem til neste snapshot/transition;
det betyr **ikke** arbeid etter cutoff. Åpen varighet må alltid klippes til lagret
cutoff ved fremtidig lesing/statistikk. Ingen cron eller browser-timeout kreves
for korrekt recovery; #11-frontenden henter serverstatus ved cutoff og recovery.

Én aktiv dag per bruker og én rad per bruker/logisk dato er tillatt. Reisen til
en annen sone endrer ikke en startet dag; heller ikke en avsluttet dag gjenåpnes.
Native start i #11 følger denne policyen og bruker snapshot før ny dag opprettes.
En avsluttet logisk dato kan ikke gjenåpnes ved tidssonereise. Ingen manuell Stopp-dag
tilbys i #11; pauser beholder dagen til cutoff.

## Atomiske arbeidsperioder

`flow_work_segment_switch(work_day_id, expected_segment_id, next_segment_id,
area_id = NULL, task_id = NULL)` er et lite fundament for #11:

- Begge segment-ID-er: lukk forventet åpent segment + åpne neste på samme servertid.
- `next_segment_id = NULL`: pause (bare lukk).
- `expected_segment_id = NULL`: fortsett fra pause (bare åpne).
- Ny UUID er idempotency-token. Retry/stale expected-ID skal ikke lukke nyere arbeid.

RPC-en reconciler cutoff først, bruker transaksjon + samme advisory brukerlås
(seed 9) som Study, `SECURITY INVOKER`, tom `search_path` og eksplisitte grants.
Enhver feil i neste segment ruller også tilbake lukking av det gamle.
DB-triggerne deler låsen og håndhever halvåpne, ikke-overlappende intervaller,
segmentgrenser innenfor dagen, én åpen periode og samme eier. Dette gjelder også
direkte Data API-writes; låsene er transaksjonsbundne.

Område/oppgave valideres ved ny attribution. Segmentet lagrer sin egen area-ID:
senere flytting av oppgaven endrer ikke historiske segmenter. Arkivering og
fullføring beholder historikken, men blokkerer nye åpne perioder med den aktiviteten.
Navneendring viser dagens navn for samme stabile ID; det lagres ikke navnesnapshots.
Ordinary DELETE er ikke gitt på native tabeller. FK-er hindrer dangling områder/
oppgaver; sletting av selve Auth-brukeren cascader egne data.

## Sikkerhet, tester og review

Alle native tabeller har RLS via `auth.uid()`, select/insert/update for egen bruker,
ingen anon-/PUBLIC-tilgang og composite owner-FK-er. Klientens `user_id` gir ingen
rettighet til andre brukere. Triggerfunksjoner er ikke eksponerte RPC-er.

```sh
cd supabase
npm ci
npm test
```

`tests/flow-database.test.mjs` tester en utfylt gammel database før/etter migration,
enveis bridge, intakte legacy-RPC-er, Annet/oppgaver, constraints, to brukere,
historisk attribution, cutoff-recovery, retry/rollback og 04:00/DST i UTC,
Europe/Oslo og America/New_York. Hele den eksisterende testsuiten kjøres også.
PGlite bruker ekte PostgreSQL/WASM med stubbet managed Auth, uten hosted writes.
Dette erstatter ikke review eller en senere flerforbindelses-/ekte JWT/Data API-
kontroll i lokal/test-Supabase før produksjonsaktivering av #11.

Anbefalt rekkefølge: review begge PR-er → merge backend → kontroller project-ref
og `supabase db push --dry-run` → godkjent `db push` → verifiser eksisterende
frontend/RLS og kopierte områder → merge/deploy frontend. Disse hosted stegene
er **ikke kjørt** i #10. Frontend-rebrand kan også fungere uten ny migration:
den aktiverer ingen `flow_*`-API-er. Domene/Auth flyttes først i #14.
