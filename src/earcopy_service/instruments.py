from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class InstrumentDefinition:
    id: str
    display_name_ja: str
    gm_program: int | None

    @property
    def kind(self) -> str:
        return "drums" if self.id == "drums" else "pitched"


_INSTRUMENT_ROWS: tuple[tuple[str, str, int | None], ...] = (
    ("acoustic_piano", "アコースティックピアノ", 0),
    ("electric_piano", "エレクトリックピアノ", 4),
    ("chromatic_percussion", "鍵盤打楽器", 9),
    ("organ", "オルガン", 19),
    ("acoustic_guitar", "アコースティックギター", 24),
    ("clean_electric_guitar", "クリーンエレキギター", 27),
    ("distorted_electric_guitar", "ディストーションギター", 30),
    ("acoustic_bass", "アコースティックベース", 32),
    ("electric_bass", "エレクトリックベース", 33),
    ("violin", "ヴァイオリン", 40),
    ("viola", "ヴィオラ", 41),
    ("cello", "チェロ", 42),
    ("contrabass", "コントラバス", 43),
    ("orchestral_harp", "オーケストラハープ", 46),
    ("timpani", "ティンパニ", 47),
    ("string_ensemble", "ストリングス", 48),
    ("synth_strings", "シンセストリングス", 50),
    ("voice", "ボーカル／クワイア", 52),
    ("orchestra_hit", "オーケストラヒット", 55),
    ("trumpet", "トランペット", 56),
    ("trombone", "トロンボーン", 57),
    ("tuba", "チューバ", 58),
    ("french_horn", "フレンチホルン", 60),
    ("brass_section", "ブラスセクション", 61),
    ("soprano_and_alto_sax", "ソプラノ／アルトサックス", 65),
    ("tenor_sax", "テナーサックス", 66),
    ("baritone_sax", "バリトンサックス", 67),
    ("oboe", "オーボエ", 68),
    ("english_horn", "イングリッシュホルン", 69),
    ("bassoon", "ファゴット", 70),
    ("clarinet", "クラリネット", 71),
    ("flutes", "フルート群", 73),
    ("synth_lead", "シンセリード", 80),
    ("synth_pad", "シンセパッド", 89),
    ("drums", "ドラム／打楽器", None),
)

INSTRUMENTS: tuple[InstrumentDefinition, ...] = tuple(
    InstrumentDefinition(*row) for row in _INSTRUMENT_ROWS
)
INSTRUMENT_BY_ID: dict[str, InstrumentDefinition] = {
    instrument.id: instrument for instrument in INSTRUMENTS
}


def get_instrument(instrument_id: str) -> InstrumentDefinition:
    try:
        return INSTRUMENT_BY_ID[instrument_id]
    except KeyError as exc:
        raise ValueError(f"未対応の楽器グループです: {instrument_id}") from exc

