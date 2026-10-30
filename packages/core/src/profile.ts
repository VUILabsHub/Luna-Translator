// 账号资料一期（只在 Canary 候选环境）：名字的规整 / 校验与默认头像取字，Web、iOS、Android 共用。
//
// 同一套名字规则管资料名和会议建会 / 入会 / 游客名（这些名字都会展示给同场的其他人）。后端校验器按同一份
// 规则实现：规则表（DISPLAY_NAME_RULES）和行为向量都写在 packages/core/tests/fixtures/profile-name-vectors.json，
// 两端测试都读它，规则表逐项比对，改规则时两边一起改。
//
// 只用显式码点区间，不用 `\p{}` 或带 `u` 的正则：Hermes 也要跑。

type CodePointRange = readonly [number, number]

/** 名字最多这么多个码点（规整之后数；一个 emoji 算一个，与后端按 rune 计数一致）。 */
export const PROFILE_NAME_MAX = 20

/** 默认头像底色：Canary 绿渐变（CSS 原样，RN 0.81 的 experimental_backgroundImage 与 Web 都直接用）。 */
export const PROFILE_AVATAR_GRADIENT = 'linear-gradient(135deg, #7FA47F 0%, #568157 100%)'

/**
 * 名字被拒的原因，按 checkOrder 的先后只报第一个：
 * empty 空 / too_long 超长 / invalid_char 控制、格式（零宽、双向控制）、私用区等不可见或乱码字符 /
 * contact 手机号（≥6 位连续数字）、网址、邮箱、QQ / 微信等联系方式 / reserved 保留名（我、游客、主持人、官方…）/
 * restricted 「中国」「国家」等须从严核验的词（《互联网用户账号信息管理规定》第十条，直接拒绝）/
 * blocked 命中关键词库（库在服务端 Secret 里，客户端一般不传）。
 */
export type DisplayNameProblem = 'empty' | 'too_long' | 'invalid_char' | 'contact' | 'reserved' | 'restricted' | 'blocked'

export type DisplayNameValidation = { ok: true; value: string } | { ok: false; reason: DisplayNameProblem }

export type DisplayNameOptions = {
  /** 关键词库钩子：每个词按 foldDisplayName 折叠后做包含匹配，命中报 blocked。 */
  blockedKeywords?: readonly string[]
}

/** 各原因的提示文案（App 改名弹窗、Web 与后端 400 的 error 同字）。 */
export const DISPLAY_NAME_PROBLEM_MESSAGES: Readonly<Record<DisplayNameProblem, string>> = {
  empty: '请输入名字',
  too_long: `名字最多 ${PROFILE_NAME_MAX} 个字`,
  invalid_char: '名字不能包含特殊符号',
  contact: '名字不能包含手机号、网址或联系方式',
  reserved: '这个名字不可用，请换一个',
  restricted: '名字不能包含「中国」「国家」等词语',
  blocked: '这个名字不可用，请换一个',
}

/**
 * 名字规则表。区间都是闭区间；词表里的词已经是 foldDisplayName 折叠后的样子（小写、半角、无空格标点）。
 * - invalidCodePointRanges：C0 / DEL / C1 控制符；Unicode 15.0 的全部格式字符 Cf（零宽 200B–200F 含 ZWJ、
 *   双向控制 202A–202E / 2066–206F、FEFF、标签字符等）；代理项；私用区；非字符；FFFC / FFFD；
 *   看着是空白的填充字符（CGJ 034F、谚文填充 115F–1160 / 3164 / FFA0、高棉 17B4–17B5、蒙古文 FVS、盲文空格 2800）。
 *   用 ZWJ 拼起来的组合 emoji（如「一家三口」）因此被拒，单个 emoji 可以。
 * - leadingMarkRanges：名字不能以附加符开头（否则只剩一个看不见的名字，或者一个虚线圈）。即 Unicode 15.0 的
 *   全部 M 类（Mn / Mc / Me，含变体选择符），与 Go 1.21+ 的 unicode.M 逐码点相同；阿拉伯文、泰文、天城文的
 *   元音符号都在里面。
 * - digitRanges：算「数字」的字——半角 / 全角、阿拉伯-印度、天城文、泰文、数学字母数字、带圈 / 带括号 / 带点数字、
 *   上下标数字。hanDigitRanges：中文数字〇零一二三四五六七八九、读号码用的幺两、大写壹贰叁肆伍陆柒捌玖（含繁体）。
 *   两种分开数：同一段里（digitSeparatorRanges——空格、- . / _、间隔号、各种破折号、减号、片假名中点——
 *   夹在中间不打断，两种数字互相也不打断）任一种到 minDigitRun 个就算手机号。这样「张三三1998」「九九 2025」
 *   不算，而 11 位号码不管怎么混写，总有一种至少 6 个。
 * - foldDropRanges：折叠时丢掉的字（ASCII 标点空白、拉丁-1 标点、通用标点、箭头到杂项符号、CJK 标点、
 *   变体选择符、竖排 / 小写形式、半角标点、emoji 区），用来让「微 信」「中-国」这类插字也能命中词表。
 */
export const DISPLAY_NAME_RULES = {
  maxCodePoints: PROFILE_NAME_MAX,
  checkOrder: ['empty', 'too_long', 'invalid_char', 'contact', 'reserved', 'restricted', 'blocked'] as const,
  invalidCodePointRanges: [
    [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x0600, 0x0605], [0x061c, 0x061c],
    [0x06dd, 0x06dd], [0x070f, 0x070f], [0x0890, 0x0891], [0x08e2, 0x08e2], [0x115f, 0x1160], [0x17b4, 0x17b5],
    [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0x2800, 0x2800],
    [0x3164, 0x3164], [0xd800, 0xdfff], [0xe000, 0xf8ff], [0xfdd0, 0xfdef], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
    [0xfff9, 0xffff], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a], [0x1fffe, 0x1ffff], [0x2fffe, 0x2ffff], [0x3fffe, 0x3ffff], [0x4fffe, 0x4ffff],
    [0x5fffe, 0x5ffff], [0x6fffe, 0x6ffff], [0x7fffe, 0x7ffff], [0x8fffe, 0x8ffff], [0x9fffe, 0x9ffff],
    [0xafffe, 0xaffff], [0xbfffe, 0xbffff], [0xcfffe, 0xcffff], [0xdfffe, 0xdffff], [0xe0000, 0xe007f],
    [0xefffe, 0xeffff], [0xf0000, 0x10ffff],
  ] as const satisfies readonly CodePointRange[],
  leadingMarkRanges: [
    [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5],
    [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
    [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x07eb, 0x07f3],
    [0x07fd, 0x07fd], [0x0816, 0x0819], [0x081b, 0x0823], [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b],
    [0x0898, 0x089f], [0x08ca, 0x08e1], [0x08e3, 0x0903], [0x093a, 0x093c], [0x093e, 0x094f], [0x0951, 0x0957],
    [0x0962, 0x0963], [0x0981, 0x0983], [0x09bc, 0x09bc], [0x09be, 0x09c4], [0x09c7, 0x09c8], [0x09cb, 0x09cd],
    [0x09d7, 0x09d7], [0x09e2, 0x09e3], [0x09fe, 0x09fe], [0x0a01, 0x0a03], [0x0a3c, 0x0a3c], [0x0a3e, 0x0a42],
    [0x0a47, 0x0a48], [0x0a4b, 0x0a4d], [0x0a51, 0x0a51], [0x0a70, 0x0a71], [0x0a75, 0x0a75], [0x0a81, 0x0a83],
    [0x0abc, 0x0abc], [0x0abe, 0x0ac5], [0x0ac7, 0x0ac9], [0x0acb, 0x0acd], [0x0ae2, 0x0ae3], [0x0afa, 0x0aff],
    [0x0b01, 0x0b03], [0x0b3c, 0x0b3c], [0x0b3e, 0x0b44], [0x0b47, 0x0b48], [0x0b4b, 0x0b4d], [0x0b55, 0x0b57],
    [0x0b62, 0x0b63], [0x0b82, 0x0b82], [0x0bbe, 0x0bc2], [0x0bc6, 0x0bc8], [0x0bca, 0x0bcd], [0x0bd7, 0x0bd7],
    [0x0c00, 0x0c04], [0x0c3c, 0x0c3c], [0x0c3e, 0x0c44], [0x0c46, 0x0c48], [0x0c4a, 0x0c4d], [0x0c55, 0x0c56],
    [0x0c62, 0x0c63], [0x0c81, 0x0c83], [0x0cbc, 0x0cbc], [0x0cbe, 0x0cc4], [0x0cc6, 0x0cc8], [0x0cca, 0x0ccd],
    [0x0cd5, 0x0cd6], [0x0ce2, 0x0ce3], [0x0cf3, 0x0cf3], [0x0d00, 0x0d03], [0x0d3b, 0x0d3c], [0x0d3e, 0x0d44],
    [0x0d46, 0x0d48], [0x0d4a, 0x0d4d], [0x0d57, 0x0d57], [0x0d62, 0x0d63], [0x0d81, 0x0d83], [0x0dca, 0x0dca],
    [0x0dcf, 0x0dd4], [0x0dd6, 0x0dd6], [0x0dd8, 0x0ddf], [0x0df2, 0x0df3], [0x0e31, 0x0e31], [0x0e34, 0x0e3a],
    [0x0e47, 0x0e4e], [0x0eb1, 0x0eb1], [0x0eb4, 0x0ebc], [0x0ec8, 0x0ece], [0x0f18, 0x0f19], [0x0f35, 0x0f35],
    [0x0f37, 0x0f37], [0x0f39, 0x0f39], [0x0f3e, 0x0f3f], [0x0f71, 0x0f84], [0x0f86, 0x0f87], [0x0f8d, 0x0f97],
    [0x0f99, 0x0fbc], [0x0fc6, 0x0fc6], [0x102b, 0x103e], [0x1056, 0x1059], [0x105e, 0x1060], [0x1062, 0x1064],
    [0x1067, 0x106d], [0x1071, 0x1074], [0x1082, 0x108d], [0x108f, 0x108f], [0x109a, 0x109d], [0x135d, 0x135f],
    [0x1712, 0x1715], [0x1732, 0x1734], [0x1752, 0x1753], [0x1772, 0x1773], [0x17b4, 0x17d3], [0x17dd, 0x17dd],
    [0x180b, 0x180d], [0x180f, 0x180f], [0x1885, 0x1886], [0x18a9, 0x18a9], [0x1920, 0x192b], [0x1930, 0x193b],
    [0x1a17, 0x1a1b], [0x1a55, 0x1a5e], [0x1a60, 0x1a7c], [0x1a7f, 0x1a7f], [0x1ab0, 0x1ace], [0x1b00, 0x1b04],
    [0x1b34, 0x1b44], [0x1b6b, 0x1b73], [0x1b80, 0x1b82], [0x1ba1, 0x1bad], [0x1be6, 0x1bf3], [0x1c24, 0x1c37],
    [0x1cd0, 0x1cd2], [0x1cd4, 0x1ce8], [0x1ced, 0x1ced], [0x1cf4, 0x1cf4], [0x1cf7, 0x1cf9], [0x1dc0, 0x1dff],
    [0x20d0, 0x20f0], [0x2cef, 0x2cf1], [0x2d7f, 0x2d7f], [0x2de0, 0x2dff], [0x302a, 0x302f], [0x3099, 0x309a],
    [0xa66f, 0xa672], [0xa674, 0xa67d], [0xa69e, 0xa69f], [0xa6f0, 0xa6f1], [0xa802, 0xa802], [0xa806, 0xa806],
    [0xa80b, 0xa80b], [0xa823, 0xa827], [0xa82c, 0xa82c], [0xa880, 0xa881], [0xa8b4, 0xa8c5], [0xa8e0, 0xa8f1],
    [0xa8ff, 0xa8ff], [0xa926, 0xa92d], [0xa947, 0xa953], [0xa980, 0xa983], [0xa9b3, 0xa9c0], [0xa9e5, 0xa9e5],
    [0xaa29, 0xaa36], [0xaa43, 0xaa43], [0xaa4c, 0xaa4d], [0xaa7b, 0xaa7d], [0xaab0, 0xaab0], [0xaab2, 0xaab4],
    [0xaab7, 0xaab8], [0xaabe, 0xaabf], [0xaac1, 0xaac1], [0xaaeb, 0xaaef], [0xaaf5, 0xaaf6], [0xabe3, 0xabea],
    [0xabec, 0xabed], [0xfb1e, 0xfb1e], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x101fd, 0x101fd], [0x102e0, 0x102e0],
    [0x10376, 0x1037a], [0x10a01, 0x10a03], [0x10a05, 0x10a06], [0x10a0c, 0x10a0f], [0x10a38, 0x10a3a], [0x10a3f, 0x10a3f],
    [0x10ae5, 0x10ae6], [0x10d24, 0x10d27], [0x10eab, 0x10eac], [0x10efd, 0x10eff], [0x10f46, 0x10f50], [0x10f82, 0x10f85],
    [0x11000, 0x11002], [0x11038, 0x11046], [0x11070, 0x11070], [0x11073, 0x11074], [0x1107f, 0x11082], [0x110b0, 0x110ba],
    [0x110c2, 0x110c2], [0x11100, 0x11102], [0x11127, 0x11134], [0x11145, 0x11146], [0x11173, 0x11173], [0x11180, 0x11182],
    [0x111b3, 0x111c0], [0x111c9, 0x111cc], [0x111ce, 0x111cf], [0x1122c, 0x11237], [0x1123e, 0x1123e], [0x11241, 0x11241],
    [0x112df, 0x112ea], [0x11300, 0x11303], [0x1133b, 0x1133c], [0x1133e, 0x11344], [0x11347, 0x11348], [0x1134b, 0x1134d],
    [0x11357, 0x11357], [0x11362, 0x11363], [0x11366, 0x1136c], [0x11370, 0x11374], [0x11435, 0x11446], [0x1145e, 0x1145e],
    [0x114b0, 0x114c3], [0x115af, 0x115b5], [0x115b8, 0x115c0], [0x115dc, 0x115dd], [0x11630, 0x11640], [0x116ab, 0x116b7],
    [0x1171d, 0x1172b], [0x1182c, 0x1183a], [0x11930, 0x11935], [0x11937, 0x11938], [0x1193b, 0x1193e], [0x11940, 0x11940],
    [0x11942, 0x11943], [0x119d1, 0x119d7], [0x119da, 0x119e0], [0x119e4, 0x119e4], [0x11a01, 0x11a0a], [0x11a33, 0x11a39],
    [0x11a3b, 0x11a3e], [0x11a47, 0x11a47], [0x11a51, 0x11a5b], [0x11a8a, 0x11a99], [0x11c2f, 0x11c36], [0x11c38, 0x11c3f],
    [0x11c92, 0x11ca7], [0x11ca9, 0x11cb6], [0x11d31, 0x11d36], [0x11d3a, 0x11d3a], [0x11d3c, 0x11d3d], [0x11d3f, 0x11d45],
    [0x11d47, 0x11d47], [0x11d8a, 0x11d8e], [0x11d90, 0x11d91], [0x11d93, 0x11d97], [0x11ef3, 0x11ef6], [0x11f00, 0x11f01],
    [0x11f03, 0x11f03], [0x11f34, 0x11f3a], [0x11f3e, 0x11f42], [0x13440, 0x13440], [0x13447, 0x13455], [0x16af0, 0x16af4],
    [0x16b30, 0x16b36], [0x16f4f, 0x16f4f], [0x16f51, 0x16f87], [0x16f8f, 0x16f92], [0x16fe4, 0x16fe4], [0x16ff0, 0x16ff1],
    [0x1bc9d, 0x1bc9e], [0x1cf00, 0x1cf2d], [0x1cf30, 0x1cf46], [0x1d165, 0x1d169], [0x1d16d, 0x1d172], [0x1d17b, 0x1d182],
    [0x1d185, 0x1d18b], [0x1d1aa, 0x1d1ad], [0x1d242, 0x1d244], [0x1da00, 0x1da36], [0x1da3b, 0x1da6c], [0x1da75, 0x1da75],
    [0x1da84, 0x1da84], [0x1da9b, 0x1da9f], [0x1daa1, 0x1daaf], [0x1e000, 0x1e006], [0x1e008, 0x1e018], [0x1e01b, 0x1e021],
    [0x1e023, 0x1e024], [0x1e026, 0x1e02a], [0x1e08f, 0x1e08f], [0x1e130, 0x1e136], [0x1e2ae, 0x1e2ae], [0x1e2ec, 0x1e2ef],
    [0x1e4ec, 0x1e4ef], [0x1e8d0, 0x1e8d6], [0x1e944, 0x1e94a], [0xe0100, 0xe01ef],
  ] as const satisfies readonly CodePointRange[],
  minDigitRun: 6,
  digitRanges: [
    [0x0030, 0x0039], [0x00b2, 0x00b3], [0x00b9, 0x00b9], [0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f],
    [0x0e50, 0x0e59], [0x2070, 0x2070], [0x2074, 0x2079], [0x2080, 0x2089], [0x2460, 0x249b], [0x24ea, 0x24ff],
    [0x2776, 0x2793], [0xff10, 0xff19], [0x1d7ce, 0x1d7ff],
  ] as const satisfies readonly CodePointRange[],
  hanDigitRanges: [
    [0x3007, 0x3007], [0x4e00, 0x4e00], [0x4e03, 0x4e03], [0x4e09, 0x4e09], [0x4e24, 0x4e24], [0x4e5d, 0x4e5d],
    [0x4e8c, 0x4e8c], [0x4e94, 0x4e94], [0x4f0d, 0x4f0d], [0x5169, 0x5169], [0x516b, 0x516b], [0x516d, 0x516d],
    [0x53c1, 0x53c1], [0x53c3, 0x53c4], [0x56db, 0x56db], [0x58f9, 0x58f9], [0x5e7a, 0x5e7a], [0x634c, 0x634c],
    [0x67d2, 0x67d2], [0x7396, 0x7396], [0x8086, 0x8086], [0x8cb3, 0x8cb3], [0x8d30, 0x8d30], [0x9646, 0x9646],
    [0x9678, 0x9678], [0x96f6, 0x96f6],
  ] as const satisfies readonly CodePointRange[],
  digitSeparatorRanges: [
    [0x0020, 0x0020], [0x002d, 0x002f], [0x005f, 0x005f], [0x00b7, 0x00b7], [0x2010, 0x2015], [0x2212, 0x2212],
    [0x30fb, 0x30fb], [0xff0d, 0xff0f], [0xff3f, 0xff3f], [0xff65, 0xff65],
  ] as const satisfies readonly CodePointRange[],
  foldDropRanges: [
    [0x0000, 0x002f], [0x003a, 0x0040], [0x005b, 0x0060], [0x007b, 0x00bf], [0x00d7, 0x00d7], [0x00f7, 0x00f7],
    [0x2000, 0x206f], [0x2190, 0x2bff], [0x2e00, 0x2e7f], [0x3000, 0x3004], [0x3008, 0x3020], [0x30fb, 0x30fb],
    [0xfe00, 0xfe0f], [0xfe10, 0xfe1f], [0xfe30, 0xfe6f], [0xff5f, 0xff65], [0x1f000, 0x1faff],
  ] as const satisfies readonly CodePointRange[],
  /** 在半角小写形式（asciiFold）里做包含匹配：邮箱 / 网址。 */
  contactMarkers: ['@', '://', 'www.'] as const,
  /** 在半角小写形式里按词匹配：前后都不是 a–z（数字、汉字、标点、空格、开头结尾都算边界）。 */
  contactLatinTokens: ['qq', 'vx', 'wx', 'wechat', 'weixin', 'whatsapp', 'telegram', 'http', 'https'] as const,
  /**
   * 在半角小写形式里找「字母或数字 + . + 顶级域」，顶级域后面是结尾或非 a–z0–9。
   * 不收 top / ltd：「Mr.Top」「ABC Co.Ltd」是正常名字。
   */
  urlTlds: ['com', 'cn', 'net', 'org', 'xyz', 'io', 'cc', 'vip', 'tv', 'site', 'club', 'shop', 'link', 'app'] as const,
  /** 在折叠形式（foldDisplayName）里做包含匹配。 */
  contactSubstrings: ['微信', '威信', '薇信', '徽信', 'v信', '扣扣', '手机号', '电话', '联系方式'] as const,
  /** 折叠后整名相等才算：「我」是会中本人的标签；Luna 本身是常见英文名，只拦整名。 */
  reservedExact: ['我', 'luna'] as const,
  /** 折叠后包含就算：会中的角色标签和冒充官方的字样（简繁都拦；主持人、官方、客服简繁同形）。 */
  reservedContains: ['游客', '遊客', '主持人', 'luna翻译', 'luna翻譯', '官方', '客服', '管理员', '管理員', '系统', '系統'] as const,
  /** 半角小写形式里按词匹配（「Admin Li」拦，「badminton」不拦）。 */
  reservedLatinTokens: ['admin'] as const,
  /** 折叠后包含就算（简繁都拦）。 */
  restrictedSubstrings: ['中国', '中华', '中央', '全国', '国家', '中國', '中華', '全國', '國家'] as const,
}

/** Go `unicode.IsSpace`（strings.Fields 按它切）：粘贴进来的换行、全角空格都并成一个半角空格。 */
const NAME_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g

function inRanges(code: number, ranges: readonly CodePointRange[]): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high)
}

function codePointsOf(value: string): number[] {
  return Array.from(value, character => character.codePointAt(0) ?? 0)
}

/**
 * NFC → 每段空白并成一个半角空格 → 去掉首尾空格。不用 `String.prototype.trim`：它会吃掉 U+FEFF，
 * 而这里要把 FEFF 留给校验报 invalid_char（与后端 strings.Fields 一致）。非字符串当空串。
 */
export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let value = raw
  try {
    if (typeof value.normalize === 'function') value = value.normalize('NFC')
  } catch {
    // 没有 Intl 的引擎拿不到 NFC：按原样继续，服务端会再规整一遍。
  }
  return value.replace(NAME_SPACE, ' ').replace(/^ | $/g, '')
}

/** 改名弹窗的「n/20」计数：规整后的码点数。 */
export function displayNameLength(raw: unknown): number {
  return Array.from(normalizeDisplayName(raw)).length
}

/**
 * 兼容分解 NFKC（Go norm.NFKC）：康熙部首「主持⼈」→「主持人」、数学 / 花体 / 带圈字母「𝐋𝐮𝐧𝐚」「ⓐⓓⓜⓘⓝ」→ 普通字母、
 * 「﹫」→「@」、半角片假名 → 全角。只用于匹配，保存的仍是 NFC 原样。拿不到 NFKC 的引擎按原样继续，服务端会再查。
 */
function compatibilityForm(value: string): string {
  try {
    if (typeof value.normalize === 'function') return value.normalize('NFKC')
  } catch {
    // 同 normalizeDisplayName。
  }
  return value
}

/**
 * 全角 ASCII → 半角，全角空格 → 空格，句号「。」「｡」→「.」，A–Z → a–z。只动 ASCII（不用 Go strings.ToLower /
 * unicode.ToLower：「İ」会被它们变成 i），与 Go 逐 rune 映射一致。
 */
function asciiFoldCodePoint(code: number): number {
  let folded = code
  if (folded >= 0xff01 && folded <= 0xff5e) folded -= 0xfee0
  else if (folded === 0x3000) folded = 0x20
  else if (folded === 0x3002 || folded === 0xff61) folded = 0x2e
  return folded >= 0x41 && folded <= 0x5a ? folded + 0x20 : folded
}

/** 匹配用的半角小写形式：整串 NFKC，再逐码点 asciiFoldCodePoint。 */
function asciiFold(value: string): string {
  return codePointsOf(compatibilityForm(value)).map(code => String.fromCodePoint(asciiFoldCodePoint(code))).join('')
}

function dropFoldRanges(ascii: string): string {
  return codePointsOf(ascii)
    .filter(code => !inRanges(code, DISPLAY_NAME_RULES.foldDropRanges))
    .map(code => String.fromCodePoint(code))
    .join('')
}

/** 匹配词表用的折叠形式：asciiFold（含 NFKC）之后丢掉 foldDropRanges 里的字（「Luna 翻译」→「luna翻译」）。 */
export function foldDisplayName(value: string): string {
  return dropFoldRanges(asciiFold(value))
}

const isLowerAsciiLetter = (unit: number) => unit >= 0x61 && unit <= 0x7a

function hasLatinToken(ascii: string, tokens: readonly string[]): boolean {
  return tokens.some(token => {
    for (let at = ascii.indexOf(token); at !== -1; at = ascii.indexOf(token, at + 1)) {
      if (!isLowerAsciiLetter(ascii.charCodeAt(at - 1)) && !isLowerAsciiLetter(ascii.charCodeAt(at + token.length))) return true
    }
    return false
  })
}

// Go 的 RE2 没有前瞻，这里也不用，两边写法一样：顶级域后面跟结尾或一个非 a–z0–9 的字。
const URL_TLD = new RegExp(`[a-z0-9]\\.(?:${DISPLAY_NAME_RULES.urlTlds.join('|')})(?:[^a-z0-9]|$)`)

/** 一段数字（分隔符和另一种数字都不打断）里，数字或中文数字任一种数到 minDigitRun 个。按 NFC 码点数，不做 NFKC。 */
function hasDigitRun(codes: readonly number[]): boolean {
  let digits = 0
  let hanDigits = 0
  for (const code of codes) {
    if (inRanges(code, DISPLAY_NAME_RULES.digitRanges)) digits += 1
    else if (inRanges(code, DISPLAY_NAME_RULES.hanDigitRanges)) hanDigits += 1
    else if (!inRanges(code, DISPLAY_NAME_RULES.digitSeparatorRanges)) {
      digits = 0
      hanDigits = 0
    }
    if (digits >= DISPLAY_NAME_RULES.minDigitRun || hanDigits >= DISPLAY_NAME_RULES.minDigitRun) return true
  }
  return false
}

function hasContact(codes: readonly number[], ascii: string, folded: string): boolean {
  return DISPLAY_NAME_RULES.contactMarkers.some(marker => ascii.includes(marker))
    || hasLatinToken(ascii, DISPLAY_NAME_RULES.contactLatinTokens)
    || URL_TLD.test(ascii)
    || DISPLAY_NAME_RULES.contactSubstrings.some(word => folded.includes(word))
    || hasDigitRun(codes)
}

/** **已规整**的名字为什么不行；null = 可以用。 */
function displayNameProblem(value: string, blockedKeywords: readonly string[]): DisplayNameProblem | null {
  if (value === '') return 'empty'
  const codes = codePointsOf(value)
  if (codes.length > PROFILE_NAME_MAX) return 'too_long'
  if (inRanges(codes[0] ?? 0, DISPLAY_NAME_RULES.leadingMarkRanges)
    || codes.some(code => inRanges(code, DISPLAY_NAME_RULES.invalidCodePointRanges))) return 'invalid_char'
  const ascii = asciiFold(value)
  const folded = dropFoldRanges(ascii)
  if (hasContact(codes, ascii, folded)) return 'contact'
  if ((DISPLAY_NAME_RULES.reservedExact as readonly string[]).includes(folded)
    || DISPLAY_NAME_RULES.reservedContains.some(word => folded.includes(word))
    || hasLatinToken(ascii, DISPLAY_NAME_RULES.reservedLatinTokens)) return 'reserved'
  if (DISPLAY_NAME_RULES.restrictedSubstrings.some(word => folded.includes(word))) return 'restricted'
  const blocked = blockedKeywords.some(keyword => {
    const word = foldDisplayName(normalizeDisplayName(keyword))
    return word !== '' && folded.includes(word)
  })
  return blocked ? 'blocked' : null
}

/**
 * 资料名、会议建会 / 入会 / 游客名的统一校验：先 normalizeDisplayName，再按 checkOrder 查。
 * 通过时 value 是要提交 / 保存的规整结果；不通过时 reason 对应 DISPLAY_NAME_PROBLEM_MESSAGES。
 */
export function validateDisplayName(raw: unknown, options: DisplayNameOptions = {}): DisplayNameValidation {
  const value = normalizeDisplayName(raw)
  const reason = displayNameProblem(value, options.blockedKeywords ?? [])
  return reason ? { ok: false, reason } : { ok: true, value }
}

/** 头像取字用的汉字（含々〇、扩展 A–H、兼容区）、假名（不含中点・）、谚文音节。 */
const AVATAR_CJK_RANGES: readonly CodePointRange[] = [
  [0x3005, 0x3005], [0x3007, 0x3007], [0x3041, 0x3096], [0x309d, 0x309f], [0x30a1, 0x30fa], [0x30fc, 0x30ff],
  [0x31f0, 0x31ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xff66, 0xff9d],
  [0x20000, 0x2a6df], [0x2a700, 0x2ebef], [0x2f800, 0x2fa1f], [0x30000, 0x323af],
]

/** 拉丁字母（含带调号的，跳过 × ÷；含越南语用的拉丁扩展附加区）。 */
const LATIN_LETTER_RANGES: readonly CodePointRange[] = [
  [0x41, 0x5a], [0x61, 0x7a], [0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0x24f], [0x1e00, 0x1eff],
]

/** 一个词的首字母：词里第一个拉丁字母（全角先转半角），大写；大写会变成两个字的（ß → SS）保留原字。 */
function latinInitial(word: string): string | null {
  for (const raw of codePointsOf(word)) {
    const code = (raw >= 0xff21 && raw <= 0xff3a) || (raw >= 0xff41 && raw <= 0xff5a) ? raw - 0xfee0 : raw
    if (!inRanges(code, LATIN_LETTER_RANGES)) continue
    const letter = String.fromCodePoint(code)
    const upper = letter.toUpperCase()
    return Array.from(upper).length === 1 ? upper : letter
  }
  return null
}

/**
 * 默认头像上的字（飞书式）：
 * - 名字里有汉字 / 假名 / 谚文：取最后两个这类字（李盛园 → 盛园、欧阳娜娜 → 娜娜、张 → 张、Tom 李 → 李）；
 * - 否则取第一个和最后一个含拉丁字母的词的首字母并大写（Yu Sheng → YS、luna → L、Mary Jane Watson → MW）；
 * - 都没有（纯数字、脱敏手机号、符号、emoji、其他文字、空名字）返回 null，由调用方画人形。
 * limit = 1 给小尺寸（20 的说话人标签）用：只取上面结果的第一个字（盛园 → 盛、YS → Y）。
 */
export function profileAvatarText(name: unknown, limit: 1 | 2 = 2): string | null {
  const value = normalizeDisplayName(name)
  const cjk = Array.from(value).filter(character => inRanges(character.codePointAt(0) ?? 0, AVATAR_CJK_RANGES))
  if (cjk.length > 0) return cjk.slice(-2).slice(0, limit).join('')
  const initials = value.split(' ').map(latinInitial).filter((initial): initial is string => initial !== null)
  if (initials.length === 0) return null
  const picked = initials.length === 1 ? initials : [initials[0], initials[initials.length - 1]]
  return picked.slice(0, limit).join('')
}
