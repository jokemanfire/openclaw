/**
 * skill 分类器测试入口
 *
 * 用法:
 *   单条测试: pnpm tsx extensions/simple-task-handel/test-classify.ts "明天天气怎么样"
 *   批量测试: pnpm tsx extensions/simple-task-handel/test-classify.ts --batch
 */

import { classifySkill, batchClassify } from "./skill-classifier.ts";

// ── 188 条测试用例（从 用户query场景与skill映射.md 提取） ──

const TEST_CASES: { id: string; category: string; text: string }[] = [
  // ── inner_ztescreenshot ──
  {
    id: "0002",
    category: "inner_ztescreenshot",
    text: "这个页面上的内容挺关键的，帮我把现在的屏幕画面拍下来。",
  },
  { id: "0001", category: "inner_ztescreenshot", text: "截图" },

  // ── inner_weather ──
  {
    id: "0032",
    category: "inner_weather",
    text: "我这周末打算去重庆看火锅节，不知道到时候那边需不需要带雨具？",
  },
  {
    id: "0030",
    category: "inner_weather",
    text: "我打算大后天去兰州出差，不知道那边到时候会变天吗，大概几度？",
  },
  {
    id: "0028",
    category: "inner_weather",
    text: "我计划这几天去威海看海，那边接下来一周的气候状况适合旅游吗？",
  },
  {
    id: "0026",
    category: "inner_weather",
    text: "我打算明天飞杭州待两天，在那边落地需要额外多穿件外套吗？",
  },
  { id: "0024", category: "inner_weather", text: "我想去外面跑步，现在的空气适合晨练吗？" },
  {
    id: "0022",
    category: "inner_weather",
    text: "我攒了一大堆厚衣服要洗，今天这天气挂在阳台能晾干吗？",
  },
  {
    id: "0020",
    category: "inner_weather",
    text: "我明天下午打算带孩子去公园放风筝，需要提前准备雨具或者多穿件外套吗？",
  },
  {
    id: "0018",
    category: "inner_weather",
    text: "我看这天灰蒙蒙的，在西安现在去洗车的话，后面几天会下雨白洗了吗？",
  },
  { id: "0016", category: "inner_weather", text: "我打算明天去成都旅游，不知道那边热不热。" },
  {
    id: "0014",
    category: "inner_weather",
    text: "我明天下午准备去广州海心沙公园写生，不知道天公作不作美？",
  },
  {
    id: "0012",
    category: "inner_weather",
    text: "我明天得去上海出差，帮我看看那边冷不冷，需要多带点衣服吗？",
  },
  {
    id: "0010",
    category: "inner_weather",
    text: "这周末打算带小孩去大唐不夜城转转，不知道西安那边的天儿怎么样，适合户外吗？",
  },
  {
    id: "0008",
    category: "inner_weather",
    text: "我打算这周六带家人去西安秦岭爬山，不知道那天天气适不适合户外运动？",
  },
  {
    id: "0006",
    category: "inner_weather",
    text: "我明天得去上海出差，帮我看看那边天气，我需要带雨伞或者厚衣服吗？",
  },
  {
    id: "0004",
    category: "inner_weather",
    text: "明早要去趟银行，我是不是得提前在包里放把折叠伞？",
  },
  { id: "0002", category: "inner_weather", text: "我明天打算去成都出差，需要带伞吗？" },
  { id: "0031", category: "inner_weather", text: "重庆未来4天天气怎么样" },
  { id: "0029", category: "inner_weather", text: "后天兰州的天气咋样，多少度" },
  { id: "0027", category: "inner_weather", text: "这一周威海天气怎么样？" },
  { id: "0025", category: "inner_weather", text: "周六去要北京出差，那边天气热不" },
  { id: "0023", category: "inner_weather", text: "今天的空气质量怎么样" },
  { id: "0021", category: "inner_weather", text: "今天的天气适合给车做保养吗" },
  { id: "0019", category: "inner_weather", text: "今天适合穿什么衣服" },
  { id: "0017", category: "inner_weather", text: "西安的洗车指数" },
  { id: "0015", category: "inner_weather", text: "明天多少度" },
  { id: "0013", category: "inner_weather", text: "广州明天会下雨吗" },
  { id: "0011", category: "inner_weather", text: "上海今天天气怎么样" },
  { id: "0009", category: "inner_weather", text: "接下来几天天气" },
  { id: "0007", category: "inner_weather", text: "周末天气怎么样" },
  { id: "0005", category: "inner_weather", text: "明天会下雨吗" },
  { id: "0003", category: "inner_weather", text: "明天天气怎么样" },
  { id: "0001", category: "inner_weather", text: "今天天气怎么样" },

  // ── inner_transportation ──
  {
    id: "0034",
    category: "inner_transportation",
    text: "下周要去西安大雁塔玩，帮我看看那附近有没有适合落脚的宾馆。",
  },
  {
    id: "0032",
    category: "inner_transportation",
    text: "天气不错，我想骑共享单车去大雁塔转转，看看怎么走最方便。",
  },
  {
    id: "0030",
    category: "inner_transportation",
    text: "快帮我想想怎么去西安北站最快，我赶两点钟的高铁，现在就得出发。",
  },
  {
    id: "0028",
    category: "inner_transportation",
    text: "我一会儿得去西安北站赶高铁，帮我查查现在怎么坐公交车过去比较快。",
  },
  {
    id: "0026",
    category: "inner_transportation",
    text: "我待会要去虹桥火车站赶高铁，帮我看看现在打车过去大概要多久？",
  },
  {
    id: "0024",
    category: "inner_transportation",
    text: "待会要去国金中心见个客户，帮我找下那附近环境比较安静的咖啡厅。",
  },
  {
    id: "0022",
    category: "inner_transportation",
    text: "等会儿打算扫个共享单车去大雁塔转转，帮我看看怎么走。",
  },
  {
    id: "0020",
    category: "inner_transportation",
    text: "晚上的电影快开场了，我现在得赶紧去赛格国际购物中心，帮我安排一下路程。",
  },
  {
    id: "0018",
    category: "inner_transportation",
    text: "我五点钟得赶到咸阳国际机场T3航站楼接人，现在出发怎么走最顺畅？",
  },
  {
    id: "0016",
    category: "inner_transportation",
    text: "刚吃完饭想消消食，帮我看看怎么溜达到万象城比较快。",
  },
  {
    id: "0014",
    category: "inner_transportation",
    text: "我现在准备去赛格城，帮我看看怎么走最快。",
  },
  {
    id: "0012",
    category: "inner_transportation",
    text: "我想买几件换季的衣服，帮我看看这附近有没有大型的商业广场。",
  },
  {
    id: "0010",
    category: "inner_transportation",
    text: "忙了一整天累坏了，帮我在周围找个能休息睡觉的地方。",
  },
  {
    id: "0008",
    category: "inner_transportation",
    text: "我现在走累了，带我找找附近最近的地铁站入口。",
  },
  {
    id: "0006",
    category: "inner_transportation",
    text: "晚一点我要去曲江创意谷吃饭，现在帮我看看怎么过去最方便。",
  },
  {
    id: "0004",
    category: "inner_transportation",
    text: "我明天得去深圳办点事，帮我看看从北京出发的飞机大概都有几点的。",
  },
  {
    id: "0002",
    category: "inner_transportation",
    text: "我待会要去大唐不夜城逛逛，帮我安排个车接我一下。",
  },
  { id: "0033", category: "inner_transportation", text: "搜索靠近华山景区的酒店，方便游玩" },
  { id: "0031", category: "inner_transportation", text: "打算骑行去陕西历史博物馆，规划下路线" },
  { id: "0029", category: "inner_transportation", text: "去钟楼，帮我导航路线，着急赶过去" },
  { id: "0027", category: "inner_transportation", text: "查询到去西安北站的公交路线" },
  { id: "0025", category: "inner_transportation", text: "今天朋友有约打车导航去世博园" },
  { id: "0023", category: "inner_transportation", text: "我想知道电子科技大学附近有哪些酒店" },
  { id: "0021", category: "inner_transportation", text: "我要骑车到西安荟聚" },
  { id: "0019", category: "inner_transportation", text: "我要打车去兴庆宫公园" },
  { id: "0017", category: "inner_transportation", text: "我要开车去西安工会医院怎么走" },
  { id: "0015", category: "inner_transportation", text: "我要走路去国际医学中心该怎么走" },
  { id: "0013", category: "inner_transportation", text: "导航到赛格城" },
  { id: "0011", category: "inner_transportation", text: "周围有哪些购物中心" },
  { id: "0009", category: "inner_transportation", text: "最近的酒店在哪" },
  { id: "0007", category: "inner_transportation", text: "最近的地铁站在哪儿" },
  { id: "0005", category: "inner_transportation", text: "坐公交去陕西省人民医院怎么走" },
  { id: "0003", category: "inner_transportation", text: "查询明天北京飞深圳的航班" },
  { id: "0001", category: "inner_transportation", text: "帮我打车去西安北站" },

  // ── inner_system_settings ──
  { id: "0102", category: "inner_system_settings", text: "声音太小了，稍微大一点。" },
  {
    id: "0100",
    category: "inner_system_settings",
    text: "把媒体音量调到30%，但闹钟音量保持最大。",
  },
  {
    id: "0098",
    category: "inner_system_settings",
    text: "我马上要开会了，不希望手机待会发出任何响动。",
  },
  { id: "0088", category: "inner_system_settings", text: "我现在在图书馆看书，别让手机发出声音。" },
  {
    id: "0074",
    category: "inner_system_settings",
    text: "我马上要进会议室了，帮我把手机设成那种只有震动、没有铃声的状态。",
  },
  {
    id: "0054",
    category: "inner_system_settings",
    text: "我现在忙完了，把手机声音恢复吧，省得听不见电话。",
  },
  { id: "0046", category: "inner_system_settings", text: "现在的声音太小了，调得再大声一点。" },
  { id: "0010", category: "inner_system_settings", text: "闪光灯怎么还开着" },
  {
    id: "0008",
    category: "inner_system_settings",
    text: "屋里突然停电了，到处黑漆漆的，帮我照下亮。",
  },
  { id: "0120", category: "inner_system_settings", text: "我手机放哪了，怎么找不到了" },
  { id: "0101", category: "inner_system_settings", text: "调小来电音量" },
  { id: "0099", category: "inner_system_settings", text: "媒体音量调到30%" },
  { id: "0097", category: "inner_system_settings", text: "打开静音" },
  { id: "0073", category: "inner_system_settings", text: "打开振动模式" },
  { id: "0053", category: "inner_system_settings", text: "开启响铃模式" },
  { id: "0047", category: "inner_system_settings", text: "调小闹钟音量" },
  { id: "0045", category: "inner_system_settings", text: "调大媒体音量" },
  { id: "0009", category: "inner_system_settings", text: "关闭手电筒" },
  { id: "0007", category: "inner_system_settings", text: "打开手电筒" },
  { id: "0121", category: "inner_system_settings", text: "帮我找一下我的手机" },

  // ── inner_recorder ──
  { id: "0010", category: "inner_recorder", text: "我刚才那段采访录好了吗？快找出来让我听一下。" },
  {
    id: "0008",
    category: "inner_recorder",
    text: "好了，内容都录进去了，可以结束这段音频采集了。",
  },
  {
    id: "0006",
    category: "inner_recorder",
    text: "刚才接了个电话，现在事情处理完了，帮我把刚才的录音续上吧。",
  },
  {
    id: "0004",
    category: "inner_recorder",
    text: "我现在要接个紧急电话，帮我把正在录的东西先停一下。",
  },
  {
    id: "0002",
    category: "inner_recorder",
    text: "老板准备开始讲话了，快帮我把接下来的现场内容存个档，我怕记不住。",
  },
  { id: "0009", category: "inner_recorder", text: "查看录音" },
  { id: "0007", category: "inner_recorder", text: "停止录音" },
  { id: "0005", category: "inner_recorder", text: "恢复录音" },
  { id: "0003", category: "inner_recorder", text: "暂停录音" },
  { id: "0001", category: "inner_recorder", text: "开始录音" },

  // ── inner_message ──
  {
    id: "0006",
    category: "inner_message",
    text: "麻烦跟18729257459说一声我已经安全到家了，让他放心。",
  },
  {
    id: "0004",
    category: "inner_message",
    text: "帮我告知一下15912345678，我已经在去餐厅的路上了。",
  },
  {
    id: "0002",
    category: "inner_message",
    text: "我这边临时有点事要加班，发个信儿告诉李明今晚的聚会我不去了。",
  },
  { id: "0005", category: "inner_message", text: "给18729257459发短信：已收到商品，感谢" },
  { id: "0003", category: "inner_message", text: "给13800138000发短信：会议改到3点" },
  { id: "0001", category: "inner_message", text: "给韩梅梅发短信说我已经到楼下了" },

  // ── inner_entertainment ──
  {
    id: "0004",
    category: "inner_entertainment",
    text: "我听说何同学最近在B站更新了新视频，帮我打开看看。",
  },
  {
    id: "0002",
    category: "inner_entertainment",
    text: "忙了一整天终于休息了，想听邓紫棋的龙卷风放松下。",
  },
  { id: "0003", category: "inner_entertainment", text: "在哔哩哔哩播放三国演义" },
  { id: "0001", category: "inner_entertainment", text: "播放陈粒的小半" },

  // ── inner_cast ──
  {
    id: "0002",
    category: "inner_cast",
    text: "手机看电影屏幕太小了，把现在的画面同步到客厅的大电视上显示。",
  },
  { id: "0001", category: "inner_cast", text: "帮我投屏" },

  // ── inner_call ──
  {
    id: "0022",
    category: "inner_call",
    text: "手机里的通话历史太乱了，帮我把今天的记录都清理干净。",
  },
  {
    id: "0020",
    category: "inner_call",
    text: "我不希望每次打电话时手机都自动保存录音，帮我把这个功能关掉。",
  },
  {
    id: "0018",
    category: "inner_call",
    text: "我总是记不住电话里客户说的要求，能不能帮我把手机设成每次通话都自动保存录音？",
  },
  {
    id: "0016",
    category: "inner_call",
    text: "我最近想把来电都转接到另一个号上，带我去改一下通话相关的配置项。",
  },
  {
    id: "0014",
    category: "inner_call",
    text: "手机里的最近通话太乱了，帮我把那些记录全都清空吧。",
  },
  { id: "0012", category: "inner_call", text: "我想确认下昨天下午我是不是给李明打过电话。" },
  { id: "0010", category: "inner_call", text: "快帮我联系一下李明，我有急事要跟她商量。" },
  {
    id: "0008",
    category: "inner_call",
    text: "帮我看看过去三天有哪些人给我打过电话，我好像漏掉了一些重要信息。",
  },
  { id: "0006", category: "inner_call", text: "帮我看下是不是有没有漏掉没接的电话" },
  {
    id: "0004",
    category: "inner_call",
    text: "刚才忙着开会没注意看手机，帮我查一下有哪些漏掉的电话没接。",
  },
  {
    id: "0002",
    category: "inner_call",
    text: "手机好像欠费停机了，用我的主卡拨打一下移动客服电话。",
  },
  { id: "0021", category: "inner_call", text: "删除今天的通话记录" },
  { id: "0019", category: "inner_call", text: "关闭通话自动录音" },
  { id: "0017", category: "inner_call", text: "打开通话自动录音" },
  { id: "0015", category: "inner_call", text: "打开系统通话设置界面" },
  { id: "0013", category: "inner_call", text: "删除所有的通话记录" },
  { id: "0011", category: "inner_call", text: "查一下和韩梅梅的通话记录" },
  { id: "0009", category: "inner_call", text: "给韩梅梅打电话" },
  { id: "0007", category: "inner_call", text: "帮我查一下上周的通话记录" },
  { id: "0005", category: "inner_call", text: "查询刚刚的通话记录" },
  { id: "0003", category: "inner_call", text: "查未接来电" },
  { id: "0001", category: "inner_call", text: "用卡一拨打10086" },

  // ── inner_agenda ──
  { id: "0032", category: "inner_agenda", text: "明天早上九点，记得叫我下楼把垃圾给倒了。" },
  {
    id: "0030",
    category: "inner_agenda",
    text: "这周五晚上七点我得去机场接机，到点儿了你支会我一声。",
  },
  {
    id: "0028",
    category: "inner_agenda",
    text: "下周四晚上九点我和老王约了在东直门吃火锅，记得提醒我一下。",
  },
  {
    id: "0026",
    category: "inner_agenda",
    text: "我打算今年国庆节第二天上午十点去参加大学舍友的婚礼，帮我设置下提醒，免得我到时候玩过头给忘了。",
  },
  {
    id: "0024",
    category: "inner_agenda",
    text: "我下下周四下午5点得去宠物店给狗狗洗澡，你帮我记一下，免得我到时候忙忘了。",
  },
  {
    id: "0022",
    category: "inner_agenda",
    text: "我明天下午那个去健身房的计划取消了，帮我清理一下。",
  },
  {
    id: "0020",
    category: "inner_agenda",
    text: "我下周二下午两点半约了老板开会，你帮我记一下，别到时候忙忘了。",
  },
  { id: "0018", category: "inner_agenda", text: "后天下午三点记得喊我去接一下孩子，别给忘了。" },
  {
    id: "0016",
    category: "inner_agenda",
    text: "下周五晚上九点我和老王有个饭局，到时候记得吱一声。",
  },
  {
    id: "0014",
    category: "inner_agenda",
    text: "周杰伦演唱会的计划变了，我不打算去了，帮我把那个行程从日历里撤销掉。",
  },
  { id: "0012", category: "inner_agenda", text: "十月五号我要去悉尼度假，帮我把这事儿记一下。" },
  { id: "0010", category: "inner_agenda", text: "帮我看看我后天忙不忙，是不是有什么安排？" },
  {
    id: "0008",
    category: "inner_agenda",
    text: "后天下午三点我要准时出门去相亲，到时提醒我一下。",
  },
  {
    id: "0006",
    category: "inner_agenda",
    text: "明天中午十二点四十那个线上会很重要，帮我把这件事记下来。",
  },
  {
    id: "0004",
    category: "inner_agenda",
    text: "下周五晚上七点我约了朋友去逛街，帮我记一下省得我忘了。",
  },
  {
    id: "0002",
    category: "inner_agenda",
    text: "我这周天早上八点得去趟高铁站接人，帮我把这个事记下来以免我忘了。",
  },
  { id: "0031", category: "inner_agenda", text: "设置一个明天早上十点半丢垃圾的日程" },
  { id: "0029", category: "inner_agenda", text: "设置教师节下午两点回母校看老师的日程" },
  { id: "0027", category: "inner_agenda", text: "订一个下下周二下午6点外出放风筝的日程" },
  { id: "0025", category: "inner_agenda", text: "请在国庆节那天10点设置一个王明结婚的日程" },
  {
    id: "0023",
    category: "inner_agenda",
    text: "后天中午10点我要在家照顾我的贵宾犬和养花，请设置日程提醒我",
  },
  { id: "0021", category: "inner_agenda", text: "明天上午九点三十打羽毛球的日程可以删了" },
  { id: "0019", category: "inner_agenda", text: "设置一个明天上午八点十五分的日程我要吃药" },
  { id: "0017", category: "inner_agenda", text: "提醒我下周周二下午三点去看拆弹专家2的电影" },
  { id: "0015", category: "inner_agenda", text: "提醒我8月31日给老婆过生日" },
  { id: "0013", category: "inner_agenda", text: "取消一下去福州旅行的日程" },
  { id: "0011", category: "inner_agenda", text: "设置一个我7月1日要去马尔代夫旅行的日程" },
  { id: "0009", category: "inner_agenda", text: "列出明天的日程" },
  { id: "0007", category: "inner_agenda", text: "设置明天下午四点出去约会的提醒" },
  { id: "0005", category: "inner_agenda", text: "设置明天晚上八点四十在线上开会的日程" },
  { id: "0003", category: "inner_agenda", text: "定一个日程，本周周六晚上七点在家煮饭" },
  { id: "0001", category: "inner_agenda", text: "设置周六八点去医院的日程" },

  // ── inner_ask_user ──
  { id: "0004", category: "inner_ask_user", text: "我这会儿要出门，你帮我导航一下" },
  { id: "0002", category: "inner_ask_user", text: "我怕明天早上起不来，帮我定个响铃。" },
  { id: "0003", category: "inner_ask_user", text: "查一下那个谁的电话号码" },
  { id: "0001", category: "inner_ask_user", text: "定一个明天的闹钟" },

  // ── inner_alarm ──
  {
    id: "0016",
    category: "inner_alarm",
    text: "我打算给在伦敦留学的妹妹打个电话，帮我看看她那边现在几点。",
  },
  {
    id: "0014",
    category: "inner_alarm",
    text: "我一会儿要和纽约的同事开会，帮我看看他们那边现在几点了。",
  },
  {
    id: "0012",
    category: "inner_alarm",
    text: "这袋方便面三分钟就能泡好，帮我记下时间，到点叫我。",
  },
  { id: "0010", category: "inner_alarm", text: "我后天早上请假调休，不用九点叫醒我了。" },
  {
    id: "0008",
    category: "inner_alarm",
    text: "后天下午三点的会议临时推迟一个小时，帮我把那个时间的闹钟也改了吧。",
  },
  {
    id: "0006",
    category: "inner_alarm",
    text: "我明天得赶早班机，帮我确认下手机里有没有设好起床的提醒。",
  },
  {
    id: "0004",
    category: "inner_alarm",
    text: "明天下午两点那个抢票计划取消了，帮我把对应的提醒也撤掉吧。",
  },
  {
    id: "0002",
    category: "inner_alarm",
    text: "我明天上午九点有个非常重要的面试，记得提前一小时叫醒我，别让我睡过头了。",
  },
  { id: "0015", category: "inner_alarm", text: "堪培拉现在几点了" },
  { id: "0013", category: "inner_alarm", text: "打开世界时钟" },
  { id: "0011", category: "inner_alarm", text: "添加一个一分钟的倒计时" },
  { id: "0009", category: "inner_alarm", text: "关闭每天早上5点30的闹钟" },
  { id: "0007", category: "inner_alarm", text: "把后天下午2点的闹钟改成下午3点的闹钟" },
  { id: "0005", category: "inner_alarm", text: "查询明天的闹钟" },
  { id: "0003", category: "inner_alarm", text: "删除明天下午1点的闹钟" },
  { id: "0001", category: "inner_alarm", text: "添加一个明天早上8点的闹钟，起床" },

  // ── artifact_image_gen ──
  {
    id: "0004",
    category: "artifact_image_gen",
    text: "我正在写一部科幻小说，帮我构思两张2048x2048的宇宙黑暗森林法则的插图，用来当做章节配图。",
  },
  {
    id: "0002",
    category: "artifact_image_gen",
    text: "我正在写一篇关于深海探险的科幻故事，能给我整一张那种既有发光水母又有废弃潜艇的海底画面吗？",
  },
  {
    id: "0003",
    category: "artifact_image_gen",
    text: "生成2张1024x1024分辨率的赛博朋克未来城市风景图",
  },
  { id: "0001", category: "artifact_image_gen", text: "帮我画一只在草地上玩耍的可爱小狗" },
];

// ── 变体测试用例（随机扰动生成，用于鲁棒性测试） ──

const VARIANT_CASES: { id: string; category: string; text: string }[] = [
  // ── inner_ztescreenshot (5 条) ──
  { id: "v_zt_01", category: "inner_ztescreenshot", text: "快，给我截个图保存下来" },
  { id: "v_zt_02", category: "inner_ztescreenshot", text: "把当前这个界面抓拍一张" },
  { id: "v_zt_03", category: "inner_ztescreenshot", text: "帮我把屏幕上的信息截取下来" },
  { id: "v_zt_04", category: "inner_ztescreenshot", text: "这页面很重要，先截个屏留个底" },
  { id: "v_zt_05", category: "inner_ztescreenshot", text: "capture the current screen for me" },

  // ── inner_weather (10 条) ──
  { id: "v_we_01", category: "inner_weather", text: "下周去三亚度假，那边会不会一直下雨啊？" },
  { id: "v_we_02", category: "inner_weather", text: "这几天降温降得厉害，什么时候能回暖？" },
  { id: "v_we_03", category: "inner_weather", text: "帮我瞧一眼今天外面的气温多少度" },
  { id: "v_we_04", category: "inner_weather", text: "后天有马拉松比赛，刮不刮大风？" },
  { id: "v_we_05", category: "inner_weather", text: "今天紫外线强不强，用不用涂防晒？" },
  { id: "v_we_06", category: "inner_weather", text: "what's the weather forecast for tomorrow" },
  { id: "v_we_07", category: "inner_weather", text: "这雨啥时候能停啊，我想出门买菜" },
  { id: "v_we_08", category: "inner_weather", text: "看外面天阴得厉害，一会儿会不会下暴雨？" },
  { id: "v_we_09", category: "inner_weather", text: "查查北京今明两天的温差大不大" },
  { id: "v_we_10", category: "inner_weather", text: "下雪了没？路上滑不滑？" },

  // ── inner_transportation (10 条) ──
  {
    id: "v_tr_01",
    category: "inner_transportation",
    text: "帮我规划一条从家到天安门最快的行车路线",
  },
  { id: "v_tr_02", category: "inner_transportation", text: "附近哪儿有经济实惠的快捷酒店？" },
  { id: "v_tr_03", category: "inner_transportation", text: "给我叫一辆网约车去虹桥机场" },
  {
    id: "v_tr_04",
    category: "inner_transportation",
    text: "查下从上海飞昆明的航班都有哪几个时间段的",
  },
  { id: "v_tr_05", category: "inner_transportation", text: "骑电动车去万达广场路上大概多长时间" },
  { id: "v_tr_06", category: "inner_transportation", text: "末班地铁是几点？帮我看看能不能赶上" },
  { id: "v_tr_07", category: "inner_transportation", text: "我要去火车站接人，坐几路公交能到？" },
  { id: "v_tr_08", category: "inner_transportation", text: "导航步行去最近的大型超市" },
  {
    id: "v_tr_09",
    category: "inner_transportation",
    text: "find me a nice hotel near the city center",
  },
  { id: "v_tr_10", category: "inner_transportation", text: "附近扫个单车骑到钟楼要多久" },

  // ── inner_system_settings (10 条) ──
  { id: "v_ss_01", category: "inner_system_settings", text: "来电铃声音量调到80%" },
  {
    id: "v_ss_02",
    category: "inner_system_settings",
    text: "这手机怎么没声儿了，帮我把扬声器打开",
  },
  { id: "v_ss_03", category: "inner_system_settings", text: "开一下勿扰模式，我要午休一会儿" },
  { id: "v_ss_04", category: "inner_system_settings", text: "屏幕太暗了，亮度帮我调亮点" },
  { id: "v_ss_05", category: "inner_system_settings", text: "手电咋关不掉，帮我把它灭了" },
  { id: "v_ss_06", category: "inner_system_settings", text: "turn on silent mode please" },
  { id: "v_ss_07", category: "inner_system_settings", text: "手机振动太吵了，改成完全静音" },
  { id: "v_ss_08", category: "inner_system_settings", text: "通话音质不太行，是不是音量没调好" },
  { id: "v_ss_09", category: "inner_system_settings", text: "帮我启用飞行模式" },
  { id: "v_ss_10", category: "inner_system_settings", text: "找找我的设备在哪，好像掉沙发缝里了" },

  // ── inner_recorder (7 条) ──
  { id: "v_re_01", category: "inner_recorder", text: "现在开始录，把会议内容全记下来" },
  { id: "v_re_02", category: "inner_recorder", text: "录完了没？把刚才录的音频保存一下" },
  { id: "v_re_03", category: "inner_recorder", text: "讲课的内容帮我用录音记一下，回头好复习" },
  { id: "v_re_04", category: "inner_recorder", text: "等一下再录，先按个暂停" },
  { id: "v_re_05", category: "inner_recorder", text: "继续接着刚才的地方往下录" },
  { id: "v_re_06", category: "inner_recorder", text: "昨天晚上录的那段在哪？我要回放听一下" },
  { id: "v_re_07", category: "inner_recorder", text: "start voice recording now" },

  // ── inner_message (7 条) ──
  { id: "v_ms_01", category: "inner_message", text: "给小王发条微信，就说我已经出发了" },
  { id: "v_ms_02", category: "inner_message", text: "帮我回个消息给13812345678：收到了谢谢" },
  { id: "v_ms_03", category: "inner_message", text: "编辑一条短消息通知大家明天会议取消" },
  { id: "v_ms_04", category: "inner_message", text: "send a text to my boss saying I'll be late" },
  { id: "v_ms_05", category: "inner_message", text: "跟老李知会一下，我下午不去公司了" },
  { id: "v_ms_06", category: "inner_message", text: "帮忙发个信息告诉我妈今晚不回家吃饭" },
  { id: "v_ms_07", category: "inner_message", text: "发个消息通知同事下午两点的会改期了" },

  // ── inner_entertainment (7 条) ──
  { id: "v_en_01", category: "inner_entertainment", text: "放一首周杰伦的七里香来听听" },
  { id: "v_en_02", category: "inner_entertainment", text: "在YouTube上搜一下那个搞笑的猫咪视频" },
  { id: "v_en_03", category: "inner_entertainment", text: "打开网易云放点轻音乐，我想放松一下" },
  { id: "v_en_04", category: "inner_entertainment", text: "最近有什么新上的电影，帮我查查排片" },
  { id: "v_en_05", category: "inner_entertainment", text: "无聊死了，给我播个脱口秀听听" },
  { id: "v_en_06", category: "inner_entertainment", text: "看会儿直播吧，帮我进一下抖音" },
  { id: "v_en_07", category: "inner_entertainment", text: "play some relaxing jazz music" },

  // ── inner_cast (5 条) ──
  { id: "v_ca_01", category: "inner_cast", text: "帮我把手机画面投射到客厅的电视上" },
  { id: "v_ca_02", category: "inner_cast", text: "把这个视频从手机推送到投影仪播放" },
  { id: "v_ca_03", category: "inner_cast", text: "连一下电视，我要在大屏上看照片" },
  { id: "v_ca_04", category: "inner_cast", text: "屏幕镜像到会议室的显示器上" },
  { id: "v_ca_05", category: "inner_cast", text: "cast my screen to the smart TV" },

  // ── inner_call (10 条) ──
  { id: "v_cl_01", category: "inner_call", text: "拨一下老张的号码，我有急事" },
  { id: "v_cl_02", category: "inner_call", text: "查下有没有未接的电话，刚才手机不在身边" },
  { id: "v_cl_03", category: "inner_call", text: "帮我把最近三天的通话清单列出来" },
  { id: "v_cl_04", category: "inner_call", text: "设置来电呼叫转移到我的工作号码" },
  { id: "v_cl_05", category: "inner_call", text: "把昨天和前天的通话历史删了吧" },
  { id: "v_cl_06", category: "inner_call", text: "以后所有通话都要自动录下来保存" },
  { id: "v_cl_07", category: "inner_call", text: "关了通话自动录音吧，占内存" },
  { id: "v_cl_08", category: "inner_call", text: "看一眼有没有谁给我打过电话我没接着" },
  { id: "v_cl_09", category: "inner_call", text: "帮我回拨一下刚才那个未接来电" },
  { id: "v_cl_10", category: "inner_call", text: "call my mom right now" },

  // ── inner_agenda (10 条) ──
  { id: "v_ag_01", category: "inner_agenda", text: "在日历上标记一下，下个月3号要去体检" },
  { id: "v_ag_02", category: "inner_agenda", text: "后天跟牙医的预约帮我取消了吧" },
  { id: "v_ag_03", category: "inner_agenda", text: "这周六有什么安排？帮我查查日程表" },
  { id: "v_ag_04", category: "inner_agenda", text: "别忘了提醒我明天早上交报告" },
  { id: "v_ag_05", category: "inner_agenda", text: "周五下午三点要开周会，先帮我记上" },
  { id: "v_ag_06", category: "inner_agenda", text: "下下周一是老妈生日，提前设个提醒" },
  { id: "v_ag_07", category: "inner_agenda", text: "把下周二的瑜伽课从日程里移除" },
  {
    id: "v_ag_08",
    category: "inner_agenda",
    text: "add a meeting to my calendar for next Monday 9am",
  },
  { id: "v_ag_09", category: "inner_agenda", text: "这周五晚上别忘了喊我去参加同学聚会" },
  { id: "v_ag_10", category: "inner_agenda", text: "清空明天所有的日程安排" },

  // ── inner_alarm (10 条) ──
  { id: "v_al_01", category: "inner_alarm", text: "定个早晨六点半的闹铃，明天要赶飞机" },
  { id: "v_al_02", category: "inner_alarm", text: "帮我把后天晚上的闹钟关掉" },
  { id: "v_al_03", category: "inner_alarm", text: "半小时后叫我，我要小睡一会儿" },
  { id: "v_al_04", category: "inner_alarm", text: "纽约跟北京时差多少？帮我换算一下" },
  { id: "v_al_05", category: "inner_alarm", text: "设一个煮鸡蛋的计时器，五分钟" },
  { id: "v_al_06", category: "inner_alarm", text: "把每天早上7点的起床闹钟调到七点半" },
  { id: "v_al_07", category: "inner_alarm", text: "set an alarm for 6am tomorrow" },
  { id: "v_al_08", category: "inner_alarm", text: "倒计时十五分钟，我做个冥想" },
  { id: "v_al_09", category: "inner_alarm", text: "查下还有哪些闹钟是开着的" },
  { id: "v_al_10", category: "inner_alarm", text: "东京现在是几点几分？" },

  // ── artifact_image_gen (7 条) ──
  { id: "v_ig_01", category: "artifact_image_gen", text: "给我生成一张夕阳下海边灯塔的风景画" },
  {
    id: "v_ig_02",
    category: "artifact_image_gen",
    text: "画一幅未来城市的科幻概念图，要带飞行汽车",
  },
  { id: "v_ig_03", category: "artifact_image_gen", text: "帮我设计一个咖啡店logo的图案" },
  {
    id: "v_ig_04",
    category: "artifact_image_gen",
    text: "generate a poster for our summer music festival",
  },
  { id: "v_ig_05", category: "artifact_image_gen", text: "制作一张春节拜年用的喜庆贺图" },
  { id: "v_ig_06", category: "artifact_image_gen", text: "我要做PPT，帮我找一张团队合作的配图" },
  { id: "v_ig_07", category: "artifact_image_gen", text: "画个穿着宇航服的橘猫在月球上漫步" },
];

// ── 主入口 ──

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
skill-classifier 测试工具

用法:
  pnpm tsx extensions/simple-task-handel/test-classify.ts "明天天气怎么样"
  pnpm tsx extensions/simple-task-handel/test-classify.ts --batch           (仅原始测试集)
  pnpm tsx extensions/simple-task-handel/test-classify.ts --batch --variant (仅变体测试集)
  pnpm tsx extensions/simple-task-handel/test-classify.ts --batch --all     (两个测试集)
  pnpm tsx extensions/simple-task-handel/test-classify.ts --batch --errors  (显示错误详情)
`);
  process.exit(0);
}

if (args.includes("--batch")) {
  const showErrors = args.includes("--errors");
  const useAll = args.includes("--all");
  const useVariant = args.includes("--variant");

  const testSets: { label: string; cases: typeof TEST_CASES }[] = [];
  if (useAll || (!useVariant && !useAll)) {
    testSets.push({ label: "原始测试集", cases: TEST_CASES });
  }
  if (useAll || useVariant) {
    testSets.push({ label: "变体测试集", cases: VARIANT_CASES });
  }

  let totalErrors = 0;
  let grandTotal = 0;
  let grandCorrect = 0;

  for (const { label, cases } of testSets) {
    const result = batchClassify(cases);
    grandTotal += result.total;
    grandCorrect += result.correct;

    console.log(`\n=== ${label} ===`);
    console.log(`总数: ${result.total} | 正确: ${result.correct} | 准确率: ${result.accuracy}\n`);

    const byCategory: Record<string, { total: number; correct: number }> = {};
    for (const d of result.details) {
      byCategory[d.expected] ??= { total: 0, correct: 0 };
      byCategory[d.expected].total++;
      if (d.ok) byCategory[d.expected].correct++;
    }

    console.log("--- 按类别准确率 ---");
    for (const [cat, stats] of Object.entries(byCategory).sort()) {
      const pct = ((stats.correct / stats.total) * 100).toFixed(1);
      const bar = "█".repeat(Math.round((stats.correct / stats.total) * 20));
      console.log(`  ${cat}: ${stats.correct}/${stats.total} ${pct}% ${bar}`);
    }

    const errors = result.details.filter((d) => !d.ok);
    totalErrors += errors.length;
    if (errors.length > 0 && showErrors) {
      console.log(`\n--- 错误详情 (${errors.length} 条) ---`);
      for (const e of errors) {
        console.log(
          `  [${e.id}] 期望: ${e.expected} → 实际: ${e.predicted} (score=${e.score.toFixed(2)}) "${e.text}"`,
        );
      }
    } else if (errors.length > 0) {
      console.log(`\n${errors.length} 条错误，使用 --errors 查看详情`);
    }
  }

  if (testSets.length > 1) {
    const overallPct = ((grandCorrect / grandTotal) * 100).toFixed(1);
    console.log(`\n=== 综合 ===`);
    console.log(`总数: ${grandTotal} | 正确: ${grandCorrect} | 准确率: ${overallPct}%`);
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

// 单条测试模式
const query = args.join(" ");
const result = await classifySkill(query);
console.log(`\n输入: "${query}"`);
console.log(`匹配: ${result.matched ? "✓" : "✗"}`);
console.log(`类别: ${result.category ?? "无"}`);
console.log(`标签: ${result.label || "无"}`);
console.log(`Skill: ${result.skillName || "无"}`);
console.log(`得分: ${result.score.toFixed(3)}`);
if (Object.keys(result.scores).length > 0) {
  const topScores = Object.entries(result.scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a);
  if (topScores.length > 0) {
    console.log(`各分类得分:`);
    for (const [cat, score] of topScores) {
      console.log(`  ${cat}: ${score.toFixed(3)}`);
    }
  } else {
    console.log(`(所有类别得分均为 0)`);
  }
}
console.log();
