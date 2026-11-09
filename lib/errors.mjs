// 调用失败的分类：spawn / timeout / aborted / exit（CLI 报错或没给出结果）/ empty / parse（回复格式不对）。
// details 里带着 stdout、stderr、退出码，供调用记录保存。
export class AgentError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}
