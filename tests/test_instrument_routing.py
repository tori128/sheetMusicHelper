from earcopy_service.instrument_routing import (
    collapse_mapped_family_duplicates,
    expand_family_track_ids,
    group_tracks_by_stem,
    transcription_candidate_ids,
)
from earcopy_service.models import Note
from earcopy_service.presets import PRESET_BY_KEY, create_project


def test_timing_guides_add_reject_candidates_without_output_tracks() -> None:
    project = create_project("guide", PRESET_BY_KEY["anime-song"])
    grouped = group_tracks_by_stem(project.tracks)

    assert transcription_candidate_ids(
        grouped["bass"], "bass", project.tracks, True
    ) == ["electric_bass", "drums"]
    assert "drums" in transcription_candidate_ids(
        {"acoustic_piano": grouped["other"]["acoustic_piano"]},
        "piano",
        project.tracks,
        True,
    )
    assert "drums" in transcription_candidate_ids(
        {"string_ensemble": grouped["other"]["string_ensemble"]},
        "other",
        project.tracks,
        True,
    )
    assert transcription_candidate_ids(
        grouped["bass"], "bass", project.tracks, False
    ) == ["electric_bass"]


def test_family_candidates_map_to_selected_output_tracks() -> None:
    project = create_project("families", PRESET_BY_KEY["anime-song"])
    tracks = {track.instrument_id: track.id for track in project.tracks}

    bass = expand_family_track_ids(
        {"electric_bass": tracks["electric_bass"]},
        {
            "acoustic_bass": (
                "acoustic_bass",
                "contrabass",
                "electric_bass",
            ),
            "electric_bass": (
                "electric_bass",
                "acoustic_bass",
                "contrabass",
            ),
            "contrabass": (
                "contrabass",
                "acoustic_bass",
                "electric_bass",
            ),
        },
    )

    assert list(bass) == ["electric_bass", "acoustic_bass", "contrabass"]
    assert set(bass.values()) == {tracks["electric_bass"]}

    guitar = expand_family_track_ids(
        {
            "acoustic_guitar": tracks["acoustic_guitar"],
            "distorted_electric_guitar": tracks[
                "distorted_electric_guitar"
            ],
        },
        {
            "acoustic_guitar": (
                "acoustic_guitar",
                "clean_electric_guitar",
                "distorted_electric_guitar",
            ),
            "clean_electric_guitar": (
                "clean_electric_guitar",
                "distorted_electric_guitar",
                "acoustic_guitar",
            ),
            "distorted_electric_guitar": (
                "distorted_electric_guitar",
                "clean_electric_guitar",
                "acoustic_guitar",
            ),
        },
    )

    assert guitar["acoustic_guitar"] == tracks["acoustic_guitar"]
    assert guitar["distorted_electric_guitar"] == tracks[
        "distorted_electric_guitar"
    ]
    assert guitar["clean_electric_guitar"] == tracks[
        "distorted_electric_guitar"
    ]


def test_mapped_family_duplicates_prefer_the_selected_instrument() -> None:
    project = create_project("families", PRESET_BY_KEY["general-band"])
    bass_track = next(
        track
        for track in project.tracks
        if track.instrument_id == "electric_bass"
    )

    def note(instrument_id: str, pitch: int, start: float, end: float) -> Note:
        return Note(
            sourceInstrumentId=instrument_id,
            trackId=bass_track.id,
            pitch=pitch,
            rawStartSec=start,
            rawEndSec=end,
            startSec=start,
            endSec=end,
        )

    collapsed, discarded = collapse_mapped_family_duplicates(
        [
            note("acoustic_bass", 40, 1.01, 1.51),
            note("electric_bass", 40, 1.00, 1.50),
            note("acoustic_bass", 43, 2.00, 2.50),
        ],
        {bass_track.id: "electric_bass"},
    )

    assert discarded == 1
    assert [
        (item.source_instrument_id, item.pitch) for item in collapsed
    ] == [("electric_bass", 40), ("acoustic_bass", 43)]
