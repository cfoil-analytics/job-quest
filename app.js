// Job Quest: gamified job search checklist.
// Everything is saved on the phone in localStorage. Use Me > Backup to keep a copy.

const STORAGE_KEY = 'jobquest-data-v1';
const DAY_BONUS = 10; // extra points for finishing the whole daily list

// ---------- dates ----------
// Dates are stored as "YYYY-MM-DD" in local time so a day flips at midnight on the phone.
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
function daysBetween(a, b) {
  return Math.round((parseKey(b) - parseKey(a)) / 86400000);
}

// ---------- saving / loading ----------
function defaultData() {
  return {
    version: 1,
    createdAt: dateKey(),
    points: 0,
    streak: { current: 0, best: 0, lastCompleteDate: null },
    settings: {
      outreachEarly: false, // unlock outreach before Project 1 is done
      jobsEnabled: false,   // show the jobs applied tracker in People
    },
    jobs: [],      // { id, company, role, link, date, status, contact, followUp, notes, interview, offer }
    checkins: {},  // weekKey -> { date, summary, ratings, win, blocker, goals, goalsDone }
    // portfolio projects: target date, done, work sessions, checked-off milestones
    projects: {
      p1: { start: dateKey(), target: '2026-11-14', done: false, doneDate: null, sessions: [], milestones: {} },
      p2: { start: null, target: null, done: false, doneDate: null, sessions: [], milestones: {} },
      p3: { start: null, target: null, done: false, doneDate: null, sessions: [], milestones: {} },
    },
    timer: null,   // running project timer: { projectId, minutes, endAt } or { projectId, minutes, pausedLeft }
    recs: [],      // letters of rec: { id, name, role, neededBy, steps: { ask, materials, reminder, received, thanks }, declined }
    outreach: [],  // { id, name, org, role, channel, date, status, followUps: [dates], replied, notes }
    days: {},   // "YYYY-MM-DD" -> { tasks: [...], complete: bool }
    log: [],    // history of finished tasks, used later for stats and spreadsheets
    study: {
      completed: {}, // lessonId -> date finished
      review: {},    // questionId -> { box, due } for questions you missed
      sessions: [],  // every quiz: date, kind, lesson, domain, score, total
      weekly: {},    // weekKey (Monday's date) -> date the weekly quiz was done
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const base = defaultData();
      return {
        ...base,
        ...saved,
        settings: { ...base.settings, ...saved.settings },
        streak: { ...base.streak, ...saved.streak },
        study: { ...base.study, ...saved.study },
        projects: { ...base.projects, ...saved.projects },
      };
    }
  } catch (e) {
    console.warn('Could not load saved data', e);
  }
  return defaultData();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    toast('⚠️ Could not save');
  }
}

let data = load();

// ---------- levels ----------
// Points needed to reach a level: L2 = 100, L3 = 300, L4 = 600, L5 = 1000 ...
function pointsForLevel(level) {
  return 50 * level * (level - 1);
}
function levelInfo(points) {
  let level = 1;
  while (points >= pointsForLevel(level + 1)) level++;
  const start = pointsForLevel(level);
  const end = pointsForLevel(level + 1);
  return { level, into: points - start, span: end - start };
}

// ---------- daily tasks ----------
// Rotating extras that show up on Mon / Wed / Fri. Later phases swap these for real
// rec letter, outreach, and docs tasks.
const EXTRAS = [
  { key: 'cover', type: 'Docs', title: 'Work 20 min on the generic cover letter', points: 15 },
  { key: 'read', type: 'Learn', title: 'Read one sport science article, write 2 takeaways', points: 10 },
  { key: 'linkedin', type: 'Docs', title: 'Update LinkedIn with one thing from this week', points: 10 },
];

function buildDay(key) {
  const tasks = [
    { id: 'study', type: 'CSCS', title: "Today's CSCS lesson + quiz", points: 10, done: false },
  ];
  const active = activeProject();
  if (active) {
    tasks.push({ id: 'project', type: 'Project', title: projectTaskTitle(active), points: 15, done: false });
  }
  const weekday = parseKey(key).getDay();
  if (weekday === 0) {
    tasks.push({ id: 'checkin', type: 'Weekly', title: 'Weekly check-in (3 min)', points: CHECKIN_POINTS, done: false });
  }
  // outreach 3 days a week (Tue / Wed / Thu) once it's unlocked
  if (outreachUnlocked() && [2, 3, 4].includes(weekday)) {
    tasks.push({ id: 'outreach', type: 'Outreach', title: 'Reach out to one professional', points: 20, done: false });
  }
  if ([1, 3, 5].includes(weekday)) {
    const n = Math.floor(daysBetween('2026-01-05', key) / 2);
    const extra = EXTRAS[((n % EXTRAS.length) + EXTRAS.length) % EXTRAS.length];
    tasks.push({ id: 'extra-' + extra.key, type: extra.type, title: extra.title, points: extra.points, done: false });
  }
  return { tasks, complete: false };
}

function todayData() {
  const key = dateKey();
  if (!data.days[key]) {
    data.days[key] = buildDay(key);
    save();
  }
  return data.days[key];
}

// Streak breaks if the last finished day was before yesterday.
function refreshStreak() {
  const today = dateKey();
  const last = data.streak.lastCompleteDate;
  if (last && last !== today && last !== addDays(today, -1) && data.streak.current !== 0) {
    data.streak.current = 0;
    save();
  }
}

// Only the main tasks count toward finishing the day. Tasks you add yourself are bonus.
function updateDayComplete(day) {
  const key = dateKey();
  const main = day.tasks.filter(t => !t.bonus);
  const allDone = main.length > 0 && main.every(t => t.done);

  if (allDone && !day.complete) {
    day.complete = true;
    day.streakBefore = { ...data.streak };
    const yesterday = addDays(key, -1);
    data.streak.current = data.streak.lastCompleteDate === yesterday ? data.streak.current + 1 : 1;
    data.streak.lastCompleteDate = key;
    data.streak.best = Math.max(data.streak.best, data.streak.current);
    addPoints(DAY_BONUS);
    celebrate();
    toast(`🎉 Day done! +${DAY_BONUS} bonus`);
  } else if (!allDone && day.complete) {
    // unchecked something after finishing, so undo the streak and bonus
    day.complete = false;
    if (day.streakBefore) data.streak = { ...day.streakBefore };
    addPoints(-DAY_BONUS);
  }
}

// All point changes go through here so level-ups get celebrated.
function addPoints(n) {
  const before = levelInfo(data.points).level;
  data.points += n;
  const after = levelInfo(data.points).level;
  if (after > before) {
    celebrate();
    setTimeout(() => toast(`⬆️ Level ${after}!`), 1400);
  }
}

function toggleTask(id) {
  const day = todayData();
  const task = day.tasks.find(t => t.id === id);
  if (!task) return;

  task.done = !task.done;
  if (task.done) {
    addPoints(task.points);
    data.log.push({ date: dateKey(), id: task.id, type: task.type, title: task.title, points: task.points });
    toast(`+${task.points} ⭐`);
  } else {
    addPoints(-task.points);
    const i = data.log.findLastIndex(l => l.date === dateKey() && l.id === task.id);
    if (i >= 0) data.log.splice(i, 1);
  }
  updateDayComplete(day);
  save();
  render();
}

function addCustomTask(title) {
  title = title.trim();
  if (!title) return;
  const day = todayData();
  day.tasks.push({ id: 'custom-' + Date.now(), type: 'Bonus', title, points: 5, done: false, bonus: true });
  save();
  render();
}

function deleteTask(id) {
  const day = todayData();
  const task = day.tasks.find(t => t.id === id);
  if (!task || !task.bonus) return;
  if (task.done) toggleTask(id); // take the points back first
  day.tasks = day.tasks.filter(t => t.id !== id);
  save();
  render();
}

// ---------- screens ----------
let currentTab = 'today';
const view = document.getElementById('view');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHeader() {
  const info = levelInfo(data.points);
  document.getElementById('streakPill').textContent = `🔥 ${data.streak.current}`;
  document.getElementById('pointsPill').textContent = `⭐ ${data.points}`;
  document.getElementById('levelLabel').textContent = `Level ${info.level} · ${info.into}/${info.span} XP`;
  document.getElementById('xpFill').style.width = `${Math.min(100, (info.into / info.span) * 100)}%`;
}

function renderToday() {
  const day = todayData();
  const main = day.tasks.filter(t => !t.bonus);
  const doneCount = main.filter(t => t.done).length;
  const pct = main.length ? (doneCount / main.length) * 100 : 0;
  const dateText = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const active = activeProject();
  let countdown;
  if (!active) {
    countdown = `<div class="big">🏆</div><div><b>All 3 projects shipped</b><div class="label">Time to build the deck</div></div>`;
  } else {
    const p = data.projects[active.id];
    const sub = active.id === 'p1' ? `${active.name} · then outreach unlocks` : active.name;
    if (!p.target) {
      countdown = `<div class="big">📅</div><div><b>Set a target date for ${active.short}</b><div class="label">${escapeHtml(active.name)} · tap to open Projects</div></div>`;
    } else {
      const left = daysBetween(dateKey(), p.target);
      countdown = left >= 0
        ? `<div class="big">${left}</div><div><b>day${left === 1 ? '' : 's'} to finish ${active.short}</b><div class="label">${escapeHtml(sub)}</div></div>`
        : `<div class="big" style="color:var(--red)">${-left}</div><div><b>day${left === -1 ? '' : 's'} past the ${active.short} target</b><div class="label">Finish it or move the date in Projects</div></div>`;
    }
  }

  // rec letter steps and follow-ups that are due (bonus, they don't affect the streak)
  const due = peopleDue();
  const peopleHtml = due.length ? `
    <h2>People to-do</h2>
    ${due.map(d => `
      <button class="lib-item" data-go-people>
        <span class="dot ${d.overdue ? 'overdue' : 'people'}"></span>
        <span class="t-title">${escapeHtml(d.text)}</span>
        <span class="t-tag">${escapeHtml(d.kind)}</span>
      </button>`).join('')}` : '';

  // goals set in the last weekly check-in
  const g = currentGoals();
  const goalsHtml = g ? `
    <h2>This week's goals</h2>
    <div class="card">
      ${g.goals.map((goal, i) => `
        <button class="milestone ${g.goalsDone[i] ? 'done' : ''}" data-goal="${i}">
          <span class="check small">${g.goalsDone[i] ? '✓' : ''}</span>
          <span>${escapeHtml(goal)}</span>
          <span></span>
        </button>`).join('')}
    </div>` : '';

  const taskHtml = day.tasks.map(t => `
    <div class="task ${t.done ? 'done' : ''}" data-id="${t.id}" role="button" tabindex="0">
      <div class="check">${t.done ? '✓' : ''}</div>
      <div class="t-body">
        <div class="t-tag">${escapeHtml(t.type)}</div>
        <div class="t-title">${escapeHtml(t.title)}</div>
      </div>
      <div class="t-pts">+${t.points}</div>
      ${t.bonus ? `<button class="del" data-del="${t.id}" aria-label="Delete task">×</button>` : ''}
    </div>`).join('');

  view.innerHTML = `
    <h1>${day.complete ? 'Crushed it 💪' : "Today's quest"}</h1>
    <p class="sub">${dateText}</p>

    <div class="card">
      <div class="day-progress"><span>${doneCount} / ${main.length} done</span><span>${day.complete ? '🔥 streak saved' : `+${DAY_BONUS} when finished`}</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>

    ${taskHtml}

    <form class="row" id="addForm" style="margin-top:4px">
      <input type="text" id="addInput" placeholder="Add a bonus task (+5)" maxlength="80">
      <button class="btn" type="submit">Add</button>
    </form>

    ${goalsHtml}

    ${peopleHtml}

    <h2>Countdown</h2>
    <div class="card countdown" data-go-projects role="button">${countdown}</div>
  `;
  view.querySelectorAll('[data-go-people]').forEach(el => el.addEventListener('click', () => goTab('people')));
  view.querySelectorAll('[data-go-projects]').forEach(el => el.addEventListener('click', () => goTab('projects')));
  view.querySelectorAll('[data-goal]').forEach(el => el.addEventListener('click', () => toggleGoal(g.wk, Number(el.dataset.goal))));

  view.querySelectorAll('.task').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-del]')) return;
      // the study task gets checked off by finishing the quiz, so send it to Study
      if (el.dataset.id === 'study' && LESSONS && LESSONS.length) {
        goTab('study');
        return;
      }
      // the outreach task gets checked off by logging someone in People
      if (el.dataset.id === 'outreach' && !el.classList.contains('done')) {
        goTab('people');
        return;
      }
      // the project task gets checked off by 20 min of logged project time
      if (el.dataset.id === 'project' && !el.classList.contains('done')) {
        goTab('projects');
        return;
      }
      // the check-in task gets checked off by saving the check-in
      if (el.dataset.id === 'checkin' && !el.classList.contains('done')) {
        startCheckin();
        return;
      }
      toggleTask(el.dataset.id);
    });
  });
  view.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', () => deleteTask(el.dataset.del));
  });
  document.getElementById('addForm').addEventListener('submit', e => {
    e.preventDefault();
    addCustomTask(document.getElementById('addInput').value);
  });
}

function renderComing(emoji, title, text) {
  view.innerHTML = `
    <div class="card coming">
      <div class="emoji">${emoji}</div>
      <h1>${title}</h1>
      <p class="sub">${text}</p>
    </div>`;
}

function renderMe() {
  if (meState === 'checkin') return renderCheckin();
  const info = levelInfo(data.points);
  const daysDone = Object.values(data.days).filter(d => d.complete).length;
  const thisWeek = data.checkins[weekKey()];
  const isSunday = new Date().getDay() === 0;

  view.innerHTML = `
    <h1>Your stats</h1>
    <p class="sub">Playing since ${parseKey(data.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>

    <div class="stats">
      <div class="card stat"><div class="num" style="color:var(--purple)">${info.level}</div><div class="lbl">Level</div></div>
      <div class="card stat"><div class="num" style="color:var(--gold-dark)">${data.points}</div><div class="lbl">Total points</div></div>
      <div class="card stat"><div class="num" style="color:var(--orange)">${data.streak.current}</div><div class="lbl">Current streak</div></div>
      <div class="card stat"><div class="num" style="color:var(--orange)">${data.streak.best}</div><div class="lbl">Best streak</div></div>
      <div class="card stat"><div class="num" style="color:var(--green)">${daysDone}</div><div class="lbl">Days completed</div></div>
      <div class="card stat"><div class="num" style="color:var(--green)">${data.log.length}</div><div class="lbl">Tasks finished</div></div>
    </div>

    <h2>Weekly check-in</h2>
    <div class="card">
      ${thisWeek
        ? `<b>✅ Done for the week of ${fmtDate(weekKey())}</b><p class="note">Next one opens Sunday. You can still edit this week's.</p><button class="btn ghost-green full" id="checkinBtn">Edit this week's check-in</button>`
        : `<b>${isSunday ? "It's Sunday: time to check in" : 'Opens on Sunday'}</b><p class="note">3 minutes: a summary of your week, 1-10 ratings, and goals for next week. +${CHECKIN_POINTS} points.</p><button class="btn ${isSunday ? '' : 'ghost-green'} full" id="checkinBtn">${isSunday ? 'Start check-in' : 'Do it early'}</button>`}
    </div>

    <h2>Trends</h2>
    ${renderTrends()}

    <h2>Share your progress</h2>
    <div class="card">
      <button class="btn full" id="xlsxBtn">📊 Export spreadsheet (.xlsx)</button>
      <p class="note">One Excel file with tabs for outreach, rec letters, jobs, study log, project hours, check-ins, and a task log. Save it to OneDrive and share the link with your mom or advisor. It's a snapshot, so export again for an update.</p>
    </div>

    <h2>Settings</h2>
    <div class="card">
      <label class="setting toggle">
        <span><b>Jobs applied tracker</b><span class="note" style="display:block;margin:2px 0 0">Shows up in People</span></span>
        <input type="checkbox" id="jobsToggle" ${data.settings.jobsEnabled ? 'checked' : ''}>
      </label>
    </div>

    <h2>Backup</h2>
    <div class="card">
      <button class="btn purple full" id="exportBtn">📤 Export backup</button>
      <button class="btn full" id="importBtn">📥 Import backup</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <p class="note">Your data lives only on this phone. Export once a week and save the file to OneDrive.</p>
    </div>

    <h2>Danger zone</h2>
    <div class="card">
      <button class="btn ghost full" id="resetBtn">Reset everything</button>
    </div>
  `;

  document.getElementById('checkinBtn').addEventListener('click', startCheckin);
  document.getElementById('xlsxBtn').addEventListener('click', exportSpreadsheet);
  document.getElementById('jobsToggle').addEventListener('change', e => {
    data.settings.jobsEnabled = e.target.checked;
    save();
    toast(e.target.checked ? 'Jobs tracker added to People' : 'Jobs tracker hidden (data kept)');
  });
  document.getElementById('exportBtn').addEventListener('click', exportBackup);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', importBackup);
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Delete ALL progress on this phone? Export a backup first if you want to keep it.')) {
      data = defaultData();
      save();
      render();
      toast('Reset done');
    }
  });
}

// ---------- backup ----------
async function exportBackup() {
  const name = `job-quest-backup-${dateKey()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });

  // On iPhone this opens the share sheet so you can "Save to Files" > OneDrive
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported || imported.version !== 1 || !imported.days) throw new Error('not a Job Quest backup');
      if (!confirm('Replace everything on this phone with this backup?')) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
      data = load();
      render();
      toast('✅ Backup loaded');
    } catch (err) {
      toast("⚠️ That file isn't a Job Quest backup");
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ---------- CSCS study ----------
// Lessons live in content/cscs/lessons.json (our own summaries, not textbook text).
let LESSONS = null;          // null = still loading, [] = failed to load
const QUESTIONS = {};        // questionId -> { ...question, lesson }
const REVIEW_DAYS = { 1: 1, 2: 3, 3: 7 }; // box -> days until it comes back
const LESSON_BONUS = 5;      // extra lesson after today's is done
const PERFECT_BONUS = 5;     // 100% on a quiz
const WEEKLY_POINTS = 20;
let studyState = null;       // what the Study tab is showing right now (not saved)

fetch('content/cscs/lessons.json')
  .then(r => r.json())
  .then(json => {
    LESSONS = json.lessons;
    LESSONS.forEach(lesson => lesson.questions.forEach(q => { QUESTIONS[q.id] = { ...q, lesson }; }));
    render();
  })
  .catch(err => {
    console.warn('Could not load lessons', err);
    LESSONS = [];
    render();
  });

function nextLesson() {
  return LESSONS.find(l => !data.study.completed[l.id]) || null;
}

function dueReviewIds() {
  const today = dateKey();
  return Object.entries(data.study.review)
    .filter(([id, r]) => r.due <= today && QUESTIONS[id])
    .map(([id]) => id);
}

// Monday's date for the current week, so the weekly quiz resets every Monday
function weekKey(key = dateKey()) {
  const dow = (parseKey(key).getDay() + 6) % 7; // Monday = 0
  return addDays(key, -dow);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shuffle the answer choices so you learn the answer, not the position
function makeQuizItem(id, isReview) {
  const q = QUESTIONS[id];
  const order = shuffle(q.choices.map((_, i) => i));
  return {
    id,
    q: q.q,
    choices: order.map(i => q.choices[i]),
    answer: order.indexOf(q.answer),
    why: q.why,
    domain: q.lesson.domain,
    isReview,
  };
}

function studyTaskDone() {
  const t = todayData().tasks.find(t => t.id === 'study');
  return !t || t.done;
}

function startLesson(lesson) {
  studyState = { mode: 'lesson', lesson };
  window.scrollTo(0, 0);
  render();
}

function startQuiz(kind, lesson) {
  let items = [];
  if (kind === 'lesson') {
    // review questions first as a warm-up (max 3), then the new lesson's 5
    const reviews = shuffle(dueReviewIds()).slice(0, 3).map(id => makeQuizItem(id, true));
    const fresh = lesson.questions.map(q => makeQuizItem(q.id, false));
    items = [...reviews, ...fresh];
  } else if (kind === 'review') {
    // all lessons finished: review day
    const due = shuffle(dueReviewIds()).slice(0, 5);
    const doneIds = LESSONS.filter(l => data.study.completed[l.id]).flatMap(l => l.questions.map(q => q.id));
    const extra = shuffle(doneIds.filter(id => !due.includes(id))).slice(0, 5 - due.length);
    items = [...due, ...extra].map(id => makeQuizItem(id, due.includes(id)));
  } else if (kind === 'weekly') {
    const doneIds = LESSONS.filter(l => data.study.completed[l.id]).flatMap(l => l.questions.map(q => q.id));
    const missed = doneIds.filter(id => data.study.review[id]);
    const rest = doneIds.filter(id => !data.study.review[id]);
    items = [...shuffle(missed), ...shuffle(rest)].slice(0, 10).map(id => makeQuizItem(id, !!data.study.review[id]));
    items = shuffle(items);
  }
  studyState = { mode: 'quiz', kind, lesson, items, i: 0, picked: null, results: [] };
  window.scrollTo(0, 0);
  render();
}

function updateReview(id, correct) {
  const r = data.study.review[id];
  if (!correct) {
    data.study.review[id] = { box: 1, due: addDays(dateKey(), REVIEW_DAYS[1]) };
  } else if (r) {
    const box = r.box + 1;
    if (box > 3) delete data.study.review[id]; // got it right 3 times in a row, it's learned
    else data.study.review[id] = { box, due: addDays(dateKey(), REVIEW_DAYS[box]) };
  }
}

function pickAnswer(choice) {
  const s = studyState;
  if (s.picked !== null) return;
  const item = s.items[s.i];
  s.picked = choice;
  const correct = choice === item.answer;
  s.results.push({ id: item.id, correct, domain: item.domain });
  updateReview(item.id, correct);
  save();
  render();
}

function nextQuestion() {
  const s = studyState;
  if (s.i < s.items.length - 1) {
    s.i++;
    s.picked = null;
    window.scrollTo(0, 0);
    render();
  } else {
    finishQuiz();
  }
}

function finishQuiz() {
  const s = studyState;
  const score = s.results.filter(r => r.correct).length;
  const total = s.results.length;
  const today = dateKey();
  let earned = 0;

  data.study.sessions.push({
    date: today,
    kind: s.kind,
    lessonId: s.lesson ? s.lesson.id : '',
    title: s.lesson ? s.lesson.title : (s.kind === 'weekly' ? 'Weekly review quiz' : 'Review day'),
    domain: s.lesson ? s.lesson.domain : 'Mixed',
    score,
    total,
  });

  if (s.kind === 'lesson') data.study.completed[s.lesson.id] = today;

  if (s.kind === 'weekly') {
    data.study.weekly[weekKey()] = today;
    earned += WEEKLY_POINTS;
    data.log.push({ date: today, id: 'weekly-quiz', type: 'CSCS', title: 'Weekly review quiz', points: WEEKLY_POINTS });
  } else {
    const day = todayData();
    const task = day.tasks.find(t => t.id === 'study');
    if (task && !task.done) {
      // this checks off today's study task
      task.done = true;
      earned += task.points;
      data.log.push({ date: today, id: 'study', type: task.type, title: task.title, points: task.points });
    } else {
      earned += LESSON_BONUS;
      data.log.push({ date: today, id: 'extra-lesson', type: 'CSCS', title: 'Extra lesson', points: LESSON_BONUS });
    }
  }
  if (score === total) earned += PERFECT_BONUS;

  addPoints(earned);
  updateDayComplete(todayData());
  save();

  studyState = { mode: 'results', kind: s.kind, lesson: s.lesson, score, total, earned, results: s.results };
  if (score === total) celebrate();
  window.scrollTo(0, 0);
  render();
}

function quitQuiz() {
  if (studyState.mode === 'quiz' && !confirm('Quit this quiz? Answers so far still count for review, but you won’t get credit.')) return;
  studyState = null;
  render();
}

function studyStats() {
  const s = data.study.sessions;
  const by = d => {
    const list = s.filter(x => x.domain === d);
    const right = list.reduce((a, x) => a + x.score, 0);
    const all = list.reduce((a, x) => a + x.total, 0);
    return all ? Math.round((right / all) * 100) : null;
  };
  return { sci: by('Scientific'), app: by('Applied') };
}

function renderStudy() {
  if (LESSONS === null) {
    view.innerHTML = `<div class="card coming"><div class="emoji">📚</div><p class="sub">Loading lessons…</p></div>`;
    return;
  }
  if (!LESSONS.length) {
    renderComing('📡', 'Lessons didn’t load', 'Open the app once with internet so it can save the lessons for offline use. You can still check off study on Today.');
    return;
  }
  if (studyState && studyState.mode === 'lesson') return renderLesson();
  if (studyState && studyState.mode === 'quiz') return renderQuiz();
  if (studyState && studyState.mode === 'results') return renderResults();
  renderStudyHome();
}

function renderStudyHome() {
  const lesson = nextLesson();
  const done = studyTaskDone();
  const due = dueReviewIds().length;
  const doneCount = Object.keys(data.study.completed).length;
  const sciTotal = LESSONS.filter(l => l.domain === 'Scientific').length;
  const sciDone = LESSONS.filter(l => l.domain === 'Scientific' && data.study.completed[l.id]).length;
  const appTotal = LESSONS.length - sciTotal;
  const appDone = doneCount - sciDone;
  const acc = studyStats();
  const weeklyReady = doneCount >= 2 && !data.study.weekly[weekKey()];
  const weeklyDone = !!data.study.weekly[weekKey()];

  let main;
  if (lesson) {
    main = `
      <div class="card lesson-card ${lesson.domain.toLowerCase()}">
        <div class="chip">${escapeHtml(lesson.domain)} · ${escapeHtml(lesson.chapter)}</div>
        <h2 style="margin-top:8px">${escapeHtml(lesson.title)}</h2>
        <p class="sub">${done ? 'Today’s study is done ✓. Keep going for a bonus.' : `About 5 min read + ${lesson.questions.length} questions${due ? ` + ${Math.min(due, 3)} review` : ''}`}</p>
        <button class="btn full" id="startLesson">${done ? `Next lesson (+${LESSON_BONUS})` : 'Start today’s lesson'}</button>
      </div>`;
  } else {
    main = `
      <div class="card lesson-card">
        <div class="chip">All lessons done 🎓</div>
        <h2 style="margin-top:8px">Review day</h2>
        <p class="sub">${done ? 'Done for today ✓' : 'New lessons are coming. For now, 5 review questions keep your streak alive.'}</p>
        ${done ? '' : '<button class="btn full" id="startReview">Start review</button>'}
      </div>`;
  }

  const library = LESSONS.filter(l => data.study.completed[l.id]).map(l => `
    <button class="lib-item" data-lesson="${l.id}">
      <span class="dot ${l.domain.toLowerCase()}"></span>
      <span class="t-title">${escapeHtml(l.title)}</span>
      <span class="t-tag">reread</span>
    </button>`).join('');

  view.innerHTML = `
    <h1>CSCS Study</h1>
    <p class="sub">Small bites every day. Scientific gets priority.</p>
    ${main}

    <div class="stats">
      <div class="card stat"><div class="num" style="color:var(--blue)">${sciDone}/${sciTotal}</div><div class="lbl">Scientific lessons</div></div>
      <div class="card stat"><div class="num" style="color:var(--purple)">${appDone}/${appTotal}</div><div class="lbl">Applied lessons</div></div>
      <div class="card stat"><div class="num" style="color:var(--blue)">${acc.sci === null ? '–' : acc.sci + '%'}</div><div class="lbl">Scientific accuracy</div></div>
      <div class="card stat"><div class="num" style="color:var(--purple)">${acc.app === null ? '–' : acc.app + '%'}</div><div class="lbl">Applied accuracy</div></div>
    </div>

    <h2>Weekly review quiz</h2>
    <div class="card">
      ${weeklyDone
        ? '<b>✅ Done this week.</b><p class="note">A new one opens Monday.</p>'
        : weeklyReady
          ? `<b>10 questions from everything so far</b><p class="note">Questions you missed show up first. +${WEEKLY_POINTS} points.</p><button class="btn purple full" id="startWeekly">Take weekly quiz</button>`
          : '<b>🔒 Unlocks after 2 lessons</b><p class="note">Mixes questions from every lesson you’ve finished.</p>'}
    </div>

    <h2>Missed questions</h2>
    <div class="card">
      <b>${Object.keys(data.study.review).length} in your review pile</b>
      <p class="note">${due} due today. Miss one and it comes back in 1 day, then 3, then 7. Get it right 3 times in a row and it leaves the pile.</p>
    </div>

    ${library ? `<h2>Lesson library</h2>${library}` : ''}
  `;

  const go = document.getElementById('startLesson');
  if (go) go.addEventListener('click', () => startLesson(lesson));
  const rev = document.getElementById('startReview');
  if (rev) rev.addEventListener('click', () => startQuiz('review', null));
  const wk = document.getElementById('startWeekly');
  if (wk) wk.addEventListener('click', () => startQuiz('weekly', null));
  view.querySelectorAll('[data-lesson]').forEach(el => {
    el.addEventListener('click', () => {
      studyState = { mode: 'lesson', lesson: LESSONS.find(l => l.id === el.dataset.lesson), reread: true };
      window.scrollTo(0, 0);
      render();
    });
  });
}

function renderLesson() {
  const { lesson, reread } = studyState;
  const sections = lesson.sections.map(sec => `
    <div class="card">
      <h2 style="margin-top:0">${escapeHtml(sec.heading)}</h2>
      <ul class="lesson-points">${sec.points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
    </div>`).join('');

  view.innerHTML = `
    <div class="quiz-top"><button class="x" id="quit" aria-label="Close">✕</button><div class="chip">${escapeHtml(lesson.domain)} · ${escapeHtml(lesson.chapter)}</div></div>
    <h1>${escapeHtml(lesson.title)}</h1>
    ${sections}
    <div class="card coach">💡 ${escapeHtml(lesson.coach)}</div>
    ${reread
      ? '<button class="btn full" id="backBtn">Back to Study</button>'
      : `<button class="btn full" id="quizBtn">I’m ready, quiz me</button>`}
  `;
  document.getElementById('quit').addEventListener('click', quitQuiz);
  const q = document.getElementById('quizBtn');
  if (q) q.addEventListener('click', () => startQuiz('lesson', lesson));
  const b = document.getElementById('backBtn');
  if (b) b.addEventListener('click', quitQuiz);
}

function renderQuiz() {
  const s = studyState;
  const item = s.items[s.i];
  const answered = s.picked !== null;
  const correct = answered && s.picked === item.answer;

  const choices = item.choices.map((c, i) => {
    let cls = '';
    if (answered && i === item.answer) cls = 'right';
    else if (answered && i === s.picked) cls = 'wrong';
    return `<button class="choice ${cls}" data-choice="${i}" ${answered ? 'disabled' : ''}>${escapeHtml(c)}</button>`;
  }).join('');

  view.innerHTML = `
    <div class="quiz-top">
      <button class="x" id="quit" aria-label="Quit quiz">✕</button>
      <div class="bar" style="flex:1"><div style="width:${((s.i + (answered ? 1 : 0)) / s.items.length) * 100}%"></div></div>
      <b>${s.i + 1}/${s.items.length}</b>
    </div>
    ${item.isReview ? '<div class="chip review">🔁 Review</div>' : `<div class="chip">${escapeHtml(item.domain)}</div>`}
    <h1 class="question">${escapeHtml(item.q)}</h1>
    ${choices}
    ${answered ? `
      <div class="feedback ${correct ? 'good' : 'bad'}">
        <b>${correct ? 'Nice! ✓' : 'Not quite'}</b>
        <p>${escapeHtml(item.why)}</p>
        <button class="btn ${correct ? '' : 'red'} full" id="nextBtn">${s.i < s.items.length - 1 ? 'Continue' : 'See results'}</button>
      </div>` : ''}
  `;
  document.getElementById('quit').addEventListener('click', quitQuiz);
  view.querySelectorAll('[data-choice]').forEach(el => el.addEventListener('click', () => pickAnswer(Number(el.dataset.choice))));
  const n = document.getElementById('nextBtn');
  if (n) {
    n.addEventListener('click', nextQuestion);
    n.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderResults() {
  const s = studyState;
  const pct = Math.round((s.score / s.total) * 100);
  const missed = s.results.filter(r => !r.correct).map(r => {
    const q = QUESTIONS[r.id];
    return `<div class="card"><b>${escapeHtml(q.q)}</b><p class="note">Answer: ${escapeHtml(q.choices[q.answer])}</p></div>`;
  }).join('');

  view.innerHTML = `
    <div class="card coming">
      <div class="emoji">${pct === 100 ? '🏆' : pct >= 70 ? '💪' : '📖'}</div>
      <h1>${s.score} / ${s.total}</h1>
      <p class="sub">${pct === 100 ? 'Perfect!' : pct >= 70 ? 'Solid work.' : 'Missed ones will come back tomorrow.'}</p>
      <div class="pill points" style="display:inline-block">+${s.earned} ⭐${s.score === s.total ? ` (incl. +${PERFECT_BONUS} perfect)` : ''}</div>
    </div>
    ${missed ? `<h2>Added to your review pile</h2>${missed}` : ''}
    <button class="btn full" id="doneBtn">Back to Today</button>
  `;
  document.getElementById('doneBtn').addEventListener('click', () => {
    studyState = null;
    goTab('today');
  });
}

// ---------- people: letters of rec + outreach ----------
const REC_GOAL = 3;
const REC_POINTS = 25;
const REMINDER_DAYS = 14;   // nudge a recommender 2 weeks after sending materials
const OUTREACH_POINTS = 20;
const FOLLOWUP_POINTS = 10;
const REPLY_POINTS = 15;
const FOLLOWUP_DAYS = 7;
const MAX_FOLLOWUPS = 2;    // don't chase anyone more than twice
const OUTREACH_STATUSES = ['Sent', 'Replied', 'Call set', 'No reply', 'Closed'];

const REC_STEPS = [
  { key: 'ask', label: 'Asked', todo: n => `Ask ${n} for a letter of rec` },
  { key: 'materials', label: 'Sent info', todo: n => `Send ${n} your resume, job info, and deadline` },
  { key: 'reminder', label: 'Reminder', todo: n => `Send ${n} a friendly reminder` },
  { key: 'received', label: 'Received', todo: n => `Check if ${n}'s letter came in` },
  { key: 'thanks', label: 'Thanked', todo: n => `Send ${n} a thank-you note` },
];

let peopleUI = { addRec: false, addOut: false, addJob: false };

function outreachUnlocked() {
  return data.projects.p1.done || data.settings.outreachEarly;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// What's the next thing to do for this recommender, and when is it due?
function recNext(r) {
  const s = r.steps;
  if (r.declined) return null;
  if (!s.ask) return { key: 'ask', due: dateKey() };
  if (!s.materials) return { key: 'materials', due: s.ask };
  if (!s.received) {
    if (!s.reminder) return { key: 'reminder', due: addDays(s.materials, REMINDER_DAYS) };
    return { key: 'received', due: null }; // just waiting on them
  }
  if (!s.thanks) return { key: 'thanks', due: s.received };
  return null;
}

function recsReceived() {
  return data.recs.filter(r => r.steps.received).length;
}

function addRec(name, role, neededBy) {
  name = name.trim();
  if (!name) return toast('Add a name first');
  data.recs.push({ id: newId(), name, role: role.trim(), neededBy, steps: {}, declined: false });
  peopleUI.addRec = false;
  save();
  render();
}

function completeRecStep(id, key) {
  const r = data.recs.find(r => r.id === id);
  if (!r || r.steps[key]) return;
  const step = REC_STEPS.find(s => s.key === key);
  r.steps[key] = dateKey();
  addPoints(REC_POINTS);
  data.log.push({ date: dateKey(), id: `rec-${r.id}-${key}`, type: 'Rec letters', title: `${step.label}: ${r.name}`, points: REC_POINTS });
  toast(`+${REC_POINTS} ⭐`);
  if (key === 'received' && recsReceived() === REC_GOAL) {
    celebrate();
    setTimeout(() => toast(`🎉 ${REC_GOAL}/${REC_GOAL} letters!`), 1400);
  }
  save();
  render();
}

function undoRecStep(id) {
  const r = data.recs.find(r => r.id === id);
  if (!r) return;
  const last = [...REC_STEPS].reverse().find(s => r.steps[s.key]);
  if (!last) return;
  delete r.steps[last.key];
  addPoints(-REC_POINTS);
  const i = data.log.findLastIndex(l => l.id === `rec-${r.id}-${last.key}`);
  if (i >= 0) data.log.splice(i, 1);
  save();
  render();
}

function removeLogsWithPrefix(prefix) {
  let pts = 0;
  data.log = data.log.filter(l => {
    if (l.id.startsWith(prefix)) { pts += l.points; return false; }
    return true;
  });
  return pts;
}

function deleteRec(id) {
  const r = data.recs.find(r => r.id === id);
  if (!r || !confirm(`Remove ${r.name}? Points from their steps come off too.`)) return;
  addPoints(-removeLogsWithPrefix(`rec-${r.id}-`));
  data.recs = data.recs.filter(x => x.id !== id);
  save();
  render();
}

function toggleDeclined(id) {
  const r = data.recs.find(r => r.id === id);
  if (!r) return;
  r.declined = !r.declined;
  save();
  render();
}

// ---- outreach ----
function lastContact(o) {
  return o.followUps.length ? o.followUps[o.followUps.length - 1] : o.date;
}

// Urgency label for following up with someone who hasn't replied
function followUpInfo(o) {
  if (o.status !== 'Sent') return null;
  const due = addDays(lastContact(o), FOLLOWUP_DAYS);
  const d = daysBetween(dateKey(), due);
  if (o.followUps.length >= MAX_FOLLOWUPS) {
    return d <= 0 ? { urgency: 'maxed', label: 'Followed up twice. Mark as No reply?', due } : null;
  }
  if (d > 0) return { urgency: 'later', label: `Follow up in ${d} day${d === 1 ? '' : 's'}`, due };
  if (d === 0) return { urgency: 'today', label: 'Follow up today', due };
  return { urgency: 'overdue', label: `Follow-up overdue by ${-d} day${d === -1 ? '' : 's'}`, due };
}

function addOutreach(f) {
  const name = f.name.trim();
  if (!name) return toast('Add a name first');
  const o = { id: newId(), name, org: f.org.trim(), role: f.role.trim(), channel: f.channel, date: dateKey(), status: 'Sent', followUps: [], replied: false, notes: f.notes.trim() };
  data.outreach.push(o);

  // logging someone checks off today's outreach task if there is one
  const day = todayData();
  const task = day.tasks.find(t => t.id === 'outreach');
  const pts = task && !task.done ? task.points : OUTREACH_POINTS;
  if (task && !task.done) task.done = true;
  addPoints(pts);
  data.log.push({ date: dateKey(), id: `out-${o.id}-sent`, type: 'Outreach', title: `Reached out: ${o.name}`, points: pts });
  updateDayComplete(day);

  peopleUI.addOut = false;
  toast(`+${pts} ⭐ Nice, that's the hard part`);
  save();
  render();
}

function logFollowUp(id) {
  const o = data.outreach.find(o => o.id === id);
  if (!o || o.followUps.length >= MAX_FOLLOWUPS) return;
  o.followUps.push(dateKey());
  addPoints(FOLLOWUP_POINTS);
  data.log.push({ date: dateKey(), id: `out-${o.id}-fu${o.followUps.length}`, type: 'Outreach', title: `Followed up: ${o.name}`, points: FOLLOWUP_POINTS });
  toast(`+${FOLLOWUP_POINTS} ⭐`);
  save();
  render();
}

function setOutreachStatus(id, status) {
  const o = data.outreach.find(o => o.id === id);
  if (!o) return;
  o.status = status;
  if ((status === 'Replied' || status === 'Call set') && !o.replied) {
    o.replied = true;
    addPoints(REPLY_POINTS);
    data.log.push({ date: dateKey(), id: `out-${o.id}-reply`, type: 'Outreach', title: `Got a reply: ${o.name}`, points: REPLY_POINTS });
    celebrate();
    toast(`📬 Reply! +${REPLY_POINTS} ⭐`);
  }
  save();
  render();
}

function deleteOutreach(id) {
  const o = data.outreach.find(o => o.id === id);
  if (!o || !confirm(`Remove ${o.name} from your log? Points for them come off too.`)) return;
  addPoints(-removeLogsWithPrefix(`out-${o.id}-`));
  data.outreach = data.outreach.filter(x => x.id !== id);
  // if they were today's outreach and nobody else was logged today, uncheck the task too
  const day = todayData();
  const task = day.tasks.find(t => t.id === 'outreach');
  if (task && task.done && o.date === dateKey() && !data.outreach.some(x => x.date === dateKey())) {
    task.done = false;
    updateDayComplete(day);
  }
  save();
  render();
}

// Everything in People that needs doing today (shown on the Today tab too)
function peopleDue() {
  const today = dateKey();
  const items = [];
  data.recs.forEach(r => {
    const next = recNext(r);
    if (next && next.due && next.due <= today) {
      const step = REC_STEPS.find(s => s.key === next.key);
      items.push({ kind: 'Rec letters', text: step.todo(r.name), overdue: next.key === 'reminder' && next.due < today });
    }
  });
  if (data.settings.jobsEnabled) {
    data.jobs.forEach(j => {
      if (['Applied', 'Interview'].includes(j.status) && j.followUp && j.followUp <= today) {
        items.push({ kind: 'Jobs', text: `Follow up on ${j.role || 'your application'} at ${j.company}`, overdue: j.followUp < today });
      }
    });
  }
  if (outreachUnlocked()) {
    data.outreach.forEach(o => {
      const f = followUpInfo(o);
      if (f && f.urgency !== 'later') {
        items.push({ kind: 'Outreach', text: f.urgency === 'maxed' ? `${o.name}: ${f.label}` : `Follow up with ${o.name}`, overdue: f.urgency === 'overdue' });
      }
    });
  }
  return items;
}

function fmtDate(key) {
  return key ? parseKey(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
}

function renderRecCard(r) {
  const next = recNext(r);
  const today = dateKey();
  const dots = REC_STEPS.map(s => `
    <div class="step ${r.steps[s.key] ? 'done' : ''} ${next && next.key === s.key ? 'current' : ''}">
      <div class="step-dot">${r.steps[s.key] ? '✓' : ''}</div>
      <div class="step-lbl">${s.label}</div>
    </div>`).join('');

  let actions = '';
  if (r.declined) {
    actions = `<p class="note">Said no or couldn't do it. No worries, it happens.</p>`;
  } else if (next) {
    const step = REC_STEPS.find(s => s.key === next.key);
    let hint = '';
    if (next.key === 'reminder') {
      const d = daysBetween(today, next.due);
      hint = d > 0 ? `Reminder suggested in ${d} day${d === 1 ? '' : 's'} (${fmtDate(next.due)})` : 'Time for a friendly reminder';
    }
    if (next.key === 'received') hint = 'Waiting on their letter';
    actions = `
      ${hint ? `<p class="note">${hint}</p>` : ''}
      <div class="row wrap">
        ${next.key !== 'received' ? `<button class="btn small" data-rec-step="${r.id}" data-key="${next.key}">${escapeHtml(step.label === 'Reminder' ? 'Sent reminder' : step.label === 'Sent info' ? 'Sent my info' : step.label)} +${REC_POINTS}</button>` : ''}
        ${(next.key === 'reminder' || next.key === 'received') ? `<button class="btn small gold" data-rec-step="${r.id}" data-key="received">Letter received +${REC_POINTS}</button>` : ''}
      </div>`;
  } else {
    actions = `<p class="note">✅ All done. Letter in, thank-you sent.</p>`;
  }

  return `
    <div class="card person ${r.declined ? 'faded' : ''}">
      <div class="person-top">
        <div>
          <b>${escapeHtml(r.name)}</b>
          <div class="note" style="margin:2px 0 0">${escapeHtml(r.role || '')}${r.neededBy ? `${r.role ? ' · ' : ''}needed by ${fmtDate(r.neededBy)}` : ''}</div>
        </div>
        <details class="menu"><summary aria-label="More">⋯</summary>
          <div class="menu-list">
            <button data-rec-undo="${r.id}">Undo last step</button>
            <button data-rec-decline="${r.id}">${r.declined ? 'Mark active again' : 'They said no'}</button>
            <button class="danger" data-rec-del="${r.id}">Remove</button>
          </div>
        </details>
      </div>
      <div class="steps">${dots}</div>
      ${actions}
    </div>`;
}

function renderOutreachCard(o) {
  const f = followUpInfo(o);
  const statusOpts = OUTREACH_STATUSES.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('');
  return `
    <div class="card person">
      <div class="person-top">
        <div>
          <b>${escapeHtml(o.name)}</b>
          <div class="note" style="margin:2px 0 0">${escapeHtml([o.role, o.org].filter(Boolean).join(' · '))}</div>
          <div class="note" style="margin:2px 0 0">${escapeHtml(o.channel)} · ${fmtDate(o.date)}${o.followUps.length ? ` · ${o.followUps.length} follow-up${o.followUps.length === 1 ? '' : 's'}` : ''}</div>
        </div>
        <details class="menu"><summary aria-label="More">⋯</summary>
          <div class="menu-list"><button class="danger" data-out-del="${o.id}">Remove</button></div>
        </details>
      </div>
      ${o.notes ? `<p class="person-notes">${escapeHtml(o.notes)}</p>` : ''}
      ${f ? `<div class="badge ${f.urgency}">${f.label}</div>` : ''}
      <div class="row wrap" style="margin-top:10px">
        <select data-out-status="${o.id}" aria-label="Status">${statusOpts}</select>
        ${o.status === 'Sent' && o.followUps.length < MAX_FOLLOWUPS ? `<button class="btn small purple" data-out-fu="${o.id}">Followed up +${FOLLOWUP_POINTS}</button>` : ''}
      </div>
    </div>`;
}

function renderPeople() {
  const received = recsReceived();
  const activeRecs = data.recs.filter(r => !r.declined);
  const unlocked = outreachUnlocked();

  // outreach sorted so the most urgent follow-ups come first
  const rank = { overdue: 0, maxed: 1, today: 2, later: 3 };
  const outs = [...data.outreach].sort((a, b) => {
    const fa = followUpInfo(a), fb = followUpInfo(b);
    const ra = fa ? rank[fa.urgency] : 4, rb = fb ? rank[fb.urgency] : 4;
    return ra - rb || b.date.localeCompare(a.date);
  });
  const sent = data.outreach.length;
  const replied = data.outreach.filter(o => o.replied).length;

  const recForm = peopleUI.addRec ? `
    <form class="card form" id="recForm">
      <input type="text" name="name" placeholder="Name" maxlength="60" required>
      <input type="text" name="role" placeholder="Who they are (e.g., professor, internship boss)" maxlength="80">
      <label class="note">Needed by (optional)</label>
      <input type="date" name="neededBy">
      <div class="row"><button class="btn" type="submit">Add</button><button class="btn ghost" type="button" id="recCancel">Cancel</button></div>
    </form>` : `<button class="btn ghost-green full" id="recAdd">+ Add a recommender</button>`;

  const outForm = peopleUI.addOut ? `
    <form class="card form" id="outForm">
      <input type="text" name="name" placeholder="Name" maxlength="60" required>
      <input type="text" name="org" placeholder="Team or organization" maxlength="80">
      <input type="text" name="role" placeholder="Their role (e.g., Director of Sports Science)" maxlength="80">
      <select name="channel"><option>Email</option><option>LinkedIn</option><option>In person</option><option>Other</option></select>
      <textarea name="notes" placeholder="Notes: what you asked, who referred you" maxlength="300" rows="2"></textarea>
      <div class="row"><button class="btn" type="submit">Log it</button><button class="btn ghost" type="button" id="outCancel">Cancel</button></div>
    </form>` : `<button class="btn full" id="outAdd">+ Log someone I reached out to</button>`;

  view.innerHTML = `
    <h1>People</h1>
    <p class="sub">Letters of rec and the people you reach out to.</p>

    <h2>Letters of rec</h2>
    <div class="card">
      <div class="day-progress"><span>${received} / ${REC_GOAL} letters received</span><span>${activeRecs.length} asked or planned</span></div>
      <div class="bar"><div style="width:${Math.min(100, (received / REC_GOAL) * 100)}%"></div></div>
      ${activeRecs.length < REC_GOAL ? `<p class="note">Most jobs want ${REC_GOAL}. Add ${REC_GOAL - activeRecs.length} more ${REC_GOAL - activeRecs.length === 1 ? 'person' : 'people'}.</p>` : ''}
    </div>
    ${data.recs.map(renderRecCard).join('')}
    ${recForm}

    <h2>Outreach</h2>
    ${unlocked ? `
      <div class="stats">
        <div class="card stat"><div class="num" style="color:var(--green)">${sent}</div><div class="lbl">Reached out</div></div>
        <div class="card stat"><div class="num" style="color:var(--purple)">${sent ? Math.round((replied / sent) * 100) + '%' : '–'}</div><div class="lbl">Reply rate (${replied})</div></div>
      </div>
      ${outForm}
      <div style="margin-top:12px">${outs.map(renderOutreachCard).join('')}</div>
      <p class="note">Follow up after ${FOLLOWUP_DAYS} days with no reply, max ${MAX_FOLLOWUPS} times.</p>
    ` : `
      <div class="card coming">
        <div class="emoji">🔒</div>
        <b>Unlocks when Project 1 is done</b>
        <p class="note">Reach out with real work to show. Finish the force plate project first, then this opens up with 3 outreach days a week.</p>
        <button class="btn ghost-green" id="unlockEarly">Unlock early anyway</button>
      </div>`}
    ${data.settings.jobsEnabled ? renderJobsSection() : ''}
  `;

  const on = (sel, ev, fn) => view.querySelectorAll(sel).forEach(el => el.addEventListener(ev, () => fn(el)));
  on('[data-rec-step]', 'click', el => completeRecStep(el.dataset.recStep, el.dataset.key));
  on('[data-rec-undo]', 'click', el => undoRecStep(el.dataset.recUndo));
  on('[data-rec-decline]', 'click', el => toggleDeclined(el.dataset.recDecline));
  on('[data-rec-del]', 'click', el => deleteRec(el.dataset.recDel));
  on('[data-out-fu]', 'click', el => logFollowUp(el.dataset.outFu));
  on('[data-out-status]', 'change', el => setOutreachStatus(el.dataset.outStatus, el.value));
  on('[data-out-del]', 'click', el => deleteOutreach(el.dataset.outDel));
  on('#recAdd', 'click', () => { peopleUI.addRec = true; render(); });
  on('#recCancel', 'click', () => { peopleUI.addRec = false; render(); });
  on('#outAdd', 'click', () => { peopleUI.addOut = true; render(); });
  on('#outCancel', 'click', () => { peopleUI.addOut = false; render(); });
  on('#unlockEarly', 'click', () => {
    if (!confirm('Unlock outreach before Project 1 is done?')) return;
    data.settings.outreachEarly = true;
    save();
    render();
  });

  on('#jobAdd', 'click', () => { peopleUI.addJob = true; render(); });
  on('#jobCancel', 'click', () => { peopleUI.addJob = false; render(); });
  on('[data-job-status]', 'change', el => setJobStatus(el.dataset.jobStatus, el.value));
  on('[data-job-fu]', 'click', el => jobFollowedUp(el.dataset.jobFu));
  on('[data-job-del]', 'click', el => deleteJob(el.dataset.jobDel));
  const jobForm_ = document.getElementById('jobForm');
  if (jobForm_) jobForm_.addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(jobForm_);
    addJob({ company: f.get('company'), role: f.get('role'), link: f.get('link'), contact: f.get('contact'), notes: f.get('notes') });
  });

  const recForm_ = document.getElementById('recForm');
  if (recForm_) recForm_.addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(recForm_);
    addRec(f.get('name'), f.get('role'), f.get('neededBy'));
  });
  const outForm_ = document.getElementById('outForm');
  if (outForm_) outForm_.addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(outForm_);
    addOutreach({ name: f.get('name'), org: f.get('org'), role: f.get('role'), channel: f.get('channel'), notes: f.get('notes') });
  });
}

// ---------- projects: timer, hours, milestones ----------
const TASK_MINUTES = 20;        // minutes in a day that check off the project task
const EXTRA_SESSION_POINTS = 5; // extra 10+ min sessions after the task is done
const MILESTONE_POINTS = 15;
const SHIP_POINTS = 50;
const TIMER_CHOICES = [10, 20, 30, 45];
const NEXT_PROJECT_DAYS = 28;   // default target for the next project

// The portfolio plan from CLAUDE.md, in order
const PROJECTS = [
  {
    id: 'p1', short: 'Project 1', name: 'Force plate jump monitoring', tag: 'force plate jumps',
    milestones: [
      { id: 'gen', text: 'Synthetic data generator (athletes, season, fatigue, missing days)' },
      { id: 'metrics', text: 'Jump height, RSI-modified, and L/R asymmetry' },
      { id: 'flags', text: 'Baselines + flags when an athlete drops below their own normal' },
      { id: 'team', text: 'Team view' },
      { id: 'athlete', text: 'Single-athlete view' },
      { id: 'readme', text: 'README: question, method, what a coach would do with it' },
      { id: 'polish', text: 'Final check + screenshots' },
    ],
  },
  {
    id: 'p2', short: 'Project 2', name: 'Training load dashboard', tag: 'training load',
    milestones: [
      { id: 'gen', text: 'Generate GPS distance, high-speed running, and session RPE data' },
      { id: 'weekly', text: 'Weekly load and week-to-week change' },
      { id: 'acwr', text: 'Acute:chronic ratio, framed as a conversation starter' },
      { id: 'dash', text: 'Dashboard views' },
      { id: 'readme', text: 'README' },
      { id: 'polish', text: 'Final check + screenshots' },
    ],
  },
  {
    id: 'p3', short: 'Project 3', name: 'Daily readiness report', tag: 'readiness report',
    milestones: [
      { id: 'gen', text: 'Generate wellness survey data (sleep, soreness, stress)' },
      { id: 'combine', text: 'Combine wellness with jump data' },
      { id: 'report', text: 'One-page coach report' },
      { id: 'readme', text: 'README' },
      { id: 'polish', text: 'Final check + screenshots' },
    ],
  },
];

let timerInterval = null;
let manualOpen = false;

function activeProject() {
  return PROJECTS.find(p => !data.projects[p.id].done) || null;
}

function projectTaskTitle(def) {
  return `Work ${TASK_MINUTES} min on ${def.short} (${def.tag})`;
}

function minutesOn(pid, fromKey, toKey = dateKey()) {
  return data.projects[pid].sessions
    .filter(s => s.date >= fromKey && s.date <= toKey)
    .reduce((a, s) => a + s.minutes, 0);
}

function totalMinutes(pid) {
  return data.projects[pid].sessions.reduce((a, s) => a + s.minutes, 0);
}

function fmtHours(min) {
  if (min < 60) return `${min}m`;
  const h = min / 60;
  return `${h.toFixed(h < 10 ? 1 : 0)}h`;
}

// Save a block of work. 20 min in a day checks off the project task.
function logSession(pid, minutes, fromTimer) {
  const today = dateKey();
  const p = data.projects[pid];
  const def = PROJECTS.find(d => d.id === pid);
  p.sessions.push({ date: today, minutes });

  const day = todayData();
  const task = day.tasks.find(t => t.id === 'project');
  const active = activeProject();
  const counts = task && !task.done && active && active.id === pid;
  let pts = 0;

  if (counts && minutesOn(pid, today) >= TASK_MINUTES) {
    task.done = true;
    pts = task.points;
    data.log.push({ date: today, id: 'project', type: task.type, title: task.title, points: pts });
  } else if (!counts && minutes >= 10) {
    pts = EXTRA_SESSION_POINTS;
    data.log.push({ date: today, id: `proj-${pid}-${Date.now()}`, type: 'Project', title: `Extra ${minutes} min on ${def.short}`, points: pts });
  }
  if (pts) addPoints(pts);
  updateDayComplete(day);
  save();

  if (fromTimer) celebrate();
  const left = counts && !task.done ? TASK_MINUTES - minutesOn(pid, today) : 0;
  toast(`⏱️ ${minutes} min logged${pts ? ` +${pts} ⭐` : left > 0 ? ` · ${left} more for today` : ''}`);
  render();
}

function timerLeftMs() {
  const t = data.timer;
  if (!t) return 0;
  return t.endAt ? Math.max(0, t.endAt - Date.now()) : t.pausedLeft;
}

// Uses an end time instead of counting down, so it stays right even if the phone sleeps
function startTimer(minutes) {
  const active = activeProject();
  if (!active) return;
  data.timer = { projectId: active.id, minutes, endAt: Date.now() + minutes * 60000 };
  save();
  ensureTick();
  render();
}

function pauseTimer() {
  const t = data.timer;
  if (!t || !t.endAt) return;
  t.pausedLeft = timerLeftMs();
  delete t.endAt;
  save();
  render();
}

function resumeTimer() {
  const t = data.timer;
  if (!t || t.endAt) return;
  t.endAt = Date.now() + t.pausedLeft;
  delete t.pausedLeft;
  save();
  ensureTick();
  render();
}

function stopTimer() {
  const t = data.timer;
  if (!t) return;
  const worked = Math.floor((t.minutes * 60000 - timerLeftMs()) / 60000);
  data.timer = null;
  save();
  if (worked >= 1) logSession(t.projectId, worked, false);
  else { toast('Under 1 min, nothing logged'); render(); }
}

function cancelTimer() {
  if (!confirm('Cancel this timer without logging any time?')) return;
  data.timer = null;
  save();
  render();
}

// Called every second and whenever the app opens: finish the session if time is up
function checkTimer() {
  const t = data.timer;
  if (t && t.endAt && Date.now() >= t.endAt) {
    data.timer = null;
    logSession(t.projectId, t.minutes, true);
  }
}

function ensureTick() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (!data.timer) {
      clearInterval(timerInterval);
      timerInterval = null;
      return;
    }
    checkTimer();
    updateTimerDisplay();
  }, 1000);
}

function fmtClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const RING = 2 * Math.PI * 54;

function updateTimerDisplay() {
  const t = data.timer;
  const text = document.getElementById('timerText');
  const ring = document.getElementById('timerRing');
  if (!t || !text || !ring) return;
  const left = timerLeftMs();
  text.textContent = fmtClock(left);
  ring.style.strokeDashoffset = RING * (1 - left / (t.minutes * 60000));
}

function toggleMilestone(pid, mid) {
  const p = data.projects[pid];
  const def = PROJECTS.find(d => d.id === pid);
  const m = def.milestones.find(m => m.id === mid);
  if (p.milestones[mid]) {
    delete p.milestones[mid];
    addPoints(-MILESTONE_POINTS);
    const i = data.log.findLastIndex(l => l.id === `ms-${pid}-${mid}`);
    if (i >= 0) data.log.splice(i, 1);
  } else {
    p.milestones[mid] = dateKey();
    addPoints(MILESTONE_POINTS);
    data.log.push({ date: dateKey(), id: `ms-${pid}-${mid}`, type: 'Project', title: `${def.short}: ${m.text}`, points: MILESTONE_POINTS });
    toast(`+${MILESTONE_POINTS} ⭐ Milestone`);
  }
  save();
  render();
}

// Today's unfinished project task follows whichever project is active
function syncProjectTask() {
  const day = todayData();
  const task = day.tasks.find(t => t.id === 'project');
  if (!task || task.done) return;
  const active = activeProject();
  if (active) task.title = projectTaskTitle(active);
  else day.tasks = day.tasks.filter(t => t !== task);
  updateDayComplete(day);
}

function markProjectDone(pid) {
  const def = PROJECTS.find(d => d.id === pid);
  const p = data.projects[pid];
  const msLeft = def.milestones.filter(m => !p.milestones[m.id]).length;
  const warn = msLeft ? `\n\n${msLeft} milestone${msLeft === 1 ? ' is' : 's are'} still unchecked.` : '';
  if (!confirm(`Mark ${def.short} as shipped?${warn}`)) return;

  p.done = true;
  p.doneDate = dateKey();
  if (data.timer && data.timer.projectId === pid) data.timer = null;
  addPoints(SHIP_POINTS);
  data.log.push({ date: dateKey(), id: `done-${pid}`, type: 'Project', title: `Shipped ${def.short}: ${def.name}`, points: SHIP_POINTS });

  const next = activeProject();
  if (next) {
    const np = data.projects[next.id];
    if (!np.start) np.start = dateKey();
    if (!np.target) np.target = addDays(dateKey(), NEXT_PROJECT_DAYS);
  }
  syncProjectTask();
  save();
  celebrate();
  toast(pid === 'p1' ? '🚀 Project 1 shipped! Outreach unlocked' : `🚀 ${def.short} shipped!`);
  render();
}

function undoProjectDone(pid) {
  const def = PROJECTS.find(d => d.id === pid);
  if (!confirm(`Mark ${def.short} as not done?`)) return;
  data.projects[pid].done = false;
  data.projects[pid].doneDate = null;
  addPoints(-removeLogsWithPrefix(`done-${pid}`));
  syncProjectTask();
  save();
  render();
}

function paceInfo(def) {
  const p = data.projects[def.id];
  if (!p.target || !p.start) return null;
  const today = dateKey();
  const left = daysBetween(today, p.target);
  if (left < 0) return { cls: 'overdue', label: `${-left} day${left === -1 ? '' : 's'} past target` };
  const total = Math.max(1, daysBetween(p.start, p.target));
  const elapsed = Math.min(total, Math.max(0, daysBetween(p.start, today)));
  const done = def.milestones.filter(m => p.milestones[m.id]).length;
  const expected = (elapsed / total) * def.milestones.length;
  if (done + 0.5 >= expected) return { cls: 'later', label: `On pace ✓ · ${left} day${left === 1 ? '' : 's'} left` };
  const behind = Math.ceil(expected - done);
  return { cls: 'today', label: `About ${behind} milestone${behind === 1 ? '' : 's'} behind · ${left} day${left === 1 ? '' : 's'} left` };
}

function renderTimer(def) {
  const t = data.timer && data.timer.projectId === def.id ? data.timer : null;
  const todayMin = minutesOn(def.id, dateKey());
  const task = todayData().tasks.find(x => x.id === 'project');
  const taskLine = task && task.done
    ? `✅ Today's ${TASK_MINUTES} min done (${todayMin} min today)`
    : `${todayMin} / ${TASK_MINUTES} min today`;

  if (!t) {
    return `
      <div class="card timer-card">
        <div class="timer-ring idle"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" class="track"/></svg><div class="timer-text">⏱️</div></div>
        <p class="timer-sub">${taskLine}</p>
        <div class="row wrap center">
          ${TIMER_CHOICES.map(m => `<button class="btn ${m === TASK_MINUTES ? '' : 'purple'} small" data-start="${m}">${m} min</button>`).join('')}
        </div>
        <button class="link" id="manualToggle">${manualOpen ? 'Hide' : 'Worked without the timer? Log time'}</button>
        ${manualOpen ? `
          <form class="row" id="manualForm" style="margin-top:8px">
            <input type="number" id="manualMin" min="1" max="180" placeholder="Minutes" inputmode="numeric">
            <button class="btn" type="submit">Log</button>
          </form>` : ''}
      </div>`;
  }
  const left = timerLeftMs();
  const running = !!t.endAt;
  return `
    <div class="card timer-card">
      <div class="timer-ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="54" class="track"/>
          <circle cx="60" cy="60" r="54" class="fill" id="timerRing" style="stroke-dasharray:${RING};stroke-dashoffset:${RING * (1 - left / (t.minutes * 60000))}"/>
        </svg>
        <div class="timer-text" id="timerText">${fmtClock(left)}</div>
      </div>
      <p class="timer-sub">${running ? `${t.minutes} min session · stay off your phone 📵` : 'Paused'}</p>
      <div class="row wrap center">
        ${running ? '<button class="btn purple" id="pauseBtn">Pause</button>' : '<button class="btn" id="resumeBtn">Resume</button>'}
        <button class="btn gold" id="stopBtn">Stop + log</button>
      </div>
      <button class="link danger" id="cancelBtn">Cancel without logging</button>
      <p class="note">It keeps counting if you lock your phone. Open the app when it's done to collect your points.</p>
    </div>`;
}

function renderProjects() {
  const active = activeProject();
  const today = dateKey();

  let main = '';
  if (active) {
    const p = data.projects[active.id];
    const pace = paceInfo(active);
    const msDone = active.milestones.filter(m => p.milestones[m.id]).length;
    const total = totalMinutes(active.id);
    const week = minutesOn(active.id, weekKey());
    const recent = [...p.sessions].reverse().slice(0, 5);

    main = `
      <div class="card lesson-card applied">
        <div class="chip">${active.short} · Active</div>
        <h2 style="margin-top:8px">${escapeHtml(active.name)}</h2>
        <div class="setting" style="margin:10px 0 0">
          <label for="targetDate">Target date</label>
          <input type="date" id="targetDate" value="${p.target || ''}" style="flex:none">
        </div>
        ${pace ? `<div class="badge ${pace.cls}">${pace.label}</div>` : ''}
      </div>

      ${renderTimer(active)}

      <div class="stats three">
        <div class="card stat"><div class="num" style="color:var(--purple)">${fmtHours(total)}</div><div class="lbl">Total</div></div>
        <div class="card stat"><div class="num" style="color:var(--green)">${fmtHours(week)}</div><div class="lbl">This week</div></div>
        <div class="card stat"><div class="num" style="color:var(--blue)">${p.sessions.length}</div><div class="lbl">Sessions</div></div>
      </div>

      <h2>Milestones · ${msDone}/${active.milestones.length}</h2>
      <div class="card">
        <div class="bar" style="margin-bottom:12px"><div style="width:${(msDone / active.milestones.length) * 100}%"></div></div>
        ${active.milestones.map(m => `
          <button class="milestone ${p.milestones[m.id] ? 'done' : ''}" data-ms="${m.id}">
            <span class="check small">${p.milestones[m.id] ? '✓' : ''}</span>
            <span>${escapeHtml(m.text)}</span>
            <span class="t-pts">+${MILESTONE_POINTS}</span>
          </button>`).join('')}
      </div>

      <button class="btn gold full" id="shipBtn">🚀 Mark ${active.short} shipped (+${SHIP_POINTS})</button>
      <p class="note">${active.id === 'p1' ? 'Shipping Project 1 unlocks outreach in People and starts Project 2.' : 'Shipping starts the next project.'}</p>

      ${recent.length ? `
        <h2>Recent sessions</h2>
        <div class="card">
          ${recent.map(s => `<div class="session-row"><span>${fmtDate(s.date)}${s.date === today ? ' (today)' : ''}</span><b>${s.minutes} min</b></div>`).join('')}
        </div>` : ''}
    `;
  } else {
    main = `<div class="card coming"><div class="emoji">🏆</div><h1>All 3 shipped</h1><p class="sub">Next up from the plan: the end-of-season review deck.</p></div>`;
  }

  const others = PROJECTS.filter(d => !active || d.id !== active.id).map(d => {
    const p = data.projects[d.id];
    const status = p.done ? `✅ Shipped ${fmtDate(p.doneDate)} · ${fmtHours(totalMinutes(d.id))}` : 'Up next';
    return `
      <div class="card person ${p.done ? '' : 'faded'}">
        <div class="person-top">
          <div><b>${d.short}: ${escapeHtml(d.name)}</b><div class="note" style="margin:2px 0 0">${status}</div></div>
          ${p.done ? `<details class="menu"><summary aria-label="More">⋯</summary><div class="menu-list"><button data-undo-ship="${d.id}">Mark not done</button></div></details>` : ''}
        </div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <h1>Projects</h1>
    <p class="sub">Portfolio work, ${TASK_MINUTES} minutes at a time.</p>
    ${main}
    <h2>All projects</h2>
    ${others}
  `;

  const on = (sel, ev, fn) => view.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(el, e)));
  on('[data-start]', 'click', el => startTimer(Number(el.dataset.start)));
  on('#pauseBtn', 'click', pauseTimer);
  on('#resumeBtn', 'click', resumeTimer);
  on('#stopBtn', 'click', stopTimer);
  on('#cancelBtn', 'click', cancelTimer);
  on('#manualToggle', 'click', () => { manualOpen = !manualOpen; render(); });
  on('#manualForm', 'submit', (el, e) => {
    e.preventDefault();
    const m = Math.round(Number(document.getElementById('manualMin').value));
    if (!m || m < 1 || m > 180) return toast('Enter 1-180 minutes');
    manualOpen = false;
    logSession(active.id, m, false);
  });
  on('[data-ms]', 'click', el => toggleMilestone(active.id, el.dataset.ms));
  on('#shipBtn', 'click', () => markProjectDone(active.id));
  on('[data-undo-ship]', 'click', el => undoProjectDone(el.dataset.undoShip));
  on('#targetDate', 'change', el => {
    if (!el.value) return;
    data.projects[active.id].target = el.value;
    save();
    toast('Target date saved');
    render();
  });
  if (data.timer) ensureTick();
}

// ---------- jobs applied ----------
const JOB_STATUSES = ['Applied', 'Interview', 'Offer', 'Rejected', 'Withdrawn'];
const JOB_POINTS = 15;
const JOB_FOLLOWUP_POINTS = 5;
const INTERVIEW_POINTS = 25;
const OFFER_POINTS = 100;
const JOB_FOLLOWUP_DAYS = 7;

// Only allow real web links, so a pasted link can't run code
function safeLink(url) {
  try {
    const u = new URL(String(url).trim());
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch (e) {
    return null;
  }
}

function addJob(f) {
  const company = f.company.trim();
  if (!company) return toast('Add a company first');
  const j = {
    id: newId(), company, role: f.role.trim(), link: safeLink(f.link) || '', date: dateKey(),
    status: 'Applied', contact: f.contact.trim(), followUp: addDays(dateKey(), JOB_FOLLOWUP_DAYS),
    notes: f.notes.trim(), interview: false, offer: false,
  };
  data.jobs.push(j);
  addPoints(JOB_POINTS);
  data.log.push({ date: dateKey(), id: `job-${j.id}-applied`, type: 'Jobs', title: `Applied: ${j.role ? j.role + ' at ' : ''}${company}`, points: JOB_POINTS });
  peopleUI.addJob = false;
  toast(`+${JOB_POINTS} ⭐ Application logged`);
  save();
  render();
}

function setJobStatus(id, status) {
  const j = data.jobs.find(j => j.id === id);
  if (!j) return;
  j.status = status;
  if (status === 'Interview' && !j.interview) {
    j.interview = true;
    addPoints(INTERVIEW_POINTS);
    data.log.push({ date: dateKey(), id: `job-${j.id}-interview`, type: 'Jobs', title: `Interview: ${j.company}`, points: INTERVIEW_POINTS });
    celebrate();
    toast(`🎤 Interview! +${INTERVIEW_POINTS} ⭐`);
  }
  if (status === 'Offer' && !j.offer) {
    j.offer = true;
    addPoints(OFFER_POINTS);
    data.log.push({ date: dateKey(), id: `job-${j.id}-offer`, type: 'Jobs', title: `Offer: ${j.company}`, points: OFFER_POINTS });
    celebrate();
    setTimeout(celebrate, 900);
    toast(`🏆 OFFER! +${OFFER_POINTS} ⭐`);
  }
  save();
  render();
}

function jobFollowedUp(id) {
  const j = data.jobs.find(j => j.id === id);
  if (!j) return;
  j.followUp = addDays(dateKey(), JOB_FOLLOWUP_DAYS);
  addPoints(JOB_FOLLOWUP_POINTS);
  data.log.push({ date: dateKey(), id: `job-${j.id}-fu${Date.now()}`, type: 'Jobs', title: `Followed up: ${j.company}`, points: JOB_FOLLOWUP_POINTS });
  toast(`+${JOB_FOLLOWUP_POINTS} ⭐ Next nudge in ${JOB_FOLLOWUP_DAYS} days`);
  save();
  render();
}

function deleteJob(id) {
  const j = data.jobs.find(j => j.id === id);
  if (!j || !confirm(`Remove ${j.company}? Points for it come off too.`)) return;
  addPoints(-removeLogsWithPrefix(`job-${j.id}-`));
  data.jobs = data.jobs.filter(x => x.id !== id);
  save();
  render();
}

function renderJobsSection() {
  const open = data.jobs.filter(j => ['Applied', 'Interview'].includes(j.status)).length;
  const interviews = data.jobs.filter(j => j.interview).length;
  const jobs = [...data.jobs].sort((a, b) => b.date.localeCompare(a.date));

  const form = peopleUI.addJob ? `
    <form class="card form" id="jobForm">
      <input type="text" name="company" placeholder="Company or team" maxlength="80" required>
      <input type="text" name="role" placeholder="Role" maxlength="80">
      <input type="url" name="link" placeholder="Link to posting (optional)" maxlength="300">
      <input type="text" name="contact" placeholder="Contact or referral (optional)" maxlength="80">
      <textarea name="notes" placeholder="Notes" maxlength="300" rows="2"></textarea>
      <div class="row"><button class="btn" type="submit">Log it</button><button class="btn ghost" type="button" id="jobCancel">Cancel</button></div>
    </form>` : `<button class="btn full" id="jobAdd">+ Log an application</button>`;

  const cards = jobs.map(j => {
    const link = safeLink(j.link);
    const statusOpts = JOB_STATUSES.map(s => `<option ${s === j.status ? 'selected' : ''}>${s}</option>`).join('');
    let badge = '';
    if (['Applied', 'Interview'].includes(j.status) && j.followUp) {
      const d = daysBetween(dateKey(), j.followUp);
      badge = d > 0 ? `<div class="badge later">Follow up in ${d} day${d === 1 ? '' : 's'}</div>`
        : d === 0 ? '<div class="badge today">Follow up today</div>'
        : `<div class="badge overdue">Follow-up overdue by ${-d} day${d === -1 ? '' : 's'}</div>`;
    }
    return `
      <div class="card person ${['Rejected', 'Withdrawn'].includes(j.status) ? 'faded' : ''}">
        <div class="person-top">
          <div>
            <b>${escapeHtml(j.company)}</b>
            <div class="note" style="margin:2px 0 0">${escapeHtml(j.role || '')}${j.role ? ' · ' : ''}applied ${fmtDate(j.date)}</div>
            ${j.contact ? `<div class="note" style="margin:2px 0 0">Contact: ${escapeHtml(j.contact)}</div>` : ''}
          </div>
          <details class="menu"><summary aria-label="More">⋯</summary>
            <div class="menu-list"><button class="danger" data-job-del="${j.id}">Remove</button></div>
          </details>
        </div>
        ${j.notes ? `<p class="person-notes">${escapeHtml(j.notes)}</p>` : ''}
        ${link ? `<a class="link-out" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ''}
        ${badge}
        <div class="row wrap" style="margin-top:10px">
          <select data-job-status="${j.id}" aria-label="Status">${statusOpts}</select>
          ${['Applied', 'Interview'].includes(j.status) ? `<button class="btn small purple" data-job-fu="${j.id}">Followed up +${JOB_FOLLOWUP_POINTS}</button>` : ''}
        </div>
      </div>`;
  }).join('');

  return `
    <h2>Jobs applied</h2>
    <div class="stats three">
      <div class="card stat"><div class="num" style="color:var(--green)">${data.jobs.length}</div><div class="lbl">Applied</div></div>
      <div class="card stat"><div class="num" style="color:var(--blue)">${open}</div><div class="lbl">Still open</div></div>
      <div class="card stat"><div class="num" style="color:var(--purple)">${interviews}</div><div class="lbl">Interviews</div></div>
    </div>
    ${form}
    <div style="margin-top:12px">${cards}</div>
  `;
}

// ---------- weekly check-in ----------
const CHECKIN_POINTS = 25;
const RATINGS = [
  { key: 'sci', label: 'CSCS Scientific confidence' },
  { key: 'app', label: 'CSCS Applied confidence' },
  { key: 'proj', label: 'Project progress' },
  { key: 'job', label: 'Job search confidence' },
  { key: 'energy', label: 'Energy / motivation' },
];
let meState = null; // null = stats screen, 'checkin' = the check-in form

function inWeek(key, wk) {
  return key >= wk && key <= addDays(wk, 6);
}

// Everything that happened Mon-Sun of the week starting wk
function weekSummary(wk) {
  const sessions = data.study.sessions.filter(s => inWeek(s.date, wk));
  const right = sessions.reduce((a, s) => a + s.score, 0);
  const asked = sessions.reduce((a, s) => a + s.total, 0);
  const projectMin = PROJECTS.reduce((a, p) => a + data.projects[p.id].sessions.filter(s => inWeek(s.date, wk)).reduce((b, s) => b + s.minutes, 0), 0);
  return {
    daysDone: Object.entries(data.days).filter(([k, d]) => inWeek(k, wk) && d.complete).length,
    points: data.log.filter(l => inWeek(l.date, wk)).reduce((a, l) => a + l.points, 0),
    streak: data.streak.current,
    lessons: sessions.filter(s => s.kind === 'lesson').length,
    quizPct: asked ? Math.round((right / asked) * 100) : null,
    projectMin,
    outreachSent: data.outreach.filter(o => inWeek(o.date, wk)).length,
    followUps: data.outreach.reduce((a, o) => a + o.followUps.filter(d => inWeek(d, wk)).length, 0),
    replies: data.log.filter(l => l.id.endsWith('-reply') && inWeek(l.date, wk)).length,
    recsReceived: recsReceived(),
    jobsApplied: data.jobs.filter(j => inWeek(j.date, wk)).length,
  };
}

function lastCheckin() {
  const keys = Object.keys(data.checkins).sort();
  return keys.length ? { wk: keys[keys.length - 1], ...data.checkins[keys[keys.length - 1]] } : null;
}

// Goals from the most recent check-in, shown on Today for the following week
function currentGoals() {
  const c = lastCheckin();
  if (!c || !c.goals.length || daysBetween(c.date, dateKey()) > 8) return null;
  return c;
}

function toggleGoal(wk, i) {
  const c = data.checkins[wk];
  if (!c) return;
  c.goalsDone[i] = !c.goalsDone[i];
  if (c.goalsDone[i]) toast('🎯 Goal done');
  save();
  render();
}

function startCheckin() {
  meState = 'checkin';
  goTab('me');
}

function saveCheckin(form) {
  const wk = weekKey();
  const f = new FormData(form);
  const ratings = {};
  RATINGS.forEach(r => { ratings[r.key] = Number(f.get(r.key)); });
  const goals = [f.get('goal1'), f.get('goal2'), f.get('goal3')].map(g => String(g || '').trim()).filter(Boolean);
  const isNew = !data.checkins[wk];

  data.checkins[wk] = {
    date: dateKey(),
    summary: weekSummary(wk),
    ratings,
    win: String(f.get('win') || '').trim(),
    blocker: String(f.get('blocker') || '').trim(),
    goals,
    goalsDone: goals.map(() => false),
  };

  if (isNew) {
    const day = todayData();
    const task = day.tasks.find(t => t.id === 'checkin');
    const pts = task && !task.done ? task.points : CHECKIN_POINTS;
    if (task) task.done = true;
    addPoints(pts);
    data.log.push({ date: dateKey(), id: `checkin-${wk}`, type: 'Weekly', title: 'Weekly check-in', points: pts });
    updateDayComplete(day);
    celebrate();
    toast(`+${pts} ⭐ Week logged`);
  } else {
    toast('Check-in updated');
  }
  meState = null;
  save();
  goTab('today');
}

function renderCheckin() {
  const wk = weekKey();
  const s = weekSummary(wk);
  const prev = data.checkins[wk] || lastCheckin();
  const tiles = [
    ['Days done', `${s.daysDone}/7`],
    ['Points', s.points],
    ['Lessons', s.lessons],
    ['Quiz', s.quizPct === null ? '–' : s.quizPct + '%'],
    ['Project', fmtHours(s.projectMin)],
    ['Outreach', s.outreachSent],
  ];
  view.innerHTML = `
    <div class="quiz-top"><button class="x" id="quit" aria-label="Close">✕</button><div class="chip">Week of ${fmtDate(wk)}</div></div>
    <h1>Weekly check-in</h1>
    <p class="sub">3 minutes. Be honest, nobody else sees this unless you export it.</p>

    <div class="stats three">
      ${tiles.map(([l, v]) => `<div class="card stat"><div class="num">${v}</div><div class="lbl">${l}</div></div>`).join('')}
    </div>

    <form id="checkinForm">
      <h2>Rate your week (1-10)</h2>
      <div class="card">
        ${RATINGS.map(r => {
          const v = prev && prev.ratings ? prev.ratings[r.key] : 5;
          return `
            <label class="slider">
              <span class="slider-top"><span>${r.label}</span><b id="out-${r.key}">${v}</b></span>
              <input type="range" name="${r.key}" min="1" max="10" step="1" value="${v}" data-out="out-${r.key}">
            </label>`;
        }).join('')}
      </div>

      <h2>Reflect</h2>
      <div class="card form">
        <label class="note" for="win">Biggest win this week</label>
        <textarea id="win" name="win" rows="2" maxlength="300">${data.checkins[wk] ? escapeHtml(data.checkins[wk].win) : ''}</textarea>
        <label class="note" for="blocker">What got in the way?</label>
        <textarea id="blocker" name="blocker" rows="2" maxlength="300">${data.checkins[wk] ? escapeHtml(data.checkins[wk].blocker) : ''}</textarea>
      </div>

      <h2>1-3 goals for next week</h2>
      <div class="card form">
        ${[0, 1, 2].map(i => `<input type="text" name="goal${i + 1}" maxlength="100" placeholder="Goal ${i + 1}${i ? ' (optional)' : ''}" value="${data.checkins[wk] && data.checkins[wk].goals[i] ? escapeHtml(data.checkins[wk].goals[i]) : ''}">`).join('')}
        <p class="note">These show on Today all week.</p>
      </div>

      <button class="btn full" type="submit">${data.checkins[wk] ? 'Update check-in' : `Save check-in (+${CHECKIN_POINTS})`}</button>
    </form>
  `;
  document.getElementById('quit').addEventListener('click', () => { meState = null; render(); });
  view.querySelectorAll('input[type=range]').forEach(el => {
    el.addEventListener('input', () => { document.getElementById(el.dataset.out).textContent = el.value; });
  });
  document.getElementById('checkinForm').addEventListener('submit', e => {
    e.preventDefault();
    saveCheckin(e.target);
  });
}

// ---------- trends (small multiples: one mini line chart per rating) ----------
function miniChart(label, points, max, suffix = '') {
  // points: [{ wk, v }] with v possibly null
  const pts = points.filter(p => p.v !== null && p.v !== undefined);
  if (!pts.length) return '';
  const W = 300, H = 70, PADX = 10, PADY = 8;
  const n = points.length;
  const x = i => n === 1 ? W / 2 : PADX + (i * (W - 2 * PADX)) / (n - 1);
  const y = v => PADY + (1 - v / max) * (H - 2 * PADY);
  const coords = points.map((p, i) => (p.v === null || p.v === undefined) ? null : [x(i), y(p.v), p]);
  const path = coords.filter(Boolean).map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1].v;
  const before = pts.length > 1 ? pts[pts.length - 2].v : null;
  const diff = before === null ? '' : last - before;
  const diffHtml = diff === '' || diff === 0 ? '' : `<span class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}</span>`;

  return `
    <div class="card trend">
      <div class="trend-top"><span>${label}</span><span><b>${last}${suffix}</b> ${diffHtml}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label} by week">
        <line x1="0" x2="${W}" y1="${y(max / 2)}" y2="${y(max / 2)}" class="grid"/>
        ${pts.length > 1 ? `<path d="${path}" class="line"/>` : ''}
        ${coords.filter(Boolean).map(c => `<circle cx="${c[0]}" cy="${c[1]}" r="4.5" class="pt"><title>Week of ${fmtDate(c[2].wk)}: ${c[2].v}${suffix}</title></circle>`).join('')}
      </svg>
      <div class="trend-axis"><span>${fmtDate(points[0].wk)}</span><span>${n > 1 ? fmtDate(points[n - 1].wk) : ''}</span></div>
    </div>`;
}

function renderTrends() {
  const weeks = Object.keys(data.checkins).sort().slice(-12);
  if (!weeks.length) return `<div class="card"><p class="note" style="margin:0">Your trends show up here after your first Sunday check-in.</p></div>`;
  const charts = RATINGS.map(r => miniChart(r.label, weeks.map(wk => ({ wk, v: data.checkins[wk].ratings[r.key] })), 10)).join('');
  const quiz = miniChart('Quiz accuracy', weeks.map(wk => ({ wk, v: data.checkins[wk].summary.quizPct })), 100, '%');
  const table = `
    <details class="card table-wrap"><summary><b>Show as table</b></summary>
      <div class="scroll-x"><table>
        <tr><th>Week of</th>${RATINGS.map(r => `<th>${r.label.replace('CSCS ', '').replace(' confidence', '')}</th>`).join('')}<th>Quiz</th></tr>
        ${weeks.map(wk => { const c = data.checkins[wk]; return `<tr><td>${fmtDate(wk)}</td>${RATINGS.map(r => `<td>${c.ratings[r.key]}</td>`).join('')}<td>${c.summary.quizPct === null ? '–' : c.summary.quizPct + '%'}</td></tr>`; }).join('')}
      </table></div>
    </details>`;
  return charts + quiz + table;
}

// ---------- spreadsheet export (.xlsx built right here, no library needed) ----------
// An .xlsx file is a zip of a few XML files. This writes them and zips them up.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Plain "stored" zip (no compression), which Excel reads fine
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach(f => {
    const name = enc.encode(f.name);
    const body = enc.encode(f.data);
    const crc = crc32(body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x0021, true); // Jan 1 1980
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, 0, true);
    cen.setUint16(14, 0x0021, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, body.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + body.length;
  });
  const cenSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: XLSX_MIME });
}

function xmlEsc(s) {
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Cell helpers: D() marks a "YYYY-MM-DD" string as a real Excel date
const D = key => (key ? { date: key } : '');

function excelSerial(key) {
  const [y, m, d] = key.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

// styles: 0 normal, 1 header, 2 date, 3 wrapped text
function sheetXml(sheet) {
  const { headers, rows, widths } = sheet;
  const all = [headers, ...rows];
  const lastCol = colName(headers.length - 1);
  const cell = (v, r, c, header) => {
    const ref = `${colName(c)}${r + 1}`;
    if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${xmlEsc(v)}</t></is></c>`;
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'object' && v.date) return `<c r="${ref}" s="2"><v>${excelSerial(v.date)}</v></c>`;
    const long = String(v).length > 40;
    return `<c r="${ref}" t="inlineStr"${long ? ' s="3"' : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const rowsXml = all.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c, r === 0)).join('')}</row>`).join('');
  const cols = headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${(widths && widths[i]) || 16}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rowsXml}</sheetData><autoFilter ref="A1:${lastCol}${all.length}"/></worksheet>`;
}

function buildWorkbook(sheets) {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(s.name)}'!$A$1:$${colName(s.headers.length - 1)}$${s.rows.length + 1}</definedName>`).join('')}</definedNames></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="mmm d, yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2333"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return makeZip(files);
}

// One tab per part of the search, ready to share with an advisor
function exportSheets() {
  const info = levelInfo(data.points);
  const recStatus = r => r.declined ? 'Declined' : r.steps.thanks ? 'Done' : r.steps.received ? 'Received' : r.steps.ask ? 'In progress' : 'Not asked yet';
  const totalProjMin = PROJECTS.reduce((a, p) => a + totalMinutes(p.id), 0);

  return [
    {
      name: 'Summary', widths: [32, 22],
      headers: ['Item', 'Value'],
      rows: [
        ['Exported', D(dateKey())],
        ['Level', info.level],
        ['Total points', data.points],
        ['Current streak (days)', data.streak.current],
        ['Best streak (days)', data.streak.best],
        ['Days completed', Object.values(data.days).filter(d => d.complete).length],
        ['CSCS lessons finished', Object.keys(data.study.completed).length],
        ['Weekly check-ins', Object.keys(data.checkins).length],
        ['Letters of rec received', `${recsReceived()} of ${REC_GOAL}`],
        ['People reached out to', data.outreach.length],
        ['Replies', data.outreach.filter(o => o.replied).length],
        ['Jobs applied', data.jobs.length],
        ['Interviews', data.jobs.filter(j => j.interview).length],
        ['Project hours (all)', Math.round((totalProjMin / 60) * 10) / 10],
        ...PROJECTS.map(p => [`${p.short}: ${p.name}`, data.projects[p.id].done ? `Shipped ${fmtDate(data.projects[p.id].doneDate)}` : (activeProject() && activeProject().id === p.id ? 'In progress' : 'Not started')]),
      ],
    },
    {
      name: 'Outreach', widths: [22, 24, 26, 12, 14, 12, 11, 15, 9, 40],
      headers: ['Name', 'Organization', 'Role', 'Channel', 'Date contacted', 'Status', 'Follow-ups', 'Last follow-up', 'Replied', 'Notes'],
      rows: data.outreach.map(o => [o.name, o.org, o.role, o.channel, D(o.date), o.status, o.followUps.length, D(o.followUps[o.followUps.length - 1]), o.replied ? 'Yes' : 'No', o.notes]),
    },
    {
      name: 'Rec Letters', widths: [22, 28, 14, 14, 14, 14, 14, 14, 14],
      headers: ['Name', 'Who they are', 'Needed by', 'Asked', 'Sent info', 'Reminder', 'Received', 'Thanked', 'Status'],
      rows: data.recs.map(r => [r.name, r.role, D(r.neededBy), D(r.steps.ask), D(r.steps.materials), D(r.steps.reminder), D(r.steps.received), D(r.steps.thanks), recStatus(r)]),
    },
    {
      name: 'Jobs Applied', widths: [24, 26, 14, 12, 22, 14, 36, 40],
      headers: ['Company', 'Role', 'Date applied', 'Status', 'Contact', 'Follow up by', 'Link', 'Notes'],
      rows: data.jobs.map(j => [j.company, j.role, D(j.date), j.status, j.contact, ['Applied', 'Interview'].includes(j.status) ? D(j.followUp) : '', j.link, j.notes]),
    },
    {
      name: 'Study Log', widths: [14, 14, 40, 12, 8, 8, 10],
      headers: ['Date', 'Type', 'Lesson', 'Domain', 'Score', 'Out of', 'Percent'],
      rows: data.study.sessions.map(s => [D(s.date), s.kind === 'lesson' ? 'Lesson quiz' : s.kind === 'weekly' ? 'Weekly quiz' : 'Review', s.title, s.domain, s.score, s.total, Math.round((s.score / s.total) * 100)]),
    },
    {
      name: 'Project Hours', widths: [14, 12, 34, 10],
      headers: ['Date', 'Project', 'Name', 'Minutes'],
      rows: PROJECTS.flatMap(p => data.projects[p.id].sessions.map(s => [D(s.date), p.short, p.name, s.minutes]))
        .sort((a, b) => a[0].date.localeCompare(b[0].date)),
    },
    {
      name: 'Weekly Check-ins', widths: [14, 10, 10, 10, 10, 12, 12, 12, 12, 12, 12, 12, 36, 36, 40],
      headers: ['Week of', 'Days done', 'Points', 'Lessons', 'Quiz %', 'Project min', 'Outreach', ...RATINGS.map(r => r.label), 'Biggest win', 'What got in the way', 'Goals for next week'],
      rows: Object.keys(data.checkins).sort().map(wk => {
        const c = data.checkins[wk];
        const s = c.summary;
        return [D(wk), s.daysDone, s.points, s.lessons, s.quizPct === null ? '' : s.quizPct, s.projectMin, s.outreachSent, ...RATINGS.map(r => c.ratings[r.key]), c.win, c.blocker, c.goals.join('; ')];
      }),
    },
    {
      name: 'Task Log', widths: [14, 14, 50, 8],
      headers: ['Date', 'Type', 'What', 'Points'],
      rows: data.log.map(l => [D(l.date), l.type, l.title, l.points]),
    },
  ];
}

async function exportSpreadsheet() {
  const name = `job-search-log-${dateKey()}.xlsx`;
  const blob = buildWorkbook(exportSheets());
  const file = new File([blob], name, { type: XLSX_MIME });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- toast + confetti ----------
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function celebrate() {
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const colors = ['#58cc02', '#ffc800', '#8b5cf6', '#ff4b4b', '#1cb0f6', '#ff9600'];
  const bits = Array.from({ length: 120 }, () => ({
    x: canvas.width / 2,
    y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 14,
    vy: Math.random() * -14 - 4,
    size: Math.random() * 6 + 5,
    color: colors[Math.floor(Math.random() * colors.length)],
    spin: Math.random() * 6,
  }));
  let frame = 0;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    bits.forEach(b => {
      b.vy += 0.45;
      b.x += b.vx;
      b.y += b.vy;
      b.spin += 0.2;
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, b.y, b.size, b.size * Math.abs(Math.sin(b.spin)) + 2);
    });
    if (++frame < 110) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  tick();
}

// ---------- tabs ----------
function render() {
  checkTimer();
  refreshStreak();
  renderHeader();
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  if (currentTab === 'today') renderToday();
  else if (currentTab === 'study') renderStudy();
  else if (currentTab === 'people') renderPeople();
  else if (currentTab === 'projects') renderProjects();
  else if (currentTab === 'me') renderMe();
}

function goTab(tab) {
  if (tab !== 'me' && currentTab === 'me') meState = null; // leaving Me closes the check-in form
  currentTab = tab;
  window.scrollTo(0, 0);
  render();
}

document.querySelectorAll('.tabbar button').forEach(btn => {
  btn.addEventListener('click', () => {
    // leaving a quiz halfway just pauses it on screen; tapping Study again picks it back up
    goTab(btn.dataset.tab);
  });
});

// re-check the date when you come back to the app (the day may have changed)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
});

// ask the phone not to clear our data when storage gets low
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

// offline support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed', err));
}

render();
