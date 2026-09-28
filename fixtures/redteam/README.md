# 红队载荷（T3.4 J8/J9 毒物隔离区）

- 本目录内容是**攻击载荷**：只允许在 CI mock fixture 环境被红队用例读取；
  禁入 sqlite 正文、禁入时间线 chunk 正文、禁进主上下文（J9 载荷零泄漏纪律）。
- 用例记录只存 fixture 的 SHA-256 hash；取证时经 hash 定位本目录文件（CI 产物留存）。
