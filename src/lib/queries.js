/* 查询内容质量统计。v4 不再提供查询改写与会话链：
 * 每轮直接使用一条真实热搜词，从根上避免「搜索词越来越长」。 */
export function quality(queries) {
  const qs = queries.filter((q) => typeof q === "string" && q.trim());
  if (!qs.length) return { n: 0 };
  const lens = qs.map((q) => q.replace(/\s/g, "").length);
  const n = qs.length;
  return {
    n,
    avgLen: +(lens.reduce((a, b) => a + b, 0) / n).toFixed(2),
    maxLen: Math.max(...lens),
    uniqueRate: +(new Set(qs).size / n).toFixed(3),
    longTailRate: +(qs.filter((q) => q.split(/\s+/).length >= 3 || q.replace(/\s/g, "").length >= 8).length / n).toFixed(3),
    questionRate: +(qs.filter((q) => /怎么|为什么|是什么|多少钱|有哪些|在哪|how|what|\?/i.test(q)).length / n).toFixed(3),
    samples: qs.slice(0, 5),
  };
}
