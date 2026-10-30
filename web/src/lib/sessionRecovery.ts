// 会话结束文案：实现在 `packages/core/src/sessionCompletion.ts`，这里只做
// re-export。
//
// 在这之前 Web 与 core 各留了一份**逐字相同**的 `sessionExitLabel` /
// `sessionTimeLimitNotice` / `sessionRecoveryNotice`（core 那份的注释里写着
// 「逐字来自 web/src/lib/sessionRecovery.ts」「两端必须一致」），也就是说这三
// 段文案的一致性此前只靠人记得同时改两处。结束页 / 历史页是两端都要看的同
// 一屏，文案漂了用户直接可见，所以把 Web 这份换成从 core 取，漂移源消掉。
//
// 调用点（`finishedSessionData.ts`、`ConsumerHistoryPage.tsx`、
// `MultilingualShowcasePage.tsx`）保持从这里 import，不用跟着改。
export {
  sessionExitLabel,
  sessionRecoveryNotice,
  sessionTimeLimitNotice,
} from '@simultrans/core/sessionCompletion'
