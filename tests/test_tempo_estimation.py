from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from muscriptor.utils.beats import BeatGrid

import earcopy_service.beat_analysis as beat_analysis
import earcopy_service.tempo_estimation as tempo_estimation
from earcopy_service.models import Note
from earcopy_service.tempo_estimation import TempoUnavailableError, estimate_tempo


def test_tempo_uses_muscriptor_grid_and_retains_fractional_bpm(monkeypatch):
    monkeypatch.setattr(tempo_estimation, 'analyze_beats', lambda path: BeatGrid(
        bpm=123.456, beats_per_bar=3, first_downbeat=8.2,
    ))
    result = estimate_tempo(Path('source.wav'), numerator=3, denominator=4)
    assert result.bpm == 123.456
    assert result.beats_per_bar == 3
    assert result.sample_rate == 16000
    assert result.beat_offset_sec == pytest.approx(8.2 % (3 * 60 / 123.456))


@pytest.mark.parametrize('denominator', [2, 4, 8, 16])
def test_measure_phase_respects_requested_denominator(monkeypatch, denominator):
    monkeypatch.setattr(tempo_estimation, 'analyze_beats', lambda path: BeatGrid(
        bpm=120, beats_per_bar=4, first_downbeat=3.2,
    ))
    result = estimate_tempo(Path('source.wav'), numerator=3, denominator=denominator)
    assert result.beat_offset_sec == pytest.approx(3.2 % (0.5 * 3 * 4 / denominator))


def test_nonsteady_beats_return_average_bpm_instead_of_rejecting_audio(monkeypatch):
    monkeypatch.setattr(tempo_estimation, 'analyze_beats', lambda path: BeatGrid(
        bpm=136.01, beats_per_bar=4, first_downbeat=0.62, steady=False,
    ))
    result = estimate_tempo(Path('source.wav'), numerator=4, denominator=4)
    assert result.bpm == 136.01
    assert result.beat_offset_sec == 0.62
    assert result.beats_per_bar == 4


def test_official_detector_regularizes_missing_and_extra_beats(monkeypatch):
    import beat_this.inference
    import torch

    regular = 0.1 + np.arange(64) * 0.5
    tracked = np.sort(np.append(np.delete(regular, [12, 13]), 8.2))
    monkeypatch.setattr(beat_this.inference, 'Audio2Beats',
                        lambda **kwargs: lambda *args: (tracked, regular[::4]))
    grid = beat_analysis.detect_beat_grid(
        torch.zeros(2, 16000), 16000, checkpoint='local.ckpt', device='cpu',
    )
    assert grid.bpm == pytest.approx(120)
    assert grid.steady
    assert grid.beats_per_bar == 4
    np.testing.assert_allclose(grid.beats, regular)


def test_unavailable_tempo_is_reported_for_manual_entry(monkeypatch):
    monkeypatch.setattr(tempo_estimation, 'analyze_beats', lambda path: None)
    with pytest.raises(TempoUnavailableError, match='BPM'):
        estimate_tempo(Path('source.wav'), numerator=4, denominator=4)


@pytest.mark.parametrize('bpm', [19, 301, float('nan')])
def test_invalid_tempo_is_rejected(monkeypatch, bpm):
    monkeypatch.setattr(tempo_estimation, 'analyze_beats', lambda path: BeatGrid(
        bpm=bpm, beats_per_bar=4, first_downbeat=0.1,
    ))
    with pytest.raises(ValueError, match='範囲外'):
        estimate_tempo(Path('source.wav'), numerator=4, denominator=4)


def _notes(delay=0.03, count=60):
    return [Note(
        sourceInstrumentId='acoustic_piano',
        trackId='00000000-0000-0000-0000-000000000001', pitch=60,
        rawStartSec=0.1 + index * 0.5 + delay,
        rawEndSec=0.4 + index * 0.5 + delay,
        startSec=0.1 + index * 0.5 + delay,
        endSec=0.4 + index * 0.5 + delay, velocity=100,
    ) for index in range(count)]


@pytest.mark.parametrize('delay', [-0.03, 0.03])
def test_onset_correction_uses_official_estimator_and_preserves_notes(delay):
    notes = _notes(delay)
    grid = BeatGrid(bpm=120, beats_per_bar=4, first_downbeat=0.1,
                    beats=0.1 + np.arange(64) * 0.5)
    corrected, measured = beat_analysis.correct_note_timing(notes, grid)
    assert measured == pytest.approx(delay, abs=1e-6)
    assert [note.id for note in corrected] == [note.id for note in notes]
    for index, note in enumerate(corrected):
        assert note.start_sec == pytest.approx(0.1 + index * 0.5)
        assert note.raw_start_sec == note.start_sec
        assert note.raw_end_sec == note.end_sec
        assert note.end_sec - note.start_sec == pytest.approx(0.3)
        assert note.velocity == 100


def test_fewer_than_forty_onsets_preserve_timing():
    notes = _notes(count=39)
    grid = BeatGrid(bpm=120, beats_per_bar=4, first_downbeat=0.1,
                    beats=0.1 + np.arange(64) * 0.5)
    corrected, delay = beat_analysis.correct_note_timing(notes, grid)
    assert corrected == notes
    assert delay == 0


def test_correction_at_audio_origin_preserves_duration():
    note = _notes(count=1)[0].model_copy(update={'raw_start_sec': 0.01, 'start_sec': 0.01})
    grid = SimpleNamespace(with_onset_delay=lambda onsets: SimpleNamespace(onset_delay=0.03))
    corrected, _ = beat_analysis.correct_note_timing([note], grid)
    assert corrected[0].start_sec == 0
    assert corrected[0].end_sec == pytest.approx(note.end_sec - 0.01)


def test_analysis_passes_only_local_checkpoint_and_caches_results(tmp_path, monkeypatch):
    audio = tmp_path / 'source.wav'
    audio.write_bytes(b'audio')
    model = tmp_path / 'final0.ckpt'
    model.write_bytes(b'model')
    monkeypatch.setattr(beat_analysis, 'beat_model_path', lambda: model)
    monkeypatch.setattr(beat_analysis, '_verify_model', lambda *args: None)
    monkeypatch.setattr(beat_analysis, 'load_audio', lambda path, target_sr: 'wave')
    calls = []
    grid = BeatGrid(bpm=120, beats_per_bar=4, first_downbeat=0.1)
    def detect(wave, sr, **kwargs):
        calls.append((wave, sr, kwargs))
        return grid
    monkeypatch.setattr(beat_analysis, 'detect_beat_grid', detect)
    beat_analysis._analyze_audio.cache_clear()
    assert beat_analysis.analyze_beats(audio) is grid
    assert beat_analysis.analyze_beats(audio) is grid
    assert calls == [('wave', 16000, {'checkpoint': str(model), 'device': 'cpu'})]
    audio.write_bytes(b'audio changed')
    beat_analysis.analyze_beats(audio)
    assert len(calls) == 2
    beat_analysis._analyze_audio.cache_clear()


def test_missing_model_is_reported_before_any_download(tmp_path, monkeypatch):
    audio = tmp_path / 'source.wav'
    audio.write_bytes(b'audio')
    monkeypatch.setattr(beat_analysis, 'beat_model_path', lambda: tmp_path / 'missing.ckpt')
    with pytest.raises(ValueError, match='拍解析モデル'):
        beat_analysis.analyze_beats(audio)


def test_invalid_checkpoint_size_is_rejected(tmp_path):
    model = tmp_path / 'bad.ckpt'
    model.write_bytes(b'bad')
    with pytest.raises(ValueError, match='ファイルサイズ'):
        beat_analysis._verify_model(model, model.stat().st_size, 0)
