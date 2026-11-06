(() => {
  'use strict';

  const L = window.SleepLogic;
  const STORE = 'sleep-log.v1';
  const MAX_CUPS = 12;
  const BACKUP_NUDGE_DAYS = 30;
  // Public half of the key that signs reminders. The private half is only in the reminder service.
  const VAPID_PUBLIC_KEY = 'BD8z0uQb2xhVnG59e3U6zjyxefxWexiFfhlGYowPqohGr9QR1BS0sN4kFuMwLM5Cng43Ojesqq4YCRYNEBmWZY8';
  const main = document.getElementById('main');
  const importInput = document.getElementById('import-file');

  const ITEM_LABELS = {
    coke: 'קולה זירו',
    ritalin: 'ריטלין',
    workout: 'אימון',
  };
  const ITEM_QUESTIONS = {
    coke: 'שתיתי קולה זירו?',
    ritalin: 'לקחתי ריטלין?',
    workout: 'התאמנתי?',
  };

  // ---------- storage ----------
  const load = () => {
    let raw = null;
    try {
      raw = localStorage.getItem(STORE);
      if (!raw) return { entries: {}, lastBackup: null };
      const parsed = JSON.parse(raw);
      return { entries: L.cleanEntries(parsed.entries), lastBackup: parsed.lastBackup || null };
    } catch {
      // Keep unreadable data aside so it is never overwritten.
      try { if (raw) localStorage.setItem(`${STORE}.unreadable`, raw); } catch { /* nothing more to do */ }
      return { entries: {}, lastBackup: null };
    }
  };
  let db = load();
  let saveFailed = false;

  // Automatic backup. Kept apart from the journal so the recovery code never ends up in a backup file.
  const B = window.SleepBackup;
  const BACKUP_URL = 'https://sleep-log-reminders.ohadtamari.workers.dev/backup';
  const AUTO_STORE = 'sleep-log.backup.v1';
  const UPLOAD_DELAY_MS = 2000;
  const loadAuto = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(AUTO_STORE));
      return saved && B.normalizeCode(saved.code) ? saved : {};
    } catch {
      return {};
    }
  };
  let auto = loadAuto(); // { code, lastAt, dirty, error }
  const saveAuto = () => {
    try {
      if (auto.code) localStorage.setItem(AUTO_STORE, JSON.stringify(auto));
      else localStorage.removeItem(AUTO_STORE);
    } catch { /* the next change tries again */ }
  };
  let uploadTimer = null;
  let uploading = false;
  let changeCount = 0;

  const refreshAuto = () => {
    const box = document.getElementById('auto');
    if (box) box.innerHTML = autoHtml();
  };

  const runUpload = async () => {
    clearTimeout(uploadTimer);
    // An empty journal is never uploaded, so it cannot replace a good backup.
    if (!auto.code || !auto.dirty || uploading || !Object.keys(db.entries).length) return;
    uploading = true;
    const startedAt = changeCount;
    let status = 0;
    try {
      status = await B.upload(BACKUP_URL, auto.code, db.entries);
    } catch { /* offline: stays dirty and retries later */ }
    uploading = false;
    if (status >= 200 && status < 300) {
      auto.lastAt = new Date().toISOString();
      auto.error = '';
      if (changeCount === startedAt) auto.dirty = false;
    } else {
      auto.error = status === 403 ? 'mismatch' : 'network';
    }
    saveAuto();
    refreshAuto();
    if (auto.dirty && !auto.error) uploadTimer = setTimeout(runUpload, UPLOAD_DELAY_MS);
  };

  const persist = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(db));
      saveFailed = false;
    } catch {
      saveFailed = true;
      return;
    }
    if (!auto.code) return;
    auto.dirty = true;
    changeCount += 1;
    saveAuto();
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(runUpload, UPLOAD_DELAY_MS);
  };

  // ---------- state ----------
  const todayKey = () => L.toKey(new Date());

  const initialView = () => {
    const now = new Date();
    const h = now.getHours();
    if (h < 4) return { date: L.addDays(todayKey(), -1), part: 'evening' }; // still last night
    return { date: todayKey(), part: h < 15 ? 'morning' : 'evening' };
  };
  const initialWeek = () => {
    const today = todayKey();
    // On Sunday the week that just ended is the useful one.
    const ref = L.fromKey(today).getDay() === 0 ? L.addDays(today, -1) : today;
    return L.weekStart(ref);
  };

  // A tapped reminder opens straight on its form.
  const viewForPart = (part) => {
    const view = initialView();
    return part === 'morning' || part === 'evening' ? { ...view, date: part === 'morning' ? todayKey() : view.date, part } : view;
  };
  const partFromUrl = new URLSearchParams(window.location.search).get('part');
  if (partFromUrl) window.history.replaceState(null, '', window.location.pathname);

  const state = { tab: 'log', ...viewForPart(partFromUrl), week: initialWeek(), notice: '', push: { status: 'loading', code: '', copied: false }, autoView: { mode: 'main', message: '', code: '', copied: false } };

  const evening = (key) => db.entries[key]?.evening || L.emptyEvening();
  const morning = (key) => db.entries[key]?.morning || L.emptyMorning();

  const commit = (key, part, value) => {
    const logged = part === 'evening' ? L.isEveningLogged(value) : L.isMorningLogged(value);
    const rec = { ...(db.entries[key] || {}) };
    if (logged) rec[part] = value; else delete rec[part];
    if (rec.evening || rec.morning) db.entries[key] = rec; else delete db.entries[key];
    persist();
  };

  // ---------- formatting ----------
  const dateLong = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  const dateShort = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric' });
  const weekdayNarrow = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const one = (x) => (x == null ? '—' : (Math.round(x * 10) / 10).toString());
  const dayLabel = (key) => {
    if (key === todayKey()) return 'היום';
    if (key === L.addDays(todayKey(), -1)) return 'אתמול';
    return '';
  };

  // ---------- journal view ----------
  const stripHtml = () => {
    const today = todayKey();
    return L.weekKeys(L.weekStart(state.date)).map((key) => {
      const d = L.fromKey(key);
      const rec = db.entries[key] || {};
      const future = key > today;
      const dot = (on) => `<i class="dot${on ? ' on' : ''}"></i>`;
      return `<button type="button" class="day${key === state.date ? ' selected' : ''}" data-act="pick-day" data-key="${key}"
        ${future ? 'disabled' : ''} aria-label="${dateLong.format(d)}${rec.morning ? ', בוקר מולא' : ''}${rec.evening ? ', ערב מולא' : ''}">
        <span class="dow">${weekdayNarrow[d.getDay()]}</span>
        <span class="num">${d.getDate()}</span>
        <span class="dots" aria-hidden="true">${dot(rec.morning)}${dot(rec.evening)}</span>
      </button>`;
    }).join('');
  };

  const statusHtml = () => {
    if (saveFailed) return '<p class="status error" role="alert">השמירה נכשלה. נסה שוב, ואם זה חוזר כדאי לגבות את הנתונים.</p>';
    const value = state.part === 'evening' ? evening(state.date) : morning(state.date);
    const logged = state.part === 'evening' ? L.isEveningLogged(value) : L.isMorningLogged(value);
    if (!logged) return '<p class="status">כל מה שתמלא יישמר אוטומטית.</p>';
    const missing = state.part === 'evening' ? L.eveningMissing(value) : L.morningMissing(value);
    if (!missing.length) return '<p class="status done"><b>✓</b> הכל מולא ונשמר</p>';
    return `<p class="status"><b>נשמר.</b> נשאר למלא: ${missing.join(', ')}</p>`;
  };

  const timeInput = (field, value, label) => `
    <label class="time-row">
      <span>${label}</span>
      <input class="time" type="time" data-field="${field}" value="${value || ''}">
    </label>`;

  const eveningHtml = () => {
    const e = evening(state.date);
    const cups = e.coffeeTimes.map((t, i) => timeInput(`cup:${i}`, t, `כוס ${i + 1}, באיזו שעה?`)).join('');
    const items = L.ITEMS.map((name) => {
      const it = e[name];
      const yn = (val, text) => `<button type="button" class="choice${it.on === val ? ' active' : ''}"
        data-act="yn" data-item="${name}" data-val="${val}" aria-pressed="${it.on === val}">${text}</button>`;
      return `<section class="card">
        <div class="row">
          <h2>${ITEM_QUESTIONS[name]}</h2>
          <div class="pair">${yn(true, 'כן')}${yn(false, 'לא')}</div>
        </div>
        ${it.on ? timeInput(`item:${name}`, it.time, 'באיזו שעה?') : ''}
      </section>`;
    }).join('');
    return `
      <section class="card">
        <div class="row">
          <h2>כמה קפה שתיתי?</h2>
          <div class="stepper" dir="ltr">
            <button type="button" data-act="cup-dec" aria-label="כוס אחת פחות" ${e.coffee === 0 ? 'disabled' : ''}>−</button>
            <output aria-live="polite">${e.coffee}</output>
            <button type="button" data-act="cup-inc" aria-label="עוד כוס" ${e.coffee >= MAX_CUPS ? 'disabled' : ''}>+</button>
          </div>
        </div>
        ${cups}
      </section>
      ${items}`;
  };

  const durationHtml = (m) => {
    const mins = L.sleepMinutes(m.bed, m.wake);
    if (mins == null) return '';
    const odd = mins < 120 || mins > 840;
    return `<strong>${L.fmtDuration(mins)}</strong> שעות שינה${odd ? ' <em>· כדאי לבדוק את השעות</em>' : ''}`;
  };

  const morningHtml = () => {
    const m = morning(state.date);
    const feel = L.FEELINGS.map((text, i) => {
      const val = i + 1;
      return `<button type="button" class="choice${m.feeling === val ? ' active' : ''}" data-act="feeling"
        data-val="${val}" aria-pressed="${m.feeling === val}">${text}</button>`;
    }).join('');
    return `
      <section class="card">
        ${timeInput('bed', m.bed, 'מתי הלכתי לישון?')}
        ${timeInput('wake', m.wake, 'מתי התעוררתי?')}
        <p class="computed" id="duration">${durationHtml(m)}</p>
      </section>
      <section class="card">
        <div class="row">
          <h2>התעוררתי בלילה?</h2>
          <div class="pair">
            <button type="button" class="choice${m.woke === true ? ' active' : ''}" data-act="woke" data-val="true" aria-pressed="${m.woke === true}">כן</button>
            <button type="button" class="choice${m.woke === false ? ' active' : ''}" data-act="woke" data-val="false" aria-pressed="${m.woke === false}">לא</button>
          </div>
        </div>
        ${m.woke ? `
          ${m.wakeTimes.map((t, i) => `
            <div class="wake-row">
              ${timeInput(`night:${i}`, t, `התעוררות ${i + 1}`)}
              ${m.wakeTimes.length > 1 ? `<button type="button" class="remove" data-act="wake-remove" data-index="${i}" aria-label="מחיקת התעוררות ${i + 1}">×</button>` : ''}
            </div>`).join('')}
          <button type="button" class="action add" data-act="wake-add" ${m.wakeTimes.length >= L.MAX_WAKINGS ? 'disabled' : ''}>+ הוספת התעוררות</button>` : ''}
      </section>
      <section class="card">
        <label class="row score-row">
          <h2>ציון שינה ב-Apple Watch</h2>
          <span class="score" dir="ltr">
            <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-field="score"
              value="${m.score ?? ''}" placeholder="—" aria-label="ציון שינה, 0 עד 100">
            <small>/100</small>
          </span>
        </label>
      </section>
      <section class="card">
        <h2>איך אני מרגיש?</h2>
        <div class="feelings">${feel}</div>
      </section>`;
  };

  const logHtml = () => {
    const today = todayKey();
    const d = L.fromKey(state.date);
    const label = dayLabel(state.date);
    const isWeekend = L.fromKey(today).getDay() >= 5;
    const hasWeekData = L.weekKeys(L.weekStart(today)).some((k) => db.entries[k]);
    return `
      ${installHint()}
      ${isWeekend && hasWeekData ? `<button type="button" class="banner" data-act="open-this-week">
        <span>סוף השבוע הגיע. הסיכום השבועי מוכן</span><span class="chev" aria-hidden="true">‹</span></button>` : ''}
      <header class="dayhead">
        <button type="button" class="arrow" data-act="day-prev" aria-label="היום הקודם">›</button>
        <div class="title">
          <h1>${dateLong.format(d)}</h1>
          ${label ? `<p>${label}</p>` : ''}
        </div>
        <button type="button" class="arrow" data-act="day-next" aria-label="היום הבא" ${state.date >= today ? 'disabled' : ''}>‹</button>
      </header>
      <div class="strip" id="strip">${stripHtml()}</div>
      <div class="segment" role="group" aria-label="חלק ביום">
        <button type="button" class="${state.part === 'morning' ? 'active' : ''}" data-act="part" data-part="morning" aria-pressed="${state.part === 'morning'}">בוקר</button>
        <button type="button" class="${state.part === 'evening' ? 'active' : ''}" data-act="part" data-part="evening" aria-pressed="${state.part === 'evening'}">ערב</button>
      </div>
      ${state.part === 'morning' ? morningHtml() : eveningHtml()}
      <div id="status">${statusHtml()}</div>`;
  };

  // ---------- weekly summary ----------
  const statRow = (label, value, note) => `
    <div class="stat-row">
      <dt>${label}${note ? `<small>${note}</small>` : ''}</dt>
      <dd>${value}</dd>
    </div>`;

  const itemValue = (it) => {
    if (!it.answered) return { value: '—', note: '' };
    return {
      value: `${it.yes} ${it.yes === 1 ? 'יום' : 'ימים'}`,
      note: it.avgTime != null ? `שעה ממוצעת ${L.fmtTime(it.avgTime)}, מתוך ${it.answered} ימים שמולאו` : `מתוך ${it.answered} ימים שמולאו`,
    };
  };

  const dayRow = (key) => {
    const rec = db.entries[key] || {};
    const d = L.fromKey(key);
    const head = `<span class="when"><b>${weekdayNarrow[d.getDay()]}</b> ${dateShort.format(d)}</span>`;
    const parts = [];
    if (rec.morning) {
      const m = rec.morning;
      const mins = L.sleepMinutes(m.bed, m.wake);
      if (mins != null) parts.push(`${L.fmtDuration(mins)} שינה`);
      if (m.score != null) parts.push(`ציון ${m.score}`);
      if (m.feeling) parts.push(L.FEELINGS[m.feeling - 1]);
    }
    const wakings = rec.morning && rec.morning.woke ? rec.morning.wakeTimes : [];
    const wakingTimes = L.sortNightTimes(wakings).join(', ');
    const wakingLine = wakings.length
      ? `${wakings.length === 1 ? 'התעוררות אחת' : `${wakings.length} התעוררויות`}${wakingTimes ? `: ${wakingTimes}` : ''}`
      : '';
    const dayParts = [];
    if (rec.evening) {
      const e = rec.evening;
      dayParts.push(`${e.coffee} קפה`);
      L.ITEMS.forEach((name) => {
        if (e[name].on) dayParts.push(`${ITEM_LABELS[name]}${e[name].time ? ` ${e[name].time}` : ''}`);
      });
    }
    const empty = !rec.morning && !rec.evening;
    const future = key > todayKey();
    return `<button type="button" class="day-row${empty ? ' empty' : ''}" data-act="open-day" data-key="${key}" ${future ? 'disabled' : ''}>
      ${head}
      <span class="what">
        ${empty ? '<span>לא מולא</span>' : ''}
        ${parts.length ? `<span>${parts.join(' · ')}</span>` : ''}
        ${wakingLine ? `<span class="sub">${wakingLine}</span>` : ''}
        ${dayParts.length ? `<span class="sub">${dayParts.join(' · ')}</span>` : ''}
      </span>
    </button>`;
  };

  const backupNudge = () => {
    if (!Object.keys(db.entries).length) return '';
    const last = Math.max(new Date(db.lastBackup || 0).getTime(), new Date(auto.lastAt || 0).getTime());
    const age = last ? (Date.now() - last) / 86400000 : Infinity;
    if (age < BACKUP_NUDGE_DAYS) return '';
    return `<button type="button" class="banner quiet" data-act="go-data">
      <span>${last ? 'עבר חודש מהגיבוי האחרון' : 'עוד לא גיבית את הנתונים'}</span><span class="chev" aria-hidden="true">‹</span></button>`;
  };

  const weekHtml = () => {
    const s = L.summarize(db.entries, state.week);
    const days = L.weekKeys(state.week);
    const range = `${dateShort.format(L.fromKey(days[0]))} – ${dateShort.format(L.fromKey(days[6]))}`;
    const atLatest = L.addDays(state.week, 7) > todayKey();
    const nav = `
      <header class="dayhead">
        <button type="button" class="arrow" data-act="week-prev" aria-label="השבוע הקודם">›</button>
        <div class="title">
          <h1>סיכום שבועי</h1>
          <p>${range}</p>
        </div>
        <button type="button" class="arrow" data-act="week-next" aria-label="השבוע הבא" ${atLatest ? 'disabled' : ''}>‹</button>
      </header>`;
    if (!s.morningCount && !s.eveningCount) {
      return `${nav}<div class="empty-state"><h2>אין נתונים לשבוע הזה</h2><p>אחרי שתמלא בוקר או ערב, הממוצעים יופיעו כאן.</p></div>`;
    }
    const feeling = s.avgFeeling == null ? null : L.FEELINGS[Math.round(s.avgFeeling) - 1];
    const coke = itemValue(s.coke);
    const rit = itemValue(s.ritalin);
    const work = itemValue(s.workout);
    const nightNotes = [];
    if (s.night.answered) {
      nightNotes.push(`ב-${s.night.woke} מתוך ${s.night.answered} לילות שמולאו`, `${one(s.night.avgPerNight)} בלילה בממוצע`);
    }
    if (s.night.avgTime != null) nightNotes.push(`שעה ממוצעת ${L.fmtTime(s.night.avgTime)}`);
    return `
      ${nav}
      <p class="coverage">${s.morningCount} מתוך 7 בקרים ו-${s.eveningCount} מתוך 7 ערבים מולאו. הממוצעים מחושבים רק ממה שמולא.</p>
      <div class="tiles">
        <div class="tile"><span>שינה בממוצע</span><strong>${L.fmtDuration(s.avgSleep)}</strong><small>שעות ללילה</small></div>
        <div class="tile"><span>ציון ממוצע</span><strong>${s.avgScore == null ? '—' : Math.round(s.avgScore)}</strong><small>Apple Watch</small></div>
        <div class="tile"><span>הרגשה ממוצעת</span><strong class="word">${feeling || '—'}</strong><small>${s.avgFeeling == null ? '' : `${one(s.avgFeeling)} מתוך 5`}</small></div>
      </div>
      <section class="card">
        <h2>שינה</h2>
        <dl>
          ${statRow('הליכה לישון, בממוצע', L.fmtTime(s.avgBed))}
          ${statRow('התעוררות, בממוצע', L.fmtTime(s.avgWake))}
          ${statRow('סך כל השינה', s.totalSleep == null ? '—' : `${L.fmtDuration(s.totalSleep)} שעות`, s.nights ? `ב-${s.nights} לילות` : '')}
          ${statRow('התעוררויות בלילה', !s.night.answered ? '—' : s.night.total === 1 ? 'פעם אחת' : `${s.night.total} פעמים`, nightNotes.join(', '))}
        </dl>
      </section>
      <section class="card">
        <h2>במהלך היום</h2>
        <dl>
          ${statRow('קפה, סך הכל', !s.eveningCount ? '—' : s.coffeeTotal === 1 ? 'כוס אחת' : `${s.coffeeTotal} כוסות`, s.coffeeAvg == null ? '' : `${one(s.coffeeAvg)} ביום בממוצע`)}
          ${statRow('הקפה האחרון, בממוצע', L.fmtTime(s.avgLastCoffee))}
          ${statRow('קולה זירו', coke.value, coke.note)}
          ${statRow('ריטלין', rit.value, rit.note)}
          ${statRow('אימון', work.value, work.note)}
        </dl>
      </section>
      <section class="card flush">
        <h2>יום אחר יום</h2>
        <div class="day-list">${days.map(dayRow).join('')}</div>
      </section>
      <p class="footnote">נתוני הבוקר של כל יום מתארים את הלילה שלפניו.</p>
      ${backupNudge()}`;
  };

  // ---------- data view ----------
  const isStandalone = () => window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;

  const installHint = () => (isStandalone() ? '' : `
    <aside class="hint">
      <b>להתקנה באייפון:</b> ב-Safari לוחצים על שיתוף ואז על ״הוספה למסך הבית״.
      נתונים שמוזנים כאן בדפדפן לא עוברים ליישומון, אז כדאי למלא רק מהסמל במסך הבית.
    </aside>`);

  const pushHtml = () => {
    const { status, code, copied } = state.push;
    const head = '<h2>התראות</h2>';
    if (status === 'loading') return `${head}<p>בודק…</p>`;
    if (status === 'unsupported') {
      return `${head}<p>${isStandalone()
        ? 'המכשיר הזה לא תומך בהתראות מהיישומון. צריך iOS 16.4 ומעלה.'
        : 'אפשר להפעיל התראות רק מתוך היישומון שבמסך הבית.'}</p>`;
    }
    if (status === 'denied') {
      return `${head}<p>ההתראות חסומות. אפשר לאפשר אותן בהגדרות האייפון, תחת ״עדכונים״ ו״יומן שינה״.</p>`;
    }
    if (status === 'error') {
      return `${head}<p>הפעלת ההתראות נכשלה. נסה שוב בעוד רגע.</p>
        <button type="button" class="action primary" data-act="push-on">הפעלת התראות</button>`;
    }
    if (status === 'off') {
      return `${head}<p>תזכורת בבוקר ובערב. שירות התזכורות שומר רק כתובת למשלוח התראות ואת השעות, בלי נתוני שינה.</p>
        <button type="button" class="action primary" data-act="push-on">הפעלת התראות</button>`;
    }
    return `${head}<p>ההתראות מופעלות במכשיר. כדי שיגיעו, צריך להעתיק את הקוד הזה פעם אחת לשירות התזכורות.</p>
      <textarea class="code" readonly dir="ltr" rows="4" aria-label="קוד התראות">${code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>
      <div class="stack">
        <button type="button" class="action primary" data-act="push-copy">${copied ? 'הקוד הועתק ✓' : 'העתקת הקוד'}</button>
        <button type="button" class="action" data-act="push-off">כיבוי התראות</button>
      </div>`;
  };

  const autoWhen = (iso) => {
    const d = new Date(iso);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${dayLabel(L.toKey(d)) || dateLong.format(d)}, ${time}`;
  };

  function autoHtml() {
    const view = state.autoView;
    const head = '<h2>גיבוי אוטומטי מוצפן</h2>';
    const message = view.message ? `<p class="auto-message" role="status">${view.message}</p>` : '';
    const copy = `<button type="button" class="action" data-act="auto-copy">${view.copied ? 'הקוד הועתק ✓' : 'העתקת הקוד'}</button>`;

    if (view.mode === 'new') {
      return `${head}
        <p>זה קוד השחזור שלך. שמור אותו במנהל סיסמאות או במקום בטוח אחר, מחוץ לאייפון. <b>בלעדיו אי אפשר לשחזר את הגיבוי, ואין דרך לאפס אותו.</b></p>
        <p class="recovery" dir="ltr">${view.code}</p>
        ${message}
        <div class="stack">
          ${copy}
          <button type="button" class="action primary" data-act="auto-confirm">שמרתי את הקוד, להפעיל</button>
          <button type="button" class="action" data-act="auto-cancel">ביטול</button>
        </div>`;
    }
    if (view.mode === 'restore') {
      return `${head}
        <p>הזן את קוד השחזור. הנתונים שבמכשיר יוחלפו בנתונים מהגיבוי.</p>
        <input id="auto-code" class="recovery-input" type="text" dir="ltr" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="קוד שחזור" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX">
        ${message}
        <div class="stack">
          <button type="button" class="action primary" data-act="auto-restore">שחזור מהגיבוי</button>
          <button type="button" class="action" data-act="auto-cancel">ביטול</button>
        </div>`;
    }
    if (!auto.code) {
      return `${head}
        <p>אחרי כל שינוי נשלח עותק מוצפן לשירות הגיבוי שלך ב-Cloudflare. הוא לא יכול לקרוא אותו, כי רק קוד השחזור פותח אותו.</p>
        ${message}
        <div class="stack">
          <button type="button" class="action primary" data-act="auto-new">הפעלת גיבוי אוטומטי</button>
          <button type="button" class="action" data-act="auto-restore-open">יש לי קוד שחזור</button>
        </div>`;
    }

    let status;
    if (auto.error === 'mismatch') status = 'הגיבוי נכשל: קוד השחזור לא מתאים לגיבוי שבשירות.';
    else if (auto.error) status = `הגיבוי לא הושלם, וננסה שוב כשיהיה חיבור.${auto.lastAt ? ` גיבוי אחרון: ${autoWhen(auto.lastAt)}.` : ''}`;
    else if (auto.lastAt) status = `גיבוי אחרון: ${autoWhen(auto.lastAt)}.`;
    else status = 'הגיבוי מופעל. הגיבוי הראשון יישלח אחרי שיהיו נתונים.';
    return `${head}
      <p class="${auto.error ? 'auto-error' : ''}">${status}</p>
      ${view.mode === 'reveal' ? `<p class="recovery" dir="ltr">${auto.code}</p>` : ''}
      ${message}
      <div class="stack">
        ${view.mode === 'reveal' ? copy : '<button type="button" class="action" data-act="auto-reveal">הצגת קוד השחזור</button>'}
        <button type="button" class="action danger-quiet" data-act="auto-off">כיבוי ומחיקת העותק המוצפן</button>
      </div>`;
  }

  const showAuto = (next) => {
    state.autoView = { mode: 'main', message: '', code: '', copied: false, ...next };
    refreshAuto();
  };

  const NETWORK_MESSAGE = 'אין חיבור לשירות הגיבוי. נסה שוב בעוד רגע.';

  const autoConfirm = async () => {
    const { code } = state.autoView;
    if (Object.keys(db.entries).length) {
      let status = 0;
      try {
        status = await B.upload(BACKUP_URL, code, db.entries);
      } catch { /* handled below */ }
      if (status === 403) {
        return showAuto({ message: 'כבר קיים גיבוי בשירות. כדי להשתמש בו, לחץ על ״יש לי קוד שחזור״.' });
      }
      if (status < 200 || status >= 300) {
        return showAuto({ mode: 'new', code, message: NETWORK_MESSAGE });
      }
      auto = { code, lastAt: new Date().toISOString(), dirty: false, error: '' };
    } else {
      auto = { code, dirty: true, error: '' };
    }
    saveAuto();
    return showAuto({ message: 'הגיבוי האוטומטי הופעל.' });
  };

  const autoRestore = async () => {
    const input = document.getElementById('auto-code');
    const code = B.normalizeCode(input ? input.value : '');
    if (!code) return showAuto({ mode: 'restore', message: 'הקוד לא תקין. צריכים להיות בו 24 תווים.' });
    let result;
    try {
      result = await B.download(BACKUP_URL, code);
    } catch (err) {
      const unreadable = err && err.name !== 'TypeError';
      return showAuto({ mode: 'restore', message: unreadable ? 'לא הצלחתי לפתוח את הגיבוי עם הקוד הזה.' : NETWORK_MESSAGE });
    }
    if (result.status === 403) return showAuto({ mode: 'restore', message: 'הקוד לא מתאים לגיבוי שבשירות.' });
    if (result.status === 404) return showAuto({ mode: 'restore', message: 'אין גיבוי בשירות.' });
    if (!result.entries) return showAuto({ mode: 'restore', message: NETWORK_MESSAGE });
    const entries = L.cleanEntries(result.entries);
    const count = Object.keys(entries).length;
    const current = Object.keys(db.entries).length;
    const days = (n) => (n === 1 ? 'יום אחד' : `${n} ימים`);
    const question = current
      ? `לשחזר ${days(count)} מהגיבוי? הנתונים שבמכשיר (${days(current)}) יוחלפו.`
      : `לשחזר ${days(count)} מהגיבוי?`;
    if (!window.confirm(question)) return showAuto({ mode: 'restore' });
    db.entries = entries;
    auto = {};
    persist();
    if (saveFailed) return showAuto({ mode: 'restore', message: 'השחזור נכשל: לא הצלחתי לשמור במכשיר.' });
    auto = { code, lastAt: new Date().toISOString(), dirty: false, error: '' };
    saveAuto();
    return showAuto({ message: `שוחזרו ${days(count)}. הגיבוי האוטומטי פעיל.` });
  };

  const autoOff = async () => {
    if (!window.confirm('לכבות את הגיבוי ולמחוק את העותק המוצפן מהשירות? הנתונים במכשיר יישארו.')) return;
    let status = 0;
    try {
      status = await B.remove(BACKUP_URL, auto.code);
    } catch { /* handled below */ }
    if (status !== 403 && (status < 200 || status >= 300)) {
      showAuto({ message: NETWORK_MESSAGE });
      return;
    }
    clearTimeout(uploadTimer);
    auto = {};
    saveAuto();
    showAuto({ message: status === 403 ? 'הגיבוי כובה במכשיר. העותק שבשירות לא נמחק, כי הקוד לא מתאים לו.' : 'הגיבוי כובה והעותק המוצפן נמחק.' });
  };

  const autoCopy = async () => {
    const code = state.autoView.code || auto.code;
    try {
      await navigator.clipboard.writeText(code);
      state.autoView.copied = true;
      refreshAuto();
    } catch {
      const box = document.querySelector('.recovery');
      if (box) window.getSelection().selectAllChildren(box);
    }
  };

  const dataHtml = () => {
    const count = Object.keys(db.entries).length;
    const last = db.lastBackup ? dateLong.format(new Date(db.lastBackup)) : 'עדיין לא';
    return `
      <header class="plain-head"><h1>הנתונים שלך</h1></header>
      ${state.notice ? `<p class="notice" role="status">${state.notice}</p>` : ''}
      <section class="card prose">
        <h2>פרטיות</h2>
        <p>נתוני השינה נשמרים על המכשיר הזה. אין כאן חשבון או ניתוח שימוש, והיישומון חסום טכנית משליחת מידע לכל מקום מלבד שירות הגיבוי שלך. אליו עובר רק עותק מוצפן, ורק אם הפעלת גיבוי אוטומטי.</p>
      </section>
      <section class="card prose" id="push">${pushHtml()}</section>
      <section class="card prose" id="auto">${autoHtml()}</section>
      <section class="card prose">
        <h2>גיבוי לקובץ</h2>
        <p>מחיקת היישומון ממסך הבית מוחקת גם את הנתונים. קובץ גיבוי שומר עותק במקום שתבחר, למשל ב״קבצים״.</p>
        <dl>
          ${statRow('ימים שמורים', count)}
          ${statRow('קובץ גיבוי אחרון', last)}
        </dl>
        <div class="stack">
          <button type="button" class="action primary" data-act="export" ${count ? '' : 'disabled'}>יצירת קובץ גיבוי</button>
          <button type="button" class="action" data-act="import">שחזור מקובץ גיבוי</button>
        </div>
      </section>
      <section class="card prose">
        <h2>מחיקה</h2>
        <p>מוחקת את כל הימים מהמכשיר, וגם את העותק המוצפן אם הגיבוי האוטומטי פעיל. אי אפשר לבטל את זה בלי קובץ גיבוי.</p>
        <button type="button" class="action danger" data-act="wipe" ${count ? '' : 'disabled'}>מחיקת כל הנתונים</button>
      </section>`;
  };

  // ---------- render ----------
  const render = () => {
    main.innerHTML = state.tab === 'log' ? logHtml() : state.tab === 'week' ? weekHtml() : dataHtml();
    document.querySelectorAll('.tab').forEach((b) => {
      if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  };
  const goTab = (tab) => {
    state.tab = tab;
    state.notice = '';
    state.autoView = { mode: 'main', message: '', code: '', copied: false }; // never leaves the code on screen
    render();
    window.scrollTo(0, 0);
    if (tab === 'data') loadPush();
  };

  // ---------- notifications ----------
  const showPush = (next) => {
    state.push = { code: '', copied: false, ...next };
    const box = document.getElementById('push');
    if (box) box.innerHTML = pushHtml();
  };
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const subscriptionCode = (sub) => {
    const { endpoint, keys } = sub.toJSON();
    return JSON.stringify({ endpoint, keys });
  };

  async function loadPush() {
    if (!pushSupported()) return showPush({ status: 'unsupported' });
    if (Notification.permission === 'denied') return showPush({ status: 'denied' });
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      return showPush(sub ? { status: 'on', code: subscriptionCode(sub) } : { status: 'off' });
    } catch {
      return showPush({ status: 'error' });
    }
  }

  const keyBytes = (text) => Uint8Array.from(
    atob(text.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );

  const pushOn = async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'denied') return showPush({ status: 'denied' });
      if (permission !== 'granted') return showPush({ status: 'off' });
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(VAPID_PUBLIC_KEY),
      });
      return showPush({ status: 'on', code: subscriptionCode(sub) });
    } catch {
      return showPush({ status: 'error' });
    }
  };

  const pushOff = async () => {
    if (!window.confirm('לכבות את ההתראות? כדי להפעיל אותן שוב יהיה צריך להעתיק קוד חדש לשירות התזכורות.')) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      showPush({ status: 'off' });
    } catch {
      showPush({ status: 'error' });
    }
  };

  const pushCopy = async () => {
    const { code } = state.push;
    try {
      await navigator.clipboard.writeText(code);
      showPush({ status: 'on', code, copied: true });
    } catch {
      // Clipboard refused: select the text so it can be copied by hand.
      const box = document.querySelector('textarea.code');
      if (box) box.select();
    }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (!ev.data || !ev.data.openPart) return;
      Object.assign(state, viewForPart(ev.data.openPart));
      goTab('log');
    });
  }
  // Refreshes what depends on a typed value without touching the input in use.
  const refreshLive = () => {
    const strip = document.getElementById('strip');
    if (strip) strip.innerHTML = stripHtml();
    const status = document.getElementById('status');
    if (status) status.innerHTML = statusHtml();
    const dur = document.getElementById('duration');
    if (dur) dur.innerHTML = durationHtml(morning(state.date));
  };

  // ---------- backup ----------
  const exportBackup = async () => {
    const payload = JSON.stringify({ app: 'sleep-log', version: 1, exported: new Date().toISOString(), entries: db.entries }, null, 2);
    const name = `sleep-log-${todayKey()}.json`;
    const file = new File([payload], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // the share sheet was closed
      state.notice = 'יצירת הגיבוי נכשלה.';
      render();
      return;
    }
    db.lastBackup = new Date().toISOString();
    persist();
    state.notice = 'קובץ הגיבוי נוצר.';
    render();
  };

  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    let entries;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.app !== 'sleep-log') throw new Error('not a backup');
      entries = L.cleanEntries(parsed.entries);
    } catch {
      state.notice = 'הקובץ הזה אינו גיבוי של יומן השינה.';
      render();
      return;
    }
    const count = Object.keys(entries).length;
    const current = Object.keys(db.entries).length;
    const question = current
      ? `לשחזר ${count} ימים מהגיבוי? זה יחליף את ${current} הימים השמורים עכשיו.`
      : `לשחזר ${count} ימים מהגיבוי?`;
    if (!window.confirm(question)) return;
    db.entries = entries;
    persist();
    state.notice = saveFailed ? 'השחזור נכשל.' : `שוחזרו ${count} ימים.`;
    render();
  });

  // ---------- events ----------
  const actions = {
    'day-prev': () => { state.date = L.addDays(state.date, -1); render(); },
    'day-next': () => { state.date = L.addDays(state.date, 1); render(); },
    'pick-day': (el) => { state.date = el.dataset.key; render(); },
    part: (el) => { state.part = el.dataset.part; render(); },
    'cup-inc': () => {
      const e = structuredClone(evening(state.date));
      if (e.coffee >= MAX_CUPS) return;
      e.coffee += 1;
      e.coffeeTimes.push('');
      commit(state.date, 'evening', e);
      render();
    },
    'cup-dec': () => {
      const e = structuredClone(evening(state.date));
      if (e.coffee <= 0) return;
      e.coffee -= 1;
      e.coffeeTimes.pop();
      commit(state.date, 'evening', e);
      render();
    },
    yn: (el) => {
      const e = structuredClone(evening(state.date));
      const name = el.dataset.item;
      const val = el.dataset.val === 'true';
      e[name].on = e[name].on === val ? null : val; // tapping again clears the answer
      if (!e[name].on) e[name].time = '';
      commit(state.date, 'evening', e);
      render();
    },
    woke: (el) => {
      const m = structuredClone(morning(state.date));
      const val = el.dataset.val === 'true';
      m.woke = m.woke === val ? null : val; // tapping again clears the answer
      m.wakeTimes = m.woke ? [''] : [];
      commit(state.date, 'morning', m);
      render();
    },
    'wake-add': () => {
      const m = structuredClone(morning(state.date));
      if (m.wakeTimes.length >= L.MAX_WAKINGS) return;
      m.wakeTimes.push('');
      commit(state.date, 'morning', m);
      render();
    },
    'wake-remove': (el) => {
      const m = structuredClone(morning(state.date));
      m.wakeTimes.splice(Number(el.dataset.index), 1);
      commit(state.date, 'morning', m);
      render();
    },
    feeling: (el) => {
      const m = { ...morning(state.date) };
      const val = Number(el.dataset.val);
      m.feeling = m.feeling === val ? null : val;
      commit(state.date, 'morning', m);
      render();
    },
    'week-prev': () => { state.week = L.addDays(state.week, -7); render(); },
    'week-next': () => { state.week = L.addDays(state.week, 7); render(); },
    'open-day': (el) => {
      state.date = el.dataset.key;
      goTab('log');
    },
    'open-this-week': () => {
      state.week = L.weekStart(todayKey());
      goTab('week');
    },
    'go-data': () => goTab('data'),
    'push-on': pushOn,
    'push-off': pushOff,
    'push-copy': pushCopy,
    export: exportBackup,
    import: () => importInput.click(),
    wipe: async () => {
      const question = auto.code
        ? 'למחוק את כל הנתונים מהמכשיר ואת העותק המוצפן מהשירות? אי אפשר לבטל את זה בלי קובץ גיבוי.'
        : 'למחוק את כל הנתונים מהמכשיר? אי אפשר לבטל את זה בלי קובץ גיבוי.';
      if (!window.confirm(question)) return;
      let cloudKept = false;
      if (auto.code) {
        let status = 0;
        try {
          status = await B.remove(BACKUP_URL, auto.code);
        } catch { /* handled below */ }
        cloudKept = status < 200 || status >= 300;
        clearTimeout(uploadTimer);
        // The code stays when deletion failed, so the copy can still be removed later.
        if (!cloudKept) auto = {};
        saveAuto();
      }
      db = { entries: {}, lastBackup: null };
      persist();
      state.notice = cloudKept
        ? 'הנתונים במכשיר נמחקו, אבל העותק המוצפן עדיין בשירות. כשיהיה חיבור, לחץ על ״כיבוי ומחיקת העותק המוצפן״.'
        : 'כל הנתונים נמחקו.';
      render();
    },
    'auto-new': () => showAuto({ mode: 'new', code: B.newCode() }),
    'auto-restore-open': () => showAuto({ mode: 'restore' }),
    'auto-cancel': () => showAuto({}),
    'auto-confirm': autoConfirm,
    'auto-restore': autoRestore,
    'auto-reveal': () => showAuto({ mode: 'reveal' }),
    'auto-copy': autoCopy,
    'auto-off': autoOff,
  };

  main.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (el && !el.disabled) actions[el.dataset.act](el);
  });

  document.querySelector('.tabbar').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-tab]');
    if (el) goTab(el.dataset.tab);
  });

  main.addEventListener('input', (ev) => {
    const field = ev.target.dataset.field;
    if (!field) return;
    const value = ev.target.value;
    if (field === 'bed' || field === 'wake') {
      commit(state.date, 'morning', { ...morning(state.date), [field]: value });
    } else if (field === 'score') {
      const digits = value.replace(/\D/g, '');
      const score = digits === '' ? null : Math.min(Number(digits), 100);
      if (String(score ?? '') !== value) ev.target.value = score ?? '';
      commit(state.date, 'morning', { ...morning(state.date), score });
    } else if (field.startsWith('night:')) {
      const m = structuredClone(morning(state.date));
      m.wakeTimes[Number(field.slice(6))] = value;
      commit(state.date, 'morning', m);
    } else if (field.startsWith('cup:')) {
      const e = structuredClone(evening(state.date));
      e.coffeeTimes[Number(field.slice(4))] = value;
      commit(state.date, 'evening', e);
    } else if (field.startsWith('item:')) {
      const e = structuredClone(evening(state.date));
      e[field.slice(5)].time = value;
      commit(state.date, 'evening', e);
    }
    refreshLive();
  });

  // An app left open overnight should not stay on yesterday's view.
  let lastActiveDay = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || todayKey() === lastActiveDay) return;
    lastActiveDay = todayKey();
    Object.assign(state, initialView(), { week: initialWeek() });
    if (!main.contains(document.activeElement)) render();
  });

  // Retry a backup that did not finish, and try to finish one when the app is put away.
  document.addEventListener('visibilitychange', () => { runUpload(); });
  window.addEventListener('online', () => { runUpload(); });

  // ---------- start ----------
  render();
  runUpload();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
