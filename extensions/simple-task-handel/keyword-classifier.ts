/**
 * 简单任务场景分类器
 *
 * 根据用户输入的关键词权重计算，将用户 query 映射到对应的 skill 场景。
 * 参考 inner-skills/local-routers.ts 的路由评分逻辑。
 */

// ── 直接响应映射 ──────────────────────────────────────────

/**
 * 直接响应映射表。
 * key 为用户输入去除首尾空格及标点符号后的文本，value 为直接返回的响应内容。
 * 命中此表后跳过所有后续逻辑（包括 LLM 调用）。
 */
export const DIRECT_RESPONSE_MAP: Record<string, string> = {
  打开蓝牙: "蓝牙已打开",
  关闭蓝牙: "蓝牙已关闭",
  打开静音: "手机已静音",
  打开振动模式: "已切换振动模式",
  开启响铃模式: "已切换响铃模式",
  调小闹钟音量: "闹钟音量已调小",
  调大媒体音量: "媒体音量已调大",
  关闭手电筒: "手电筒已关闭",
  打开手电筒: "手电筒已开启",
  停止录音: "录音已停止并保存",
  恢复录音: "已恢复录音",
  暂停录音: "录音已暂停",
  开始录音: "已开始录音",
};

/**
 * 从 cleanedBody 中提取实际消息文本，剥离行首的方括号时间戳前缀。
 * 例如 "[Fri 2026-05-08 21:14 GMT+8] 打开静音" → "打开静音"
 */
export function extractMessageBody(cleanedBody: string): string {
  return (cleanedBody ?? "").replace(/^\[[^\]]*\]\s*/, "").trim();
}

/**
 * 去除首尾空格及常见中英文标点符号。
 */
export function normalizeInput(input: string): string {
  return (input ?? "")
    .trim()
    .replace(/^[\s\p{P}]+/u, "")
    .replace(/[\s\p{P}]+$/u, "");
}

/**
 * 检查用户输入是否命中直接响应映射表。
 * 会先剥离 cleanedBody 中的时间戳前缀，再去除首尾空格及标点符号后匹配。
 * @returns 命中的响应文本，未命中返回 null。
 */
export function matchDirectResponse(input: string): string | null {
  const message = extractMessageBody(input);
  const key = normalizeInput(message);
  if (!key) return null;
  return DIRECT_RESPONSE_MAP[key] ?? null;
}

// ── 类型定义 ──────────────────────────────────────────────

export type SkillCategory =
  | "inner_weather"
  | "inner_transportation"
  | "inner_system_settings"
  | "inner_recorder"
  | "inner_message"
  | "inner_entertainment"
  | "inner_cast"
  | "inner_call"
  | "inner_agenda"
  | "inner_alarm"
  | "inner_ztescreenshot"
  | "artifact_image_gen"
  | "inner_ask_user";

export type ClassifyResult = {
  /** 匹配到的 skill 类别，无匹配时为 null */
  category: SkillCategory | null;
  /** 最佳匹配的类别标签（中文） */
  label: string;
  /** 最佳匹配的 skill 名称 */
  skillName: string;
  /** 最佳匹配得分 */
  score: number;
  /** 所有类别的得分明细 */
  scores: Record<string, number>;
  /** 是否命中（得分超过阈值） */
  matched: boolean;
};

// ── 关键词定义 ────────────────────────────────────────────

type KeywordSet = {
  label: string;
  skillName: string;
  /** 强关键词：命中 1 个即高权重 */
  strong: string[];
  /** 弱关键词：需要命中 2+ 才有中等权重 */
  weak: string[];
};

const SKILL_KEYWORDS: Record<SkillCategory, KeywordSet> = {
  inner_weather: {
    label: "天气查询",
    skillName: "inner-weather",
    strong: [
      "天气",
      "下雨",
      "多少度",
      "气候",
      "空气质量",
      "雨具",
      "带伞",
      "雨伞",
      "伞",
      "洗车指数",
      "变天",
      "晾干",
      "下雪",
      "刮风",
      "雾霾",
      "台风",
      "冷不冷",
      "热不热",
      "天儿",
      "天公",
      "适合穿",
      "空气",
      "暴雨",
      "天阴",
      "温差",
      "weather",
      "rain",
      "temperature",
      "forecast",
      "humidity",
      "下.*雨",
      "刮.*风",
      "雨.*停",
    ],
    weak: [
      "户外",
      "穿什么",
      "外套",
      "厚衣服",
      "着凉",
      "降温",
      "升温",
      "多穿",
      "潮湿",
      "干燥",
      "紫外线",
      "防晒",
      "晨练",
      "放风筝",
      "回暖",
      "适合旅游",
      "适合出行",
      "适不适合",
      "会不会下雨",
      "温差",
      "大风",
      "飓风",
      "雷雨",
      "雨夹雪",
      "雨停",
      "雨.*停",
      "天晴",
      "转凉",
      "转暖",
      "气温",
      "温度",
      "hot",
      "cold",
      "umbrella",
      "wind",
      "snow",
      "storm",
    ],
  },

  inner_transportation: {
    label: "交通出行",
    skillName: "inner-transportation-linux",
    strong: [
      "导航",
      "打车",
      "公交",
      "地铁",
      "路线",
      "航班",
      "高铁",
      "骑行",
      "共享单车",
      "地铁站",
      "火车站",
      "机场",
      "怎么走",
      "怎么去",
      "酒店",
      "宾馆",
      "购物中心",
      "商业广场",
      "叫车",
      "网约车",
      "飞机",
      "navigate",
      "taxi",
      "bus",
      "metro",
      "subway",
      "route",
      "flight",
      "hotel",
    ],
    weak: [
      "附近",
      "最近",
      "走路",
      "开车",
      "骑车",
      "坐车",
      "叫车",
      "接人",
      "接机",
      "接我",
      "安排个车",
      "安排车",
      "赶飞机",
      "赶高铁",
      "出差",
      "溜达",
      "逛逛",
      "周围",
      "怎么过去",
      "帮我安排",
      "路程",
      "最快",
      "怎么走",
      "bike",
      "bicycle",
      "walk",
      "drive",
      "nearby",
      "商场",
      "广场",
      "购物",
      "咖啡厅",
      "吃饭",
      "出发",
      "路线",
      "飞机场",
      "航站楼",
      "休息睡觉",
      "消消食",
      "单车",
      "电动车",
      "骑.*车",
      "扫.*车",
      "步行",
      "车程",
      "末班",
      "早班",
      "直达",
      "换乘",
      "多长时间",
      "多久",
    ],
  },

  inner_system_settings: {
    label: "系统设置",
    skillName: "inner-system-settings",
    strong: [
      "音量",
      "静音",
      "振动模式",
      "震动静音",
      "响铃",
      "手电筒",
      "闪光灯",
      "媒体音量",
      "闹钟音量",
      "来电音量",
      "声音",
      "找手机",
      "手机找不到",
      "勿扰",
      "飞行模式",
      "手电",
      "亮度",
      "volume",
      "mute",
      "silent",
      "vibrate",
      "flashlight",
    ],
    weak: [
      "调大",
      "调小",
      "打开",
      "关闭",
      "声音太小",
      "大声",
      "发出声音",
      "图书馆",
      "会议室",
      "震动",
      "不要发出声音",
      "恢复声音",
      "照下亮",
      "照个亮",
      "黑漆漆",
      "找不到了",
      "发出任何响动",
      "找.*手机",
      "手机.*找",
      "我的手机",
      "手机放哪",
      "听不见",
      "铃声",
      "声音恢复",
      "听不到",
      "任何响动",
      "不希望.*发出",
      "扬声器",
      "调亮",
      "调暗",
      "没声",
      "消音",
      "屏.*亮",
      "屏.*暗",
      "设备.*找",
      "找.*设备",
      "掉.*缝",
      "sound",
      "ring",
      "loud",
      "quiet",
      "silent mode",
      "do not disturb",
    ],
  },

  inner_recorder: {
    label: "录音",
    skillName: "inner-recorder",
    strong: [
      "录音",
      "录制",
      "音频采集",
      "录音机",
      "存档",
      "录下来",
      "回放",
      "音频",
      "record",
      "recording",
      "audio record",
      "voice record",
      "开始录",
      "录完",
      "录好",
      "接着录",
      "往下录",
      "先录",
      "再录",
    ],
    weak: [
      "暂停录音",
      "停止录音",
      "开始录音",
      "恢复录音",
      "查看录音",
      "录好了",
      "录进去",
      "录的东西",
      "存个档",
      "采访录",
      "正在录",
      "录音续上",
      "结束.*音频",
      "现场内容",
      "录了",
      "录的",
      "录一下",
      "录下来.*保存",
      "重放",
      "回听",
      "播放录音",
      "按个暂停",
      "pause record",
      "stop record",
      "start record",
    ],
  },

  inner_message: {
    label: "短信消息",
    skillName: "inner-message",
    strong: [
      "发短信",
      "短信",
      "告知",
      "发信",
      "发个信",
      "说一声",
      "发消息",
      "微信",
      "知会",
      "message",
      "sms",
      "text",
      "发.*消息",
      "回.*消息",
    ],
    weak: [
      "告诉",
      "通知",
      "联系",
      "跟.*说",
      "send message",
      "text to",
      "发消息",
      "通知.*大家",
      "发条",
      "短消息",
      "编.*消息",
      "发个信息",
      "发信息",
      "转告",
      "捎个话",
      "带个话",
      "知会.*一下",
    ],
  },

  inner_entertainment: {
    label: "影音娱乐",
    skillName: "inner-entertainment",
    strong: [
      "播放",
      "视频",
      "哔哩哔哩",
      "bilibili",
      "B站",
      "音乐",
      "听歌",
      "电影",
      "直播",
      "抖音",
      "play",
      "video",
      "music",
      "song",
      "watch",
      "放.*歌",
      "放.*曲",
      "播.*歌",
      "听.*歌",
    ],
    weak: [
      "放松",
      "更新",
      "up主",
      "何同学",
      "邓紫棋",
      "陈粒",
      "三国演义",
      "龙卷风",
      "小半",
      "听.*歌",
      "看.*视频",
      "youtube",
      "netflix",
      "movie",
      "entertainment",
      "脱口秀",
      "综艺",
      "连续剧",
      "动漫",
      "番剧",
      "七里香",
      "周杰伦",
      "听听",
      "听会儿",
      "看会儿",
      "放松.*听",
      "网易云",
      "QQ音乐",
      "酷狗",
      "spotify",
    ],
  },

  inner_cast: {
    label: "投屏",
    skillName: "inner-cast",
    strong: [
      "投屏",
      "屏幕同步",
      "电视上显示",
      "投到大屏",
      "镜像",
      "投射",
      "cast",
      "screen mirror",
      "tv cast",
      "推送.*电视",
      "推送.*投影",
      "投影仪",
    ],
    weak: [
      "电视",
      "大屏幕",
      "客厅",
      "投影",
      "投影仪",
      "投影到",
      "投射到",
      "mirror screen",
      "connect tv",
      "连.*电视",
      "投.*屏",
      "显示器",
      "大屏",
      "屏幕.*电视",
      "屏幕.*投影",
      "从手机.*推送",
      "推送到",
      "投到",
    ],
  },

  inner_call: {
    label: "通话电话",
    skillName: "inner-call",
    strong: [
      "打电话",
      "通话记录",
      "未接来电",
      "通话录音",
      "通话设置",
      "拨打",
      "漏接",
      "欠费",
      "呼叫",
      "通话",
      "来电",
      "通话自动录音",
      "通话配置",
      "未接",
      "联系",
      "没接",
      "call",
      "phone",
      "dial",
      "missed call",
      "通话.*录",
    ],
    weak: [
      "电话",
      "客服电话",
      "联系人",
      "转接",
      "联系",
      "清理记录",
      "清空",
      "自动保存录音",
      "通话历史",
      "最近通话",
      "没接的电话",
      "漏掉",
      "打过电话",
      "contact",
      "phone number",
      "incoming",
      "电话号码",
      "拨.*号",
      "来电.*转移",
      "呼叫.*转移",
      "未接.*电话",
      "通话.*记录",
      "通话.*录音",
      "拨一下",
      "回拨",
      "拨过去",
      "打过去",
      "联系.*一下",
    ],
  },

  inner_agenda: {
    label: "日程提醒",
    skillName: "inner-calendar",
    strong: [
      "日程",
      "日历",
      "提醒我",
      "记一下",
      "别忘了",
      "记得",
      "支会",
      "预约",
      "记上",
      "agenda",
      "schedule",
      "remind",
      "calendar",
      "reminder",
    ],
    weak: [
      "安排",
      "取消",
      "列出",
      "计划",
      "行程",
      "约会",
      "开会",
      "接人",
      "婚礼",
      "生日",
      "旅行",
      "取消日程",
      "查看日程",
      "明天有.*安排",
      "提醒",
      "记下来",
      "吱一声",
      "喊我",
      "记下来",
      "叫你",
      "叫我",
      "支会我",
      "记.*以免",
      "到点儿",
      "标记",
      "标记一下",
      "移除",
      "清除",
      "清空",
      "取消.*预约",
      "删除.*日程",
      "删了.*日程",
      "event",
      "appointment",
      "meeting",
      "有什么安排",
      "忙不忙",
      "开.*会",
      "周会",
      "例会",
    ],
  },

  inner_alarm: {
    label: "闹钟时钟",
    skillName: "inner-alarm",
    strong: [
      "闹钟",
      "叫醒",
      "倒计时",
      "世界时钟",
      "时差",
      "到点",
      "闹铃",
      "计时器",
      "计时",
      "几点",
      "alarm",
      "timer",
      "countdown",
      "timezone",
      "world clock",
      "定.*闹铃",
    ],
    weak: [
      "起床",
      "抢票",
      "泡面",
      "记下时间",
      "方便面",
      "早班机",
      "提醒",
      "取消闹钟",
      "改闹钟",
      "到点叫",
      "提前.*叫醒",
      "睡过头",
      "clock",
      "wake",
      "morning call",
      "time",
      "现在几点",
      "那边几点",
      "几点.*叫",
      "叫我",
      "喊我.*起",
      "催促",
      "叫我起床",
      "定.*闹",
      "设.*闹",
      "小睡",
      "午睡",
      "打盹",
      "冥想",
      "赶早",
    ],
  },

  inner_ztescreenshot: {
    label: "截屏",
    skillName: "inner-screenshot",
    strong: [
      "截图",
      "截屏",
      "屏幕截图",
      "拍下来",
      "屏幕拍照",
      "截.*图",
      "截.*屏",
      "抓拍",
      "screenshot",
      "screen capture",
      "snapshot",
      "capture.*screen",
      "screen.*capture",
    ],
    weak: [
      "画面",
      "当前屏幕",
      "屏幕画面",
      "屏幕",
      "capture screen",
      "screen shot",
      "截取",
      "留个底",
      "保存.*画面",
      "页面.*重要",
      "截个",
      "拍张",
      "抓取.*屏幕",
    ],
  },

  artifact_image_gen: {
    label: "图片生成",
    skillName: "artifact-image-gen",
    strong: [
      "插图",
      "配图",
      "构图",
      "poster",
      "海报",
      "generate image",
      "draw",
      "illustration",
      "生成.*图",
      "画.*图",
      "生成.*画",
      "设计.*图",
      "制作.*图",
      "画个",
      "画幅",
      "画一张",
      "生成一张",
      "生成个",
    ],
    weak: [
      "赛博朋克",
      "分辨率",
      "像素",
      "图片",
      "科幻",
      "海底",
      "画面",
      "设计图",
      "画一只",
      "画一张",
      "整一张",
      "帮我画",
      "构思.*图",
      "章节配图",
      "image",
      "picture",
      "generate.*picture",
      "2048",
      "1024",
      "创作",
      "logo",
      "贺图",
      "图案",
      "插图",
      "作图",
      "制图",
      "风景画",
      "概念图",
      "壁纸",
      "海报",
      "draw.*picture",
      "make.*image",
      "create.*poster",
      "generate",
      "generate.*poster",
    ],
  },

  inner_ask_user: {
    label: "通用助手",
    skillName: "inner-ask-user",
    strong: [
      "帮我导航",
      "定闹钟",
      "查.*电话",
      "帮我定",
      "帮我导航一下",
      "定一个.*闹钟",
      "定个.*响铃",
    ],
    weak: ["帮我看", "帮我查", "帮我找", "帮我想", "能不能", "可以帮我", "请帮我"],
  },
};

// ── 评分逻辑 ──────────────────────────────────────────────

const CLASSIFY_THRESHOLD = 0.3;

/**
 * 对单个类别计算匹配得分
 */
function scoreCategory(text: string, keywords: KeywordSet): number {
  const lower = text.toLowerCase();
  let score = 0;

  // 强关键词：命中 1 个计 0.5，命中 2+ 计 1.0（支持 .* 正则）
  const strongHits = keywords.strong.filter((kw) => {
    const kwLower = kw.toLowerCase();
    if (kw.includes(".*")) {
      try {
        return new RegExp(kw).test(lower);
      } catch {
        return lower.includes(kwLower);
      }
    }
    return lower.includes(kwLower);
  });
  if (strongHits.length >= 2) {
    score += 1.0;
  } else if (strongHits.length === 1) {
    score += 0.5;
  }

  // 弱关键词：命中 1 个计 0.15，命中 2+ 计 0.4，命中 4+ 计 0.7
  const weakHits = keywords.weak.filter((kw) => {
    const wLower = kw.toLowerCase();
    // 支持简单的正则模式（包含 .* 的视为正则子串）
    if (kw.includes(".*")) {
      try {
        return new RegExp(kw).test(lower);
      } catch {
        return lower.includes(wLower);
      }
    }
    return lower.includes(wLower);
  });
  if (weakHits.length >= 4) {
    score += 0.7;
  } else if (weakHits.length >= 2) {
    score += 0.4;
  } else if (weakHits.length === 1) {
    score += 0.15;
  }

  return score;
}

/**
 * 对用户输入进行 skill 场景分类
 *
 * @param query - 用户输入文本
 * @param threshold - 分类阈值，默认 0.3
 * @returns 分类结果
 */
export function classifySkill(query: string, threshold = CLASSIFY_THRESHOLD): ClassifyResult {
  const trimmed = (query ?? "").trim();
  const empty: ClassifyResult = {
    category: null,
    label: "",
    skillName: "",
    score: 0,
    scores: {},
    matched: false,
  };

  if (!trimmed) return empty;

  const rawScores: Record<string, number> = {};
  const entries = Object.entries(SKILL_KEYWORDS) as [SkillCategory, KeywordSet][];

  for (const [cat, kw] of entries) {
    rawScores[cat] = scoreCategory(trimmed, kw);
  }

  // 找出最高分
  const sorted = entries
    .map(([cat]) => ({ cat, score: rawScores[cat] }))
    .sort((a, b) => b.score - a.score);

  const best = sorted[0];
  if (!best || best.score < threshold) {
    return { ...empty, scores: rawScores };
  }

  const bestKw = SKILL_KEYWORDS[best.cat];
  return {
    category: best.cat,
    label: bestKw.label,
    skillName: bestKw.skillName,
    score: best.score,
    scores: rawScores,
    matched: true,
  };
}

/**
 * 批量测试分类效果
 */
export function batchClassify(queries: { id: string; category: string; text: string }[]): {
  total: number;
  correct: number;
  accuracy: string;
  details: {
    id: string;
    expected: string;
    predicted: string;
    score: number;
    ok: boolean;
    text: string;
  }[];
} {
  const details = queries.map((q) => {
    const result = classifySkill(q.text);
    const predicted = result.category ?? "none";
    const ok = predicted === q.category;
    return {
      id: q.id,
      expected: q.category,
      predicted,
      score: result.score,
      ok,
      text: q.text.slice(0, 60),
    };
  });
  const correct = details.filter((d) => d.ok).length;
  return {
    total: queries.length,
    correct,
    accuracy: `${((correct / queries.length) * 100).toFixed(1)}%`,
    details,
  };
}
