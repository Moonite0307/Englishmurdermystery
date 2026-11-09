# 日常场景交涉数据校验报告

由 `scripts/daily/validate_daily_data.py` 自动生成。

- [1] 对话总数：216 / 216 ✔
- [2] 板块数量：9（每板块 24 条）
    - 01：24 条
    - 02：24 条
    - 03：24 条
    - 04：24 条
    - 05：24 条
    - 06：24 条
    - 07：24 条
    - 08：24 条
    - 09：24 条
- [3] 场景数量：72（每场景 3 条）
- [4] 各等级记录数：{'A2': 72, 'B1': 72, 'B2': 72}
- [5] 重复 id：0
- [6] 缺少 turns：0
- [7] 少于 6 轮：0
- [8] 非法 speaker：0
- [9] 空台词：0
- [10] dialogue_text 不一致：0
- [11] 中文旁白：0；含括号：0
- [12] target_words 非数组：0；为空：0
- [13] 缺失的 source_ref：0（共检查 17 个不同来源）
- [15] vocabulary.json 可解析，词条数：510，来源分布：{'block_keywords': 466, 'scene_target_extension': 44}，状态分布：{'partial': 392, 'verified': 74, 'supplemental': 44}
    - 核心词字段覆盖：释义 427/466；CEFR 411/466；真题考频 74/466；音标 463/466；一般词频参考 385/466
- [16] scene_catalog.json：72 / 72 ✔
- [17] review_queue.json：529 条，类型分布：{'phonetic_needs_spot_check': 40, 'missing_cefr': 55, 'missing_meaning': 39, 'missing_phonetic': 3, 'exam_not_in_list': 392}

## 汇总

- 总记录数：216
- 板块数量：9
- 场景数量：72
- 每个等级数量：{'A2': 72, 'B1': 72, 'B2': 72}
- 缺陷数量（fail）：0
- 提醒数量（warn）：0
- review_queue 数量：529
- 结论：校验通过
