/**
 * ISO 3166-1 alpha-2 region codes, named by the browser.
 *
 * The route schema stores country guards as raw two-letter codes because that is
 * exactly what Cloudflare puts in `cf.country` — comparing anything else would mean
 * a translation layer between the panel and the hot path. But asking an operator to
 * type `CU, IR` from memory is the terminology wall a previous review named: the
 * field was correct and unusable at the same time.
 *
 * So the codes stay canonical and the *names* come from `Intl.DisplayNames`, which
 * every browser ships. No bundled translation table, no 249-line name list to rot.
 *
 * The list is the codes only. When the panel gains a second interface language, the
 * locale below is the one line that has to follow it.
 */

/**
 * 249 个正式分配的 alpha-2 码，按字母序。写成一个字符串是为了让它在 diff 里是一行
 * 数据而不是 249 行代码 —— 它是标准的抄本，不是逻辑。
 */
const ALPHA2_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ ' +
  'BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET ' +
  'FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY ' +
  'HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
  'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ ' +
  'LA LB LC LI LK LR LS LT LU LV LY ' +
  'MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ OM ' +
  'PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
  'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

/**
 * Cloudflare 在标准之外还会报的两个值。
 *
 * `T1` 是 Tor 出口 —— 它不是国家，但走的是同一个字段、同一次比对，所以封 Tor 的
 * 唯一入口就是这里。它是 jouska 的操作者真会用到的一项，`Intl.DisplayNames` 不认，
 * 名字只能自己给。
 */
const CLOUDFLARE_EXTRA: readonly (readonly [string, string])[] = [['T1', 'Tor 出口节点']];

/**
 * 形状是 `{ value, label }` 不是 `{ code, label }`：官方 Combobox 认这个形状，认到了
 * 就自动拿 label 做显示与过滤，不需要再配 itemToStringLabel。label 里同时含中文名与
 * 代码，所以搜「中国」和搜「CN」都命中 —— 这正是那道术语墙要拆掉的东西。
 */
export interface CountryOption {
  /** 存进配置的原值：大写两字母，与 cf.country 一字不差。 */
  readonly value: string;
  /** 给人看的：「中国（CN）」。 */
  readonly label: string;
}

/**
 * 界面语言。messages 现在只有 zh-CN；加语言时这里跟着改，别让国家名留在中文。
 */
const DISPLAY_LOCALE = 'zh-CN';

const buildOptions = (): readonly CountryOption[] => {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames([DISPLAY_LOCALE], { type: 'region' });
  } catch {
    // Intl 数据被裁掉的运行时（极小的 Node 构建）不该让整页崩掉：退回裸代码。
    display = null;
  }
  const standard = ALPHA2_CODES.split(' ').map((code) => {
    const name = display?.of(code);
    return {
      value: code,
      label: name === undefined || name === code ? code : `${name}（${code}）`,
    };
  });
  const extra = CLOUDFLARE_EXTRA.map(([code, name]) => ({
    value: code,
    label: `${name}（${code}）`,
  }));
  return [...standard, ...extra];
};

export const COUNTRY_OPTIONS = buildOptions();

/** 代码 → 选项，用于把已存的值渲染成 chip。未知代码原样显示，不吞掉数据。 */
const BY_CODE = new Map(COUNTRY_OPTIONS.map((option) => [option.value, option]));

/**
 * 代码 → 选项。写进 JSON 的未知代码（手写的乱码、以后新分配的码）原样变成一个 chip：
 * 认不出不等于可以吞掉，操作者得看得见它、也得能删掉它。
 */
export const countryOption = (code: string): CountryOption =>
  BY_CODE.get(code) ?? { value: code, label: code };
