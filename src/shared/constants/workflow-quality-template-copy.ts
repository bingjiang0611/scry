/**
 * Copy for the quality-oriented builtin templates. Kept separate from the large
 * shared dictionaries so each authored file stays small; the text is user-visible
 * and therefore centralised here rather than inline in the template definitions.
 */
export const WORKFLOW_QUALITY_TEMPLATE_COPY = {
  adversarial: {
    name: '对抗复核对',
    description: '两名复核者分别寻找反例与审计证据，再由裁决者保留分歧。意见不是系统检查或写入授权。',
    hunter: '只做一件事：尝试推翻给定候选。给出具体反例、触发条件和缺失证据；找不到反例时明确说明已尝试的角度，不要用赞同代替反驳。',
    auditor: '审计给定候选的证据链：区分已核实的系统结果、模型自述和未验证推断。列出无法验证的断言及其影响，不把通过性意见当作检查结果。',
    adjudicator: '综合两名复核者的意见与原目标。明确哪些质疑成立、哪些不成立及依据；保留未解决的分歧，不宣称系统检查已通过，也不授权写入。输出 typed_refutation_feedback：逐条列出 refutation 与 successor feedback。'
  },
  research: {
    name: '研究简报',
    description: '并行比较来源，保留证据来源与不确定性，再形成简报。',
    sourceA: '调查问题并区分已观察事实与假设。只使用提供的材料，不编造引用。',
    sourceB: '独立调查问题，寻找反证与未知项。明确哪些内容需要外部验证。',
    review: '核对两份调查中的主张与证据，标记没有依据的主张。',
    brief: '写出带来源和明确不确定性的简报。不要编造引用或把研究意见写成检查结果。'
  },
  multiAngle: {
    name: '多角度方案与裁决',
    description: '三个角度并行起草，交叉评审后裁决并改进。中间草稿不进入父会话，改进版仍需复核。',
    angleA: '从最小可靠实现角度起草方案。说明取舍、成本与被删除的可能范围；不修改文件，不声称已验证。',
    angleB: '从可维护性与失败模式角度起草方案。列出最可能的失败路径和观测手段；不修改文件，不声称已验证。',
    angleC: '从用户可见行为与回归风险角度起草方案。给出可接受的验收证据；不修改文件，不声称已验证。',
    crossReview: '对三份草稿做交叉评审。逐份指出与其他草稿冲突之处、各自遗漏的前提，以及需要实测才能决定的分歧；不要合并成一份新方案。',
    arbitrate: '基于交叉评审裁决：选择或组合方案，写明理由与被放弃方案的原因。不得把未经检验的组合当作已验证。',
    improve: '按裁决结论产出改进后的单一方案，先检查 hard constraints。若没有满足约束的方案，明确输出 no_acceptable_plan；否则保留仍然存在的风险与未验证项。只输出方案文本，不修改文件，不宣称检查通过。',
    revalidate: '对最终方案逐条重新验证 hard constraints 与裁决结论。只报告复核结果，不修改文件；若证据不足，标为未验证。',
    noPlan: '明确报告 no_acceptable_plan，列出阻断的 hard constraints 和需要用户决定的取舍，不伪造方案。'
  }
} as const
