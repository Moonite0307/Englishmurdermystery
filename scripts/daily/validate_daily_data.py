#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_daily_data.py
日常场景交涉数据校验脚本。

读取 Englishmurdermystery/data/daily 下生成的数据，逐项检查并在控制台输出统计，
同时把结果写入 Englishmurdermystery/data/daily/validation_report.md。

检查项：
  1  是否有 216 条对话
  2  每个板块是否正好 24 条
  3  每个场景是否正好 3 条
  4  是否覆盖 A2、B1、B2
  5  是否有重复 id
  6  是否有缺少 turns
  7  每段是否至少 6 轮
  8  speaker 是否为 A、B 或 C
  9  是否存在空台词
  10 dialogue_text 是否和 turns 内容一致
  11 是否存在中文旁白或括号动作
  12 target_words 是否为数组
  13 所有 source_refs 是否存在
  14 JSONL 是否可以逐行解析
  15 vocabulary.json 是否可以解析
  16 scene_catalog.json 是否正好有 72 条
  17 review_queue.json 是否可以解析

运行：
  python Englishmurdermystery/scripts/daily/validate_daily_data.py
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, OrderedDict
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
REPO_DIR = SCRIPT_PATH.parents[2]            # Englishmurdermystery
PROJECT_ROOT = REPO_DIR.parent               # 词狱 Word Prison
DATA_DIR = REPO_DIR / "data" / "daily"

SCENES = DATA_DIR / "scenes.jsonl"
VOCAB = DATA_DIR / "vocabulary.json"
CATALOG = DATA_DIR / "scene_catalog.json"
SOURCES = DATA_DIR / "sources.json"
REVIEW = DATA_DIR / "review_queue.json"
REPORT = DATA_DIR / "validation_report.md"

LEVEL_ORDER = ["A2", "B1", "B2"]
CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
BRACKET_RE = re.compile(r"[\(\)\[\]\{\}\（\）【】]")

problems: list[str] = []          # 严重问题（会导致校验不通过）
warnings: list[str] = []          # 提醒


def fail(msg: str) -> None:
    problems.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for i, line in enumerate(fh, start=1):
            s = line.strip()
            if not s:
                continue
            try:
                rows.append(json.loads(s))
            except json.JSONDecodeError as exc:
                fail(f"[14] scenes.jsonl 第 {i} 行无法解析：{exc}")
    return rows


def main() -> int:
    lines: list[str] = []

    def out(text: str = "") -> None:
        print(text)
        lines.append(text)

    out("# 日常场景交涉数据校验报告")
    out("")
    out("由 `scripts/daily/validate_daily_data.py` 自动生成。")
    out("")

    # ---- 14 JSONL 解析 ----
    records = load_jsonl(SCENES) if SCENES.exists() else []
    if not SCENES.exists():
        fail("[14] scenes.jsonl 不存在")

    # ---- 1 总数 ----
    if len(records) != 216:
        fail(f"[1] 对话总数为 {len(records)}，应为 216")
    else:
        out(f"- [1] 对话总数：{len(records)} / 216 ✔")

    # ---- 2 每板块 24 ----
    by_block = Counter(r.get("block_id") for r in records)
    block_bad = {k: v for k, v in by_block.items() if v != 24}
    if len(by_block) != 9:
        fail(f"[2] 板块数为 {len(by_block)}，应为 9")
    if block_bad:
        fail(f"[2] 以下板块不是 24 条：{block_bad}")

    # ---- 3 每场景 3 ----
    by_scene = Counter(r.get("scene_id") for r in records)
    scene_bad = {k: v for k, v in by_scene.items() if v != 3}
    if scene_bad:
        fail(f"[3] 以下场景不是 3 条：{scene_bad}")

    # ---- 4 覆盖 A2/B1/B2 ----
    by_level = Counter(r.get("level") for r in records)
    for lv in LEVEL_ORDER:
        if by_level.get(lv, 0) == 0:
            fail(f"[4] 缺少等级 {lv}")
    unknown_levels = {k: v for k, v in by_level.items() if k not in LEVEL_ORDER}
    if unknown_levels:
        fail(f"[4] 出现未知等级：{unknown_levels}")

    # ---- 5 重复 id ----
    ids = [r.get("id") for r in records]
    dup = [k for k, v in Counter(ids).items() if v > 1]
    if dup:
        fail(f"[5] 重复 id：{dup[:10]}")
    if len(set(ids)) != len(ids):
        fail("[5] id 不唯一")

    # ---- 6/7/8/9/10/11/12 逐条 ----
    n_missing_turns = n_short = n_bad_speaker = n_empty = n_text_mismatch = 0
    n_cjk = n_bracket = n_tw_not_array = n_empty_target_words = 0
    for r in records:
        rid = r.get("id")
        turns = r.get("turns")
        if not isinstance(turns, list) or not turns:
            n_missing_turns += 1
            fail(f"[6] {rid} 缺少 turns")
            continue
        if len(turns) < 6:
            n_short += 1
            fail(f"[7] {rid} 只有 {len(turns)} 轮，少于 6 轮")
        for t in turns:
            spk = t.get("speaker")
            txt = t.get("text", "")
            if spk not in ("A", "B", "C"):
                n_bad_speaker += 1
                fail(f"[8] {rid} speaker 非法：{spk!r}")
            if not isinstance(txt, str) or not txt.strip():
                n_empty += 1
                fail(f"[9] {rid} 存在空台词")
            if isinstance(txt, str):
                if CJK_RE.search(txt):
                    n_cjk += 1
                    warn(f"[11] {rid} 台词含中文：{txt[:40]!r}")
                if BRACKET_RE.search(txt):
                    n_bracket += 1
                    warn(f"[11] {rid} 台词含括号（可能是动作/旁白）：{txt[:40]!r}")
        # 10 dialogue_text 一致
        rebuilt = "\n".join(f"{t.get('speaker')}: {t.get('text')}" for t in turns)
        if r.get("dialogue_text") != rebuilt:
            n_text_mismatch += 1
            fail(f"[10] {rid} dialogue_text 与 turns 不一致")
        # 12 target_words 数组
        if not isinstance(r.get("target_words"), list):
            n_tw_not_array += 1
            fail(f"[12] {rid} target_words 不是数组")
        elif not r["target_words"]:
            n_empty_target_words += 1

    out(f"- [2] 板块数量：{len(by_block)}（每板块 24 条）")
    for bid, cnt in sorted(by_block.items()):
        out(f"    - {bid}：{cnt} 条")
    out(f"- [3] 场景数量：{len(by_scene)}（每场景 3 条）")
    out(f"- [4] 各等级记录数：{dict(sorted(by_level.items()))}")
    out(f"- [5] 重复 id：{len(dup)}")
    out(f"- [6] 缺少 turns：{n_missing_turns}")
    out(f"- [7] 少于 6 轮：{n_short}")
    out(f"- [8] 非法 speaker：{n_bad_speaker}")
    out(f"- [9] 空台词：{n_empty}")
    out(f"- [10] dialogue_text 不一致：{n_text_mismatch}")
    out(f"- [11] 中文旁白：{n_cjk}；含括号：{n_bracket}")
    out(f"- [12] target_words 非数组：{n_tw_not_array}；为空：{n_empty_target_words}")

    # ---- 13 source_refs 存在 ----
    ref_missing = 0
    checked_refs = set()
    for r in records:
        refs = []
        src = r.get("source")
        if isinstance(src, dict) and src.get("file"):
            refs.append(src["file"])
        for tw in r.get("target_words", []) or []:
            refs.extend(tw.get("source_refs", []) or [])
        for ref in refs:
            if ref in checked_refs:
                continue
            checked_refs.add(ref)
            if not (PROJECT_ROOT / ref).exists():
                ref_missing += 1
                fail(f"[13] source_ref 不存在：{ref}")
    if VOCAB.exists():
        v = json.loads(VOCAB.read_text(encoding="utf-8"))
        for w in v.get("words", []):
            for ref in w.get("source_refs", []) or []:
                if ref in checked_refs:
                    continue
                checked_refs.add(ref)
                if not (PROJECT_ROOT / ref).exists():
                    ref_missing += 1
                    fail(f"[13] source_ref 不存在：{ref}")
    out(f"- [13] 缺失的 source_ref：{ref_missing}（共检查 {len(checked_refs)} 个不同来源）")

    # ---- 15 vocabulary.json ----
    vocab_cnt = 0
    vocab_status = Counter()
    if VOCAB.exists():
        try:
            v = json.loads(VOCAB.read_text(encoding="utf-8"))
            vocab_cnt = len(v.get("words", []))
            origin_counts = Counter(w.get("vocab_origin", "block_keywords") for w in v.get("words", []))
            for w in v.get("words", []):
                vocab_status[w.get("data_status")] += 1
        except json.JSONDecodeError as exc:
            fail(f"[15] vocabulary.json 无法解析：{exc}")
    else:
        fail("[15] vocabulary.json 不存在")
    out(f"- [15] vocabulary.json 可解析，词条数：{vocab_cnt}，来源分布：{dict(origin_counts) if VOCAB.exists() else {}}，状态分布：{dict(vocab_status)}")
    if VOCAB.exists():
        words = json.loads(VOCAB.read_text(encoding="utf-8")).get("words", [])
        core = [w for w in words if w.get("vocab_origin", "block_keywords") == "block_keywords"]
        out(f"    - 核心词字段覆盖：释义 {sum(bool(w.get('meanings_zh')) for w in core)}/{len(core)}；"
            f"CEFR {sum(w.get('cefr') is not None for w in core)}/{len(core)}；"
            f"真题考频 {sum(any(s.get('rank') is not None or s.get('frequency') is not None for s in w.get('exam_frequency', {}).values()) for w in core)}/{len(core)}；"
            f"音标 {sum(bool(w.get('phonetic')) for w in core)}/{len(core)}；"
            f"一般词频参考 {sum(bool(w.get('general_frequency')) for w in core)}/{len(core)}")

    # ---- 16 scene_catalog.json ----
    catalog_cnt = 0
    if CATALOG.exists():
        try:
            c = json.loads(CATALOG.read_text(encoding="utf-8"))
            catalog_cnt = len(c.get("scenes", []))
        except json.JSONDecodeError as exc:
            fail(f"[16] scene_catalog.json 无法解析：{exc}")
    else:
        fail("[16] scene_catalog.json 不存在")
    if catalog_cnt != 72:
        fail(f"[16] scene_catalog.json 有 {catalog_cnt} 条，应为 72")
    else:
        out(f"- [16] scene_catalog.json：{catalog_cnt} / 72 ✔")

    # ---- 17 review_queue.json ----
    review_cnt = 0
    review_types = Counter()
    if REVIEW.exists():
        try:
            rq = json.loads(REVIEW.read_text(encoding="utf-8"))
            review_cnt = len(rq.get("items", []))
            for it in rq.get("items", []):
                review_types[it.get("type")] += 1
        except json.JSONDecodeError as exc:
            fail(f"[17] review_queue.json 无法解析：{exc}")
    else:
        fail("[17] review_queue.json 不存在")
    out(f"- [17] review_queue.json：{review_cnt} 条，类型分布：{dict(review_types)}")

    # ---- 汇总 ----
    out("")
    out("## 汇总")
    out("")
    out(f"- 总记录数：{len(records)}")
    out(f"- 板块数量：{len(by_block)}")
    out(f"- 场景数量：{len(by_scene)}")
    out(f"- 每个等级数量：{dict(sorted(by_level.items()))}")
    out(f"- 缺陷数量（fail）：{len(problems)}")
    out(f"- 提醒数量（warn）：{len(warnings)}")
    out(f"- review_queue 数量：{review_cnt}")
    out(f"- 结论：{'校验通过' if not problems else '存在需要处理的缺陷'}")

    if problems:
        out("")
        out("## 缺陷")
        out("")
        for p in problems[:200]:
            out(f"- {p}")
        if len(problems) > 200:
            out(f"- …… 另有 {len(problems) - 200} 条，略")
    if warnings:
        out("")
        out("## 提醒")
        out("")
        for w in warnings[:200]:
            out(f"- {w}")
        if len(warnings) > 200:
            out(f"- …… 另有 {len(warnings) - 200} 条，略")

    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("")
    print(f"报告已写入：{REPORT.relative_to(PROJECT_ROOT).as_posix()}")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
