// 全部业务事实发生在同一日（UTC+08:00），时间用“当日分钟数”做比较，保留原文用于展示。
export const DAY = '2026-12-04';
export const TZ = 'UTC+08:00';

export function toMinutes(hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new TypeError(`无法识别的时刻: ${hhmm}`);
  }
  return hour * 60 + minute;
}

export function fromMinutes(value) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// 生效时段统一按“含起点、不含终点”解释。
export function withinWindow(atMinutes, fromTime, untilTime) {
  return toMinutes(fromTime) <= atMinutes && atMinutes < toMinutes(untilTime);
}

// connections 的 grace_minutes：发车后宽限到 departure + grace（含）。
export function withinGrace(scanMinutes, departureTime, graceMinutes) {
  return scanMinutes <= toMinutes(departureTime) + graceMinutes;
}
