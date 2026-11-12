#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prepare_daily_data.py
日常场景交涉数据构建脚本。

用途：
  解析「训练资料/日常场景交涉」下九个板块的标准场景对话（txt），
  结合九板块重点词表、真题考频总表，生成前端可读取的：
    Englishmurdermystery/data/daily/scenes.jsonl
    Englishmurdermystery/data/daily/vocabulary.json
    Englishmurdermystery/data/daily/scene_catalog.json
    Englishmurdermystery/data/daily/sources.json
    Englishmurdermystery/data/daily/review_queue.json

原则：
  - 只读取原始资料，绝不修改原始 txt / csv / jsonl / json。
  - 不读取、不显示、不修改任何 API 密钥。
  - 不编造 CEFR、音标、释义、考频、许可证；资料里没有的字段一律 null / 空。
  - 雅思/托福词表只补充有明确词条的释义、词性和托福表中存在的 IPA；开放词频
    单独写入 general_frequency，不能替代 exam_frequency。
  - 审核选定的场景补充词保留为 vocab_origin=scene_target_extension，不冒充九板块核心词。
  - 无法确定的信息写入 review_queue.json，交给人工核对。

运行：
  python Englishmurdermystery/scripts/daily/prepare_daily_data.py
"""

from __future__ import annotations

import csv
import json
import re
import unicodedata
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------
SCRIPT_PATH = Path(__file__).resolve()
REPO_DIR = SCRIPT_PATH.parents[2]            # Englishmurdermystery
PROJECT_ROOT = REPO_DIR.parent               # 词境寻真 Cijing Xunzhen
TRAIN_DIR = PROJECT_ROOT / "训练资料"
DAILY_SRC_DIR = TRAIN_DIR / "日常场景交涉"
OUT_DIR = REPO_DIR / "data" / "daily"

KEYWORD_CSV = DAILY_SRC_DIR / "九板块重点词表.csv"
EXAM_FREQ_CSV = TRAIN_DIR / "cet- 四六级词表 + 真题 + 考频" / "真题考频总表.csv"
IELTS_VOCAB_CSV = TRAIN_DIR / "雅思托福" / "雅思8000词_净版.csv"
TOEFL_VOCAB_CSV = TRAIN_DIR / "雅思托福" / "托福7000词_净版.csv"

# 这些表只用于补充已存在的词条信息；它们没有 CEFR 或 CET/考研真题句频，
# 因此不会被写入 exam_frequency。
GENERAL_FREQ_SPECS = (
    ("secondary", TRAIN_DIR / "中高考" / "开放词频参考" / "secondary_open_frequency_1600.csv"),
    ("gaokao", TRAIN_DIR / "中高考" / "开放词频参考" / "gaokao_open_frequency_3500.csv"),
    ("cet4_open", TRAIN_DIR / "cet- 四六级词表 + 真题 + 考频" / "开放词频参考" / "cet4_open_frequency_4500.csv"),
    ("cet6_open", TRAIN_DIR / "cet- 四六级词表 + 真题 + 考频" / "开放词频参考" / "cet6_open_frequency_5500.csv"),
)

KEYWORD_CSV_REL = "训练资料/日常场景交涉/九板块重点词表.csv"
EXAM_FREQ_CSV_REL = "训练资料/cet- 四六级词表 + 真题 + 考频/真题考频总表.csv"
IELTS_VOCAB_CSV_REL = "训练资料/雅思托福/雅思8000词_净版.csv"
TOEFL_VOCAB_CSV_REL = "训练资料/雅思托福/托福7000词_净版.csv"
GENERAL_FREQ_RELS = {
    "secondary": "训练资料/中高考/开放词频参考/secondary_open_frequency_1600.csv",
    "gaokao": "训练资料/中高考/开放词频参考/gaokao_open_frequency_3500.csv",
    "cet4_open": "训练资料/cet- 四六级词表 + 真题 + 考频/开放词频参考/cet4_open_frequency_4500.csv",
    "cet6_open": "训练资料/cet- 四六级词表 + 真题 + 考频/开放词频参考/cet6_open_frequency_5500.csv",
}

SCHEMA_VERSION = "daily_scene.v1"

# 板块 id 顺序固定，用于稳定生成 scene_id
BLOCK_IDS = ["01", "02", "03", "04", "05", "06", "07", "08", "09"]
LEVEL_ORDER = ["A2", "B1", "B2"]

# ---------------------------------------------------------------------------
# 场景任务元数据（依据「板块 + 场景名」推导，中文描述；固定英文功能标签）
# 结构： block_id -> {scene_name: (task_goal, [success_criteria], [functions])}
# ---------------------------------------------------------------------------
SCENE_META: dict[str, dict[str, tuple]] = {
    "01": {
        "电话预订桌位": (
            "通过电话预订餐厅桌位并确认时间、人数与预订信息",
            ["说明用餐时间与人数", "询问可预订的时段或替代时间", "确认预订姓名与联系方式"],
            ["make_a_reservation", "ask_for_information", "confirm", "end_a_conversation"],
        ),
        "到店入座": (
            "到店后说明预订并顺利入座",
            ["说明预订信息", "询问等待时间或座位安排", "确认入座"],
            ["request", "ask_for_information", "clarify", "confirm"],
        ),
        "看菜单点菜": (
            "看懂菜单并完成点餐",
            ["询问菜品内容与价格", "说明口味偏好或提出替换", "确认所点菜品"],
            ["ask_for_information", "request", "clarify", "confirm"],
        ),
        "特殊饮食要求": (
            "说明饮食禁忌并确认菜品是否安全",
            ["说明过敏或饮食限制", "请服务员核对食材与做法", "确认可接受的替代菜品"],
            ["describe_problem", "ask_for_information", "request", "confirm"],
        ),
        "菜品出问题": (
            "反馈菜品问题并取得补救",
            ["说明菜品的问题", "要求更换或重做", "确认补救结果"],
            ["describe_problem", "make_a_complaint", "request", "confirm"],
        ),
        "结账与小费": (
            "结账付款并处理账单与小费",
            ["要求结账", "核对账单或要求分单", "确认付款与小费"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "外带打包": (
            "要求把餐食打包外带并交代打包要求",
            ["说明要打包的食物", "提出打包方式要求", "确认打包结果"],
            ["request", "clarify", "confirm", "end_a_conversation"],
        ),
        "快餐柜台点单": (
            "在快餐柜台完成点单与付款",
            ["说明想点的套餐与规格", "询问加料或替换", "确认订单与取餐信息"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
    },
    "02": {
        "试穿衣服": (
            "试穿衣服并确定合适的尺码",
            ["说明想试的商品", "询问尺码与试衣间位置", "确认尺码并决定购买"],
            ["request", "ask_for_information", "clarify", "confirm"],
        ),
        "问价与折扣": (
            "询问商品价格并争取折扣",
            ["询问价格与优惠", "说明可比较的价格或优惠资格", "确认最终价格"],
            ["ask_for_information", "negotiate", "request", "confirm"],
        ),
        "退换货": (
            "在商店说明商品问题并完成退货或换货",
            ["说明购买的商品和存在的问题", "询问退换条件", "确认退款或换货结果"],
            ["describe_problem", "ask_for_information", "request", "confirm"],
        ),
        "结账付款": (
            "完成结账并向收银员确认付款方式",
            ["询问或说明付款方式", "处理找零或分单", "确认付款完成并索取收据"],
            ["request", "make_a_payment", "clarify", "confirm"],
        ),
        "缺货与调货": (
            "询问缺货商品并申请调货或预留",
            ["说明想要的商品", "询问其他门店库存或到货时间", "确认调货或预留安排"],
            ["ask_for_information", "request", "confirm", "end_a_conversation"],
        ),
        "网购客服": (
            "联系网店客服处理订单问题",
            ["说明订单问题", "提供订单信息并询问处理方案", "确认退款或补发结果"],
            ["describe_problem", "make_a_complaint", "request", "confirm"],
        ),
        "超市找商品": (
            "在超市向店员询问并找到目标商品",
            ["询问商品位置", "确认规格或优惠信息", "致谢并确认购买"],
            ["ask_for_information", "ask_for_directions", "clarify", "confirm"],
        ),
        "售后保修": (
            "申请售后维修或保修",
            ["说明故障与购买信息", "询问保修范围与流程", "确认维修安排"],
            ["describe_problem", "ask_for_information", "request", "confirm"],
        ),
    },
    "03": {
        "公交问路线": (
            "询问公交路线并确认乘车方式",
            ["说明目的地", "询问线路与换乘或车费", "确认下车站点"],
            ["ask_for_information", "ask_for_directions", "clarify", "confirm"],
        ),
        "地铁买票与换乘": (
            "购买地铁票并完成换乘",
            ["询问购票方式与票价", "询问换乘路线", "确认方向与站点"],
            ["request", "ask_for_information", "ask_for_directions", "confirm"],
        ),
        "打车": (
            "打车并向司机说明目的地与要求",
            ["说明目的地", "询问车费或所需时间", "确认下车地点与付款"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "火车票购买与改签": (
            "购买火车票或办理改签",
            ["说明出行时间与车次", "询问票价与座位", "确认购买或改签结果"],
            ["request", "ask_for_information", "negotiate", "confirm"],
        ),
        "机场值机与安检": (
            "办理机场值机并通过安检",
            ["说明航班与证件", "询问行李与座位安排", "确认登机信息"],
            ["ask_for_information", "request", "clarify", "confirm"],
        ),
        "租车": (
            "租车并确认租车条件",
            ["说明租车需求与时间", "询问车型、价格与保险", "确认取还车与押金"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "交通违章处理": (
            "处理交通违章并缴纳罚款",
            ["说明违章情况", "询问罚款与处理流程", "确认缴纳与后续事项"],
            ["describe_problem", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "拼车/网约车": (
            "使用拼车或网约车出行",
            ["说明上车地点与目的地", "询问等待时间与费用", "确认行程与付款"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
    },
    "04": {
        "预订房间": (
            "预订酒店房间",
            ["说明入住日期与人数", "询问房型与价格", "确认预订信息"],
            ["make_a_reservation", "ask_for_information", "negotiate", "confirm"],
        ),
        "入住登记": (
            "办理酒店入住登记",
            ["说明预订信息与证件", "询问房间与设施", "确认入住"],
            ["request", "ask_for_information", "clarify", "confirm"],
        ),
        "房间问题": (
            "反馈房间问题并请求解决",
            ["说明房间问题", "要求换房或维修", "确认解决结果"],
            ["describe_problem", "make_a_complaint", "request", "confirm"],
        ),
        "客房服务与叫早": (
            "请求客房服务或叫早服务",
            ["说明服务需求与时间", "询问是否收费", "确认服务安排"],
            ["request", "ask_for_information", "confirm", "end_a_conversation"],
        ),
        "延住与换房": (
            "办理延住或换房",
            ["说明延住或换房需求", "询问可行性与费用", "确认新的住宿安排"],
            ["request", "ask_for_information", "negotiate", "confirm"],
        ),
        "退房结账": (
            "办理退房并结清账单",
            ["说明要退房", "核对账单与消费", "确认付款与发票"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "行李寄存": (
            "在前台寄存或领取行李",
            ["说明寄存需求与时间", "询问手续与凭证", "确认领取安排"],
            ["request", "ask_for_information", "confirm", "end_a_conversation"],
        ),
        "投诉与索赔": (
            "就酒店问题提出投诉并索赔",
            ["说明问题与损失", "要求赔偿或补救", "确认处理结果"],
            ["make_a_complaint", "describe_problem", "negotiate", "confirm"],
        ),
    },
    "05": {
        "街头问路": (
            "在街上询问前往目的地的路线",
            ["说明要去的地点", "询问走法与方向", "确认路线并致谢"],
            ["ask_for_directions", "ask_for_information", "clarify", "end_a_conversation"],
        ),
        "问地铁/公交站位置": (
            "询问地铁或公交站的位置",
            ["说明要找的车站", "询问具体位置与入口", "确认方向并致谢"],
            ["ask_for_directions", "ask_for_information", "confirm", "end_a_conversation"],
        ),
        "找地标": (
            "询问如何找到某地标",
            ["说明要找的地标", "询问路线或参照物", "确认方位"],
            ["ask_for_directions", "ask_for_information", "clarify", "confirm"],
        ),
        "给陌生人指路": (
            "为问路的陌生人指路",
            ["询问对方目的地", "说明路线与标志物", "确认对方理解"],
            ["ask_for_information", "clarify", "confirm", "end_a_conversation"],
        ),
        "迷路求助": (
            "迷路时向他人求助",
            ["说明自己迷路与目的地", "请求帮助", "确认路线并致谢"],
            ["describe_problem", "request", "ask_for_directions", "confirm"],
        ),
        "问距离与步行时间": (
            "询问距离与步行所需时间",
            ["询问距离", "询问步行时间与方式", "确认自己的判断"],
            ["ask_for_information", "ask_for_directions", "clarify", "confirm"],
        ),
        "问停车场位置与收费": (
            "询问停车场位置与收费",
            ["说明要找停车场", "询问位置与收费标准", "确认入场方式"],
            ["ask_for_directions", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "问路时的确认与致谢": (
            "复述并确认路线后向对方致谢",
            ["复述路线以确认", "询问不理解之处", "感谢对方帮助"],
            ["clarify", "confirm", "ask_for_directions", "end_a_conversation"],
        ),
    },
    "06": {
        "挂号与分诊": (
            "挂号并完成分诊",
            ["说明就诊需求", "提供个人信息与症状", "确认科室与候诊安排"],
            ["request", "ask_for_information", "describe_symptoms", "confirm"],
        ),
        "描述症状": (
            "向医生描述症状",
            ["说明症状与持续时间", "回答医生追问", "确认双方理解一致"],
            ["describe_symptoms", "ask_for_information", "clarify", "confirm"],
        ),
        "医生问诊": (
            "配合医生问诊并了解病情",
            ["回答医生询问", "询问病因与检查", "确认诊断"],
            ["ask_for_information", "describe_symptoms", "clarify", "confirm"],
        ),
        "开药与取药": (
            "拿到处方并取药",
            ["询问用药方法与剂量", "确认取药流程", "确认注意事项"],
            ["ask_for_information", "request", "clarify", "confirm"],
        ),
        "复诊与复查": (
            "进行复诊或复查",
            ["说明复诊原因", "询问检查结果", "确认后续治疗"],
            ["describe_symptoms", "ask_for_information", "confirm", "end_a_conversation"],
        ),
        "急诊": (
            "在急诊说明紧急情况并求助",
            ["说明紧急症状", "请求立即处理", "确认处置安排"],
            ["describe_symptoms", "request", "ask_for_information", "confirm"],
        ),
        "体检咨询": (
            "咨询体检项目与安排",
            ["说明体检需求", "询问项目与费用", "确认预约时间"],
            ["ask_for_information", "request", "make_a_reservation", "confirm"],
        ),
        "药店买药": (
            "在药店购买药品",
            ["说明症状与需求", "询问药品用法与禁忌", "确认购买"],
            ["describe_symptoms", "ask_for_information", "request", "make_a_payment"],
        ),
    },
    "07": {
        "开户": (
            "在银行开立账户",
            ["说明开户需求与账户类型", "提供证件并询问流程", "确认开户结果"],
            ["request", "ask_for_information", "clarify", "confirm"],
        ),
        "存取款": (
            "办理存款或取款",
            ["说明金额与方式", "提供账户信息", "确认交易结果"],
            ["request", "make_a_payment", "ask_for_information", "confirm"],
        ),
        "转账汇款": (
            "办理转账或汇款",
            ["说明转账金额与对象", "询问手续费与到账时间", "确认转账完成"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "信用卡申请": (
            "申请信用卡",
            ["说明申请需求", "询问额度与所需材料", "确认申请与后续流程"],
            ["request", "ask_for_information", "negotiate", "confirm"],
        ),
        "挂失与补卡": (
            "办理银行卡挂失并补卡",
            ["说明卡丢失情况", "询问挂失与补卡流程", "确认补卡安排"],
            ["describe_problem", "request", "ask_for_information", "confirm"],
        ),
        "外币兑换": (
            "办理外币兑换",
            ["说明兑换币种与金额", "询问汇率与手续费", "确认兑换结果"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "办证": (
            "办理证件",
            ["说明要办理的证件", "询问所需材料与流程", "确认办理结果"],
            ["request", "ask_for_information", "clarify", "confirm"],
        ),
        "填表与签字": (
            "完成表格填写与签字",
            ["询问填写方式", "确认信息与签字位置", "确认提交"],
            ["ask_for_information", "clarify", "request", "confirm"],
        ),
    },
    "08": {
        "买景点门票": (
            "购买景点门票",
            ["说明参观日期与人数", "询问票价与优惠", "确认购票与入场方式"],
            ["request", "ask_for_information", "make_a_payment", "confirm"],
        ),
        "参加一日游": (
            "报名参加一日游",
            ["说明参加意愿与人数", "询问行程与价格", "确认报名"],
            ["make_a_reservation", "ask_for_information", "negotiate", "confirm"],
        ),
        "景点讲解": (
            "听取景点讲解并询问相关信息",
            ["询问景点历史与看点", "追问细节", "确认理解"],
            ["ask_for_information", "clarify", "confirm", "end_a_conversation"],
        ),
        "游客中心咨询": (
            "在游客中心咨询游览信息",
            ["说明咨询需求", "询问路线与设施", "确认信息"],
            ["ask_for_information", "ask_for_directions", "clarify", "confirm"],
        ),
        "请人帮忙拍照": (
            "请路人帮忙拍照",
            ["礼貌请求帮助", "说明拍照要求", "感谢对方"],
            ["request", "clarify", "confirm", "end_a_conversation"],
        ),
        "买纪念品": (
            "购买纪念品",
            ["询问商品与价格", "比较或议价", "确认购买"],
            ["ask_for_information", "negotiate", "make_a_payment", "confirm"],
        ),
        "行程咨询": (
            "咨询行程安排",
            ["说明行程需求", "询问路线与时间", "确认行程方案"],
            ["ask_for_information", "request", "clarify", "confirm"],
        ),
        "遇到问题": (
            "在旅途中遇到走散或丢东西等问题时求助",
            ["说明遇到的问题", "请求帮助", "确认解决方案"],
            ["describe_problem", "request", "ask_for_information", "confirm"],
        ),
    },
    "09": {
        "初次见面与自我介绍": (
            "初次见面并作自我介绍",
            ["自我介绍并询问对方", "寒暄互动", "礼貌结束谈话"],
            ["ask_for_information", "clarify", "accept", "end_a_conversation"],
        ),
        "天气与季节闲聊": (
            "就天气与季节展开闲聊",
            ["开启话题", "回应并补充细节", "自然结束谈话"],
            ["ask_for_information", "clarify", "accept", "end_a_conversation"],
        ),
        "周末与假期计划": (
            "聊周末与假期计划",
            ["询问或说明计划", "回应并补充", "自然结束谈话"],
            ["ask_for_information", "accept", "clarify", "end_a_conversation"],
        ),
        "兴趣爱好": (
            "聊兴趣爱好",
            ["询问对方兴趣", "介绍自己的兴趣", "回应并结束谈话"],
            ["ask_for_information", "clarify", "accept", "end_a_conversation"],
        ),
        "工作与学习": (
            "聊工作与学习情况",
            ["询问对方工作或学业", "介绍自己的情况", "回应并结束谈话"],
            ["ask_for_information", "clarify", "accept", "end_a_conversation"],
        ),
        "家庭与朋友": (
            "聊家庭与朋友",
            ["询问对方家庭或朋友", "介绍自己的情况", "回应并结束谈话"],
            ["ask_for_information", "clarify", "accept", "end_a_conversation"],
        ),
        "邀请与赴约": (
            "发出或接受邀请并约定时间地点",
            ["发出或回应邀请", "确认时间与地点", "确认赴约"],
            ["request", "make_a_reservation", "accept", "confirm"],
        ),
        "告别与约定下次": (
            "告别并约定下次见面",
            ["表达告别", "约定下次见面的时间", "礼貌结束谈话"],
            ["request", "make_a_reservation", "accept", "end_a_conversation"],
        ),
    },
}

# index.html 中 DAILY_BLOCKS 的场景名（用于比对差异；以训练资料为准）
INDEX_SCENES: dict[str, list[str]] = {
    "01": ["电话预订桌位", "到店入座", "看菜单点菜", "特殊饮食要求", "菜品出问题", "结账与小费", "外带打包", "快餐柜台点单"],
    "02": ["试穿衣服", "问价与折扣", "退换货", "结账付款", "缺货与调货", "网购客服", "超市找商品", "售后保修"],
    "03": ["公交问路线", "地铁买票与换乘", "打车", "火车票购买与改签", "机场值机与安检", "租车", "交通违章处理", "拼车/网约车"],
    "04": ["预订房间", "入住登记", "房间问题", "客房服务与叫早", "延住与换房", "退房结账", "行李寄存", "投诉与索赔"],
    "05": ["街头问路", "问地铁/公交站位置", "找地标", "给陌生人指路", "迷路求助", "问距离与步行时间", "问停车场位置与收费", "问路时的确认与致谢"],
    "06": ["挂号与分诊", "描述症状", "医生问诊", "开药与取药", "复诊与复查", "急诊", "体检咨询", "药店买药"],
    "07": ["开户", "存取款", "转账汇款", "信用卡申请", "挂失与补卡", "外币兑换", "办证", "填表与签字"],
    "08": ["买景点门票", "参加一日游", "景点讲解", "游客中心咨询", "请人帮忙拍照", "买纪念品", "行程咨询", "遇到问题"],
    "09": ["初次见面与自我介绍", "天气与季节闲聊", "周末与假期计划", "兴趣爱好", "工作与学习", "家庭与朋友", "邀请与赴约", "告别与约定下次"],
}

# 由审核意见逐条挑选的高价值词：只在原对话中实际出现，且必须能在
# 已下载雅思/托福词表中查到词条后才会加入；不以店名或单词形似关系凑数。
TARGET_WORD_ADDITIONS = {
    "daily-02-01-A2-001": ["jacket", "fitting", "size", "fit"],
    "daily-02-01-B1-002": ["jacket", "fitting", "sleeve", "shoulder", "fit", "try"],
    "daily-02-01-B2-003": ["coat", "shoulder", "fitting", "comfortable", "return"],
    "daily-02-03-B1-008": ["stock", "return"],
    "daily-02-05-A2-013": ["stock", "phone", "call", "arrive"],
    "daily-02-07-A2-019": ["aisle", "shelf", "flour"],
    "daily-06-07-A2-019": ["appointment", "fast", "health", "test", "water", "card"],
    "daily-08-05-A2-013": ["photo", "fountain", "phone", "picture", "stand"],
    "daily-08-08-A2-022": ["ticket", "gate", "jacket", "staff", "contact", "wait"],
    "daily-08-08-B2-024": ["security", "contact", "medical", "description", "entrance", "gallery", "staff"],
    "daily-09-04-A2-010": ["music", "guitar", "instrument", "practice", "enjoy"],
    "daily-09-05-B1-014": ["job", "client", "meeting", "training", "course", "manager", "comfortable"],
    "daily-09-05-B2-015": ["urban", "community", "communication", "resident", "project", "engagement", "approach"],
}

# 审核明确指出的低价值或误匹配标注。这里仅移除 target_words 里的标记，
# 不删除总词库中的词，也不改动对话原文。
TARGET_WORD_EXCLUSIONS = {
    "daily-02-01-A2-001": ["clothes"],  # 只出现在店名 Harbor Clothes
    "daily-02-01-B2-003": ["dollars"],
    "daily-02-03-B1-008": ["market", "problem"],  # market 只在店名 North Market 中
    "daily-02-03-B2-009": ["need"],
    "daily-02-04-B1-011": ["market", "need"],  # market 只在店名 River Market 中
    "daily-02-04-B2-012": ["here's"],
    "daily-02-05-A2-013": ["store"],  # 首次出现为店名，后文也只是弱泛词
    "daily-02-06-A2-016": ["need"],
    "daily-02-06-B2-018": ["need"],
    "daily-02-07-A2-019": ["market"],  # 只在店名 Family Market 中
    "daily-02-07-B2-021": ["need"],
}

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
PAREN_ACTION_RE = re.compile(r"^\s*[\(\[\（【].*[\)\]\）】]\s*$")


def nfkc_lower(text: str) -> str:
    return unicodedata.normalize("NFKC", text).lower()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    """读取 UTF-8/UTF-8-BOM CSV，缺失文件由调用方记录为来源问题。"""
    if not path.exists():
        return []
    return list(csv.DictReader(read_text(path).splitlines()))


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# 1. 解析标准场景对话
# ---------------------------------------------------------------------------
HEADER_RE = re.compile(
    r"^###BLOCK:\s*(?P<block>[^|]+?)\s*\|\s*SCENE:\s*(?P<scene>[^|]+?)\s*\|\s*LEVEL:\s*(?P<level>[^|\s]+)\s*$"
)
TURN_RE = re.compile(r"^(?P<spk>[A-Za-z])\s*[:：]\s*(?P<txt>.*)$")


def parse_dialogue_file(path: Path, review: list) -> list[dict]:
    """解析单个板块的标准场景对话文件，返回 entries（未排序、未生成 id）。"""
    rel = path.relative_to(PROJECT_ROOT).as_posix()
    lines = read_text(path).splitlines()
    entries: list[dict] = []

    header = None
    turns: list[dict] = []
    seen_end = False
    start_line = 0

    def flush():
        nonlocal header, turns, seen_end
        if header is None:
            return
        if not seen_end:
            review.append({
                "type": "missing_end_marker",
                "record_id": None,
                "word": None,
                "message": f"「{rel}」第 {start_line} 行起的对话缺少 ###END 结束标记",
                "severity": "high",
                "suggested_action": "等待人工核对原始文件，不要由脚本补写",
            })
        if not turns:
            review.append({
                "type": "empty_dialogue",
                "record_id": None,
                "word": None,
                "message": f"「{rel}」第 {start_line} 行起的对话没有任何台词",
                "severity": "high",
                "suggested_action": "等待人工核对原始文件",
            })
        entries.append({
            "block_name": header["block"],
            "scene_name": header["scene"],
            "level": header["level"],
            "turns": turns,
            "source_file": rel,
            "start_line": start_line,
        })
        header, turns, seen_end = None, [], False

    for idx, raw in enumerate(lines, start=1):
        line = raw.rstrip("\r\n")
        if line.strip() == "":
            continue
        if line.startswith("###BLOCK:"):
            flush()
            m = HEADER_RE.match(line.strip())
            if not m:
                review.append({
                    "type": "malformed_block_header",
                    "record_id": None,
                    "word": None,
                    "message": f"「{rel}」第 {idx} 行 BLOCK 头无法解析：{line.strip()[:80]}",
                    "severity": "high",
                    "suggested_action": "等待人工核对原始文件格式",
                })
                header = None
                start_line = idx
                continue
            header = {"block": m.group("block").strip(), "scene": m.group("scene").strip(),
                      "level": m.group("level").strip()}
            start_line = idx
            turns = []
            seen_end = False
        elif line.strip() == "###END":
            seen_end = True
            flush()
        elif header is not None:
            m = TURN_RE.match(line.strip())
            if m:
                turns.append({"speaker": m.group("spk").upper(), "text": m.group("txt").strip()})
            else:
                review.append({
                    "type": "unparsed_line",
                    "record_id": None,
                    "word": None,
                    "message": f"「{rel}」第 {idx} 行无法识别为台词：{line.strip()[:80]}",
                    "severity": "medium",
                    "suggested_action": "等待人工核对原始文件",
                })
    flush()
    return entries


# ---------------------------------------------------------------------------
# 2. 词汇资源
# ---------------------------------------------------------------------------
def parse_pos(meaning: str) -> list[str]:
    """从释义里解析词性标签（n. / v. / adj. ...），不推测。"""
    pos: list[str] = []
    for seg in re.split(r"[|｜]", meaning):
        m = re.match(r"\s*([a-zA-Z]+)\.", seg)
        if m:
            tag = m.group(1).lower()
            if tag not in pos:
                pos.append(tag)
    return pos


def split_meanings(meaning: str) -> list[str]:
    if not meaning or not meaning.strip():
        return []
    return [seg.strip() for seg in re.split(r"[|｜]", meaning) if seg.strip()]


def parse_external_pos(value: str) -> list[str]:
    """读取外部词表明确给出的词性标签，不从词义推断。"""
    tags = re.findall(r"(?<![a-z])(?:n|v|vt|vi|adj|adv|a|ad|prep|conj|pron|num|int)\.", value or "", re.I)
    return list(dict.fromkeys(tag[:-1].lower() for tag in tags))


def load_lexical_sources(review: list) -> dict[str, dict[str, dict]]:
    """按精确词形加载雅思/托福释义；仅托福表的非空 IPA 作为未指定口音音标。"""
    result: dict[str, dict[str, dict]] = {}
    for source_id, path in (("ielts", IELTS_VOCAB_CSV), ("toefl", TOEFL_VOCAB_CSV)):
        if not path.exists():
            review.append({
                "type": "missing_vocabulary_source",
                "record_id": source_id,
                "word": None,
                "message": f"词汇来源文件不存在：{path.relative_to(PROJECT_ROOT).as_posix()}",
                "severity": "high",
                "suggested_action": "恢复该资料文件后重新生成",
            })
            continue
        for row in read_csv_rows(path):
            word = nfkc_lower((row.get("单词") or "").strip())
            if not word:
                continue
            source_rows = result.setdefault(word, {})
            previous = source_rows.get(source_id)
            score = sum(bool((row.get(field) or "").strip()) for field in ("词性", "释义", "音标"))
            old_score = sum(bool((previous.get(field) or "").strip()) for field in ("词性", "释义", "音标")) if previous else -1
            if score > old_score:
                source_rows[source_id] = row
    return result


def load_general_frequency_sources(review: list) -> dict[str, dict[str, dict]]:
    """加载开放语料词频，保留其来源，绝不并入考试真题考频。"""
    result: dict[str, dict[str, dict]] = {}
    for source_id, path in GENERAL_FREQ_SPECS:
        if not path.exists():
            review.append({
                "type": "missing_vocabulary_source",
                "record_id": f"{source_id}-open-frequency",
                "word": None,
                "message": f"开放词频文件不存在：{path.relative_to(PROJECT_ROOT).as_posix()}",
                "severity": "medium",
                "suggested_action": "恢复该资料文件后重新生成",
            })
            continue
        for row in read_csv_rows(path):
            word = nfkc_lower((row.get("word") or "").strip())
            if not word:
                continue
            try:
                rank = int(row["rank"])
                zipf = float(row["zipf_frequency_estimate"])
            except (KeyError, TypeError, ValueError):
                continue
            result.setdefault(word, {})[source_id] = {
                "rank": rank,
                "zipf_frequency_estimate": zipf,
                "source": (row.get("source") or "wordfreq 3.1.1 large_en").strip(),
            }
    return result


def regular_singular(word: str) -> str | None:
    """仅做规则的复数还原；不处理不规则变化，避免强行匹配。"""
    w = word
    if len(w) < 4:
        return None
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith(("ches", "shes", "xes", "zes", "sses")):
        return w[:-2]
    if w.endswith("s") and not w.endswith(("ss", "us", "is")):
        return w[:-1]
    return None


def build_vocabulary(keyword_rows: list[dict], exam_index: dict,
                     lexical_index: dict[str, dict[str, dict]],
                     general_frequency_index: dict[str, dict[str, dict]],
                     review: list) -> tuple[dict, dict]:
    """按词元合并九板块重点词，返回 (vocab_by_word, surface_to_lemma)。"""
    headwords = {nfkc_lower(r["单词"]) for r in keyword_rows if r["单词"].strip()}

    def lemma_of(word: str) -> str:
        w = nfkc_lower(word)
        cand = regular_singular(w)
        if cand and cand in headwords:
            return cand
        return w

    merged: dict[str, dict] = {}
    for row in keyword_rows:
        raw_word = row["单词"].strip()
        if not raw_word:
            continue
        surface = nfkc_lower(raw_word)
        lemma = lemma_of(raw_word)

        entry = merged.setdefault(lemma, {
            "word": lemma,
            "lemma": lemma,
            "surface_forms": [],
            "parts_of_speech": [],
            "meanings_zh": [],
            "cefr": None,
            "phonetic": None,
            "phonetic_source": None,
            "exam_frequency": {
                "cet4": {"rank": None, "frequency": None},
                "cet6": {"rank": None, "frequency": None},
                "kaoyan": {"rank": None, "frequency": None},
            },
            "general_frequency": {},
            "scene_blocks": [],
            "vocab_origin": "block_keywords",
            "source_refs": [KEYWORD_CSV_REL],
            "_cefr_values": set(),
            "_cefr_conflict": False,
        })

        if surface not in entry["surface_forms"]:
            entry["surface_forms"].append(surface)
        block = row["板块"].strip()
        if block and block not in entry["scene_blocks"]:
            entry["scene_blocks"].append(block)

        cefr = row.get("CEFR", "").strip()
        if cefr:
            entry["_cefr_values"].add(cefr)

        for seg in split_meanings(row.get("释义", "")):
            if seg not in entry["meanings_zh"]:
                entry["meanings_zh"].append(seg)
        for p in parse_pos(row.get("释义", "")):
            if p not in entry["parts_of_speech"]:
                entry["parts_of_speech"].append(p)

        # 重点词表中的考频列（真实名次 + 句频）
        for key, rank_col, freq_col in (
            ("cet4", "四级名次", "四级句频"),
            ("cet6", "六级名次", "六级句频"),
            ("kaoyan", "考研名次", "考研句频"),
        ):
            rank = row.get(rank_col, "").strip()
            freq = row.get(freq_col, "").strip()
            if rank:
                entry["exam_frequency"][key]["rank"] = int(rank)
            if freq:
                entry["exam_frequency"][key]["frequency"] = int(freq)

    # 为审核中选出的场景词建立独立的补充词条，避免只把释义塞进场景 JSON。
    for record_id, terms in TARGET_WORD_ADDITIONS.items():
        block_id = record_id.split("-")[1]
        block_name = next((r["板块"].strip() for r in keyword_rows
                           if (r.get("板块") or "").strip().startswith(block_id)), None)
        for term in terms:
            lemma = nfkc_lower(term)
            if lemma in merged:
                entry = merged[lemma]
                if block_name and block_name not in entry["scene_blocks"]:
                    entry["scene_blocks"].append(block_name)
                continue
            external = lexical_index.get(lemma, {})
            if not any((row.get("释义") or "").strip() for row in external.values()):
                review.append({
                    "type": "curated_target_word_unavailable",
                    "record_id": record_id,
                    "word": term,
                    "message": f"人工挑选的场景重点词「{term}」没有可用的来源释义，未加入总词库",
                    "severity": "low",
                    "suggested_action": "保留场景原文并人工核对可用词条",
                })
                continue
            official_info = exam_index.get(lemma, {})
            official_cefr = official_info.get("cefr")
            official_meaning = official_info.get("meaning")
            merged[lemma] = {
                "word": lemma,
                "lemma": lemma,
                "surface_forms": [lemma],
                "parts_of_speech": [],
                "meanings_zh": [official_meaning] if official_meaning else [],
                "cefr": None,
                "phonetic": None,
                "phonetic_source": None,
                "exam_frequency": {
                    "cet4": official_info.get("exam", {}).get("cet4", {"rank": None, "frequency": None}),
                    "cet6": official_info.get("exam", {}).get("cet6", {"rank": None, "frequency": None}),
                    "kaoyan": official_info.get("exam", {}).get("kaoyan", {"rank": None, "frequency": None}),
                },
                "general_frequency": {},
                "scene_blocks": [block_name] if block_name else [],
                "vocab_origin": "scene_target_extension",
                "source_refs": [EXAM_FREQ_CSV_REL] if official_info else [],
                "_cefr_values": {official_cefr} if official_cefr else set(),
                "_cefr_conflict": False,
            }

    # 用真题考频总表补全（同样只填真实存在的名次/句频）
    for lemma, entry in merged.items():
        info = exam_index.get(lemma)
        if not info:
            continue
        if info.get("cefr") and not entry["_cefr_values"]:
            entry["_cefr_values"].add(info["cefr"])
        if info.get("meaning") and not entry["meanings_zh"]:
            entry["meanings_zh"].append(info["meaning"])
            for p in parse_pos(info["meaning"]):
                if p not in entry["parts_of_speech"]:
                    entry["parts_of_speech"].append(p)
        for key in ("cet4", "cet6", "kaoyan"):
            slot = entry["exam_frequency"][key]
            src = info["exam"].get(key)
            if not src:
                continue
            if slot["rank"] is None and src["rank"] is not None:
                slot["rank"] = src["rank"]
            if slot["frequency"] is None and src["frequency"] is not None:
                slot["frequency"] = src["frequency"]
        if EXAM_FREQ_CSV_REL not in entry["source_refs"]:
            entry["source_refs"].append(EXAM_FREQ_CSV_REL)

    # 雅思/托福词表只补充明确存在的词性、中文释义和（托福部分词条的）IPA。
    # 这些表没有 CEFR 或 CET/考研真题句频，所以不触碰对应字段。
    for lemma, entry in merged.items():
        for source_id, row in lexical_index.get(lemma, {}).items():
            used_this_source = False
            meaning = (row.get("释义") or "").strip()
            if meaning:
                for seg in split_meanings(meaning):
                    if seg not in entry["meanings_zh"]:
                        entry["meanings_zh"].append(seg)
                used_this_source = True
            for p in parse_external_pos(row.get("词性", "")):
                if p not in entry["parts_of_speech"]:
                    entry["parts_of_speech"].append(p)
                    used_this_source = True
            phonetic = (row.get("音标") or "").strip()
            if source_id == "toefl" and phonetic and not entry["phonetic"]:
                entry["phonetic"] = phonetic
                entry["phonetic_source"] = "toefl"
                entry["phonetic_accent"] = "unspecified"
                entry["phonetic_status"] = "needs_spot_check"
                used_this_source = True
            source_ref = IELTS_VOCAB_CSV_REL if source_id == "ielts" else TOEFL_VOCAB_CSV_REL
            if used_this_source and source_ref not in entry["source_refs"]:
                entry["source_refs"].append(source_ref)

        general = general_frequency_index.get(lemma, {})
        if general:
            entry["general_frequency"] = general
            for source_id in general:
                source_ref = GENERAL_FREQ_RELS[source_id]
                if source_ref not in entry["source_refs"]:
                    entry["source_refs"].append(source_ref)

    # 收尾：确定 cefr / data_status / 生成审查项
    vocab_by_word: dict[str, dict] = {}
    for lemma, entry in merged.items():
        values = entry.pop("_cefr_values")
        conflict = entry.pop("_cefr_conflict")
        if len(values) > 1:
            conflict = True
        entry["cefr"] = sorted(values)[0] if values else None
        if conflict:
            review.append({
                "type": "cefr_conflict",
                "record_id": f"vocab-{lemma}",
                "word": lemma,
                "message": f"「{lemma}」在资料中出现多个不同 CEFR 等级：{sorted(values)}",
                "severity": "medium",
                "suggested_action": "等待人工核对，不要由模型编造",
            })

        has_exam = any(
            entry["exam_frequency"][k]["rank"] is not None or entry["exam_frequency"][k]["frequency"] is not None
            for k in ("cet4", "cet6", "kaoyan")
        )
        has_meaning = bool(entry["meanings_zh"])
        has_cefr = entry["cefr"] is not None
        is_supplemental = entry.get("vocab_origin") == "scene_target_extension"

        if conflict:
            status = "needs_review"
        elif is_supplemental:
            status = "supplemental"
        elif has_cefr and has_meaning and has_exam:
            status = "verified"
        else:
            status = "partial"
        entry["data_status"] = status
        entry["surface_forms"].sort()
        entry["scene_blocks"].sort()
        vocab_by_word[lemma] = entry

        if is_supplemental:
            continue
        if not has_cefr:
            review.append({
                "type": "missing_cefr",
                "record_id": f"vocab-{lemma}",
                "word": lemma,
                "message": "九板块重点词表与真题考频总表中都没有该词的 CEFR 等级",
                "severity": "medium",
                "suggested_action": "等待人工核对，不要由模型编造",
            })
        if not has_meaning:
            review.append({
                "type": "missing_meaning",
                "record_id": f"vocab-{lemma}",
                "word": lemma,
                "message": "资料中没有该词的中文释义",
                "severity": "medium",
                "suggested_action": "等待人工核对，不要由模型编造",
            })
        if not has_exam:
            review.append({
                "type": "missing_exam_frequency",
                "record_id": f"vocab-{lemma}",
                "word": lemma,
                "message": "真题考频总表中没有该词的可靠考频（名次/句频）",
                "severity": "low",
                "suggested_action": "等待人工核对，不要用榜单排名冒充真题句频",
            })
        if not entry["phonetic"]:
            review.append({
                "type": "missing_phonetic",
                "record_id": f"vocab-{lemma}",
                "word": lemma,
                "message": "已下载词表中没有该词的音标（托福词表只覆盖部分词，且未标明英美口音）",
                "severity": "low",
                "suggested_action": "接入有明确授权、明确音标体系的词典后再补充",
            })
        elif entry.get("phonetic_status") == "needs_spot_check":
            review.append({
                "type": "phonetic_needs_spot_check",
                "record_id": f"vocab-{lemma}",
                "word": lemma,
                "message": "音标取自托福词表的部分 IPA 字段；来源未注明英美口音，且原 PDF 抽取说明提示少量字段需抽查",
                "severity": "low",
                "suggested_action": "人工抽查音标并确认口音后再标作已核验",
            })

    surface_to_lemma = {}
    for lemma, entry in vocab_by_word.items():
        for sf in entry["surface_forms"]:
            surface_to_lemma[sf] = lemma
    return vocab_by_word, surface_to_lemma


# ---------------------------------------------------------------------------
# 3. target_words 提取
# ---------------------------------------------------------------------------
def inflections(word: str) -> set[str]:
    w = word
    forms = set()
    if w.endswith(("s", "x", "z", "ch", "sh")):
        forms.add(w + "es")
    else:
        forms.add(w + "s")
    if w.endswith("y") and len(w) > 1 and w[-2] not in "aeiou":
        forms.add(w[:-1] + "ies")
        forms.add(w[:-1] + "ied")
    else:
        forms.add(w + "ed")
    if w.endswith("e"):
        forms.add(w + "d")
        forms.add(w[:-1] + "ing")
    else:
        forms.add(w + "ing")
    forms.discard(w)
    return forms


def word_in_text(word: str, norm_text: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", norm_text) is not None


def build_target_words(block_name: str, dialogue_text: str, keyword_rows: list[dict],
                       vocab_by_word: dict, surface_to_lemma: dict,
                       lexical_index: dict[str, dict[str, dict]],
                       general_frequency_index: dict[str, dict[str, dict]], review: list,
                       record_id: str) -> list[dict]:
    norm = nfkc_lower(dialogue_text)
    candidates = [r["单词"].strip() for r in keyword_rows if r["板块"].strip() == block_name and r["单词"].strip()]
    candidates.extend(TARGET_WORD_ADDITIONS.get(record_id, []))
    candidates = list(dict.fromkeys(candidates))
    excluded = {nfkc_lower(w) for w in TARGET_WORD_EXCLUSIONS.get(record_id, [])}
    results: list[dict] = []
    seen_lemmas: set[str] = set()
    for cand in candidates:
        cid = nfkc_lower(cand)
        if cid in excluded:
            continue
        matched_by = None
        surfaces: list[str] = []
        if word_in_text(cid, norm):
            matched_by = "exact"
            surfaces = [cid]
        else:
            hit = sorted({f for f in inflections(cid) if word_in_text(f, norm)})
            if hit:
                matched_by = "inflection"
                surfaces = hit
        if not matched_by:
            continue
        lemma = surface_to_lemma.get(cid, cid)
        if lemma in seen_lemmas:
            continue
        seen_lemmas.add(lemma)
        voc = vocab_by_word.get(lemma)
        if voc is None:
            # 场景补充词可以来自雅思/托福词表，但不必伪装成九板块核心词。
            external = lexical_index.get(lemma) or lexical_index.get(cid)
            if external:
                voc = {
                    "meanings_zh": [],
                    "parts_of_speech": [],
                    "cefr": None,
                    "phonetic": None,
                    "phonetic_source": None,
                    "general_frequency": general_frequency_index.get(lemma, {}),
                    "exam_frequency": {
                        "cet4": {"rank": None, "frequency": None},
                        "cet6": {"rank": None, "frequency": None},
                        "kaoyan": {"rank": None, "frequency": None},
                    },
                    "source_refs": [],
                }
                for source_id, row in external.items():
                    voc["meanings_zh"].extend(split_meanings((row.get("释义") or "").strip()))
                    voc["parts_of_speech"].extend(parse_external_pos(row.get("词性", "")))
                    phonetic = (row.get("音标") or "").strip()
                    if source_id == "toefl" and phonetic and not voc["phonetic"]:
                        voc["phonetic"] = phonetic
                        voc["phonetic_source"] = "toefl"
                        voc["phonetic_accent"] = "unspecified"
                        voc["phonetic_status"] = "needs_spot_check"
                    ref = IELTS_VOCAB_CSV_REL if source_id == "ielts" else TOEFL_VOCAB_CSV_REL
                    if ref not in voc["source_refs"]:
                        voc["source_refs"].append(ref)
                voc["meanings_zh"] = list(dict.fromkeys(voc["meanings_zh"]))
                voc["parts_of_speech"] = list(dict.fromkeys(voc["parts_of_speech"]))
        meaning_zh = voc["meanings_zh"][0] if voc and voc["meanings_zh"] else None
        cefr = voc["cefr"] if voc else None
        exam = voc["exam_frequency"] if voc else {
            "cet4": {"rank": None, "frequency": None},
            "cet6": {"rank": None, "frequency": None},
            "kaoyan": {"rank": None, "frequency": None},
        }
        has_exam = any(exam[k]["rank"] is not None or exam[k]["frequency"] is not None for k in ("cet4", "cet6", "kaoyan"))
        if cefr and meaning_zh and has_exam:
            status = "verified"
        else:
            status = "partial"
        results.append({
            "word": cand,
            "lemma": lemma,
            "surface_forms": surfaces,
            "matched_by": matched_by,
            "meaning_zh": meaning_zh,
            "parts_of_speech": voc["parts_of_speech"] if voc else [],
            "phonetic": voc.get("phonetic") if voc else None,
            "phonetic_source": voc.get("phonetic_source") if voc else None,
            "phonetic_accent": voc.get("phonetic_accent") if voc else None,
            "phonetic_status": voc.get("phonetic_status") if voc else None,
            "general_frequency": voc.get("general_frequency", {}) if voc else {},
            "vocab_origin": voc.get("vocab_origin", "block_keywords") if voc else "block_keywords",
            "cefr": cefr,
            "exam_frequency": exam,
            "source_refs": sorted(set(voc.get("source_refs", [KEYWORD_CSV_REL])) if voc else {KEYWORD_CSV_REL}),
            "status": status,
        })
    return results


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main() -> int:
    review: list[dict] = []

    # ---- 步骤 1：扫描输入文件 ----
    dialogue_files = sorted(DAILY_SRC_DIR.glob("0*/标准场景对话.txt"))
    print("== 输入文件扫描 ==")
    print(f"标准场景对话文件：{len(dialogue_files)} 个")
    for p in dialogue_files:
        print(f"  - {p.relative_to(PROJECT_ROOT).as_posix()}")
    print(f"九板块重点词表：{KEYWORD_CSV.exists()} -> {KEYWORD_CSV_REL}")
    print(f"真题考频总表：{EXAM_FREQ_CSV.exists()} -> {EXAM_FREQ_CSV_REL}")

    if len(dialogue_files) != 9:
        review.append({
            "type": "missing_dialogue_file",
            "record_id": None,
            "word": None,
            "message": f"预期 9 个标准场景对话文件，实际找到 {len(dialogue_files)} 个",
            "severity": "high",
            "suggested_action": "等待人工核对训练资料目录",
        })

    # ---- 步骤 2：解析对话 ----
    raw_entries: list[dict] = []
    for path in dialogue_files:
        raw_entries.extend(parse_dialogue_file(path, review))

    # 按文件顺序分组：block -> scene(按出现顺序) -> level
    scene_order: dict[str, list[str]] = {}
    for e in raw_entries:
        b = e["block_name"]
        scene_order.setdefault(b, [])
        if e["scene_name"] not in scene_order[b]:
            scene_order[b].append(e["scene_name"])

    block_of = {}
    for e in raw_entries:
        b = e["block_name"]
        m = re.match(r"^(\d{2})", b)
        block_of[b] = m.group(1) if m else "??"

    # 生成 scenes.jsonl 记录
    records: list[dict] = []
    id_counter: dict[str, int] = {}
    seen_ids: set[str] = set()
    block_records: dict[str, int] = {}

    for e in raw_entries:
        block_name = e["block_name"]
        block_id = block_of[block_name]
        scene_idx = scene_order.get(block_name, []).index(e["scene_name"]) + 1
        scene_id = f"{block_id}-{scene_idx:02d}"
        level = e["level"]

        block_records[block_name] = block_records.get(block_name, 0) + 1
        seq = block_records[block_name]
        rid = f"daily-{block_id}-{scene_idx:02d}-{level}-{seq:03d}"

        if rid in seen_ids:
            review.append({
                "type": "duplicate_id",
                "record_id": rid,
                "word": None,
                "message": "生成过程中出现重复 id",
                "severity": "high",
                "suggested_action": "检查解析脚本的 id 生成逻辑",
            })
        seen_ids.add(rid)
        id_counter.setdefault(block_id, 0)

        turns = e["turns"]
        dialogue_text = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)

        if level not in LEVEL_ORDER:
            review.append({
                "type": "invalid_level",
                "record_id": rid,
                "word": None,
                "message": f"难度标记不是 A2/B1/B2，而是「{level}」",
                "severity": "high",
                "suggested_action": "等待人工核对原始文件",
            })
        if len(turns) < 6:
            review.append({
                "type": "dialogue_too_short",
                "record_id": rid,
                "word": None,
                "message": f"有效对话只有 {len(turns)} 轮，少于 6 轮",
                "severity": "high",
                "suggested_action": "等待人工核对，不要为凑长度编造台词",
            })
        for t in turns:
            if not t["text"].strip():
                review.append({
                    "type": "empty_turn",
                    "record_id": rid,
                    "word": None,
                    "message": "存在空台词",
                    "severity": "high",
                    "suggested_action": "等待人工核对原始文件",
                })
            if t["speaker"] not in ("A", "B", "C"):
                review.append({
                    "type": "invalid_speaker",
                    "record_id": rid,
                    "word": None,
                    "message": f"说话人不是 A/B/C，而是「{t['speaker']}」",
                    "severity": "high",
                    "suggested_action": "等待人工核对原始文件",
                })
            if CJK_RE.search(t["text"]):
                review.append({
                    "type": "chinese_narration",
                    "record_id": rid,
                    "word": None,
                    "message": "对话中混入中文（可能是旁白）",
                    "severity": "high",
                    "suggested_action": "等待人工核对，不要由模型改写",
                })
            if PAREN_ACTION_RE.match(t["text"]):
                review.append({
                    "type": "stage_direction",
                    "record_id": rid,
                    "word": None,
                    "message": "台词看起来是括号动作/舞台说明",
                    "severity": "medium",
                    "suggested_action": "等待人工核对原始文件",
                })

        meta = SCENE_META.get(block_id, {}).get(e["scene_name"])
        if not meta:
            review.append({
                "type": "scene_task_undetermined",
                "record_id": rid,
                "word": None,
                "message": f"无法确定场景「{block_name} / {e['scene_name']}」的任务目标",
                "severity": "high",
                "suggested_action": "等待人工核对，不要随意猜测",
            })
            task_goal, criteria, functions = None, [], []
        else:
            task_goal, criteria, functions = meta

        records.append({
            "schema_version": SCHEMA_VERSION,
            "id": rid,
            "block_id": block_id,
            "block_name": block_name,
            "scene_id": scene_id,
            "scene_name": e["scene_name"],
            "level": level,
            "mode": "campaign",
            "task_goal": task_goal,
            "success_criteria": criteria,
            "communication_functions": functions,
            "turns": turns,
            "dialogue_text": dialogue_text,
            "target_words": [],
            "source": {
                "type": "project_standard_dialogue",
                "file": e["source_file"],
                "license": "unknown_until_verified",
            },
        })

    # ---- 步骤 3：词汇 ----
    keyword_rows = read_csv_rows(KEYWORD_CSV)
    keyword_rows = [r for r in keyword_rows if (r.get("单词") or "").strip()]

    exam_index: dict[str, dict] = {}
    for row in read_csv_rows(EXAM_FREQ_CSV):
        board = (row.get("榜单") or "").strip()
        word = nfkc_lower((row.get("单词") or "").strip())
        if not board or not word:
            continue
        key = board.replace("_rank", "")
        slot = exam_index.setdefault(word, {"cefr": None, "meaning": None,
                                            "exam": {"cet4": {"rank": None, "frequency": None},
                                                     "cet6": {"rank": None, "frequency": None},
                                                     "kaoyan": {"rank": None, "frequency": None}}})
        if not slot["cefr"] and (row.get("CEFR") or "").strip():
            slot["cefr"] = row["CEFR"].strip()
        if not slot["meaning"] and (row.get("释义") or "").strip():
            slot["meaning"] = row["释义"].strip()
        if key in slot["exam"]:
            rank = (row.get("榜单名次") or "").strip()
            freq = (row.get("真题句频") or "").strip()
            if rank:
                slot["exam"][key]["rank"] = int(rank)
            if freq:
                slot["exam"][key]["frequency"] = int(freq)

    lexical_index = load_lexical_sources(review)
    general_frequency_index = load_general_frequency_sources(review)
    vocab_by_word, surface_to_lemma = build_vocabulary(
        keyword_rows, exam_index, lexical_index, general_frequency_index, review)

    # target_words
    for rec in records:
        rec["target_words"] = build_target_words(
            rec["block_name"], rec["dialogue_text"], keyword_rows,
            vocab_by_word, surface_to_lemma, lexical_index, general_frequency_index,
            review, rec["id"])
        if not rec["target_words"]:
            review.append({
                "type": "missing_target_words",
                "record_id": rec["id"],
                "word": None,
                "message": "该段对话没有匹配到任何九板块重点词",
                "severity": "low",
                "suggested_action": "等待人工核对，不要为凑数量编造词汇",
            })

    # ---- 步骤 4：scene_catalog ----
    catalog: list[dict] = []
    for block_id in BLOCK_IDS:
        block_name = next((b for b, bid in block_of.items() if bid == block_id), None)
        if block_name is None:
            review.append({
                "type": "missing_block",
                "record_id": None,
                "word": None,
                "message": f"缺少板块 {block_id}",
                "severity": "high",
                "suggested_action": "等待人工核对训练资料",
            })
            continue
        for i, scene_name in enumerate(scene_order.get(block_name, []), start=1):
            scene_id = f"{block_id}-{i:02d}"
            levels_present = [r["level"] for r in records
                              if r["block_id"] == block_id and r["scene_name"] == scene_name]
            meta = SCENE_META.get(block_id, {}).get(scene_name)
            catalog.append({
                "scene_id": scene_id,
                "block_id": block_id,
                "block_name": block_name,
                "scene_name": scene_name,
                "task_goal": meta[0] if meta else None,
                "typical_functions": meta[2] if meta else [],
                "levels": sorted(set(levels_present), key=lambda x: LEVEL_ORDER.index(x) if x in LEVEL_ORDER else 99),
                "dialogue_count": len(levels_present),
                "status": "ready_for_review",
            })

    # index.html 场景名差异
    for block_id in BLOCK_IDS:
        block_name = next((b for b, bid in block_of.items() if bid == block_id), None)
        data_scenes = scene_order.get(block_name, [])
        index_scenes = INDEX_SCENES.get(block_id, [])
        for i, (ds, is_) in enumerate(zip(data_scenes, index_scenes), start=1):
            if ds != is_:
                review.append({
                    "type": "scene_name_mismatch",
                    "record_id": f"{block_id}-{i:02d}",
                    "word": None,
                    "message": f"训练资料场景名「{ds}」与 index.html DAILY_BLOCKS「{is_}」不一致",
                    "severity": "medium",
                    "suggested_action": "以训练资料为准；接入前端时同步修正 index.html 文案",
                })
        if len(data_scenes) != len(index_scenes):
            review.append({
                "type": "scene_count_mismatch",
                "record_id": block_id,
                "word": None,
                "message": f"板块 {block_id} 训练资料场景数 {len(data_scenes)} 与 index.html {len(index_scenes)} 不一致",
                "severity": "medium",
                "suggested_action": "等待人工核对",
            })

    # ---- 步骤 5：sources ----
    sources = [
        {
            "source_id": "daily-dialogues",
            "name": "九板块标准场景对话",
            "path": "训练资料/日常场景交涉",
            "usage": "作为日常交涉闯关模式的基础对话和任务参考",
            "license": "unknown_until_verified",
            "attribution": "待确认",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "daily-keywords",
            "name": "九板块重点词表",
            "path": KEYWORD_CSV_REL,
            "usage": "作为九个板块的候选重点词，用于对话 target_words 匹配",
            "license": "unknown_until_verified",
            "attribution": "待确认",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "exam-frequency",
            "name": "CET4 / CET6 / 考研 真题考频总表",
            "path": EXAM_FREQ_CSV_REL,
            "usage": "为词汇补充真实存在的真题名次与句频",
            "license": "unknown_until_verified",
            "attribution": "懒笔记「真题单词」 english-exam.lazynote.cn（据来源与说明.txt）",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "zhongkao-freq",
            "name": "中考开放词频（wordfreq 参考）",
            "path": "训练资料/中高考/开放词频参考/secondary_open_frequency_1600.csv",
            "usage": "单独记录一般英语语料词频参考，不视为中考官方词表或真题考频",
            "license": "Apache-2.0 / CC BY-SA 4.0（wordfreq 3.1.1，见来源许可说明）",
            "attribution": "wordfreq 3.1.1 英语词频数据",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "gaokao-freq",
            "name": "高考开放词频（wordfreq 参考）",
            "path": "训练资料/中高考/开放词频参考/gaokao_open_frequency_3500.csv",
            "usage": "单独记录一般英语语料词频参考，不视为高考官方词表或真题考频",
            "license": "Apache-2.0 / CC BY-SA 4.0（wordfreq 3.1.1，见来源许可说明）",
            "attribution": "wordfreq 3.1.1 英语词频数据",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "cet4-open-freq",
            "name": "四级开放词频（wordfreq 参考）",
            "path": "训练资料/cet- 四六级词表 + 真题 + 考频/开放词频参考/cet4_open_frequency_4500.csv",
            "usage": "单独记录一般英语语料词频参考，不视为四级官方词表或真题考频",
            "license": "Apache-2.0 / CC BY-SA 4.0（wordfreq 3.1.1）",
            "attribution": "wordfreq 3.1.1（非官方 CET4 考纲，不得当作真题频率）",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "cet6-open-freq",
            "name": "六级开放词频（wordfreq 参考）",
            "path": "训练资料/cet- 四六级词表 + 真题 + 考频/开放词频参考/cet6_open_frequency_5500.csv",
            "usage": "单独记录一般英语语料词频参考，不视为六级官方词表或真题考频",
            "license": "Apache-2.0 / CC BY-SA 4.0（wordfreq 3.1.1）",
            "attribution": "wordfreq 3.1.1（非官方 CET6 考纲，不得当作真题频率）",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "ielts-vocab",
            "name": "雅思 8000 词（净版）",
            "path": "训练资料/雅思托福/雅思8000词_净版.csv",
            "usage": "按精确词形补充可用词性的词条及缺失中文释义；不用于推导 CEFR 或考试频率",
            "license": "unknown_until_verified",
            "attribution": "待确认（由用户提供的 PDF 提取）",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "toefl-vocab",
            "name": "托福 7000 词（净版）",
            "path": "训练资料/雅思托福/托福7000词_净版.csv",
            "usage": "按精确词形补充可用词性的词条、缺失中文释义及原表中存在的 IPA；音标口音未标且抽取质量需抽查",
            "license": "unknown_until_verified",
            "attribution": "待确认（由用户提供的 PDF 提取）",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "sgd",
            "name": "Schema-Guided Dialogue (SGD)",
            "path": "训练资料/日常场景交涉/SGD-CC-BY-SA-4.0",
            "usage": "暂未接入",
            "license": "CC BY-SA 4.0",
            "attribution": "Google Research, Schema-Guided Dialogue Dataset",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "multiwoz",
            "name": "MultiWOZ 2.2",
            "path": "训练资料/日常场景交涉/multiwoz",
            "usage": "暂未接入",
            "license": "MIT",
            "attribution": "MultiWOZ authors; see multiwoz/SOURCE_LICENSE",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "subtitles",
            "name": "影视字幕（OpenSubtitles v2018）",
            "path": "训练资料/opensubtitles-影视对话",
            "usage": "暂未接入",
            "license": "unknown_until_verified（OpenSubtitles 各影片许可不一）",
            "attribution": "待确认",
            "raw_data_copied_to_repo": False,
        },
        {
            "source_id": "tatoeba",
            "name": "Tatoeba 英语句对",
            "path": "训练资料/tatoeba-英语句对",
            "usage": "暂未接入",
            "license": "CC BY 2.0 FR（Tatoeba 开放许可数据）",
            "attribution": "Tatoeba contributors",
            "raw_data_copied_to_repo": False,
        },
    ]

    # 来源/许可不明确
    for sid in ("daily-dialogues", "daily-keywords", "exam-frequency", "ielts-vocab", "toefl-vocab", "subtitles"):
        review.append({
            "type": "unclear_source_license",
            "record_id": sid,
            "word": None,
            "message": f"来源「{sid}」的许可证尚未核实",
            "severity": "medium",
            "suggested_action": "等待人工核对许可证后再决定是否公开再分发",
        })

    # ---- 写出 ----
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_jsonl(OUT_DIR / "scenes.jsonl", records)
    write_json(OUT_DIR / "vocabulary.json", {
        "schema_version": "daily_vocabulary.v1",
        "count": len(vocab_by_word),
        "words": sorted(vocab_by_word.values(), key=lambda x: x["word"]),
    })
    write_json(OUT_DIR / "scene_catalog.json", {
        "schema_version": "daily_scene_catalog.v1",
        "count": len(catalog),
        "scenes": catalog,
    })
    write_json(OUT_DIR / "sources.json", {
        "schema_version": "daily_sources.v1",
        "count": len(sources),
        "sources": sources,
    })
    write_json(OUT_DIR / "review_queue.json", {
        "schema_version": "daily_review_queue.v1",
        "count": len(review),
        "items": review,
    })

    # ---- 控制台统计 ----
    level_counts = {lv: sum(1 for r in records if r["level"] == lv) for lv in LEVEL_ORDER}
    status_counts: dict[str, int] = {}
    for v in vocab_by_word.values():
        status_counts[v["data_status"]] = status_counts.get(v["data_status"], 0) + 1

    print("\n== 生成结果 ==")
    print(f"对话记录数：{len(records)}（目标 216）")
    print(f"板块数：{len({r['block_id'] for r in records})}")
    print(f"场景数：{len(catalog)}（目标 72）")
    print(f"各板块记录数：{json.dumps({k: v for k, v in sorted(block_records.items())}, ensure_ascii=False)}")
    print(f"各等级记录数：{json.dumps(level_counts, ensure_ascii=False)}")
    print(f"词汇条数：{len(vocab_by_word)}  状态分布：{json.dumps(status_counts, ensure_ascii=False)}")
    print(f"review_queue 条数：{len(review)}")
    print(f"输出目录：{OUT_DIR.relative_to(REPO_DIR.parent).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
