from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class GmProgramDefinition:
    program: int
    display_name_ja: str


@dataclass(frozen=True, slots=True)
class InstrumentDefinition:
    id: str
    display_name_ja: str
    gm_program: int | None
    gm_programs: tuple[GmProgramDefinition, ...]

    @property
    def kind(self) -> str:
        return "drums" if self.id == "drums" else "pitched"

    def supports_gm_program(self, program: int | None) -> bool:
        if self.kind == "drums":
            return program is None
        return any(option.program == program for option in self.gm_programs)


def _gm(*rows: tuple[int, str]) -> tuple[GmProgramDefinition, ...]:
    return tuple(GmProgramDefinition(*row) for row in rows)


_INSTRUMENT_ROWS: tuple[
    tuple[str, str, int | None, tuple[GmProgramDefinition, ...]], ...
] = (
    (
        "acoustic_piano",
        "アコースティックピアノ",
        0,
        _gm(
            (0, "アコースティックグランドピアノ"),
            (1, "ブライトアコースティックピアノ"),
            (2, "エレクトリックグランドピアノ"),
            (3, "ホンキートンクピアノ"),
        ),
    ),
    (
        "electric_piano",
        "エレクトリックピアノ",
        4,
        _gm(
            (4, "エレクトリックピアノ1"),
            (5, "エレクトリックピアノ2"),
            (6, "ハープシコード"),
            (7, "クラビネット"),
        ),
    ),
    (
        "chromatic_percussion",
        "鍵盤打楽器",
        9,
        _gm(
            (8, "チェレスタ"),
            (9, "グロッケン"),
            (10, "オルゴール"),
            (11, "ヴィブラフォン"),
            (12, "マリンバ"),
            (13, "シロフォン"),
            (14, "チューブラーベル"),
            (15, "ダルシマー"),
            (112, "ティンクルベル"),
            (113, "アゴゴ"),
            (114, "スチールドラム"),
            (115, "ウッドブロック"),
            (117, "メロディックタム"),
            (118, "シンセドラム"),
        ),
    ),
    (
        "organ",
        "オルガン",
        19,
        _gm(
            (16, "ドローバーオルガン"),
            (17, "パーカッシブオルガン"),
            (18, "ロックオルガン"),
            (19, "チャーチオルガン"),
            (20, "リードオルガン"),
            (21, "アコーディオン"),
            (22, "ハーモニカ"),
            (23, "タンゴアコーディオン"),
        ),
    ),
    (
        "acoustic_guitar",
        "アコースティックギター",
        24,
        _gm((24, "ナイロン弦ギター"), (25, "スチール弦ギター")),
    ),
    (
        "clean_electric_guitar",
        "クリーンエレキギター",
        27,
        _gm(
            (26, "ジャズギター"),
            (27, "クリーンギター"),
            (28, "ミュートギター"),
        ),
    ),
    (
        "distorted_electric_guitar",
        "ディストーションギター",
        30,
        _gm(
            (29, "オーバードライブギター"),
            (30, "ディストーションギター"),
            (31, "ギターハーモニクス"),
        ),
    ),
    (
        "acoustic_bass",
        "アコースティックベース",
        32,
        _gm((32, "アコースティックベース"),),
    ),
    (
        "electric_bass",
        "エレクトリックベース",
        33,
        _gm(
            (33, "フィンガーベース"),
            (34, "ピックベース"),
            (35, "フレットレスベース"),
            (36, "スラップベース1"),
            (37, "スラップベース2"),
            (38, "シンセベース1"),
            (39, "シンセベース2"),
        ),
    ),
    ("violin", "ヴァイオリン", 40, _gm((40, "ヴァイオリン"),)),
    ("viola", "ヴィオラ", 41, _gm((41, "ヴィオラ"),)),
    ("cello", "チェロ", 42, _gm((42, "チェロ"),)),
    ("contrabass", "コントラバス", 43, _gm((43, "コントラバス"),)),
    (
        "orchestral_harp",
        "オーケストラハープ",
        46,
        _gm((46, "オーケストラハープ"),),
    ),
    ("timpani", "ティンパニ", 47, _gm((47, "ティンパニ"),)),
    (
        "string_ensemble",
        "ストリングス",
        48,
        _gm(
            (44, "トレモロストリングス"),
            (45, "ピチカートストリングス"),
            (48, "ストリングアンサンブル1"),
            (49, "ストリングアンサンブル2"),
        ),
    ),
    (
        "synth_strings",
        "シンセストリングス",
        50,
        _gm(
            (50, "シンセストリングス1"),
            (51, "シンセストリングス2"),
        ),
    ),
    (
        "voice",
        "ボーカル／クワイア",
        71,
        _gm(
            (52, "クワイア"),
            (53, "ボイス"),
            (54, "シンセボイス"),
            (71, "クラリネット（聞き取り用）"),
        ),
    ),
    (
        "orchestra_hit",
        "オーケストラヒット",
        55,
        _gm((55, "オーケストラヒット"),),
    ),
    (
        "trumpet",
        "トランペット",
        56,
        _gm((56, "トランペット"), (59, "ミュートトランペット")),
    ),
    ("trombone", "トロンボーン", 57, _gm((57, "トロンボーン"),)),
    ("tuba", "チューバ", 58, _gm((58, "チューバ"),)),
    ("french_horn", "フレンチホルン", 60, _gm((60, "フレンチホルン"),)),
    (
        "brass_section",
        "ブラスセクション",
        61,
        _gm(
            (61, "ブラスセクション"),
            (62, "シンセブラス1"),
            (63, "シンセブラス2"),
        ),
    ),
    (
        "soprano_and_alto_sax",
        "ソプラノ／アルトサックス",
        65,
        _gm((64, "ソプラノサックス"), (65, "アルトサックス")),
    ),
    ("tenor_sax", "テナーサックス", 66, _gm((66, "テナーサックス"),)),
    (
        "baritone_sax",
        "バリトンサックス",
        67,
        _gm((67, "バリトンサックス"),),
    ),
    ("oboe", "オーボエ", 68, _gm((68, "オーボエ"),)),
    (
        "english_horn",
        "イングリッシュホルン",
        69,
        _gm((69, "イングリッシュホルン"),),
    ),
    ("bassoon", "ファゴット", 70, _gm((70, "ファゴット"),)),
    ("clarinet", "クラリネット", 71, _gm((71, "クラリネット"),)),
    (
        "flutes",
        "フルート群",
        73,
        _gm(
            (72, "ピッコロ"),
            (73, "フルート"),
            (74, "リコーダー"),
            (75, "パンフルート"),
            (76, "ボトルブロー"),
            (77, "尺八"),
            (78, "口笛"),
            (79, "オカリナ"),
        ),
    ),
    (
        "synth_lead",
        "シンセリード",
        80,
        _gm(
            (80, "スクエアリード"),
            (81, "ソートゥースリード"),
            (82, "カリオペリード"),
            (83, "チフリード"),
            (84, "チャランゴリード"),
            (85, "ボイスリード"),
            (86, "フィフスリード"),
            (87, "ベース＋リード"),
        ),
    ),
    (
        "synth_pad",
        "シンセパッド",
        89,
        _gm(
            (88, "ニューエイジパッド"),
            (89, "ウォームパッド"),
            (90, "ポリシンセパッド"),
            (91, "クワイアパッド"),
            (92, "ボウドパッド"),
            (93, "メタリックパッド"),
            (94, "ハローパッド"),
            (95, "スウィープパッド"),
        ),
    ),
    ("drums", "ドラム／打楽器", None, ()),
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
