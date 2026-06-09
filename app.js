// ─────────────────────────────────────────────────────────────
//  SurveyTrack — app.js  (Firebase Firestore version)
//  Data shape:
//    weeks/{id}               → { name, order, createdAt }
//    weeks/{id}/surveys/{id}  → { name, url, date (YYYY-MM-DD), createdAt }
//    students/{name}          → { pass, createdAt }
//    completions/{name}/done/{surveyId} → { done, at }
// ─────────────────────────────────────────────────────────────

import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore,
         collection, doc,
         getDocs, getDoc,
         setDoc, addDoc,
         updateDoc, deleteDoc,
         query, orderBy }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, INSTRUCTOR_CREDS } from "./firebase-config.js";

// ── Firebase init ────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── Session ──────────────────────────────────────────────────
let currentUser = sessionStorage.getItem("st_user") || null;
let currentRole = sessionStorage.getItem("st_role") || null;

function saveSession(user, role) {
  currentUser = user; currentRole = role;
  sessionStorage.setItem("st_user", user);
  sessionStorage.setItem("st_role", role);
}
function clearSession() {
  currentUser = null; currentRole = null;
  sessionStorage.removeItem("st_user");
  sessionStorage.removeItem("st_role");
}

// ── In-memory cache ──────────────────────────────────────────
let weeksCache       = [];
let studentsCache    = [];   // [name, name, ...]
let completionsCache = {};   // { studentName: Set([surveyId, ...]) }

// ── UI state ─────────────────────────────────────────────────
let expandedWeeks = {};
let quickAddWeeks = {};  // weekId → boolean
let editingEntry  = null;

// ── Helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function setErr(id, msg) { const e=$(id); if(e) e.textContent=msg; }
function clrErr(id)      { setErr(id,""); }
function loading(on)     { $("loading-overlay").style.display = on?"flex":"none"; }

// ── Date formatting ───────────────────────────────────────────
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function formatDate(dateStr) {
  // dateStr is YYYY-MM-DD
  if (!dateStr) return "No date";
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dd   = String(d).padStart(2,"0");
  const mm   = String(m).padStart(2,"0");
  const yy   = String(y).slice(2);
  const day  = DAY_NAMES[date.getDay()];
  return `${dd}/${mm}/${yy} ${day}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ── Screen routing ───────────────────────────────────────────
window.showScreen = id => {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id)?.classList.add("active");
};

function updateTopbar(role, name) {
  $("topbar-sub").textContent = name;
  $("role-badge").textContent = role;
  $("role-badge").hidden = false;
  $("signout-btn").hidden = false;
}

window.signOut = () => {
  clearSession();
  $("role-badge").hidden = true;
  $("signout-btn").hidden = true;
  $("topbar-sub").textContent = "Sign in to continue";
  ["ins-user","ins-pass","slogin-name","slogin-pass","signup-name","signup-pass"]
    .forEach(id => { const e=$(id); if(e) e.value=""; });
  ["ins-err","slogin-err","signup-err"].forEach(clrErr);
  $("tab-surveys").hidden  = false;
  $("tab-students").hidden = true;
  document.querySelectorAll(".tab").forEach((t,i) => {
    t.classList.toggle("active", i===0);
    t.setAttribute("aria-selected", i===0?"true":"false");
  });
  showScreen("screen-pick");
};

// ── Core data fetch ───────────────────────────────────────────
async function refreshWeeks() {
  // Load weeks + surveys
  const snap = await getDocs(query(collection(db,"weeks"), orderBy("order","asc")));
  const weeks = [];
  for (const wDoc of snap.docs) {
    const surveysSnap = await getDocs(
      query(collection(db,"weeks",wDoc.id,"surveys"), orderBy("createdAt","asc"))
    );
    weeks.push({
      id:      wDoc.id,
      name:    wDoc.data().name,
      order:   wDoc.data().order,
      surveys: surveysSnap.docs.map(s => ({ id: s.id, ...s.data() }))
    });
  }
  weeksCache = weeks;

  // For instructor: also load students + their completions
  if (currentRole === "instructor") {
    const studSnap = await getDocs(collection(db,"students"));
    studentsCache = studSnap.docs.map(d => d.id);
    // Load each student's completions
    completionsCache = {};
    await Promise.all(studentsCache.map(async name => {
      try {
        const compSnap = await getDocs(collection(db,"completions",name,"done"));
        completionsCache[name] = new Set(compSnap.docs.map(d => d.id));
      } catch { completionsCache[name] = new Set(); }
    }));
    renderInstructorWeeks();
  }
  if (currentRole === "student") renderStudentView();
}

// ── Auth ─────────────────────────────────────────────────────
window.instructorLogin = () => {
  clrErr("ins-err");
  if ($("ins-user").value.trim() === INSTRUCTOR_CREDS.user &&
      $("ins-pass").value        === INSTRUCTOR_CREDS.pass) {
    saveSession("instructor","instructor");
    updateTopbar("Instructor","Instructor");
    renderInstructorWeeks();
    showScreen("screen-instructor");
  } else {
    setErr("ins-err","Incorrect credentials.");
  }
};

window.studentSignup = async () => {
  clrErr("signup-err");
  const name = $("signup-name").value.trim();
  const pass = $("signup-pass").value;
  if (!name)           return setErr("signup-err","Please enter your full name.");
  if (pass.length < 4) return setErr("signup-err","Password must be at least 4 characters.");
  loading(true);
  try {
    const ref = doc(db,"students",name);
    if ((await getDoc(ref)).exists())
      return setErr("signup-err","Name already registered. Try signing in.");
    await setDoc(ref, { pass, createdAt: Date.now() });
    saveSession(name,"student");
    updateTopbar("Student",name);
    renderStudentView();
    showScreen("screen-student");
  } catch(e) { setErr("signup-err","Error: "+e.message); }
  loading(false);
};

window.studentLogin = async () => {
  clrErr("slogin-err");
  const name = $("slogin-name").value.trim();
  const pass = $("slogin-pass").value;
  loading(true);
  try {
    const snap = await getDoc(doc(db,"students",name));
    if (!snap.exists() || snap.data().pass !== pass)
      return setErr("slogin-err","Name or password is incorrect.");
    saveSession(name,"student");
    updateTopbar("Student",name);
    renderStudentView();
    showScreen("screen-student");
  } catch(e) { setErr("slogin-err","Error: "+e.message); }
  loading(false);
};

// ── Instructor tabs ───────────────────────────────────────────
window.switchTab = tab => {
  const s = tab==="surveys";
  $("tab-surveys").hidden  = !s;
  $("tab-students").hidden =  s;
  $("tab-btn-surveys").classList.toggle("active", s);
  $("tab-btn-surveys").setAttribute("aria-selected", String(s));
  $("tab-btn-students").classList.toggle("active", !s);
  $("tab-btn-students").setAttribute("aria-selected", String(!s));
  if (!s) renderStudents();
};

// ── Add week ──────────────────────────────────────────────────
window.toggleAddWeek = () => {
  const f = $("add-week-form");
  f.hidden = !f.hidden;
  if (!f.hidden) {
    clrErr("new-week-err");
    $("new-week-name").focus();
    // Default date to today
    $("new-survey-date").value = todayISO();
  }
};

window.addWeek = async () => {
  clrErr("new-week-err");
  const wn = $("new-week-name").value.trim();
  const sn = $("new-survey-name").value.trim();
  const su = $("new-survey-url").value.trim();
  const sd = $("new-survey-date").value;
  if (!wn) return setErr("new-week-err","Please enter a week name.");
  if (!sn) return setErr("new-week-err","Please enter the survey name.");
  if (!su) return setErr("new-week-err","Please enter the survey URL.");
  if (!sd) return setErr("new-week-err","Please pick a date.");
  loading(true);
  try {
    const wRef = await addDoc(collection(db,"weeks"), {
      name: wn, order: Date.now(), createdAt: Date.now()
    });
    await addDoc(collection(db,"weeks",wRef.id,"surveys"), {
      name: sn, url: su, date: sd, createdAt: Date.now()
    });
    $("new-week-name").value   = "";
    $("new-survey-name").value = "";
    $("new-survey-url").value  = "";
    $("new-survey-date").value = "";
    $("add-week-form").hidden  = true;
    await refreshWeeks();
  } catch(e) { setErr("new-week-err","Error: "+e.message); }
  loading(false);
};

// ── Quick-add survey to existing week ────────────────────────
window.toggleQuickAdd = weekId => {
  quickAddWeeks[weekId] = !quickAddWeeks[weekId];
  renderInstructorWeeks();
  if (quickAddWeeks[weekId]) {
    setTimeout(() => {
      $("qs-name-"+weekId)?.focus();
      const dateEl = $("qs-date-"+weekId);
      if (dateEl && !dateEl.value) dateEl.value = todayISO();
    }, 50);
  }
};

window.addSurveyToWeek = async weekId => {
  const errId = "qs-err-"+weekId;
  clrErr(errId);
  const sn = $("qs-name-"+weekId)?.value.trim();
  const su = $("qs-url-" +weekId)?.value.trim();
  const sd = $("qs-date-"+weekId)?.value;
  if (!sn||!su) return setErr(errId,"Please fill in name and URL.");
  if (!sd)      return setErr(errId,"Please pick a date.");
  loading(true);
  try {
    await addDoc(collection(db,"weeks",weekId,"surveys"), {
      name: sn, url: su, date: sd, createdAt: Date.now()
    });
    quickAddWeeks[weekId] = false;
    await refreshWeeks();
  } catch(e) { setErr(errId,"Error: "+e.message); }
  loading(false);
};

// ── Delete ────────────────────────────────────────────────────
window.deleteWeek = async (weekId, weekName) => {
  if (!confirm(`Delete "${weekName}" and all its surveys?`)) return;
  loading(true);
  try {
    const ss = await getDocs(collection(db,"weeks",weekId,"surveys"));
    for (const s of ss.docs) await deleteDoc(s.ref);
    await deleteDoc(doc(db,"weeks",weekId));
    delete expandedWeeks[weekId];
    delete quickAddWeeks[weekId];
    await refreshWeeks();
  } catch(e) { alert("Error: "+e.message); }
  loading(false);
};

window.deleteSurvey = async (weekId, surveyId) => {
  loading(true);
  try {
    await deleteDoc(doc(db,"weeks",weekId,"surveys",surveyId));
    await refreshWeeks();
  } catch(e) { alert("Error: "+e.message); }
  loading(false);
};

// ── Inline edit ───────────────────────────────────────────────
window.startEditSurvey = (weekId, surveyId) => {
  editingEntry = { weekId, surveyId };
  renderInstructorWeeks();
  setTimeout(() => $("edit-name-"+surveyId)?.focus(), 50);
};

window.cancelEdit = () => { editingEntry = null; renderInstructorWeeks(); };

window.saveEditSurvey = async (weekId, surveyId) => {
  const n = $("edit-name-"+surveyId)?.value.trim();
  const u = $("edit-url-" +surveyId)?.value.trim();
  const d = $("edit-date-"+surveyId)?.value;
  if (!n||!u||!d) return;
  loading(true);
  try {
    await updateDoc(doc(db,"weeks",weekId,"surveys",surveyId), { name:n, url:u, date:d });
    editingEntry = null;
    await refreshWeeks();
  } catch(e) { alert("Error: "+e.message); }
  loading(false);
};

// ── Group surveys by date ─────────────────────────────────────
function groupByDate(surveys) {
  const map = {};
  for (const s of surveys) {
    const key = s.date || "no-date";
    if (!map[key]) map[key] = [];
    map[key].push(s);
  }
  // Sort dates ascending, "no-date" at end
  return Object.entries(map).sort(([a],[b]) => {
    if (a==="no-date") return 1;
    if (b==="no-date") return -1;
    return a < b ? -1 : 1;
  });
}

// ── Render: instructor weeks ──────────────────────────────────
function renderInstructorWeeks() {
  const c = $("instructor-weeks");
  if (!weeksCache.length) {
    c.innerHTML = '<div class="empty">No weeks yet. Click "Add week" to get started.</div>';
    return;
  }

  c.innerHTML = weeksCache.map(week => {
    const collapsed = expandedWeeks[week.id] === false;
    const showQA    = quickAddWeeks[week.id];
    const byDate    = groupByDate(week.surveys);

    // Build date-grouped survey rows
    const datesHtml = byDate.length === 0
      ? '<div class="empty" style="padding:6px 0">No surveys yet.</div>'
      : byDate.map(([dateKey, surveys]) => {
          const surveysHtml = surveys.map(s => {
            if (editingEntry?.weekId===week.id && editingEntry?.surveyId===s.id) {
              return `<div class="survey-row">
                <div class="edit-row-inputs">
                  <input id="edit-name-${esc(s.id)}" type="text" value="${esc(s.name)}" placeholder="Survey name"/>
                  <input id="edit-url-${esc(s.id)}"  type="url"  value="${esc(s.url)}"  placeholder="https://..."/>
                  <input id="edit-date-${esc(s.id)}" type="date" value="${esc(s.date||"")}"/>
                </div>
                <button class="btn btn-primary btn-sm" onclick="saveEditSurvey('${esc(week.id)}','${esc(s.id)}')">Save</button>
                <button class="btn btn-ghost btn-sm"   onclick="cancelEdit()">Cancel</button>
              </div>`;
            }
            // Calculate who hasn't answered this survey
            const pending = studentsCache.filter(name =>
              !completionsCache[name]?.has(s.id)
            );
            const pendingId = "pending-"+esc(s.id);
            const pendingHtml = pending.length === 0
              ? `<div class="pending-all-done"><i class="ti ti-circle-check"></i> All students answered</div>`
              : pending.map(name => {
                  const initials = name.split(" ").map(x=>x[0]).join("").toUpperCase().slice(0,2);
                  return `<div class="pending-student"><div class="avatar avatar-xs">${esc(initials)}</div>${esc(name)}</div>`;
                }).join("");

            return `<div class="survey-wrap">
              <div class="survey-row">
                <span class="survey-name">${esc(s.name)}</span>
                <a href="${esc(s.url)}" target="_blank" rel="noopener" class="survey-link-icon" title="Open">
                  <i class="ti ti-external-link"></i>
                </a>
                <button class="btn btn-ghost btn-sm" onclick="startEditSurvey('${esc(week.id)}','${esc(s.id)}')" title="Edit">
                  <i class="ti ti-edit"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteSurvey('${esc(week.id)}','${esc(s.id)}')" title="Delete">
                  <i class="ti ti-trash"></i>
                </button>
                <button class="btn btn-ghost btn-sm pending-toggle${pending.length===0?" pending-done":""}"
                  onclick="togglePending('${esc(s.id)}')" title="Who hasn't answered">
                  <i class="ti ti-users"></i>
                  ${studentsCache.length > 0 ? `<span class="pending-badge">${pending.length}</span>` : ""}
                </button>
              </div>
              <div class="pending-panel" id="${pendingId}" hidden>
                <div class="pending-label">Not answered yet (${pending.length} / ${studentsCache.length})</div>
                <div class="pending-list">${pendingHtml}</div>
              </div>
            </div>`;
          }).join("");

          return `<div class="date-group">
            <div class="date-label">
              <i class="ti ti-calendar-event" style="font-size:13px"></i>
              ${esc(formatDate(dateKey))}
            </div>
            ${surveysHtml}
          </div>`;
        }).join("");

    const qaForm = showQA ? `<div class="inline-form">
      <div class="form-group">
        <label class="form-label">Survey name</label>
        <input id="qs-name-${esc(week.id)}" type="text" placeholder="Survey name"/>
      </div>
      <div class="form-group">
        <label class="form-label">Link</label>
        <input id="qs-url-${esc(week.id)}" type="url" placeholder="https://..."/>
      </div>
      <div class="form-group">
        <label class="form-label">Date</label>
        <input id="qs-date-${esc(week.id)}" type="date"/>
      </div>
      <p class="err" id="qs-err-${esc(week.id)}"></p>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-outline btn-sm" onclick="toggleQuickAdd('${esc(week.id)}')">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="addSurveyToWeek('${esc(week.id)}')">Add survey</button>
      </div>
    </div>` : "";

    const totalSurveys = week.surveys.length;
    return `<div class="week-block${collapsed?" collapsed":""}">
      <div class="week-header" onclick="toggleWeek('${esc(week.id)}')" role="button" aria-expanded="${!collapsed}">
        <i class="ti ti-calendar-week" style="font-size:16px;color:var(--text-3)"></i>
        <span class="week-label">${esc(week.name)}</span>
        <div class="week-meta">
          <span class="week-count">${totalSurveys} survey${totalSurveys!==1?"s":""}</span>
          <i class="ti ti-chevron-down chevron"></i>
        </div>
      </div>
      <div class="week-body">
        ${datesHtml}
        <div class="week-actions">
          <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();toggleQuickAdd('${esc(week.id)}')">
            <i class="ti ti-plus"></i> Add survey
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteWeek('${esc(week.id)}','${esc(week.name)}')">
            <i class="ti ti-trash"></i> Delete week
          </button>
        </div>
        ${qaForm}
      </div>
    </div>`;
  }).join("");
}

window.togglePending = id => {
  const panel = document.getElementById("pending-"+id);
  if (panel) panel.hidden = !panel.hidden;
};

window.toggleWeek = id => {
  expandedWeeks[id] = expandedWeeks[id]===false ? true : false;
  renderInstructorWeeks();
};

// ── Render: students list ─────────────────────────────────────
async function renderStudents() {
  const c = $("students-list");
  c.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const snap  = await getDocs(collection(db,"students"));
    const total = weeksCache.reduce((a,w) => a+w.surveys.length, 0);
    if (snap.empty) { c.innerHTML='<div class="empty">No students yet.</div>'; return; }
    const existingSurveyIds = new Set(weeksCache.flatMap(w => w.surveys.map(s => s.id)));
    const rows = await Promise.all(snap.docs.map(async d => {
      const name     = d.id;
      const initials = name.split(" ").map(x=>x[0]).join("").toUpperCase().slice(0,2);
      let done = 0;
      try {
        const compSnap = await getDocs(collection(db,"completions",name,"done"));
        done = compSnap.docs.filter(d => existingSurveyIds.has(d.id)).length;
      } catch{}
      const pct = total ? Math.round(done/total*100) : 0;
      return `<div class="student-row">
        <div class="avatar">${esc(initials)}</div>
        <div class="student-info">
          <div class="student-name">${esc(name)}</div>
          <div class="student-prog-track">
            <div class="student-prog-fill" style="width:${pct}%"></div>
          </div>
        </div>
        <span class="student-stat">${done} / ${total}</span>
      </div>`;
    }));
    c.innerHTML = `<p style="font-size:13px;color:var(--text-3);margin-bottom:12px">
      ${snap.size} student${snap.size!==1?"s":""} registered</p>
      <div class="card" style="padding:4px 14px">${rows.join("")}</div>`;
  } catch(e) { c.innerHTML=`<div class="empty">Error: ${esc(e.message)}</div>`; }
}

// ── Render: student view ──────────────────────────────────────
async function renderStudentView() {
  const progWrap = $("student-progress-wrap");
  const weeksEl  = $("student-weeks");

  let comp = {};
  try {
    (await getDocs(collection(db,"completions",currentUser,"done")))
      .forEach(d => { comp[d.id]=true; });
  } catch {}

  const total      = weeksCache.reduce((a,w) => a+w.surveys.length, 0);
  const existingIds = new Set(weeksCache.flatMap(w => w.surveys.map(s => s.id)));
  const done       = Object.keys(comp).filter(id => existingIds.has(id)).length;
  const pct        = total ? Math.round(done/total*100) : 0;

  progWrap.innerHTML = `
    <div class="progress-title">Your progress</div>
    <div class="progress-numbers">
      <span class="progress-big">${done}</span>
      <span class="progress-of">of ${total} surveys completed</span>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="progress-label">${pct}% complete</div>`;

  if (!weeksCache.length) {
    weeksEl.innerHTML = '<div class="empty">No surveys assigned yet. Check back later!</div>';
    return;
  }

  weeksEl.innerHTML = weeksCache.map(week => {
    const wDone   = week.surveys.filter(s => existingIds.has(s.id) && comp[s.id]).length;
    const wTotal  = week.surveys.filter(s => existingIds.has(s.id)).length;
    const allDone = wTotal > 0 && wDone === wTotal;
    const byDate  = groupByDate(week.surveys);

    const datesHtml = byDate.map(([dateKey, surveys]) => {
      const rows = surveys.map(s => {
        const checked = comp[s.id] ? "checked" : "";
        return `<div class="check-row">
          <input type="checkbox" id="chk-${esc(s.id)}" ${checked}
            onchange="toggleComplete('${esc(s.id)}',this.checked)"/>
          <label class="check-label${checked?" done":""}" for="chk-${esc(s.id)}">${esc(s.name)}</label>
          <a href="${esc(s.url)}" target="_blank" rel="noopener" class="open-link">
            <i class="ti ti-external-link"></i> Open
          </a>
        </div>`;
      }).join("");

      return `<div class="date-group">
        <div class="date-label">
          <i class="ti ti-calendar-event" style="font-size:13px"></i>
          ${esc(formatDate(dateKey))}
        </div>
        ${rows}
      </div>`;
    }).join("");

    return `<div class="week-block">
      <div class="week-header" style="cursor:default">
        <i class="ti ti-calendar-week" style="font-size:16px;color:var(--text-3)"></i>
        <span class="week-label">${esc(week.name)}</span>
        <div class="week-meta">
          <span class="week-count${allDone?" all-done":""}">${wDone} / ${wTotal}</span>
          ${allDone?'<i class="ti ti-circle-check" style="font-size:16px;color:var(--green)"></i>':""}
        </div>
      </div>
      <div class="week-body">${datesHtml}</div>
    </div>`;
  }).join("");
}

window.toggleComplete = async (surveyId, checked) => {
  try {
    const ref = doc(db,"completions",currentUser,"done",surveyId);
    if (checked) await setDoc(ref,{done:true,at:Date.now()});
    else         await deleteDoc(ref);
    renderStudentView();
  } catch(e) { alert("Error: "+e.message); }
};

// ── Keyboard shortcuts ────────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const id = document.querySelector(".screen.active")?.id;
  if (id==="screen-instructor-login") instructorLogin();
  else if (id==="screen-student-login")  studentLogin();
  else if (id==="screen-student-signup") studentSignup();
});

// ── Auto-refresh every 20s ────────────────────────────────────
setInterval(() => refreshWeeks(), 20000);

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  loading(true);
  await refreshWeeks();

  if (currentRole === "instructor") {
    updateTopbar("Instructor","Instructor");
    renderInstructorWeeks();
    showScreen("screen-instructor");
  } else if (currentRole === "student" && currentUser) {
    updateTopbar("Student", currentUser);
    renderStudentView();
    showScreen("screen-student");
  }

  loading(false);
})();
