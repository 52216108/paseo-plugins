export interface Draft {
  text: string;
  sourceText: string;
  expanded: boolean;
  attempted: boolean;
  sent: boolean;
  notice: string;
}

// 由插件安装实例持有，滚动卸载一行不会丢失正在编辑的文字。
export class Drafts {
  private values = new Map<string, Draft>();
  get(token: string, text: string): Draft {
    return this.values.get(token) ?? { text, sourceText: text, expanded: false, attempted: false, sent: false, notice: "" };
  }
  edited(token: string): Draft | undefined {
    const draft = this.values.get(token);
    return draft?.expanded && draft.text !== draft.sourceText && !draft.sent ? draft : undefined;
  }
  update(token: string, text: string, patch: Partial<Draft>): Draft {
    const next = { ...this.get(token, text), ...patch };
    this.values.set(token, next);
    return next;
  }
  clear(): void { this.values.clear(); }
}
