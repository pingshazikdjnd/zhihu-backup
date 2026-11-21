/**
 * 知乎回答/文章「和谐风险（防夹预警）+ 内容含金量」双维评估引擎
 *
 * 设计目标：
 * 找出那些「写得好（高赞、高收藏比、深度长文）但容易被知乎管家折叠/删除/禁评」的高危内容，
 * 供「关注的人」与「推荐页」凸显预警，并配合 Cloudflare Workers AI 做深度风险鉴定。
 */

export type RiskAssessment = {
  risk_score: number; // 0 ~ 100
  risk_level: "high" | "medium" | "low";
  risk_tags: string[];
  value_score: number; // 0 ~ 100（“写得好”程度）
};

// 高危/易触发知乎管家巡查或争议折叠的议题词簇（社会/历史/国际/体制/经济/舆论）
const HIGH_RISK_KEYWORDS = [
  "审查", "封禁", "删帖", "河蟹", "和谐", "敏感", "禁评", "夹总", "小管家",
  "文革", "苏联", "解体", "政治", "政权", "意识形态", "官僚", "特权", "权贵", "既得利益",
  "阶级", "阶层固化", "剥削", "牛马", "人矿", "烂尾", "维权", "赋红码", "公信力",
  "人口崩塌", "生育率", "断交", "制裁", "房价崩盘", "失业率", "洗脑", "润学", "润出", "亡国",
  "贪腐", "腐败", "垄断", "内幕", "真相", "反思", "历史虚无", "拜金", "男女对立", "彩礼"
];

const MEDIUM_RISK_KEYWORDS = [
  "华为", "公知", "民族", "爱国", "资本家", "996", "劳动法", "工会", "裁员",
  "房地产", "土地财政", "城投", "地方债", "集采", "医保", "养老金", "延迟退休",
  "教育公平", "学区房", "考公", "编制", "国企", "央企", "体制内", "贫富差距",
  "俄乌", "中东", "以色列", "巴勒斯坦", "台海", "关税", "贸易战", "芯片封锁"
];

export function evaluateContentRisk(row: any): RiskAssessment {
  let riskScore = 0;
  const tags: string[] = [];

  const voteup = Number(row?.voteup_count) || 0;
  const comments = Number(row?.live_comment_count ?? row?.comment_count) || 0;
  const favs = Number(row?.favorite_count) || 0;
  const isDeleted = Number(row?.is_deleted) === 1;
  const isCollapsed = Number(row?.is_collapsed) === 1;
  const isLabeled = Number(row?.is_labeled) === 1 || Boolean(row?.label_info && row.label_info !== "" && row.label_info !== "null");

  const text = `${row?.question_title || ""} ${row?.title || ""} ${row?.excerpt || ""}`.toLowerCase();

  // 1. 原站已处置信号（最高权重）
  if (isDeleted) {
    riskScore += 55;
    tags.push("💀 原站已删/绝版");
  }
  if (isCollapsed) {
    riskScore += 45;
    tags.push("⚠️ 原站已折叠");
  }
  if (isLabeled) {
    riskScore += 30;
    tags.push("🏷️ 争议/风险黄标");
  }

  // 2. 评论区异常信号（高赞但 0 评论或极低评论，通常是评论区被关闭/精选管控的高危帖）
  if (voteup >= 1000 && comments === 0) {
    riskScore += 35;
    tags.push("🔇 千赞零评(疑似禁评)");
  } else if (voteup >= 250 && comments === 0) {
    riskScore += 25;
    tags.push("🔇 高赞零评(疑似禁评)");
  } else if (voteup >= 2000 && comments > 0 && voteup / comments >= 80) {
    riskScore += 18;
    tags.push("🔒 评论严控");
  }

  // 3. 议题敏感度匹配
  let highHits = 0;
  for (const kw of HIGH_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      highHits++;
      if (highHits >= 3) break;
    }
  }
  let medHits = 0;
  for (const kw of MEDIUM_RISK_KEYWORDS) {
    if (text.includes(kw)) {
      medHits++;
      if (medHits >= 3) break;
    }
  }

  if (highHits > 0) {
    riskScore += 22 + (highHits - 1) * 10;
    tags.push("🔥 高敏议题");
  } else if (medHits > 0) {
    riskScore += 14 + (medHits - 1) * 7;
    tags.push("⚡ 热点争议议题");
  }

  // 4. 内容含金量（“写得好”）与传播热度（越火的敏感帖越容易被夹）
  let valueScore = 0;
  if (voteup >= 10000) valueScore += 45;
  else if (voteup >= 3000) valueScore += 35;
  else if (voteup >= 1000) valueScore += 28;
  else if (voteup >= 300) valueScore += 20;
  else if (voteup >= 50) valueScore += 12;

  // 收藏/赞同比：知乎硬核干货与深度神贴最显著的特征
  const favRatio = voteup >= 50 ? favs / voteup : 0;
  if (favRatio >= 0.5) {
    valueScore += 30;
    riskScore += 12;
    tags.push("⭐ 极高收藏比(硬核神贴)");
  } else if (favRatio >= 0.25 || favs >= 1000) {
    valueScore += 20;
    riskScore += 6;
    tags.push("💎 高收藏干货");
  }

  if (row?.upvote_time) valueScore += 12;
  if (Number(row?.in_favorites) === 1) valueScore += 15;

  // 高传播度的敏感内容更容易触发人工审核
  if ((highHits > 0 || medHits > 0) && voteup >= 1000) {
    riskScore += 12;
    tags.push("📈 高赞引流易被巡查");
  }

  const finalRisk = Math.min(100, Math.round(riskScore));
  const finalValue = Math.min(100, Math.round(valueScore));
  const riskLevel: "high" | "medium" | "low" =
    finalRisk >= 50 ? "high" : finalRisk >= 28 ? "medium" : "low";

  return {
    risk_score: finalRisk,
    risk_level: riskLevel,
    risk_tags: tags.slice(0, 3),
    value_score: finalValue
  };
}
