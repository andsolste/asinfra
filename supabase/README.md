# Canonical backend: Study og Flow

Config, migrations og databasetester eies av `andsolste/asinfra/supabase`.
Frontenden eies av `andsolste/asinfra-study` og kjører på `https://flow.asinfra.no/`.
Domeneflyttingen ble gjennomført og manuelt verifisert 20. oktober 2026 uten
backend-, data- eller brukermigrasjon. Det brukes samme Supabase-prosjekt og Auth-
brukere; RLS og `auth.uid()` er fortsatt eierskapsgrensen.
Supabase Site URL er Flow. Study og localhost/preview kan fortsatt være tillatte
Redirect URLs. `study.asinfra.no` eies kun av `andsolste/asinfra-study-redirect`;
både den adressen og `asinfra.no/study/` videresender til Flow.

## Flow-fundamentet (#10)

Fundamentet er etablert og deployet med `20261012180000_create_flow_foundation.sql`.
De tre eksisterende Study-migrasjonene og de fem `study_session_*`-RPC-ene
endres ikke. Pages/CI deployer aldri databaseschema.

## Native tidtaker og cutover (#11)

`20261013090000_activate_flow_workday.sql` er deployet og legger til orkestrering og vern, uten
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

#13 kombinerer to tydelige kilder: `legacy-study` med eksisterende segmenter,
og `flow` med native segmenter. Kilde + segment-ID er identitet; en kopiert area
er metadata, ikke kopiert arbeid. Legacy null-område kan bety slettet fag;
originalt navn er ikke kjent. Den eksplisitte 04:00-visningspolicyen nedenfor
endrer ikke gamle data eller gamle klienters API-er.

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

## Oppgaver og frister (#12)

Ny additiv migration: `20261013120000_add_flow_tasks.sql`. Deployede foundation-
og workday-migrations endres ikke. `updated_at` backfilles fra eksisterende
completed/created-tid; nye tidspunkter styres av serveren. En ekte endring av
tittel/beskrivelse/område/frist/status øker versjonen, en no-op gjør ikke det.
Klientens `created_at` ved INSERT og `updated_at`/`completed_at` ignoreres;
identitet/eier/creation time er immutable etter INSERT.

Anbefalte, `SECURITY INVOKER`-RPC-er med tom `search_path`, kun authenticated:

- `flow_task_save(id, title, description, area, deadline, expected_updated_at)`:
  null expected = create med UUID-retrytoken; gjentatt create endrer aldri raden.
  Edit krever radens opprinnelige serverversjon; stale form avvises med `40001`.
- `flow_task_status(id, active|completed, expected_updated_at)`: ønsket status
  som allerede er satt er en no-op. Stale fullføring etter gjenåpning avvises.
- `flow_task_time(id)`: `task_id`, `work_milliseconds`, `server_time`; summerer
  bare egne native task-ID-segmenter. Åpent arbeid klippes til server now/cutoff.
  Ingen legacy navne-/beskrivelsesmatching eller full historikkoverføring.

Writes tar samme advisory brukerlås (seed 9) før row locks. Triggers beskytter
også direkte Data API-writes: cutoff reconciles; fullføring lukker eventuell
åpen task-periode og setter `completed_at` på kontrollert servertid i samme
transaksjon. Dagen blir pauset, ingen neste aktivitet starter. Reopen nuller
completed time. Flytting av område mens en task har åpen periode avvises;
endring av tekst/frist er tillatt. Historisk segment-attribution omskrives ikke.
Nye/moved tasks kan bare bruke egne aktive områder; eksisterende arkivert område
kan beholdes ved tekstredigering. Nye åpne segmenter må alltid ha active task
med samsvarende area, også ved direkte writes.

Bruk RPC-ene for fast låserekkefølge. Konkurrerende direkte row-writes kan få
en PostgreSQL deadlock/serialization-feil og rulles da helt tilbake; klienten må
hente status før retry. Ingen timer/task-endring antas lagret ved usikkert svar.

Migrationen stopper for review hvis pre-eksisterende åpne segmenter peker på
completed task eller har avvikende task-area. Den gjetter ikke tidligere
fullføringstid eller omskriver historikk. Kontroller dette ved dry-run/review.
Ingen hosted migration kjøres av frontend/Pages.

`tests/flow-tasks.test.mjs` kjører hele migrationkjeden i isolert PostgreSQL og
kontrollerer to eiere, direkte writes, retry/stale form, fullføring/pause/reopen,
områdeflytting/arkivering, cutoff og total task-tid over flere dager. Frontend-
deadline-input bruker browserens lokale tid, med eksisterende DST-validering;
backend mottar absolutt `timestamptz`, uavhengig av arbeidsdagens 04:00.

## Samlet historikk og statistikk (#13)

Deployet migration: `20261019090000_add_flow_history_statistics.sql`.
Ingen gamle migrations, timer-/task-kontrakter,
tabellrader, timestamps eller cutover-markører omskrives.

### Leselag og skalering

`flow_read_segments` er en `security_invoker`-view med `UNION ALL` av de to
fysiske kildene. Tabellgrants og RLS gjelder fortsatt; alle join har eierkontroll
med `auth.uid()`. Native area/task hentes fra segmentet, legacy area fra sessionens
subject-ID, aldri fra oppgavens nåværende område eller beskrivelsesmatching.
Eksisterende area-backfill gir felles ID-er. NULL = Annet, med dagens metadata.

- `flow_history(limit=25, cursor=NULL)`: én sortert UNION av ferdige legacy-økter
  og avsluttede/utløpte native dager. Global keyset på
  `(started_at DESC, source DESC, id DESC)`, `limit+1` for neste side. Markøren
  beholder database-timestampets mikrosekunder; ikke konverter den gjennom JS Date.
  Eier/start/id-indekser på begge kilder støtter oppslag. Underliggende segmenter
  følger bare postene på siden. Dagens uavsluttede dag forblir i timerpanelet.
- `flow_statistics(kind, date?, timezone?, area_id?, area_only=false, task_id?)`:
  serveraggregater for day/week/month/total, daglige area-summer og area/task-bidrag.
  Perioder filtreres før aggregering; lifetime skanner egne segmenter på serveren,
  ikke store råhistorikk-sider til browseren. `total` returnerer ingen dagsserie.
- `flow_area_statistics(area_id=NULL, timezone?)`: day/week/month/total fra samme
  snapshot/klokke, inkludert Annet og tidligere arbeid uten oppgave. Dersom ingen
  periode kan bestemmes uten gyldig sone, er periodefelt NULL, men Totalt beholdes.
- Task-filter i `flow_statistics` gir `task_date`, `task_today` og `task_current`
  fra lagret aktuell Flow-dato. Legacy bidrar aldri til en task. Den eldre
  `flow_task_time` beholdes uendret for kompatibilitet.

Reads er `STABLE`, `SECURITY INVOKER`, med tom `search_path`, eksplisitt auth-sjekk
og execute kun for authenticated. Én statement-snapshot og `statement_timestamp()`
brukes for alle delsummer, også de fire area-kallene. MVCC ser en atomisk
timertransition før eller etter commit, ikke en halvt lukket/åpnet kombinasjon.
Reads tar ikke langvarig advisory-lås som blokkerer timeren. Utløpt åpent arbeid
klippes til cutoff uten at lesingen skriver/reconciler dagen.

### Tid og datakorrekthet

Native segmenter grupperes på **lagret logical_date** og klippes til lagret cutoff
og samme serverklokke. Gjeldende dato bruker dagen som omfatter server now innenfor
sine fryste grenser, ikke browserens nye tidssone. Uke er mandag–søndag, måned er
kalendermåned. Kalenderdatoer må ikke beregnes med faste 24-timersintervaller.

Legacy har ingen historisk zone. Klienten velger eksplisitt en gyldig IANA-zone
(normalt browserens) for visning: hver dag er lokal 04:00 → neste lokale 04:00.
Segmenter splittes/klippes ved disse grensene. Dette er **ikke** en backfill eller
en påstand om original tidssone. Hver grense konverteres separat ved DST; en dag
kan være 23/25 timer. Ugyldig/manglende sone eller ikke-eksisterende 04:00 returneres
som `legacy_timezone_error`, aldri en gjettet standard. Native data er fortsatt
tilgjengelige; Totalt trenger ingen tidssone eller vilkårlig dato.

Bare positive faktiske segmentintervaller telles. Åpne perioder klippes til server
now/cutoff (og legacy parent-end/cutover), uten fremtidig arbeid. Pauser og
session-envelope telles ikke. Presisjon beholdes frem til frontendens visning.
Ingen union-rad kopieres mellom kilder; områdemetadata lager aldri dobbelt arbeid.

### Korreksjon og kompatibilitet

`flow_history_attribute(segment, area, task, expected_area, expected_task)` endrer
bare område/oppgave på et lukket segment i en avsluttet dag. Brukerlås seed 9 og
forventet opprinnelig tilknytning beskytter stale skjemaer. Identisk ønsket verdi
er idempotent. Eksisterende guards håndhever egne area/task og sammenheng mellom
dem, også arkiverte områder/fullførte oppgaver for historisk korreksjon. Ingen
native start, slutt, logisk dato, zone, boundary eller cutoff kan redigeres her;
native sletting/reåpning tilbys ikke. RPC-en beholdes for kompatibilitet; den nye
samlede periodeeditoren bruker #34C-kontrakten nedenfor.

`flow_history_edit_legacy` bruker den eksisterende atomiske editoren, men avviser
i tillegg overlapp med andre positive legacy-/native perioder. Feil ruller tilbake
både session og segmentutskifting. `study_session_history_delete` brukes uendret.
Alle gamle read/write-RPC-er og RLS-policyer beholdes slik at deploy av backend
ikke krever samtidig frontendbytte. Ny frontend må derimot vente på denne migrationen.

### Test og deploy

`tests/flow-history-statistics.test.mjs` kjører hele canonical migrationkjeden med
to brukere: legacy-only/native-only/begge, NULL/slettet område, flyttet/fullført
task, åpne/cutoff-segmenter, 03:59:59/04:00, DST i UTC/Oslo/New York, måned/år/skuddår,
mer enn 1100 legacy-segmenter og flere blandede cursorsider, korreksjoner/rollback,
grants/invoker/RLS og gamle kontrakter. Frontend tester mapper, stale responses,
periode-/areakansellering og usikker write-recovery separat. Testdatabasen stubber
Auth og serverklokken; dette er ikke hosted JWT- eller flerforbindelsesverifisering.

Rekkefølge: review begge PR-er → merge backend → kontroller project-ref og
`supabase migration list` → `supabase db push --dry-run` → særskilt godkjent
`supabase db push` → smoke-test gammel Flow/timer/tasks/RLS → merge frontend →
test samlet historikk/statistikk. Før produksjon: ekte JWT/Data API med to
testbrukere og flere DB-forbindelser mens en annen fane bytter/pause/fullfører;
kontroller ingen dobbeltelling, snapshots, stale korreksjon og cutoff/DST.
Se frontend README for UI-/feil-/mobilpunkter. Ingen hosted push/merge, DNS/Auth-
endring eller lukking av #13 utføres her. #13 er nå deployet; eksport følger som
separat fase nedenfor. Domeneflyttingen i #14 ble gjennomført 20. oktober 2026
uten schemaendring; se frontendens historiske runbook og rollback.

## Lokal eksport (#7)

Ny additiv migration: `20261019140000_add_flow_export.sql`. **Ikke deployet**
av denne PR-en. Eksisterende RPC-kontrakter og migrations endres ikke. Frontend
og CSV-/rapportpresentasjon eies fortsatt bare av `andsolste/asinfra-study`.

### API og tidssemantikk

- `flow_export_start(p_kind='week', p_date=null, p_timezone=null)` oppretter et
  serverstyrt manifest og returnerer første 500 rader samt canonical statistikk.
  Alle fire perioder støttes. Dato/zone/kind er valg, aldri klientens user_id/now/cutoff.
- `flow_export_rows(p_cursor, p_limit=500)` tar kun markør `{job: UUID, after: heltall}`,
  med limit 1–1000. Respons: `job_id`, `period`, `server_time`, `expires_at`,
  `total_rows`, `rows`, `next_cursor`. Startresponsen inkluderer også `statistics`.
  Hver rad har sammenhengende `ordinal`; siste side har null neste markør.
- `flow_export_discard(p_job_id)` sletter bare eget manifest. Frontend forsøker
  dette ved ferdig eksport, feil og avbrudd. Ingen CSV eller rådatafil lagres her.

`flow_read_segments` er råkilden. `flow_statistics` bestemmer periodegrenser og
starttotal; `flow_day_bounds` beregner 04:00/DST. Native bruker lagret logical date,
zone, cutoff og segmentets område/task. Legacy klippes til perioden og deles til
positive dagslices ved canonical grenser. Kalendergrenser caches per dato i hvert
kall, ikke beregnes på nytt for hvert segment. Ingen JS-splitting, N+1-oppslag,
pausearbeid, task-matching eller kopiering/migrering av historiske data.

Radene inkluderer source, segment_id, flow_date, timezone, absolutte UTC
started_at/ended_at, eksakte `work_microseconds` som heltallstekst, område/kode/
arkivstatus, task/tittel/status/frist og beskrivelse. Interne ID-er brukes bare til
runtime-validering/deduplisering; frontend utelater dem fra CSV/rapport.
Navn/status/frist/beskrivelse er nåværende tilgjengelige metadata. Områdetilknytning
er historisk fra segmentet. Arkiverte områder og fullførte tasks filtreres ikke bort.

CSV krever gyldig eksplisitt IANA-displayzone også for Totalt, fordi legacy trenger
en logical date. Totalsummen er fortsatt tidssoneuavhengig. Urepresenterbare
kalendergrenser avvises, ikke gjettes. Rapport bruker `flow_statistics` direkte,
ikke rå eksportrows. Alle eksportfunksjoner serialiserer timestamps i UTC slik
at endret DB-session-timezone mellom sider ikke gir falsk digest-endring.

### Konsistens, kostnad og sikkerhet

`flow_export_jobs` lagrer bare eget immutable manifest: servergenerert ID, eier,
periode/displayzone, serverreferanse, 30-minutters utløp, radantall, varighet,
digest og aggregert statistikk. BEFORE INSERT-triggeren overskriver alle avledede
felt, inkludert ID/eier/tid, også ved direkte Data API-insert. Ingen authenticated
UPDATE er tillatt. RLS begrenser SELECT/INSERT/DELETE til `auth.uid()`.

Hver side leser radsett/digest fra samme MVCC-statement og sammenligner med
manifestet. Åpent arbeid fryses ved serverreferansen; senere vanlig timervekst,
pause/bytte legger ikke til arbeid før denne referansen. Korreksjon, sletting og
metadataendring gir `40001`: klienten avbryter og starter på nytt, uten delvis fil.
Dette er **ikke** en langvarig transaksjon eller bevart historisk MVCC-snapshot.
Den bundne ordinalmarkøren er stabil bare fordi endret radsett avvises, ikke en
skjør offset over levende data. Ingen langvarig bruker-advisory-lock tas.

Digest (MD5 som endringsdetektor, ikke autentiseringstoken) beregnes over alle
ordnede eksportrows for hver side. Det koster O(N) lesing per side og midlertidig
serverminne; svært store eksporter bør måles i testmiljø før produksjon. Manifest
varer 30 minutter og avvises etter dette. Egne utløpte manifester slettes ved neste
eksportstart; best-effort discard rydder normalt straks. Ingen global cron/TTL-
delete er lagt til: dersom klienten forsvinner og aldri eksporterer igjen, kan et
inaktivt manifest bli liggende til administrativ opprydding eller brukersletting.
Det inneholder aggregert brukermetadata under RLS, ikke CSV/rårows. Vurder senere
serverstyrt periodisk sletting hvis faktisk volum tilsier det.

`flow_private.export_slices` og insert-triggeren er interne, utenfor Data API-ens
eksponerte `public` schema. Ikke legg `flow_private` til exposed schemas.
Nye offentlige RPC-er er `SECURITY INVOKER`, har tom search_path, eksplisitt
execute bare til authenticated og kontrollerer `auth.uid()`. RLS for alle kilder
beholdes; andre brukeres jobb-ID-er gir ikke tilgang. Ny indeks er
`flow_export_jobs_owner_expiry(user_id,expires_at)`; eksisterende segmentindekser
gjenbrukes. Ingen service-role eller nye frontendhemmeligheter.

### Tester og utrulling

`tests/flow-export.test.mjs` kjører hele migrationkjeden med perioder/summer mot
`flow_statistics`, native/legacy/Annet/arkivert/fullført, åpne segmenter,
03:59:59/04:00, uke/måned/år/skuddår, 23/25-timers DST i Oslo/New York, over 1100
rader, ties/mikrosekunder, tre sider, session-timezonebytte, frozen reference,
metadataendring/korreksjon/sletting, serveroverstyrte manifestfelt, utløp/discard og
to brukeres RLS/grants. PGlite stubber Auth og serverklokke; ekte JWT/Data API og
flerforbindelses-concurrency må fortsatt smoke-testes separat i lokal/test-Supabase.

Rekkefølge: review backend → merge backend → kontroller project-ref og
`supabase migration list` → `supabase db push --dry-run` → særskilt godkjent
`supabase db push` → smoke-test eksisterende Flow med gammel frontend → merge
frontend → frontend README sin konkrete 24-punkts eksportkontroll (CSV-import,
rapporter, A4/Letter/PDF, mobil, store eksporter, feil/avbrudd og to testbrukere).
Ingen merge, hosted migration eller lukking av #7 er utført. #19 offentlig Flow,
#14 domeneovergang, deling og cloud upload er ikke en del av eksporten.

## Native periodekorreksjon (#34C)

Ny additiv migration: `20261022170000_add_flow_segment_correction.sql`.
Ingen gamle migrations, tabeller eller data endres ved installasjon.

`flow_work_segment_correct` tar segment-ID, work-day-ID og to separate sett med
`started_at`, `ended_at`, `area_id`, `task_id`: `p_expected_*` og nye `p_*`.
Responsen er et canonical `flow_work_day_snapshot` for samme dag. Funksjonen
krever `auth.uid()`, bruker advisory brukerlås seed 9 og eierbegrenset radlås,
`SECURITY INVOKER`, tom `search_path` og execute kun for `authenticated`.

Cutoff avstemmes **før** expected-state-sammenligning. Alle fire originalverdier
sammenlignes NULL-sikkert. Endret periode gir `40001`, utilgjengelig/feil eier
`42501`. Hvis nøyaktig ønsket tilstand allerede finnes, bekreftes den uten ny
write (trygg gjentakelse etter mistet svar); andre endringer rebases aldri.
Ved exception rulles hele kallet tilbake, også eventuell cutoff-avstemming;
en etterfølgende fersk snapshot-lesing avstemmer før nytt eksplisitt forsøk.

Start/slutt må være finite og ikke-null; start må ligge fra dagstart til før
cutoff, slutt fra start til min(cutoff, lagret dagslutt), aldri etter servernåtid.
Lik start/slutt gir 0 min uten DELETE. Dagens identitet, logiske dato, tidssone,
boundary, cutoff og start er urørt. Canonical tabelltriggere er fortsatt siste
forsvar mot overlapp, ugyldig attribution og legacy-cutover; kjente overlap-feil
oversettes til `23P01`, attribution til `23503`, tidsgrenser til `22023/22008`.
Uendret historisk attribution beholdes selv etter flytting/arkivering/fullføring;
endret task må passe eget område. Ingen RLS-regler endres.

Et fortsatt åpent segment kan få en eksplisitt historisk slutt. Dagen forblir
pauset: ingen ny periode og ingen automatisk Fortsett. Et nytt segment i en annen
fane kan ikke treffes av den gamle identiteten. Gap/checkpoint fra frontend er
aldri autoritativ sluttid. `flow_history_attribute` beholdes kompatibel.

Historikk, statistikk, task-total og nye rapporter/eksporter bruker samme
oppdaterte segment; ingen korrigerte sidetotaler lagres. Et eksportmanifest fra
før korreksjonen må fortsatt avvises som endret grunnlag.

`tests/flow-segment-correction.test.mjs` kjører hele migrationkjeden med to eiere,
grants/auth/RLS, åpne/lukkede perioder, tidsgrenser/overlapp/0 min, alle expected-
felt, cutoff, endret aktivitet, retry, attribution, mikrosekunder og canonical
history/statistics/task/export. PGlite har stubbet Auth og klokke; dette erstatter
ikke ekte JWT/Data API eller flerforbindelses-smoke i test-Supabase.

Utrulling: review/merge backend → kontroller project-ref og migration list →
`supabase db push --dry-run` → særskilt godkjent `supabase db push` → smoke-test
RPC/RLS og gammel frontend → merge/deploy frontend. Ingen hosted migration kjøres
av denne PR-en eller Pages; frontend må vente til RPC-en er deployet.

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
den aktiverer ingen `flow_*`-API-er. Domene/Auth-flyttingen i #14 ble gjennomført
20. oktober 2026 og endret ikke backend eller data.
