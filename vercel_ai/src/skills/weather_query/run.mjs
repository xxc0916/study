const TIME_ZONE = 'Asia/Shanghai';

/**
 * 判断是否为普通对象（排除数组/null）。
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 在指定时区下把 Date 格式化为 YYYY-MM-DD。
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
function formatYmdInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * 在指定时区下给日期加上天数偏移。
 * @param {number} days
 * @param {string} timeZone
 * @returns {string} YYYY-MM-DD
 */
function todayPlusDaysYmd(days, timeZone) {
  const now = new Date();
  const baseYmd = formatYmdInTimeZone(now, timeZone);
  const base = new Date(`${baseYmd}T00:00:00.000Z`);
  const next = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return formatYmdInTimeZone(next, timeZone);
}

/**
 * 解析日期输入（支持 YYYY-MM-DD / 今天/明天/后天 / today/tomorrow）。
 * @param {unknown} value
 * @returns {string} YYYY-MM-DD
 */
function parseDateYmd(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('必须提供 date（支持 YYYY-MM-DD / 今天 / 明天 / 后天）');
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const lower = raw.toLowerCase();
  if (raw === '今天' || lower === 'today') return todayPlusDaysYmd(0, TIME_ZONE);
  if (raw === '明天' || lower === 'tomorrow') return todayPlusDaysYmd(1, TIME_ZONE);
  if (raw === '后天') return todayPlusDaysYmd(2, TIME_ZONE);

  throw new Error('date 格式不支持，请使用 YYYY-MM-DD 或 今天/明天/后天');
}

/**
 * 将 Open-Meteo 的 weather_code 映射为中文描述。
 * @param {number} code
 * @returns {string}
 */
function weatherCodeToZh(code) {
  if (code === 0) return '晴';
  if (code === 1) return '晴间多云';
  if (code === 2) return '多云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻毛毛雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75) return '雪';
  if (code === 77) return '雪粒';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95) return '雷暴';
  if (code === 96 || code === 99) return '强雷暴';
  return `未知(${code})`;
}

/**
 * 发起 HTTP 请求并解析 JSON。
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
  const res = await globalThis.fetch(url, {
    method: 'GET',
    headers: { 'accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`请求失败：${res.status} ${res.statusText}`);
  return await res.json();
}

/**
 * 通过 Open-Meteo 地理编码把地址解析为经纬度。
 * @param {string} address
 * @returns {Promise<{ name: string, latitude: number, longitude: number }>}
 */
async function geocode(address) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(address)}&count=1&language=zh&format=json`;
  const data = await fetchJson(url);
  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) throw new Error(`找不到地址：${address}`);
  const first = results[0];
  const name = typeof first?.name === 'string' ? first.name : address;
  const latitude = Number(first?.latitude);
  const longitude = Number(first?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`地理编码结果无效：${address}`);
  return { name, latitude, longitude };
}

/**
 * 获取指定经纬度的逐日天气预报数据。
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<{ time: string[], weather_code: number[], temperature_2m_min: number[], temperature_2m_max: number[] }>}
 */
async function fetchDailyForecast(latitude, longitude) {
  const params = new globalThis.URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: TIME_ZONE
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const data = await fetchJson(url);
  const daily = data?.daily;
  const time = daily?.time;
  const weather_code = daily?.weather_code;
  const temperature_2m_min = daily?.temperature_2m_min;
  const temperature_2m_max = daily?.temperature_2m_max;

  if (!Array.isArray(time) || !Array.isArray(weather_code) || !Array.isArray(temperature_2m_min) || !Array.isArray(temperature_2m_max)) {
    throw new Error('天气接口返回格式异常');
  }
  return { time, weather_code, temperature_2m_min, temperature_2m_max };
}

/**
 * Skill 入口：查询指定地址在指定日期的天气（学习用最小实现）。
 * 输入：
 * - address: string（城市/地址）
 * - date: string（YYYY-MM-DD 或 今天/明天/后天）
 * 输出：
 * - { address, date, weather, temperatureMinC, temperatureMaxC, source }
 * @param {unknown} input
 * @returns {Promise<any>}
 */
export async function run(input) {
  if (!isRecord(input)) throw new Error('输入必须是对象');
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  if (!address) throw new Error('必须提供 address（城市/地址）');
  const date = parseDateYmd(input.date);

  const geo = await geocode(address);
  const daily = await fetchDailyForecast(geo.latitude, geo.longitude);
  const idx = daily.time.indexOf(date);
  if (idx < 0) throw new Error(`该日期不在预报范围内：${date}`);

  const code = Number(daily.weather_code[idx]);
  const tMin = Number(daily.temperature_2m_min[idx]);
  const tMax = Number(daily.temperature_2m_max[idx]);
  const weather = weatherCodeToZh(code);

  return {
    address: geo.name,
    date,
    weather,
    temperatureMinC: Number.isFinite(tMin) ? tMin : null,
    temperatureMaxC: Number.isFinite(tMax) ? tMax : null,
    source: 'open-meteo'
  };
}
