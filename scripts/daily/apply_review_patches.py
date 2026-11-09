#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply_review_patches.py
把「豆包」返回的审核结果（review-batch-*.jsonl）应用到 scenes.jsonl。

规则：
  - 只应用 status == "needs_revision" 记录里的 suggested_patches。
  - status == "pass" 的记录保持原样。
  - status == "reject" 的记录不改动，改写入 review_queue.json 等人工处理。
  - 绝不改动 id / block_id / scene_id / level。
  - 不修改任何原始 txt / csv / 审核结果 jsonl。
  - 不编造 CEFR / 音标 / 考频 / 许可证。

支持的 patch.field：
  - turns[N].text        台词文本（turns[N] 兼容 0-based / 1-based，按内容兜底匹配）
  - turns[N].speaker     单个说话人字母（A/B/C）
  - turns[*].speaker     全篇角色对调，before/after 形如「A 为顾客、B 为店员」
  - task_goal / success_criteria[N] 等普通字段

产出：
  - 覆盖 Englishmurdermystery/data/daily/scenes.jsonl（同步 dialogue_text）
  - 追加 Englishmurdermystery/data/daily/review_queue.json（reject 记录）
  - 生成 Englishmurdermystery/data/daily/patch_log.json

运行：
  python Englishmurdermystery/scripts/daily/apply_review_patches.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
REPO_DIR = SCRIPT_PATH.parents[2]            # Englishmurdermystery
DATA_DIR = REPO_DIR / "data" / "daily"
SCENES = DATA_DIR / "scenes.jsonl"
REVIEW_QUEUE = DATA_DIR / "review_queue.json"
PATCH_LOG = DATA_DIR / "patch_log.json"

REVIEWER = "doubao-review-batch"

TURN_TEXT_RE = re.compile(r"^turns\[(\d+)\]\.text$")
TURN_SPK_RE = re.compile(r"^turns\[(\d+)\]\.speaker$")
TURN_SPK_ANY_RE = re.compile(r"^turns\[\*\]\.speaker$")
LIST_RE = re.compile(r"^([a-z_]+)\[(\d+)\]$")
ROLE_RE = re.compile(r"([ABC])\s*为\s*([^、,，;；]+)")


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def parse_role_map(before: str, after: str) -> dict[str, str] | None:
    """把「A 为顾客、B 为店员」->「A 为店员、B 为顾客」解析成字母映射 {旧字母: 新字母}。"""
    b = {m.group(1): m.group(2).strip() for m in ROLE_RE.finditer(before or "")}
    a = {m.group(1): m.group(2).strip() for m in ROLE_RE.finditer(after or "")}
    if not b or not a:
        return None
    role_to_new = {role: letter for letter, role in a.items()}
    mapping = {letter: role_to_new.get(role) for letter, role in b.items()}
    if any(v is None for v in mapping.values()):
        return None
    return mapping


def apply_patch(rec: dict, field: str, before, after):
    """返回 (ok, resolved_field)；ok=True 已应用，False 已应用过，None 未能匹配。"""
    # 全篇角色对调
    if TURN_SPK_ANY_RE.match(field):
        mapping = parse_role_map(before, after)
        if not mapping:
            return None, field
        for t in rec["turns"]:
            t["speaker"] = mapping.get(t["speaker"], t["speaker"])
        return True, field

    # 单个说话人字母
    m = TURN_SPK_RE.match(field)
    if m:
        arr = rec["turns"]
        i = int(m.group(1))
        for idx in (i, i - 1):               # 只在声明索引及其前一位上匹配，避免误改
            if 0 <= idx < len(arr) and arr[idx]["speaker"] == before:
                arr[idx]["speaker"] = after
                return True, field
        if 0 <= i < len(arr) and arr[i]["speaker"] == after:
            return False, field
        return None, field

    # 台词文本
    m = TURN_TEXT_RE.match(field)
    if m:
        arr = rec["turns"]
        n = int(m.group(1))
        getter = lambda i: arr[i]["text"]                       # noqa: E731
        setter = lambda i, v: arr[i].__setitem__("text", v)     # noqa: E731
        tmpl = "turns[{}].text"
    else:
        m = LIST_RE.match(field)
        if m:
            base, n = m.group(1), int(m.group(2))
            arr = rec.get(base, [])
            getter = lambda i: arr[i]                           # noqa: E731
            setter = lambda i, v: arr.__setitem__(i, v)         # noqa: E731
            tmpl = base + "[{}]"
        else:
            cur = rec.get(field)
            if cur == before:
                rec[field] = after
                return True, field
            if cur == after:
                return False, field
            return None, field

    for i in (n, n - 1, n + 1):              # 兼容 0-based / 1-based
        if 0 <= i < len(arr) and getter(i) == before:
            setter(i, after)
            return True, tmpl.format(i)
    for i in range(len(arr)):                # 兜底：按内容精确匹配
        if getter(i) == before:
            setter(i, after)
            return True, tmpl.format(i)
    for i in range(len(arr)):                # 是否已经应用过
        if getter(i) == after:
            return False, tmpl.format(i)
    return None, field


def rebuild_dialogue_text(rec: dict) -> str:
    return "\n".join(f"{t['speaker']}: {t['text']}" for t in rec["turns"])


def main() -> int:
    review_files = sorted(DATA_DIR.glob("review-batch-*.jsonl"))
    if not review_files:
        print("未找到 review-batch-*.jsonl")
        return 1

    records = load_jsonl(SCENES)
    by_id = {r["id"]: r for r in records}

    # 已应用过的补丁（避免重复运行把角色对调来回切）
    done: set[tuple] = set()
    if PATCH_LOG.exists():
        for e in json.loads(PATCH_LOG.read_text(encoding="utf-8")).get("entries", []):
            done.add((e.get("record_id"), e.get("field"), e.get("before"), e.get("after")))

    review_items: list[dict] = []
    for path in review_files:
        for row in load_jsonl(path):
            if "id" in row:
                review_items.append(row)

    print(f"审核结果文件：{[p.name for p in review_files]}")
    print(f"审核条目：{len(review_items)}")

    log: list[dict] = []
    skipped: list[str] = []
    rejects: list[dict] = []
    unresolved: list[str] = []
    resolved_without_patch: list[str] = []
    applied_ids: set[str] = set()

    for row in review_items:
        rid = row.get("id")
        status = row.get("status")
        if status == "pass":
            continue
        if status == "reject":
            rejects.append(row)
            continue
        if status != "needs_revision":
            continue

        rec = by_id.get(rid)
        if rec is None:
            skipped.append(f"{rid}: scenes.jsonl 中找不到该 id")
            continue

        guard = (rec["id"], rec["block_id"], rec["scene_id"], rec["level"])
        turns_touched = False
        n_applied = 0
        patches = row.get("suggested_patches", []) or []

        if not patches:
            issues = row.get("issues", []) or []
            remaining_issues = []
            has_missing_vocab_issue = False
            for issue in issues:
                is_vocab_issue = any(marker in issue for marker in ("target_words 为空", "重点词为空", "没有任何重点词", "只缺词汇标注"))
                if is_vocab_issue:
                    has_missing_vocab_issue = True
                    if isinstance(rec.get("target_words"), list) and rec["target_words"]:
                        continue  # 词表接入流程已用有来源的词条补齐，无需结构化台词补丁。
                closing_claim = re.search(r"\b([ABC])\s*收尾", issue)
                if closing_claim and rec.get("turns"):
                    actual_last_speaker = rec["turns"][-1].get("speaker")
                    if actual_last_speaker != closing_claim.group(1):
                        continue  # 审核意见与记录末轮说话人不符，该项已被数据校验推翻。
                remaining_issues.append(issue)
            if remaining_issues:
                unresolved.append(f"{rid}: needs_revision 无可应用补丁，仍需核对（{'；'.join(remaining_issues)}）")
            elif has_missing_vocab_issue:
                resolved_without_patch.append(f"{rid}: 重点词已由来源词表补齐")

        for patch in patches:
            field = patch.get("field")
            before = patch.get("before")
            after = patch.get("after")
            reason = patch.get("reason", "")
            if not field:
                continue
            if (rid, field, before, after) in done:
                skipped.append(f"{rid}.{field}: 已在 patch_log 中，跳过（重复运行）")
                continue

            ok, resolved = apply_patch(rec, field, before, after)
            if ok is True:
                n_applied += 1
                if TURN_TEXT_RE.match(field) or TURN_SPK_RE.match(field) or TURN_SPK_ANY_RE.match(field):
                    turns_touched = True
                log.append({
                    "record_id": rid,
                    "field": field,
                    "before": before,
                    "after": after,
                    "reason": reason,
                    "reviewer": REVIEWER,
                })
            elif ok is False:
                skipped.append(f"{rid}.{field}: 已是目标值，跳过（可能已应用）")
            else:
                skipped.append(f"{rid}.{field}: 未找到与 patch.before 一致的原文，未应用")

        if turns_touched:
            old_text = rec["dialogue_text"]
            new_text = rebuild_dialogue_text(rec)
            if old_text != new_text:
                rec["dialogue_text"] = new_text
                log.append({
                    "record_id": rid,
                    "field": "dialogue_text",
                    "before": old_text,
                    "after": new_text,
                    "reason": "turns 修改后同步 dialogue_text，保证与 turns 一致",
                    "reviewer": REVIEWER,
                })

        if (rec["id"], rec["block_id"], rec["scene_id"], rec["level"]) != guard:
            print(f"!! {rid} 的 id/block_id/scene_id/level 被改动，终止", file=sys.stderr)
            return 2
        if n_applied:
            applied_ids.add(rid)

    # reject 记录写入 review_queue.json
    rq = json.loads(REVIEW_QUEUE.read_text(encoding="utf-8"))
    existing = {(i.get("type"), i.get("record_id")) for i in rq.get("items", [])}
    for row in rejects:
        key = ("reviewer_reject", row.get("id"))
        if key in existing:
            continue
        rq["items"].append({
            "type": "reviewer_reject",
            "record_id": row.get("id"),
            "word": None,
            "message": f"审核方判定为 reject：{'; '.join(row.get('issues', []) or []) or '未给出原因'}",
            "severity": "high",
            "suggested_action": "等待人工重写或废弃该条，不要由脚本自动改写",
        })
    rq["count"] = len(rq["items"])
    REVIEW_QUEUE.write_text(json.dumps(rq, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 合并写入 patch_log.json（含历史条目）
    existing_entries = []
    if PATCH_LOG.exists():
        existing_entries = json.loads(PATCH_LOG.read_text(encoding="utf-8")).get("entries", [])
    all_entries = existing_entries + log

    with SCENES.open("w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    PATCH_LOG.write_text(json.dumps({
        "schema_version": "daily_patch_log.v1",
        "reviewer": REVIEWER,
        "review_files": sorted({p.name for p in review_files}),
        "count": len(all_entries),
        "entries": all_entries,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"本次审核条目：{len(review_items)}")
    print(f"应用的记录：{len(applied_ids)} 条 -> {sorted(applied_ids)}")
    print(f"本次 patch_log 新增条目：{len(log)}（累计 {len(all_entries)}）")
    print(f"reject 记录：{len(rejects)}")
    if unresolved:
        print("未解决（needs_revision 无补丁，需人工）：")
        for u in unresolved:
            print(f"  - {u}")
    if resolved_without_patch:
        print("无需文本补丁、已由词汇流程处理：")
        for item in resolved_without_patch:
            print(f"  - {item}")
    if skipped:
        print("跳过：")
        for s in skipped:
            print(f"  - {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
