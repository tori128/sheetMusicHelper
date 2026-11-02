# System Test Design

[日本語](TESTING.md)

## Purpose and Scope

This design covers EarCopy Assist startup, input, model management, transcription, editing, playback, analysis, persistence, export, settings, shutdown, and distribution.
Release acceptance depends on evidence of user operations and their outputs.
The design is based on source inspection on 2026-09-06. Newly specified tests are identified as additions, separately from implemented and executed tests.
Record test existence, execution success, and system acceptance separately.

## Current Audit

| Area | Existing evidence | What it verifies | Missing integration |
|---|---|---|---|
| Startup and navigation | `app/src/App.test.tsx` | Terms acceptance and startup requests; API and new/editor screens are replaced | Project operations through real preload, embedded service, and navigation |
| UI, editing, playback | `app/src/components/EditorScreen.test.tsx`, `app/src/store/project-editing.test.ts` | State, editing calculations, events; Canvas and playback engines are replaced | Real Canvas hit testing, media events, PCM supply, SoundFont output, persistence |
| Transcription | `tests/test_jobs.py`, `app/src/services/transcription-controller.test.ts` | Jobs, cancellation, ordering, partial results; inference or API is replaced | Real HTTP/SSE with UI, real models, delayed responses during editing |
| API, audio, persistence | `tests/test_api.py`, `tests/test_audio.py`, `tests/test_project_io.py` | Partial integration with TestClient and files, PCM arrays, persistence round trips | TypeScript client against the real service, round trips of UI edits |
| Export and preview | `tests/test_midi_export.py`, `tests/test_musicxml_export.py`, `app/src/musicxml-preview.integration.test.ts` | Output formats and real OSMD loading | Editing, saving, reopening, and exporting the same data |
| Service and shutdown | `app/src/service-manager.test.ts`, `tests/test_service_main.py`, `app/scripts/smoke-shutdown.cjs` | Process doubles, real parent monitoring, real Electron shutdown with an unresponsive Renderer | Shutdown during transcription, saving, playback; restart; full embedded-service lifecycle |
| Distribution | `app/scripts/smoke-packaged.cjs`, `verifySmokeWindow` in `app/electron/main.ts` | Real startup, settings, tempo, local audio, SoundFont, MusicXML, drawing performance, shutdown | Complete editor operation sequences, real transcription, artifact round trips |
| CI | `.github/workflows/ci.yml`, `.github/workflows/windows-release.yml` | Python, Vitest, types, shutdown in regular CI; packaged smoke in release builds | Results and unexecuted counts by mandatory use-case ID, correspondence to candidate binaries |

Some integration tests already exist. The gap is integration across replaced dependencies and acceptance of consecutive operations across features.
Audio conversion tests can be skipped when FFmpeg is unavailable in regular CI. Exit code 0 and execution of every required test are separate facts.

## Sources of Expected Behavior

Use `AGENTS.md` and the [Development Guide](DEVELOPMENT.en.md) for regression requirements, and the [User Guide](../USER_GUIDE.en.md) for supported operations.
Each case identifies its requirement, input, operations, expected result, and observations. Known notes, samples, and files define expected results.

Specification conflict SPEC-01: `AGENTS.md` limits Mute during Solo to soloed transcription tracks in transcription mode.
The development and user guides allow soloed stems to be muted in every playback mode.
The affected UC-17 expectations await resolution. Completion requires a behavior decision and agreement between Japanese/English documentation and tests.
Other cases can be implemented and executed independently. An unresolved SPEC-01 means system acceptance remains incomplete.

## Test Layers and Test Double Boundaries

| Layer | Real components | Test doubles | Passing evidence | Current status |
|---|---|---|---|---|
| Unit | Editing calculations, quantization, routing, note processing, state transitions | External dependencies such as clocks and I/O | Independent expected values and boundaries | Retain existing tests |
| Service integration | Real HTTP/SSE, TypeScript API client, Python processing, files | Inference engine and the fault injection target | Responses, event ordering, persisted/exported files | Existing partial TestClient integration; add cross-language integration |
| UI integration | React screens, ProjectStore, editing/playback coordination | OS dialogs and controlled HTTP responses including delays/failures | UI and state after user operations | Partially existing; add feature-spanning sequences |
| Electron E2E | Real main, preload, Renderer, embedded Python, Canvas, AudioWorklet, SoundFont, files | Only inference in deterministic tests; file selection targets the test directory | Operation logs, UI, output audio, files, process exit | Existing startup/shutdown smoke; add sequences below |
| Real-model acceptance | Same E2E operations with MuScriptor and separation models | Real inference | Model SHA-256, note validity, completion, reopenable artifacts | Existing model smoke; add full operation sequences |
| Distribution acceptance | Candidate extracted on Windows 10/11 | Real OS files and output devices | Candidate SHA-256 and results from that candidate | Existing checklist; add case-specific evidence |

E2E operations use displayed controls, keyboard input, and Canvas coordinates. Direct store changes are limited to fixture initialization.
Observe browser-generated audio events in E2E; explicitly dispatch asynchronous events in UI integration.
Use a local test server for external network operations in regular tests and local models for inference.
Reuse pytest, Vitest, Testing Library, and Electron. Select any E2E driver after checking existing dependency capabilities and Electron support.

## Fixtures and Acceptance Values

| ID | Input | Expected result |
|---|---|---|
| F-01 | Generated WAVs: 8/44.1/48/96 kHz, mono/stereo, 8 combinations, 6 seconds each; known impulses and sine waves | Original rate/duration, conversion to playback 44.1 kHz stereo, channel ordering and timing. PCM read values within absolute error 1e-6 of reference arrays |
| F-02 | MP3/FLAC/Ogg/M4A/AAC generated from F-01 using FFmpeg, silent WAV, truncated file, 0 byte file | Supported decoding, recorded format-specific decoder delays, explanatory errors and successful subsequent operations. Lossy decoding uses criteria separate from sample equality |
| F-03 | 30-second original and 6 stems, each with a distinct frequency and shared impulse, known transcription notes | Identify original/stems separately. PCM input start difference within 1 frame. Mix references derive from fixture generation specifications |
| F-04 | Current format 5 project: pitched/drum notes, same-pitch overlaps, durations 0.009/0.010/0.011 and 9.999/10.000/10.001 seconds, beat phase 0.2 seconds, BPM 123.4, 3/4, 4/4, 6/8 | Note boundaries, timeline, invalid notes and immediate retriggers, drum 10 ms correction and at least 14 px hit area, persisted fields |
| F-05 | F-04 with missing original/stems/reference results, invalid JSON, unknown format version, spaces and Japanese characters in paths | Errors preserving data, playback/editing of available transcription, corresponding operation availability |
| F-06 | Generated 1,801-second WAV, 100,000 notes, 10/11 entries per cache kind | Streaming, drawing, latest 10 cache entries. Existing drawing criterion: 360 frames within 5,000 ms |
| F-07 | Rights-cleared 30-second audio, small/medium/large, CPU/CUDA/Auto, real separation model | Audio/model SHA-256 and environment. Assess note validity, existing benchmarks, and completion separately from exact inferred-note equality |

Isolate test directories and UserData per case. Compare input SHA-256 before and after tests.
Read exports independently using mido for MIDI, XML parsing and OSMD for MusicXML, and soundfile for WAV, rather than generating expectations with the exporter under test.
Persistence comparisons cover every field except explicitly identified variable metadata such as timestamps, including meaningful array ordering.
Use PCM captured at the output node for numerical audio checks. Physical output-device playback is a separate acceptance item.
Exclude the PCM 10 ms gain ramp and scheduled start interval when comparing selected signals. Check SoundFont channel assignment, note counts, and scheduling times.

## Required Use Cases

These 36 cases specify additional feature-spanning tests. Existing component tests listed above provide supporting evidence.
Implement P0 first because it addresses data loss, primary-function failure, asynchronous races, or remaining processes. P1 covers the other public functions.
Release acceptance requires both P0 and P1. Arrows indicate operation order.

### Startup, Input, and Models

| ID and priority | Preconditions and operations | Expected results and observations |
|---|---|---|
| UC-01 P0 | New UserData → launch → review/accept terms → new project screen → exit → restart | Main starts the service after acceptance; preload and service ports agree; 0 remaining test-owned processes after exit |
| UC-02 P0 | Inject service startup failure, invalid token, or non-loopback URL → startup/API request | Invalid access rejected with an error; normal connection works after restart |
| UC-03 P1 | Select F-01/F-02 → inspect → estimate tempo → create project | Format, timing, meter, analysis agree; silence/invalid files return to an operable state |
| UC-04 P0 | Analyze A → select B → finish B → delayed A response → start transcription | Displayed information, transcription input, and persisted source remain B; 0 overwrites from A |
| UC-05 P1 | Register 3 models → restart → switch model; missing separation model → download → validation failure/success | All 3 models share registration behavior; download completes after size/hash validation; retry works after interruption or mismatch |

### Transcription, Progress, and Postprocessing

| ID and priority | Preconditions and operations | Expected results and observations |
|---|---|---|
| UC-06 P0 | Direct transcription of F-07 → partial display → completion → save | Selected model and preset/automatic instruments applied; progress and completion agree; every trackId exists; saved result reopens |
| UC-07 P0 | Separated transcription of F-07 → per-part progress → completion → stem WAV export | Stems and tracks correspond; drum additions apply to transcription inputs; exported stems equal separation model outputs |
| UC-08 P0 | Cancel during preparation, model loading, separation, inference, postprocessing, or queueing → transcribe again | Results stop changing after cancellation completes; next job works; partial results and edited data agree with the UI |
| UC-09 P0 | Perform allowed note edits during transcription → partial results → completion | Result updates preserve edited IDs/notes without duplication or loss; disabled operations agree between UI and processing |
| UC-10 P0 | SSE disconnect/reconnect, duplicates, delayed completion, switch project A→B | Apply results by sequence; 0 changes to B from old jobs; progress/error/completion refer to the same jobId |
| UC-11 P0 | Inference exception, CUDA memory exhaustion, invalid model → inspect error → run another job | Error identifies the stage; failure preserves existing edits; queue resolves and retry works |
| UC-12 P0 | Options ON→OFF→ON with reversed responses → save → reopen; repeat with missing references | Save notes/velocity for latest settings; recompute from saved inputResults; transcribe only inputs requiring missing references |

### Playback, Display, and Timeline

| ID and priority | Preconditions and operations | Expected results and observations |
|---|---|---|
| UC-13 P0 | F-03 in original/transcription/comparison → play → pause → resume → stop | Correct PCM/SoundFont selection and stereo routing; expected positions; 0 unhandled errors, unexpected silence, or duplicate notes |
| UC-14 P0 | All 9 transitions among 3 playback modes, including reselection, during playback; choose next mode while preparing | Latest mode plays; Mute/Solo initialization, PCM preparation, real pause/play events, and visible notes agree |
| UC-15 P0 | Playing/stopped, with/without stems: Mute → add Solo → multiple Solo → clear final Solo | Selected sources and visible tracks agree; comparison pairing and original preservation without stems; verify position during gain changes |
| UC-16 P0 | F-03 playback → seek → A-B repeat → full repeat → end → beginning | PCM/SoundFont resume with shared start time; playback intent retained; 1 restart per iteration; source/timeline times agree each iteration |
| UC-17 P1 | Mute soloed/non-soloed transcription tracks and stems in 3 modes | Resolve SPEC-01 into a truth table, then compare UI/state/audio. Expectations currently unresolved |
| UC-18 P0 | Delay preparation → consecutive play/pause/seek/mode operations | Only latest action activates; 0 activations from cancelled loads; injected PCM shortage produces matching stopped state and permits restart |
| UC-19 P0 | F-04: change BPM/beat phase/meter → quantize → play → save | Measure/beat lines, selection, note times, persistence use one timeline; verify source/timeline offset round trips |
| UC-20 P1 | Change playback/track volume, octave, metronome, positive/negative offset, output device | Gains, pitch, clicks, delay reflect values; device disconnection is explained and recoverable; check restored settings and physical output |
| UC-21 P1 | F-04: zoom/scroll/follow → click/range selection → Solo display | Real Canvas display and hit areas agree; drums at least 14 px; 0 unintended off-screen selections |

### Editing, Analysis, and Persistence

| ID and priority | Preconditions and operations | Expected results and observations |
|---|---|---|
| UC-22 P0 | F-04: add → move → resize → copy/cut/paste → split/join → reassign → delete → Undo all → Redo all | Full note fields match initial state after Undo and final state after Redo; compare collisions, cross-kind reassignment, boundaries, Canvas |
| UC-23 P1 | Show chords → edit notes; refresh mismatch → change displayed sources/BPM → delayed old result | Chords/mismatch match current notes and beats; 0 stale results displayed as current |
| UC-24 P0 | Create → transcribe → edit → save → exit → restart → load → play → MIDI/MusicXML export | Compare all fields and final artifacts for one project, separately from isolated fixture-based feature success |
| UC-25 P0 | Begin save → additional edit → save response; also permission error, full disk, dialog cancellation | Only saved content becomes clean; further edits remain dirty; failures preserve existing file hash and edits |
| UC-26 P0 | Unsaved edits → new/open/exit → cancel/save/discard confirmation | Perform selected action only; preserve edits after save failure; 0 cross-project Undo history or delayed response updates |
| UC-27 P0 | Open F-05 → inspect error/edit available transcription → save → reopen | Explain invalid JSON/unsupported format; preserve original file; transcription remains playable/editable with missing audio |

### Export, Settings, and Cache

| ID and priority | Preconditions and operations | Expected results and observations |
|---|---|---|
| UC-28 P0 | Edit F-04 → export MIDI → reopen with mido | Note count, pitch, velocity, instruments, drum channel, timing match; time tolerance within 1 output tick |
| UC-29 P0 | Configure MusicXML → select validation error → correct → preview → export → reopen | Resolution/key/pickup/metadata applied; validation and output agree; preview measure limit leaves full export intact |
| UC-30 P0 | Export stems → compare duration/start with original; repeat with missing/modified cache | Valid files have expected names/content; errors identify target and preserve existing exports and source data |
| UC-31 P1 | Create/overwrite preset → restart → select → delete; switch Japanese/English/Chinese | Preset IDs, instruments, order persist; screens and dialogs remain operable in each language |
| UC-32 P0 | 10 entries per cache → reuse → 11th entry → list → delete selection → reopen; repeat during use | Latest 10 retained; verify treatment of unselected/in-use data; regeneration/errors reach an operable state |

### Repeated Use, Shutdown, and Distribution

| ID and priority | Preconditions and operations | Expected results and observations |
|---|---|---|
| UC-33 P0 | Run UC-24 3 times in one process, inserting cancellation/failure/other projects | History, selection, audio, jobs, errors belong to current project; 0 pending jobs/open output files after completion |
| UC-34 P1 | F-06: load → play → seek → zoom → edit → save; 100 playback operations | Existing drawing criterion met; latest operation/UI agree; 0 PCM underruns/unhandled errors; record memory, handles, pending jobs |
| UC-35 P0 | Exit while idle/transcribing/playing/saving/Renderer-unresponsive → restart | Follow exit confirmation choice; 0 remaining test-owned Electron/service processes; preserve existing unresponsive-shutdown limit of 3,000 ms |
| UC-36 P0 | Extract all volumes of same candidate → install 3 models → UC-01/06/07/24/35 → inspect licenses | Normal launch on Windows 10/11; record input/model/candidate SHA-256, corresponding sources, licenses, excluded files, artifacts, 0 remaining processes |

## Transitions, Combinations, and Fault Injection

Parameterize the following transitions in addition to successful paths.

| Area | Required transitions/combinations | Observations |
|---|---|---|
| Project | Absent → create → edited → saved → edited → exit → reopen; edit/switch/exit during saving | projectId, dirty state, persisted data, Undo target |
| Job | Queued → preparation → separation → inference → postprocessing → complete; cancel/fail each stage → next job | jobId, sequence, latest settings, partial results |
| Playback | Stopped → preparing → playing → paused → resumed; cancel/seek/reselect while preparing; end → repeat | Intent, real events, start frame, notes, remaining timers |
| Save/analysis | Request A → B → B response → A response, and A failure; insert project switch | Latest target/settings correspond to response |
| Exhaustive combinations | 3 modes × 2 playback states × stems present/absent; all 9 mode transitions; 8 F-01 combinations | Enumerate executed and unexecuted combinations |
| Real models | small/medium/large on CPU for direct/separated transcription; 3 models in both modes on CUDA-capable environment; Auto with/without CUDA | High accuracy for every combination; add fast profile for CPU/CUDA and 3 models. Missing models/resources are recorded as unexecuted |
| Other settings | All values and all two-factor combinations of meter, zoom, language, quantization resolution, input format | Attach generated combination table; explicit cases cover known regressions involving 3 or more factors |

Control asynchronous order by holding/releasing responses. Use 0/100/1,000 ms delays and PCM supply delays exceeding the remaining buffer.
Explicitly cover zero length, final frame, one frame before/after chunk boundaries, note boundaries, and repeat boundaries.
Normal cases require 0 unhandled exceptions/unexpected stops; fault cases require only the expected error and successful subsequent operation.
Wait for events, UI states, or output files and record the awaited condition on timeout.
Define timeouts per case/model/environment in the test implementation, separately from measured durations.

## Execution and Release Acceptance

| Trigger | Required scope | Criteria |
|---|---|---|
| CI for each change | Unit, types, service integration, deterministic UI integration/E2E, shutdown regression | 0 required failures/unexecuted tests; additions beyond current CI remain implementation work |
| Affected changes | Changed feature and preceding/following feature sequences; reverse responses, cancellation, retry for asynchronous changes | Regression fails before fix and passes after fix; verify operable final state |
| Release candidate | UC-01–36, combination table, real models, distribution acceptance, existing benchmarks | 100% required cases executed, 0 unresolved failures, 0 required skips/unexecuted cases, 0 unresolved expectations including SPEC-01 |

Report layers separately. Unit successes are separate from E2E and real-model acceptance counts.
For flaky tests passing on retry, retain the initial failure, trigger, fix, and revalidation for the decision.
Missing required evidence means incomplete acceptance. Dedicated CUDA/device cases complete on the corresponding environment.
After source changes, rerun affected cases and common regressions. After rebuilding, run distribution acceptance against the new SHA-256.
Use code coverage to find untested branches alongside operation/transition/output evidence.

Current workflows do not automate these case-level decisions and evidence retention. The release owner checks the case table until automation is implemented.
This document specifies that automation as future implementation. Distribution builds follow repository operating conditions.

## Implementation Order and Completion Criteria

1. Prepare expectations and fixtures. Resolve SPEC-01 and register F-01–07 generators/references/SHA-256, 36 cases, and combination tables.
2. Add real-service/TypeScript-client integration through audio preparation, PCM, SSE, persistence/reopening, and export files.
3. Implement UC-24's complete single-project sequence in real Electron, then all P0 cases including reverse responses, cancellation, and retry after failure.
4. Add P1 cases, real Canvas, output devices, and repeated use. Complete UI/state/audio/artifact comparisons.
5. Execute the same cases with real models and candidate packages; retain case results, logs, and artifacts in CI or acceptance records.

A stage completes when its tests are executable. A design, empty test, or test using doubles alone does not complete a subsequent integration layer.
The implementer owns regression/integration cases, the tester owns execution evidence, and the release owner checks candidate/result correspondence.
When one person performs multiple roles, keep implementation, execution, and release decisions distinct.

## Execution Record

Record the following per candidate and expand each case into its parameter rows.

| Field | Required content |
|---|---|
| Target | Git commit, worktree changes, candidate SHA-256, date/time, operator |
| Environment | Windows version, CPU/RAM, GPU/VRAM/driver, Python/Node/Electron, FFmpeg, output device |
| Data | Fixture ID, audio/model SHA-256, generator seed, case parameters |
| Case result | UC-ID, layer, preconditions, operations, expectations, observations, pass/fail/skip/unexecuted/unresolved expectations |
| Automated tests | Command, exit code, pass/fail/skip counts, timeouts, initial/retry results |
| Evidence | main/Renderer/Python logs, HTTP/SSE order, screenshots, audio measurements, persisted/exported files, remaining process count |
| Release decision | Total/completed required cases, unresolved defects/specifications, complete/incomplete acceptance, decision owner |

Retain evidence on abnormal exit and inspect test-owned processes/temp files after cleanup.
Keep failure data sufficient for reproduction and exclude user audio, tokens, and model weights from public logs.
