// Ported from llysc ctok 1.3.0 implementation; upstream license: resources/tokenizers/embedded/LICENSE.ctok.
import { fileURLToPath } from 'node:url'
// Claude min-cost tiling 计数(对齐 server_go/pkg/ctok + sanderland/ctok)
// 仅 count 相等;词表与 Go embed 同源(./data/pieces_*.json)
// DEC_20260810_000000 E2:Nest 与 Go 同步换尺,替换 @anthropic-ai/tokenizer 旧 BPE
import { readFileSync } from 'node:fs'
import { join } from 'path'
import { createHash } from 'node:crypto'
export const ctokVersion = '1.3.0'
export const ctokCountProfile = 'claude_content_ctok_1_3_0'
// 结构标记(U+FDD0-FDD4 非字符);码位用 \u 写,禁止再被半角替换吞成空串
const BOW = '\uFDD0'
const EOW = '\uFDD1'
const SHIFT = '\uFDD3'
const CAPS = '\uFDD4'
const MARKERS = new Set([BOW, EOW, SHIFT, CAPS])
const BOW_ATOM = '\u27E8bow\u27E9'
const EOW_ATOM = '\u27E8eow\u27E9'
const SHIFT_ATOM = '\u27E8shift\u27E9'
const CAPS_ATOM = '\u27E8caps\u27E9'
const FAMILIES = [
  {
    name: 'v4.8',
    pieces: 'pieces_v4_7.json',
    sourceModel: 'claude-opus-4-8',
    minVersion: [4, 8],
    alsoServes: [
      'claude-opus-4-9',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-haiku-5',
      'claude-mythos-5',
    ],
    messageOverhead: 6,
    foldQuotes: false,
    allcapsMin: 0,
    frameBow: false,
    frameTail: 'ladder',
    frameStrip: '\n',
  },
  {
    name: 'v4.7',
    pieces: 'pieces_v4_7.json',
    sourceModel: 'claude-opus-4-7',
    minVersion: [4, 7],
    alsoServes: ['claude-sonnet-4-7'],
    messageOverhead: 11,
    foldQuotes: false,
    allcapsMin: 0,
    frameBow: true,
    frameTail: 'ladder',
    frameStrip: '\n',
  },
  {
    name: 'v3',
    pieces: 'pieces_v3.json',
    sourceModel: 'claude-opus-4-5',
    minVersion: [3, 0],
    alsoServes: [],
    messageOverhead: 7,
    foldQuotes: true,
    allcapsMin: 4,
    frameBow: true,
    frameTail: 'ladder',
    frameStrip: '\n',
  },
]
const OPUS5_FAMILY = { ...FAMILIES[0], frameTail: 'free', frameStrip: ' \t\n\r\f\v' }
const PUNCT_SYMS = new Set(
  Array.from(
    '\u2014\u00BB\u00AB\u2022\u00B0\u201E\u2013\u2212\u00A3\u00A7\u20AC\u2026\u221A\u2192\uFF08\u2116\u2020\u2514\u2502\u0F0D\u00B7\u2500\u2550\u2588',
  ),
)
const QUOTE_FOLD = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"' }
const CONTRACTION_SUFFIXES = new Set(['s', 't', 'd', 'm', 'll', 're', 've'])
// Unicode 15.0.0 的 BMP 非零 canonical combining class 区间，与参考 Python 数据一致。
const COMBINING_NONZERO = [
  [768, 846],
  [848, 879],
  [1155, 1159],
  [1425, 1469],
  [1471, 1471],
  [1473, 1474],
  [1476, 1477],
  [1479, 1479],
  [1552, 1562],
  [1611, 1631],
  [1648, 1648],
  [1750, 1756],
  [1759, 1764],
  [1767, 1768],
  [1770, 1773],
  [1809, 1809],
  [1840, 1866],
  [2027, 2035],
  [2045, 2045],
  [2070, 2073],
  [2075, 2083],
  [2085, 2087],
  [2089, 2093],
  [2137, 2139],
  [2200, 2207],
  [2250, 2273],
  [2275, 2303],
  [2364, 2364],
  [2381, 2381],
  [2385, 2388],
  [2492, 2492],
  [2509, 2509],
  [2558, 2558],
  [2620, 2620],
  [2637, 2637],
  [2748, 2748],
  [2765, 2765],
  [2876, 2876],
  [2893, 2893],
  [3021, 3021],
  [3132, 3132],
  [3149, 3149],
  [3157, 3158],
  [3260, 3260],
  [3277, 3277],
  [3387, 3388],
  [3405, 3405],
  [3530, 3530],
  [3640, 3642],
  [3656, 3659],
  [3768, 3770],
  [3784, 3787],
  [3864, 3865],
  [3893, 3893],
  [3895, 3895],
  [3897, 3897],
  [3953, 3954],
  [3956, 3956],
  [3962, 3965],
  [3968, 3968],
  [3970, 3972],
  [3974, 3975],
  [4038, 4038],
  [4151, 4151],
  [4153, 4154],
  [4237, 4237],
  [4957, 4959],
  [5908, 5909],
  [5940, 5940],
  [6098, 6098],
  [6109, 6109],
  [6313, 6313],
  [6457, 6459],
  [6679, 6680],
  [6752, 6752],
  [6773, 6780],
  [6783, 6783],
  [6832, 6845],
  [6847, 6862],
  [6964, 6964],
  [6980, 6980],
  [7019, 7027],
  [7082, 7083],
  [7142, 7142],
  [7154, 7155],
  [7223, 7223],
  [7376, 7378],
  [7380, 7392],
  [7394, 7400],
  [7405, 7405],
  [7412, 7412],
  [7416, 7417],
  [7616, 7679],
  [8400, 8412],
  [8417, 8417],
  [8421, 8432],
  [11503, 11505],
  [11647, 11647],
  [11744, 11775],
  [12330, 12335],
  [12441, 12442],
  [42607, 42607],
  [42612, 42621],
  [42654, 42655],
  [42736, 42737],
  [43014, 43014],
  [43052, 43052],
  [43204, 43204],
  [43232, 43249],
  [43307, 43309],
  [43347, 43347],
  [43443, 43443],
  [43456, 43456],
  [43696, 43696],
  [43698, 43700],
  [43703, 43704],
  [43710, 43711],
  [43713, 43713],
  [43766, 43766],
  [44013, 44013],
  [64286, 64286],
  [65056, 65071],
]
const REFERENCE_ASSIGNED = [
  [0, 887],
  [890, 895],
  [900, 906],
  [908, 908],
  [910, 929],
  [931, 1327],
  [1329, 1366],
  [1369, 1418],
  [1421, 1423],
  [1425, 1479],
  [1488, 1514],
  [1519, 1524],
  [1536, 1805],
  [1807, 1866],
  [1869, 1969],
  [1984, 2042],
  [2045, 2093],
  [2096, 2110],
  [2112, 2139],
  [2142, 2142],
  [2144, 2154],
  [2160, 2190],
  [2192, 2193],
  [2200, 2435],
  [2437, 2444],
  [2447, 2448],
  [2451, 2472],
  [2474, 2480],
  [2482, 2482],
  [2486, 2489],
  [2492, 2500],
  [2503, 2504],
  [2507, 2510],
  [2519, 2519],
  [2524, 2525],
  [2527, 2531],
  [2534, 2558],
  [2561, 2563],
  [2565, 2570],
  [2575, 2576],
  [2579, 2600],
  [2602, 2608],
  [2610, 2611],
  [2613, 2614],
  [2616, 2617],
  [2620, 2620],
  [2622, 2626],
  [2631, 2632],
  [2635, 2637],
  [2641, 2641],
  [2649, 2652],
  [2654, 2654],
  [2662, 2678],
  [2689, 2691],
  [2693, 2701],
  [2703, 2705],
  [2707, 2728],
  [2730, 2736],
  [2738, 2739],
  [2741, 2745],
  [2748, 2757],
  [2759, 2761],
  [2763, 2765],
  [2768, 2768],
  [2784, 2787],
  [2790, 2801],
  [2809, 2815],
  [2817, 2819],
  [2821, 2828],
  [2831, 2832],
  [2835, 2856],
  [2858, 2864],
  [2866, 2867],
  [2869, 2873],
  [2876, 2884],
  [2887, 2888],
  [2891, 2893],
  [2901, 2903],
  [2908, 2909],
  [2911, 2915],
  [2918, 2935],
  [2946, 2947],
  [2949, 2954],
  [2958, 2960],
  [2962, 2965],
  [2969, 2970],
  [2972, 2972],
  [2974, 2975],
  [2979, 2980],
  [2984, 2986],
  [2990, 3001],
  [3006, 3010],
  [3014, 3016],
  [3018, 3021],
  [3024, 3024],
  [3031, 3031],
  [3046, 3066],
  [3072, 3084],
  [3086, 3088],
  [3090, 3112],
  [3114, 3129],
  [3132, 3140],
  [3142, 3144],
  [3146, 3149],
  [3157, 3158],
  [3160, 3162],
  [3165, 3165],
  [3168, 3171],
  [3174, 3183],
  [3191, 3212],
  [3214, 3216],
  [3218, 3240],
  [3242, 3251],
  [3253, 3257],
  [3260, 3268],
  [3270, 3272],
  [3274, 3277],
  [3285, 3286],
  [3293, 3294],
  [3296, 3299],
  [3302, 3311],
  [3313, 3315],
  [3328, 3340],
  [3342, 3344],
  [3346, 3396],
  [3398, 3400],
  [3402, 3407],
  [3412, 3427],
  [3430, 3455],
  [3457, 3459],
  [3461, 3478],
  [3482, 3505],
  [3507, 3515],
  [3517, 3517],
  [3520, 3526],
  [3530, 3530],
  [3535, 3540],
  [3542, 3542],
  [3544, 3551],
  [3558, 3567],
  [3570, 3572],
  [3585, 3642],
  [3647, 3675],
  [3713, 3714],
  [3716, 3716],
  [3718, 3722],
  [3724, 3747],
  [3749, 3749],
  [3751, 3773],
  [3776, 3780],
  [3782, 3782],
  [3784, 3790],
  [3792, 3801],
  [3804, 3807],
  [3840, 3911],
  [3913, 3948],
  [3953, 3991],
  [3993, 4028],
  [4030, 4044],
  [4046, 4058],
  [4096, 4293],
  [4295, 4295],
  [4301, 4301],
  [4304, 4680],
  [4682, 4685],
  [4688, 4694],
  [4696, 4696],
  [4698, 4701],
  [4704, 4744],
  [4746, 4749],
  [4752, 4784],
  [4786, 4789],
  [4792, 4798],
  [4800, 4800],
  [4802, 4805],
  [4808, 4822],
  [4824, 4880],
  [4882, 4885],
  [4888, 4954],
  [4957, 4988],
  [4992, 5017],
  [5024, 5109],
  [5112, 5117],
  [5120, 5788],
  [5792, 5880],
  [5888, 5909],
  [5919, 5942],
  [5952, 5971],
  [5984, 5996],
  [5998, 6000],
  [6002, 6003],
  [6016, 6109],
  [6112, 6121],
  [6128, 6137],
  [6144, 6169],
  [6176, 6264],
  [6272, 6314],
  [6320, 6389],
  [6400, 6430],
  [6432, 6443],
  [6448, 6459],
  [6464, 6464],
  [6468, 6509],
  [6512, 6516],
  [6528, 6571],
  [6576, 6601],
  [6608, 6618],
  [6622, 6683],
  [6686, 6750],
  [6752, 6780],
  [6783, 6793],
  [6800, 6809],
  [6816, 6829],
  [6832, 6862],
  [6912, 6988],
  [6992, 7038],
  [7040, 7155],
  [7164, 7223],
  [7227, 7241],
  [7245, 7304],
  [7312, 7354],
  [7357, 7367],
  [7376, 7418],
  [7424, 7957],
  [7960, 7965],
  [7968, 8005],
  [8008, 8013],
  [8016, 8023],
  [8025, 8025],
  [8027, 8027],
  [8029, 8029],
  [8031, 8061],
  [8064, 8116],
  [8118, 8132],
  [8134, 8147],
  [8150, 8155],
  [8157, 8175],
  [8178, 8180],
  [8182, 8190],
  [8192, 8292],
  [8294, 8305],
  [8308, 8334],
  [8336, 8348],
  [8352, 8384],
  [8400, 8432],
  [8448, 8587],
  [8592, 9254],
  [9280, 9290],
  [9312, 11123],
  [11126, 11157],
  [11159, 11507],
  [11513, 11557],
  [11559, 11559],
  [11565, 11565],
  [11568, 11623],
  [11631, 11632],
  [11647, 11670],
  [11680, 11686],
  [11688, 11694],
  [11696, 11702],
  [11704, 11710],
  [11712, 11718],
  [11720, 11726],
  [11728, 11734],
  [11736, 11742],
  [11744, 11869],
  [11904, 11929],
  [11931, 12019],
  [12032, 12245],
  [12272, 12283],
  [12288, 12351],
  [12353, 12438],
  [12441, 12543],
  [12549, 12591],
  [12593, 12686],
  [12688, 12771],
  [12784, 12830],
  [12832, 42124],
  [42128, 42182],
  [42192, 42539],
  [42560, 42743],
  [42752, 42954],
  [42960, 42961],
  [42963, 42963],
  [42965, 42969],
  [42994, 43052],
  [43056, 43065],
  [43072, 43127],
  [43136, 43205],
  [43214, 43225],
  [43232, 43347],
  [43359, 43388],
  [43392, 43469],
  [43471, 43481],
  [43486, 43518],
  [43520, 43574],
  [43584, 43597],
  [43600, 43609],
  [43612, 43714],
  [43739, 43766],
  [43777, 43782],
  [43785, 43790],
  [43793, 43798],
  [43808, 43814],
  [43816, 43822],
  [43824, 43883],
  [43888, 44013],
  [44016, 44025],
  [44032, 55203],
  [55216, 55238],
  [55243, 55291],
  [55296, 64109],
  [64112, 64217],
  [64256, 64262],
  [64275, 64279],
  [64285, 64310],
  [64312, 64316],
  [64318, 64318],
  [64320, 64321],
  [64323, 64324],
  [64326, 64450],
  [64467, 64911],
  [64914, 64967],
  [64975, 64975],
  [65008, 65049],
  [65056, 65106],
  [65108, 65126],
  [65128, 65131],
  [65136, 65140],
  [65142, 65276],
  [65279, 65279],
  [65281, 65470],
  [65474, 65479],
  [65482, 65487],
  [65490, 65495],
  [65498, 65500],
  [65504, 65510],
  [65512, 65518],
  [65529, 65533],
]
const inRanges = (cp, ranges) => {
  let low = 0,
    high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1,
      [start, end] = ranges[mid]
    if (cp < start) {
      high = mid - 1
    } else if (cp > end) {
      low = mid + 1
    } else {
      return true
    }
  }
  return false
}
const MARK = /\p{M}/u
const ALPHABETIC = /\p{Alphabetic}/u
const SELECTOR = (cp) => cp >= 0xfe00 && cp <= 0xfe0f
const literalMarker = (ch) => {
  const cp = ch.codePointAt(0)
  return cp >= 0xe000 && cp <= 0xe004 ? String.fromCodePoint(0xfdd0 + cp - 0xe000) : ch
}
const isSeparator = (ch) =>
  ch.codePointAt(0) < 0x10000 && MARK.test(ch) && !SELECTOR(ch.codePointAt(0)) && !ALPHABETIC.test(ch)
const isStrayMark = (ch) => {
  const cp = ch.codePointAt(0)
  if (cp === 0x0711 || (cp >= 0x0730 && cp <= 0x073f) || !MARK.test(ch) || isSeparator(ch)) {
    return false
  }
  let low = 0,
    high = COMBINING_NONZERO.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1,
      [start, end] = COMBINING_NONZERO[mid]
    if (cp < start) {
      high = mid - 1
    } else if (cp > end) {
      low = mid + 1
    } else {
      return true
    }
  }
  return false
}
const isHardCp = (cp) =>
  cp >= 0x10000 ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  cp === 0x3005 ||
  cp === 0x3006 ||
  (cp >= 0x3031 && cp <= 0x3035) ||
  cp === 0x303b ||
  cp === 0x303c
const classify = (ch) => {
  const cp = ch.codePointAt(0)
  if (cp < 128) {
    if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) {
      return 'wordy'
    }
    if (cp >= 48 && cp <= 57) {
      return 'digit'
    }
    if (cp === 32 || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      return 'space'
    }
    return cp >= 33 && cp <= 126 ? 'punct' : 'hard'
  }
  if (cp === 0x1c89 || cp === 0x1c8a || cp === 0xa7cb || cp === 0x0264) {
    return 'wordy'
  }
  if (/\p{Z}/u.test(ch)) {
    return 'space'
  }
  if (
    (cp >= 0x16ee && cp <= 0x16f0) ||
    (cp >= 0x2160 && cp <= 0x2188) ||
    (cp >= 0x24b6 && cp <= 0x24e9) ||
    (cp >= 0xa6e6 && cp <= 0xa6ef)
  ) {
    return 'wordy'
  }
  if (/\p{Nd}/u.test(ch) && ((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9))) {
    return 'digit'
  }
  if (PUNCT_SYMS.has(ch)) {
    return 'punct'
  }
  if (SELECTOR(cp)) {
    return 'hard'
  }
  if (MARK.test(ch)) {
    return cp < 0x10000 && ALPHABETIC.test(ch) ? 'wordy' : 'hard'
  }
  return inRanges(cp, REFERENCE_ASSIGNED) && /\p{L}/u.test(ch) && !isHardCp(cp) ? 'wordy' : 'hard'
}
const marksLikePunct = (character) => {
  const ch = literalMarker(character),
    cp = ch.codePointAt(0)
  if (cp >= 0x10000) {
    return false
  }
  if (isSeparator(ch) || !inRanges(cp, REFERENCE_ASSIGNED)) {
    return true
  }
  if (cp >= 0x3001 && cp <= 0x303f && (/\p{P}/u.test(ch) || '〄〒〓〠〶〷〾〿'.includes(ch))) {
    return false
  }
  return /[\p{P}\p{S}\p{Cf}\p{Cn}]/u.test(ch)
}
const digitBorder = (ch) =>
  ch.codePointAt(0) < 0x10000 && (/\p{No}/u.test(ch) || (ch.codePointAt(0) >= 128 && /\p{Nd}/u.test(ch)))
const digitRun = (body) => /^(?:\p{Nd}+|\p{No}+)$/u.test(body)
const firstChar = (body) => String.fromCodePoint(body.codePointAt(0))
const lastChar = (body) => {
  const end = body.length - 1,
    unit = body.charCodeAt(end)
  return unit >= 0xdc00 && unit <= 0xdfff && end > 0 ? body.slice(end - 1) : body.slice(end)
}
const hardKind = (ch) => (marksLikePunct(ch) ? 1 : digitBorder(ch) ? 2 : 0)
const hardBow = (body) => SELECTOR(body.codePointAt(0)) || marksLikePunct(firstChar(body))
const hardEow = (body) => SELECTOR(lastChar(body).codePointAt(0)) || marksLikePunct(lastChar(body))
const digitBow = (body) => digitRun(body) && digitBorder(firstChar(body))
const digitEow = (body) => digitRun(body) && digitBorder(lastChar(body))
const parseMarked = (publicForm) => {
  if (!publicForm.includes('\u27E8')) {
    return publicForm
  }
  let out = ''
  let byteBuf = []
  const flush = () => {
    if (byteBuf.length) {
      out += Buffer.from(byteBuf).toString('utf8')
      byteBuf = []
    }
  }
  const chars = Array.from(publicForm)
  for (let i = 0; i < chars.length;) {
    if (chars[i] !== '\u27E8') {
      flush()
      out += chars[i]
      i++
      continue
    }
    let end = -1
    for (let j = i + 1; j < chars.length && j <= i + 10; j++) {
      if (chars[j] === '\u27E9') {
        end = j
        break
      }
    }
    if (end < 0) {
      flush()
      out += chars[i]
      i++
      continue
    }
    const atom = chars.slice(i, end + 1).join('')
    if (atom === BOW_ATOM) {
      flush()
      out += BOW
    } else if (atom === EOW_ATOM) {
      flush()
      out += EOW
    } else if (atom === SHIFT_ATOM) {
      flush()
      out += SHIFT
    } else if (atom === CAPS_ATOM) {
      flush()
      out += CAPS
    } else {
      const inner = chars.slice(i + 1, end).join('')
      if (inner.length === 4 && /^0x/i.test(inner)) {
        const b = parseInt(inner.slice(2), 16)
        if (!Number.isNaN(b)) {
          byteBuf.push(b)
          i = end + 1
          continue
        }
      }
      flush()
      out += atom
    }
    i = end + 1
  }
  flush()
  return out
}
const nfc = (text, foldQuotes) => {
  let value = text.replace(/[\ud800-\udfff]/gu, '\uFFFD').normalize('NFC')
  value = value
    .replace(/[\x01-\x08\x0B-\x1F\x7F-\x9F]/g, '') // eslint-disable-line no-control-regex
    .replace(/\x00/g, ' ') // eslint-disable-line no-control-regex
    .replace(/\u0E4D\u0E32/g, '\u0E33')
  value = value.replace(/[\uE000-\uF8FF]/g, '')
  if (foldQuotes) {
    value = value.replace(/[\u2018\u2019\u201C\u201D]/g, (ch) => QUOTE_FOLD[ch])
  }
  return value.replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F]/g, ' ')
}
const tokCache = new Map()
const familyCacheKey = (family) => family.name + (family.frameTail === 'free' ? ':opus5' : '')
// 词表目录:dev 在 src 旁,编译后在 dist 旁;再兜底 cwd 下的源码树(swc 不拷 json)
// __dirname 仅 CJS 有;ESM/strip-types 跑测时用 cwd 兜底
const DATA_DIR = fileURLToPath(new URL('../../../resources/tokenizers/embedded/', import.meta.url))
export const ctokDataDir = () => DATA_DIR
let appliedVocabularyFiles = {}
export const setCtokVocabularyFiles = (files) => {
  if (JSON.stringify(files) === JSON.stringify(appliedVocabularyFiles)) {
    return
  }
  appliedVocabularyFiles = files
  tokCache.clear()
  vocabularyHashes.clear()
}
const loadTok = (fam) => {
  const hit = tokCache.get(familyCacheKey(fam))
  if (hit) {
    return hit
  }
  const raw = readFileSync(appliedVocabularyFiles[fam.pieces] ?? join(DATA_DIR, fam.pieces), 'utf8')
  const doc = JSON.parse(raw)
  const vocab = new Set()
  const unitPieces = new Set()
  const byteTokens = new Set()
  let maxPieceLen = 1
  let maxByteLen = 1
  for (const [group, entries] of Object.entries(doc.tokens)) {
    for (const publicForm of Object.keys(entries)) {
      if (group === 'bytes_fallback') {
        byteTokens.add(publicForm.toLowerCase())
        maxByteLen = Math.max(maxByteLen, publicForm.length / 2)
        continue
      }
      if (group === 'contractions') {
        vocab.add(parseMarked(publicForm))
        vocab.add(parseMarked(publicForm) + EOW)
        continue
      }
      const piece = parseMarked(publicForm)
      vocab.add(piece)
      const chars = Array.from(piece)
      if (chars.length === 1 && !MARKERS.has(chars[0])) {
        unitPieces.add(chars[0])
      }
      maxPieceLen = Math.max(maxPieceLen, chars.length)
    }
  }
  for (const ch of unitPieces) {
    const hex = Buffer.from(ch, 'utf8').toString('hex')
    byteTokens.add(hex)
    maxByteLen = Math.max(maxByteLen, hex.length / 2)
  }
  const trie = { children: new Map(), terminal: false }
  for (const piece of vocab) {
    const chars = Array.from(piece)
    maxPieceLen = Math.max(maxPieceLen, chars.length)
    let node = trie
    for (let index = chars.length - 1; index >= 0; index--) {
      let child = node.children.get(chars[index])
      if (!child) {
        child = { children: new Map(), terminal: false }
        node.children.set(chars[index], child)
      }
      node = child
    }
    node.terminal = true
  }
  const tok = { fam, vocab, trie, unitPieces, maxPieceLen, byteTokens, maxByteLen, charCost: new Map() }
  tokCache.set(familyCacheKey(fam), tok)
  return tok
}
const resolveFamily = (model) => {
  const lower = (model ?? '').toLowerCase().trim()
  if (!lower || !lower.startsWith('claude')) {
    return null
  }
  const parts = lower.split('-')
  let version = null
  for (let index = 0; index < parts.length; index++) {
    const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(parts[index])
    if (!match || Number(match[1]) <= 0) {
      continue
    }
    version = [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])]
    if (match[2] === undefined && index + 1 < parts.length && /^\d{1,2}$/.test(parts[index + 1])) {
      version[1] = Number(parts[index + 1])
    }
    break
  }
  if (lower.startsWith('claude-opus-') && version?.[0] === 5 && version[1] === 0) {
    return OPUS5_FAMILY
  }
  for (const family of FAMILIES) {
    if (lower === family.sourceModel || family.alsoServes.includes(lower)) {
      return family
    }
  }
  if (!version) {
    return FAMILIES[FAMILIES.length - 1]
  }
  return (
    FAMILIES.find(
      (family) =>
        version[0] > family.minVersion[0] ||
        (version[0] === family.minVersion[0] && version[1] >= family.minVersion[1]),
    ) ?? null
  )
}
const minTile = (n, costFn, maxLen) => {
  const INF = 1e15
  const best = new Array(n + 1).fill(INF)
  best[0] = 0
  for (let i = 1; i <= n; i++) {
    const start = Math.max(0, i - maxLen)
    for (let j = start; j < i; j++) {
      const c = costFn(j, i)
      if (c !== null && c !== undefined && best[j] + c < best[i]) {
        best[i] = best[j] + c
      }
    }
  }
  return best[n]
}
const byteCost = (tok, ch) => {
  if (tok.unitPieces.has(ch)) {
    return 1
  }
  const bs = Buffer.from(ch, 'utf8')
  // 简化:逐字节 floor(与完整 byte-prefix DP 在常见 CJK 上同为每字节 1;有 prefix 时略高估可接受,后续可换完整 DP)
  // 为对齐 Go,做完整 min-tile on bytes
  const costFn = (j, i) => {
    if (i - j === 1) {
      return 1
    }
    return tok.byteTokens.has(bs.subarray(j, i).toString('hex')) ? 1 : null
  }
  return minTile(bs.length, costFn, tok.maxByteLen)
}
const charCost = (tok, ch) => {
  if (MARKERS.has(ch)) {
    return 1
  }
  const literal = literalMarker(ch)
  if (tok.unitPieces.has(literal)) {
    return 1
  }
  const hit = tok.charCost.get(ch)
  if (hit !== undefined) {
    return hit
  }
  const value = byteCost(tok, literal)
  tok.charCost.set(ch, value)
  return value
}
const lowerRune = (ch) =>
  ch === '\u03F4' ? ch : ch === '\u1C89' ? '\u1C8A' : ch === '\uA7CB' ? '\u0264' : ch.toLowerCase()
const isUpperRune = (ch) =>
  ch !== '\u03F4' && lowerRune(ch) !== ch && (ch === '\u1C89' || ch === '\uA7CB' || /\p{Uppercase}/u.test(ch))
const isLowerRune = (ch) => ch === '\u1C8A' || ch === '\u0264' || /\p{Lowercase}/u.test(ch)
const lowerSpan = (span, keepDottedI = false) => {
  let out = ''
  for (const ch of span) {
    out += keepDottedI && ch === '\u0130' ? ch : lowerRune(ch)
  }
  return out
}
const markCase = (span, family, headMark = false) => {
  if (!span || headMark || span.includes('\u1E9E')) {
    return span
  }
  const first = firstChar(span)
  if (family.allcapsMin === 0 && !isUpperRune(first)) {
    return span
  }
  if (span.includes('\u0130')) {
    if (!isUpperRune(first) || first === '\u0130') {
      return span
    }
    for (const ch of span.slice(first.length)) {
      if (ch !== '\u0130' && isUpperRune(ch)) {
        return span
      }
    }
    return SHIFT + lowerSpan(span, true)
  }
  let allUpper = true,
    hasCased = false,
    unlowerable = false,
    tailUpper = false,
    length = 0
  for (const ch of span) {
    const upper = isUpperRune(ch),
      lower = isLowerRune(ch)
    if (upper || lower) {
      hasCased = true
      if (!upper) {
        allUpper = false
      }
    }
    if (length > 0 && upper) {
      tailUpper = true
    }
    length++
    if (
      (/[\p{L}\p{M}]/u.test(ch) || '\u1C89\u1C8A\uA7CB\u0264'.includes(ch)) &&
      !lower &&
      (!upper || lowerRune(ch) === ch)
    ) {
      unlowerable = true
    }
  }
  if (family.allcapsMin > 0 && hasCased && allUpper && length >= family.allcapsMin && !unlowerable) {
    return CAPS + lowerSpan(span)
  }
  return lowerRune(first) !== first && isUpperRune(first) && !tailUpper ? SHIFT + lowerSpan(span) : span
}
const readRun = (reader, target) => {
  if (reader.at >= reader.text.length) {
    return false
  }
  const start = reader.at,
    first = String.fromCodePoint(reader.text.codePointAt(start))
  let cls = classify(first)
  if (cls === 'wordy' && isStrayMark(first)) {
    cls = 'stray'
  }
  const kind = cls === 'hard' ? hardKind(first) : 0
  reader.at += first.length
  while (reader.at < reader.text.length) {
    const ch = String.fromCodePoint(reader.text.codePointAt(reader.at)),
      next = classify(ch)
    if (!(next === cls || (cls === 'stray' && next === 'wordy' && isStrayMark(ch)))) {
      break
    }
    if (cls === 'hard' && !SELECTOR(ch.codePointAt(0)) && hardKind(ch) !== kind) {
      break
    }
    reader.at += ch.length
  }
  target.cls = cls
  target.text = reader.text.slice(start, reader.at)
  return true
}
const takesRightBorder = (run) =>
  run.cls === 'punct' || hardEow(run.text) || ((run.cls === 'digit' || run.cls === 'hard') && digitEow(run.text))
const streamNorm = (normalized, family, rawHeadSpace = true) => {
  let text = normalized.replace(/[\uFDD0-\uFDD4]/g, (ch) => String.fromCodePoint(0xe000 + ch.charCodeAt(0) - 0xfdd0))
  if (family.frameTail !== 'free') {
    text = text.replace(/\n+$/, '')
  }
  if (family.frameBow && rawHeadSpace && text.startsWith(' ') && !text.startsWith('  ')) {
    text = text.slice(1)
  }
  const reader = { text, at: 0 }
  let current = { cls: 'hard', text: '' },
    next = { cls: 'hard', text: '' },
    previous = { cls: 'hard', text: '' },
    previous2 = { cls: 'hard', text: '' }
  if (!readRun(reader, current)) {
    return family.frameBow ? BOW : ''
  }
  let hasNext = readRun(reader, next)
  const headQuote = current.text === "'" && hasNext && (next.cls === 'wordy' || next.cls === 'stray')
  const hasBow =
    !headQuote &&
    (current.cls === 'wordy' ||
      current.cls === 'punct' ||
      current.cls === 'stray' ||
      hardBow(current.text) ||
      ((current.cls === 'digit' || current.cls === 'hard') && digitBow(current.text)) ||
      (current.cls === 'space' && current.text.startsWith(' ')))
  let out = !hasBow && family.frameBow ? (headQuote ? ' ' : BOW) : ''
  for (let index = 0; ; index++) {
    const { cls, text: body } = current
    const leftSpace =
      (index === 0 && family.frameBow) || (index > 0 && previous.cls === 'space' && previous.text.endsWith(' '))
    const rightSpace = hasNext && next.cls === 'space' && next.text.startsWith(' ') && !next.text.startsWith('  ')
    const opensWord = body === "'" && hasNext && (next.cls === 'wordy' || next.cls === 'stray')
    if (cls === 'wordy') {
      const fused = index > 0 && previous.cls === 'stray'
      let marked = markCase(body, family, fused)
      while (marked.startsWith(SHIFT) || marked.startsWith(CAPS)) {
        out += marked[0]
        marked = marked.slice(1)
      }
      const seam =
        CONTRACTION_SUFFIXES.has(body) &&
        index > 0 &&
        previous.cls === 'punct' &&
        previous.text === "'" &&
        (index < 2 || !takesRightBorder(previous2))
      out += (fused || seam ? '' : BOW) + marked + EOW
    } else if (cls === 'stray') {
      out += BOW + body + (hasNext && next.cls === 'wordy' ? '' : EOW)
    } else if (cls === 'punct' || hardBow(body) || hardEow(body)) {
      out +=
        (leftSpace && !opensWord && (cls === 'punct' || hardBow(body)) ? BOW : '') +
        body +
        (rightSpace && (cls === 'punct' || hardEow(body)) ? EOW : '')
    } else if ((cls === 'digit' || cls === 'hard') && digitRun(body)) {
      out += (leftSpace && digitBow(body) ? BOW : '') + body + (rightSpace && digitEow(body) ? EOW : '')
    } else {
      out += body
    }
    if (!hasNext) {
      break
    }
    const reusable = previous2
    previous2 = previous
    previous = current
    current = next
    next = reusable
    hasNext = readRun(reader, next)
  }
  return out.replace(/(.)\uFDD1 ([\uFDD3\uFDD4]*)\uFDD0/gu, `$1${EOW}$2${BOW}`)
}
const countVocab = (chars, tok) => {
  const window = tok.maxPieceLen + 1
  const best = new Int32Array(window)
  for (let end = 1; end <= chars.length; end++) {
    let value = best[(end - 1) % window] + charCost(tok, chars[end - 1])
    let node = tok.trie
    for (let start = end - 1; start >= 0 && end - start <= tok.maxPieceLen; start--) {
      node = node.children.get(chars[start])
      if (!node) {
        break
      }
      if (node.terminal) {
        value = Math.min(value, best[start % window] + 1)
      }
    }
    best[end % window] = value
  }
  return best[chars.length % window]
}
const frameTail = (n, tok) => {
  if (n === 0 || tok.fam.frameTail !== 'ladder') {
    return 0
  }
  const run = '\n'.repeat(n + 2)
  const chars = Array.from(run)
  const total = countVocab(chars, tok)
  return Math.max(0, total - 1)
}
const tile = (text, tok) => {
  if (tok.fam.frameTail === 'free') {
    text = text.replace(/[ \t\n\r\f\v]+$/, '')
  }
  const normalized = nfc(text, tok.fam.foldQuotes),
    stripped = normalized.replace(/\n+$/, '')
  const tail = tok.fam.frameTail === 'free' ? 0 : frameTail(normalized.length - stripped.length, tok)
  const stream = streamNorm(normalized, tok.fam, text.startsWith(' '))
  return stream ? countVocab(Array.from(stream), tok) + tail : tail
}
// countContentCtok 正文 token 数(不含 message_overhead).
// 仅 Claude 族 model 有效;空 model / 非 claude 返回 -1(调用方不得当 v3 默认)
export const ctokModelCoverage = (pieces) => {
  const examples = [
    'claude-sonnet-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-mythos-5-1',
  ]
  const notes = {
    v3: '无版本的 Claude 名称也会回落到此档，不代表已逐型号验证。',
    'v4.7': 'ctok 1.3.0 的 4.7 家族规则；历史官方样本可离线核对，不代表任意请求均精确。',
    'v4.8': '4.8 及 5.x 共用词表；额外保留已验证的 Opus 5 尾部空白特例并隔离缓存。Opus 5.5 的两 token 帧差异尚未建模。',
  }
  const formatVersion = (version) => (version[1] === 0 ? String(version[0]) : version.join('.'))
  return FAMILIES.flatMap((family, index) =>
    family.pieces !== pieces
      ? []
      : [
          {
            family: family.name,
            versionRule:
              index === 0
                ? `版本 ≥ ${formatVersion(family.minVersion)}`
                : `${formatVersion(family.minVersion)} ≤ 版本 < ${formatVersion(FAMILIES[index - 1].minVersion)}`,
            referenceModel: family.sourceModel,
            models: [
              ...new Set(
                [family.sourceModel, ...family.alsoServes, ...examples].filter(
                  (model) => resolveFamily(model)?.name === family.name,
                ),
              ),
            ],
            notes: notes[family.name],
          },
        ],
  )
}
export const countContentCtok = (text, model) => {
  try {
    if (!model || !model.toLowerCase().includes('claude')) {
      return -1
    }
    const fam = resolveFamily(model)
    if (!fam) {
      return -1
    }
    const tok = loadTok(fam)
    return tile(text ?? '', tok)
  } catch (e) {
    console.error(e)
    return -1
  }
}
export const ctokCacheModelKey = (model) => {
  const family = resolveFamily(model)
  return family ? familyCacheKey(family) : ''
}
const vocabularyHashes = new Map()
export const ctokVocabularyHash = (model) => {
  const family = resolveFamily(model)
  if (!family) {
    return ''
  }
  const cached = vocabularyHashes.get(family.pieces)
  if (cached) {
    return cached
  }
  const data = readFileSync(appliedVocabularyFiles[family.pieces] ?? join(DATA_DIR, family.pieces))
  const hash = createHash('sha256').update(data.toString('utf8').replace(/\r\n/g, '\n')).digest('hex')
  vocabularyHashes.set(family.pieces, hash)
  return hash
}
