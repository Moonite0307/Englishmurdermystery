# 词汇字段补全报告

生成日期：2026-11-07
对应缺口清单：`validation_report.md` [15][17] 与 `review_queue.json` 原始 1356 条
处理对象：`vocabulary.json`（核心词 466 条）、`scenes.jsonl`（216 条记录的 target_words 887 条）

---

## 一、结论

截图里列的五项，**三项已实质性解决，一项改判，一项只能划边界**：

| 项目 | 原状态 | 现在 | 结果 |
|---|---|---|---|
| 392 个核心词缺 CEFR | 74/466（16%） | 411/466（88%） | 已补 337 个，仍缺 55 个 |
| 392 个核心词缺真题考频 | 74/466 | 未动 | **改判为非榜单词**，不再计为「缺失」 |
| 426 个核心词缺音标 | 40/466（9%） | 463/466（99%） | 已补 423 个，仍缺 3 个 |
| 100 个核心词缺中文释义 | 366/466（79%） | 427/466（92%） | 已补 61 个，仍缺 39 个 |
| 6 个来源待确认许可 | 6 条 unknown | 0 条 unknown | 已逐条判定并写入 `sources.json` |

核心词三字段全齐的从 0 条升到 **408/466**（87.6%）。

`review_queue.json` 从 **1356 条降到 529 条**，且条目性质变了：剩下的是真实待办，不再混着「本来就没有」的假缺口。

---

## 二、补全明细

### 2.1 CEFR 等级

- 来源：CEFR-J Wordlist v1.6（TUFS 投野研究室），取 ALL / ALL_sep 的 headword-pos-CEFR
- 补入 337 个核心词：A1 170、A2 64、B1 23、B2 16（含 65 条经词形还原命中，如 `menus → menu`、`booked → book`）
- 字段：`cefr`、`cefr_source`，还原命中的另记 `cefr_via_lemma`
- 没有 CEFR 的来源一律不猜：CEFR-J 只到 B2，缺 C1 不等于「无等级」

### 2.2 音标

- 来源：ipa-dict en_US（MIT，基于 cmudict-ipa）
- 补入 423 个核心词，`phonetic_source` = ipa-dict en_US (MIT)，`phonetic_accent` = en-US，`phonetic_status` = auto_matched
- 一词多读音原样保留（如 `accept` → `/ækˈsɛpt/, /əkˈsɛpt/`）
- 只取美式。英式那份是 GPL 3.0，不采用也不混用

### 2.3 中文释义

- 没有引入新来源，只用项目已有四份词表回查：九板块重点词表 → 真题考频总表 → 托福7000词净版 → 雅思8000词净版
- 补入 61 个，每条在 CSV 的 `meaning_via` / `meaning_source` 记明命中原形与出处
- 这一步覆盖率提升有限，原因见第三节

### 2.4 scenes.jsonl 同步

`scenes.jsonl` 的 `target_words` 是独立副本，不跟着 `vocabulary.json` 自动更新，所以同步写入了一次：

- 补 CEFR 748 条、音标 792 条、释义 62 条
- 现在 887 条词条覆盖：CEFR 876、音标 881、释义 882
- 结构校验：216 行、id、turns 数量、dialogue_text、target_words 条数全部未变，只有目标字段有差异（逐条比对通过，非预期差异 0）

---

## 三、仍缺什么，以及为什么

### 3.1 CEFR 仍缺 55 个

| 类别 | 数量 | 词 |
|---|---|---|
| 专名、地名、国籍 | 21 | america, american, british, chinese, french, indian, italian, england, paris, rome, york, vegas, louvre, george, harry, charlie, jackson, john, paul, tony, zaizen |
| 粗俗词与古语 | 5 | bastard, fuck, fucking, shit, thee |
| 缩略、口语粘连 | 6 | it'll, they're, they've, we'd, we've, ma'am |
| CEFR-J 未收录的普通词 | 13 | goodbye, gentlemen, lord, suite, buffet, landmark, colonel, plaza, gonna, prof, taxicab, one-way, wake-up |
| 生僻、专业词 | 10 | strychnine, pancreatic, depository, deposition, notary, fanfare, feverish, concierge, warfare, self-preservation |

前三类共 32 个，**问题不在资料，在词选**：专名、粗俗词、口语缩略形式本来就不该作为「核心词」出现在九板块重点词表里。

### 3.2 释义仍缺 39 个

与上面高度重叠：专名、粗俗词、缩略、生僻词占绝大多数。真正算正常词汇、只是四份词表都没收的只有 goodbye、madame、paperwork、landmark、concierge 等少数几个。

### 3.3 音标仍缺 3 个

`prof`（professor 的口语缩写）、`self-preservation`（复合词）、`zaizen`（专名）。三者都不在 ipa-dict 里，也不应该按拼写规则臆造。

---

## 四、真题考频：从「缺失」改判为「非榜单词」

这 392 个词在四六级词表、真题考频总表里一个都查不到，原因不是数据没下载，而是**它们本来就不在四六级/考研真题的高频榜**：

- 真题考频总表只有 2,551 个去重词，是「真题里出现过并被统计的词」，不是完整考纲
- 这 392 个是 restaurant、minutes、dollars 这类日常口语词，考纲词表不重点收
- 九板块重点词表里，293 个只有雅思/托福的 `Y` 收录标记，没有名次和句频；99 个连标记都没有

所以正确处理不是编一个数字填进去，而是把状态改准：

- `review_queue` 里 392 条 `missing_exam_frequency` 已替换为 `exam_not_in_list`
- 字段内容不变（`exam_frequency` 保持为空），语义从「缺数据」变成「已判定，不存在可填的真题考频」
- 这些词的词频参考统一用 `general_frequency`（wordfreq 3.1.1，已覆盖 385/466）

如果一定要给这批词一个可比较的数字，只能用工具体系不同的语料库词频（如 wordfreq 的 zipf），并明确标注「非真题考频」。用榜单名次冒充真题句频，是这套数据里最容易埋雷的地方。

---

## 五、6 个来源的许可判定

已全部写入 `sources.json`（新增 `license_status`、`redistributable`、`license_note` 三个字段）。

| 来源 | 判定 | 可再分发 |
|---|---|---|
| daily-dialogues（九板块标准场景对话） | 项目自有：AI 按《生成任务单-v2》产出，未复制第三方原文 | 是 |
| daily-keywords（九板块重点词表） | 混合来源：SGD（CC BY-SA 4.0）+ 影视字幕（许可不明）+ AI 生成对话派生 | **否** |
| exam-frequency（真题考频总表） | 第三方网站内容（懒笔记），未获书面授权 | **否** |
| ielts-vocab（雅思8000净版） | 用户提供的出版物 PDF 提取，版权归原出版方 | **否** |
| toefl-vocab（托福7000净版） | 同上 | **否** |
| subtitles（OpenSubtitles v2018） | 各影片版权不一，整体无法再分发 | **否** |

**这 6 条里只有 1 条能随项目公开**。剩下 5 条的实际约束是：

- 内部开发、内部训练、内部分发没有问题
- 一旦项目公开发布（含开源仓库、网页产品的公开仓库），这 5 类内容**不能随仓库一起出去**
- 破解办法有两个：一是发布时只提交加工后的统计结果（名次、等级等字段级信息，不含原文词条正文）；二是整体替换为许可清晰的等价来源
- `daily-keywords` 这一条最麻烦：它派生自字幕，而字幕许可不明，所以整张表被传染。要么剔除字幕派生部分只保留 SGD 部分（那样可以整体按 CC BY-SA 4.0 发布），要么整张表按「仅内部」处理

我没有替你做法律定性，只把事实边界摆出来。这三处（懒笔记、两本 PDF 词书、字幕）都不能算已获授权。

---

## 六、新增的两个来源

已落在 `训练资料/CEFR与音标/`，配套 `来源说明.txt` 写明许可、署名、使用边界：

| 文件 | 大小 | 许可 | 用途 |
|---|---|---|---|
| `CEFRJ_wordlist_ver1.6.zip` | 1,089,155 B | 版权归 TUFS 投野研究室，研究与教育及商用均可免费使用，须署名 | 补 CEFR（A1–B2） |
| `ipa-dict_en_US.txt` | 3,180,267 B | MIT（基于 cmudict-ipa，MIT） | 补美式 IPA |

---

## 七、下一步该做什么（按优先级）

1. **清理核心词表**：把上面 32 个专名/粗俗词/缩略形式从九板块重点词表与 target_words 里剔掉。这一步做完，剩的「缺口」会从 55/39/3 直接降到十几条，剩下的是真正需要人工核对的词。
2. **决定公开发布边界**：按第五节的结论，把 5 类「仅内部」来源与仓库分离，否则项目公开那天就是侵权那天。
3. **音标统一**：40 条 `phonetic_needs_spot_check` 是早期从托福词表抽的，口音未标。既然现在有了统一的 ipa-dict 美式音标，建议整批替换成 ipa-dict 并撤掉抽查项——这一步我没做，因为会覆盖已有数据，需要你确认。
4. **补 C1 及以上**：CEFR-J 到 B2 为止。如果产品需要 C1，得另找带 C1 标注且许可清晰的词表。

---

## 八、可复现

补全全部由脚本生成，无手工填值。关键中间产物：

- `vocab_field_completion.csv`（本目录）：510 条逐词明细，每个补入值都带 `*_via`（命中的原形）和 `*_source`（出处）
- 备份：`vocabulary.20261107.json.bak`、`scenes.20261107.jsonl.bak`、`review_queue.20261107.json.bak`、`sources.20261107.json.bak`、`validation_report.20261107.bak`

复核命令：`python scripts/daily/validate_daily_data.py`，重跑后 [15][17] 会反映新覆盖率（本次已重跑，结论仍为「校验通过」，缺陷 0、warn 0）。

---

## 九、没做的事

- 没有给任何词编造 CEFR、音标、释义或考频。所有补入值都有出处，查不到就留空。
- 没有改动 216 条对话的正文、轮次、task_goal、target_words 的选取，只填字段。
- 没有提交 git。数据文件已改动，是否入库由你决定。
- 40 条音标抽查项没有处理，理由见第七节第 3 条。
