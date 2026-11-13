import type { Tag } from "./types";
export const TAGS: Tag[] = [
  ["verb-tense", "时态与体", "结合语境选择谓语时态"], ["subject-agreement", "主谓一致", "谓语与主语在人称和数上一致"],
  ["passive", "被动语态", "判断主语与动作的关系"], ["infinitive", "动词不定式", "不定式结构与功能"],
  ["participle-ing", "动名词与现在分词", "-ing 形式的句法功能"], ["participle-ed", "过去分词", "过去分词的功能与关系"],
  ["noun", "名词单复数", "可数性与名词形式"], ["pronoun", "代词形式", "人称、物主与反身代词"],
  ["article", "冠词", "a、an、the 与零冠词"], ["determiner", "其他限定词", "数量与指示限定"],
  ["word-formation", "词性转换", "根据句法选择词性"], ["comparison", "比较等级", "形容词和副词的比较"],
  ["preposition", "介词", "介词的语义与搭配"], ["conjunction", "并列连词", "连接关系与逻辑"],
  ["relative-clause", "定语从句", "先行词、关系词与从句成分"], ["noun-clause", "名词性从句", "主宾表同位语从句"],
  ["adverbial-clause", "状语从句", "时间、条件、让步等关系"], ["fixed-expression", "固定结构", "语境中的固定表达"],
  ["unclassified", "待归类", "暂时不能确定的考点"],
].map(([id, name, description]) => ({ id, name, description }));
export const isTag = (id: string) => TAGS.some(tag => tag.id === id);
export const tagName = (id: string) => TAGS.find(tag => tag.id === id)?.name ?? "待归类";
