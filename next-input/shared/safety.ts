// 保守的交互门禁，不判断用户意图；正常提问命中时也要求先修改文字。
export function requiresEditing(text: string): boolean {
  return /`/.test(text)
    || /\b(?:rm|sudo|curl|wget|chmod|chown|ssh|scp|DROP|DELETE|TRUNCATE)\b/i.test(text)
    || /\bgit\s+(?:push|reset)\b/i.test(text)
    || /--force\b|(?:^|\s)-f(?=\s|$)/i.test(text)
    || /(?:^|[^A-Za-z0-9_])(?:~\/|\.\.?\/|\/|[A-Za-z]:[\\/])/.test(text)
    || /https?:\/\/|www\./i.test(text)
    || /\.env\b|\b(?:token|secret|password|apikey|api\s+key|private\s+key|ssh\s+key)\b|密钥|令牌|密码/i.test(text)
    || /删除|清空|覆盖|推送|部署|发布|上线|强制|\b(?:delete|remove|wipe|overwrite|push|deploy|publish|release|force)\b/i.test(text);
}
