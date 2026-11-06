// Pure date, time and statistics helpers. No DOM and no storage here.
window.SleepLogic = (() => {
  'use strict';

  const FEELINGS = ['עייף מאוד', 'קצת עייף', 'סביר', 'טוב', 'מעולה'];
  const ITEMS = ['coke', 'ritalin', 'workout'];
  const MAX_WAKINGS = 12;
  const MAX_MINUTES = 600;
  const DAY = 1440;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

  const pad = (n) => String(n).padStart(2, '0');
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  };
  const addDays = (key, n) => {
    const d = fromKey(key);
    d.setDate(d.getDate() + n);
    return toKey(d);
  };
  // Weeks run Sunday to Saturday.
  const weekStart = (key) => addDays(key, -fromKey(key).getDay());
  const weekKeys = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

  const toMin = (t) => {
    if (!t || !TIME_RE.test(t)) return null;
    return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  };
  const fmtTime = (m) => {
    if (m == null) return '—';
    const v = ((Math.round(m) % DAY) + DAY) % DAY;
    return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
  };
  const fmtDuration = (m) => {
    if (m == null) return '—';
    const v = Math.round(m);
    return `${Math.floor(v / 60)}:${pad(v % 60)}`;
  };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // Clock times cannot be averaged directly: 23:30 and 00:30 must average to
  // 00:00, not 12:00. Each time is moved onto a line that starts at `cut`.
  const meanClock = (times, cut) => {
    const mins = times.map(toMin).filter((m) => m != null).map((m) => (m < cut ? m + DAY : m));
    const avg = mean(mins);
    return avg == null ? null : avg % DAY;
  };
  const BED_CUT = 12 * 60; // bedtimes: a day starts at noon
  const EVENING_CUT = 4 * 60; // daytime items: 01:00 still belongs to the previous day

  const sleepMinutes = (bed, wake) => {
    const b = toMin(bed);
    const w = toMin(wake);
    if (b == null || w == null || b === w) return null;
    return (w - b + DAY) % DAY;
  };

  const emptyEvening = () => ({
    coffee: 0,
    coffeeTimes: [],
    coke: { on: null, time: '' },
    ritalin: { on: null, time: '' },
    workout: { on: null, time: '' },
  });
  const emptyWaking = () => ({ time: '', awake: null, back: null, ease: null });
  const emptyMorning = () => ({ bed: '', wake: '', score: null, feeling: null, woke: null, wakings: [] });

  const isEveningLogged = (e) => !!e && (e.coffee > 0 || ITEMS.some((i) => e[i].on !== null));
  const isMorningLogged = (m) => !!m && (!!m.bed || !!m.wake || m.score != null || m.feeling != null || m.woke != null);

  // Wakings in the order they happened: 23:50 comes before 02:10. Any without a time go last.
  const sortWakings = (wakings) => {
    const place = (w) => {
      const m = toMin(w.time);
      if (m == null) return Infinity;
      return m < BED_CUT ? m + DAY : m;
    };
    return [...wakings].sort((a, b) => place(a) - place(b));
  };

  // A duration in minutes, as text for the screen.
  const fmtMinutes = (m) => {
    if (m == null) return '—';
    const v = Math.round(m);
    return v < 60 ? `${v} דק׳` : `${Math.floor(v / 60)}:${pad(v % 60)} שעות`;
  };

  const eveningMissing = (e) => {
    const out = [];
    if (e.coffeeTimes.some((t) => !t)) out.push('שעות הקפה');
    const names = { coke: 'קולה זירו', ritalin: 'ריטלין', workout: 'אימון' };
    ITEMS.forEach((i) => {
      if (e[i].on === null) out.push(names[i]);
      else if (e[i].on && !e[i].time) out.push(`שעת ${names[i]}`);
    });
    return out;
  };
  const morningMissing = (m) => {
    const out = [];
    if (!m.bed) out.push('שעת השינה');
    if (!m.wake) out.push('שעת ההתעוררות');
    if (m.woke == null) out.push('התעוררויות בלילה');
    else if (m.woke && m.wakings.some((w) => !w.time || w.awake == null || w.back == null || !w.ease)) {
      out.push('פרטי ההתעוררויות בלילה');
    }
    if (m.score == null) out.push('ציון השינה');
    if (m.feeling == null) out.push('הרגשה');
    return out;
  };

  const summarize = (entries, start) => {
    const days = weekKeys(start);
    const mornings = days.map((k) => entries[k]?.morning).filter(isMorningLogged);
    const evenings = days.map((k) => entries[k]?.evening).filter(isEveningLogged);

    const durations = mornings.map((m) => sleepMinutes(m.bed, m.wake)).filter((x) => x != null);
    const scores = mornings.map((m) => m.score).filter((x) => x != null);
    const feelings = mornings.map((m) => m.feeling).filter((x) => x != null);

    const lastCoffees = evenings
      .map((e) => {
        const mins = e.coffeeTimes.map(toMin).filter((m) => m != null)
          .map((m) => (m < EVENING_CUT ? m + DAY : m));
        return mins.length ? fmtTime(Math.max(...mins)) : null;
      })
      .filter(Boolean);
    const coffeeTotal = evenings.reduce((sum, e) => sum + e.coffee, 0);

    const item = (name) => {
      const answered = evenings.filter((e) => e[name].on !== null);
      const yes = answered.filter((e) => e[name].on);
      return {
        yes: yes.length,
        answered: answered.length,
        avgTime: meanClock(yes.map((e) => e[name].time), EVENING_CUT),
      };
    };

    const answeredNights = mornings.filter((m) => m.woke === true || m.woke === false);
    const wokeNights = answeredNights.filter((m) => m.woke);
    const wakeups = wokeNights.flatMap((m) => m.wakings);
    const awakeTimes = wakeups.map((w) => w.awake).filter((x) => x != null);
    const backTimes = wakeups.map((w) => w.back).filter((x) => x != null);

    return {
      night: {
        answered: answeredNights.length,
        woke: wokeNights.length,
        total: wakeups.length,
        avgPerNight: answeredNights.length ? wakeups.length / answeredNights.length : null,
        avgTime: meanClock(wakeups.map((w) => w.time), BED_CUT),
        totalAwake: awakeTimes.length ? awakeTimes.reduce((a, b) => a + b, 0) : null,
        avgAwake: mean(awakeTimes),
        avgBack: mean(backTimes),
        easy: wakeups.filter((w) => w.ease === 'easy').length,
        hard: wakeups.filter((w) => w.ease === 'hard').length,
      },
      morningCount: mornings.length,
      eveningCount: evenings.length,
      nights: durations.length,
      avgSleep: mean(durations),
      totalSleep: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      avgBed: meanClock(mornings.map((m) => m.bed), BED_CUT),
      avgWake: meanClock(mornings.map((m) => m.wake), 0),
      avgScore: mean(scores),
      avgFeeling: mean(feelings),
      coffeeTotal,
      coffeeAvg: evenings.length ? coffeeTotal / evenings.length : null,
      avgLastCoffee: meanClock(lastCoffees, EVENING_CUT),
      coke: item('coke'),
      ritalin: item('ritalin'),
      workout: item('workout'),
    };
  };

  // Backups are outside data: keep only values of the expected shape.
  const cleanTime = (t) => (typeof t === 'string' && TIME_RE.test(t) ? t : '');
  const cleanMinutes = (n) => (Number.isInteger(n) && n >= 0 && n <= MAX_MINUTES ? n : null);
  const cleanEntries = (raw) => {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.entries(raw).forEach(([key, value]) => {
      if (!KEY_RE.test(key) || !value || typeof value !== 'object') return;
      const rec = {};
      if (value.evening && typeof value.evening === 'object') {
        const src = value.evening;
        const e = emptyEvening();
        const n = Number.isInteger(src.coffee) ? Math.min(Math.max(src.coffee, 0), 12) : 0;
        const times = Array.isArray(src.coffeeTimes) ? src.coffeeTimes : [];
        e.coffee = n;
        e.coffeeTimes = Array.from({ length: n }, (_, i) => cleanTime(times[i]));
        ITEMS.forEach((i) => {
          const on = src[i]?.on;
          e[i] = {
            on: on === true || on === false ? on : null,
            time: on === true ? cleanTime(src[i].time) : '',
          };
        });
        if (isEveningLogged(e)) rec.evening = e;
      }
      if (value.morning && typeof value.morning === 'object') {
        const src = value.morning;
        const score = Number.isInteger(src.score) && src.score >= 0 && src.score <= 100 ? src.score : null;
        const feeling = Number.isInteger(src.feeling) && src.feeling >= 1 && src.feeling <= 5 ? src.feeling : null;
        const woke = src.woke === true || src.woke === false ? src.woke : null;
        // Earlier versions saved only the times, as `wakeTimes`.
        let rows = [];
        if (Array.isArray(src.wakings)) rows = src.wakings;
        else if (Array.isArray(src.wakeTimes)) rows = src.wakeTimes.map((time) => ({ time }));
        const kept = rows.slice(0, MAX_WAKINGS).map((w) => ({
          time: cleanTime(w && w.time),
          awake: cleanMinutes(w && w.awake),
          back: cleanMinutes(w && w.back),
          ease: w && (w.ease === 'easy' || w.ease === 'hard') ? w.ease : null,
        }));
        const wakings = woke ? (kept.length ? kept : [emptyWaking()]) : [];
        const m = { bed: cleanTime(src.bed), wake: cleanTime(src.wake), score, feeling, woke, wakings };
        if (isMorningLogged(m)) rec.morning = m;
      }
      if (rec.evening || rec.morning) out[key] = rec;
    });
    return out;
  };

  return {
    FEELINGS, ITEMS, MAX_WAKINGS, MAX_MINUTES, emptyWaking, sortWakings, fmtMinutes, toKey, fromKey, addDays, weekStart, weekKeys, toMin, fmtTime, fmtDuration,
    sleepMinutes, emptyEvening, emptyMorning, isEveningLogged, isMorningLogged,
    eveningMissing, morningMissing, summarize, cleanEntries,
  };
})();
